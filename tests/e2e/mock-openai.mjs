import http from 'node:http';
import fs from 'node:fs';
const PORT = Number(process.env.MOCK_PORT || 8124);
const LOG = process.env.MOCK_LOG || new URL('./mock-requests.jsonl', import.meta.url).pathname;
let n = 0;
function lastUser(messages){ for (let i=messages.length-1;i>=0;i--) if (messages[i].role==='user') return typeof messages[i].content==='string'?messages[i].content:JSON.stringify(messages[i].content); return ''; }
http.createServer((req,res)=>{
  let body=''; req.on('data',c=>body+=c); req.on('end', async ()=>{
    if (req.url.endsWith('/models')) { res.writeHead(200,{'content-type':'application/json'}); return res.end(JSON.stringify({object:'list',data:[{id:'mock-model',object:'model'}]})); }
    if (!req.url.endsWith('/chat/completions')) { res.writeHead(404); return res.end('{}'); }
    const data = JSON.parse(body||'{}'); const id = ++n;
    const msgs = data.messages||[]; const lu = lastUser(msgs);
    let lui=-1; for (let i=msgs.length-1;i>=0;i--) if (msgs[i].role==='user'){lui=i;break;} const hasToolResult = msgs.slice(lui+1).some(m=>m.role==='tool');
    fs.appendFileSync(LOG, JSON.stringify({id, at: Date.now(), stream: !!data.stream, tools: !!data.tools, lastUser: lu, all: msgs.map(m=>({role:m.role, content: typeof m.content==='string'?m.content:JSON.stringify(m.content)}))})+'\n');
    // FOLLOWFAIL: the request that carries a tool result fails (tool chain broken mid-way).
    if (lu.includes('FOLLOWFAIL') && hasToolResult) { res.writeHead(500,{'content-type':'application/json'}); return res.end(JSON.stringify({error:{message:'mock follow-up failure'}})); }
    if (lu.includes('MOCKFAIL')) { res.writeHead(500,{'content-type':'application/json'}); return res.end(JSON.stringify({error:{message:'mock failure'}})); }
    // AITOOL: call a tool only when the AI is continuing on its own (last message is an assistant reply).
    const lastMsg = msgs[msgs.length - 1];
    const aiContinues = lastMsg?.role === 'assistant' && !lastMsg.tool_calls;
    const wantTool = data.tools && ((lu.includes('MOCKTOOL') && !hasToolResult) || (lu.includes('AITOOL') && aiContinues));
    const text = lu.includes('MOCKSLOW') ? 'slow '.repeat(200) : `mock reply #${id} to: ${lu.slice(0,40)}`;
    const delay = lu.includes('MOCKSLOW') ? 50 : 2;
    if (wantTool) {
      const fn = data.tools[0].function.name;
      const tc = [{index:0,id:'call_'+id,type:'function',function:{name:fn,arguments:'{}'}}];
      // MOCKTOOLTEXT: the same response also carries visible text before the tool call.
      const pre = lu.includes('MOCKTOOLTEXT') ? 'I will check the result.' : '';
      if (data.stream) {
        res.writeHead(200,{'content-type':'text/event-stream'});
        if (pre) res.write(`data: ${JSON.stringify({id:'c'+id,object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:pre}}]})}\n\n`);
        res.write(`data: ${JSON.stringify({id:'c'+id,object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',tool_calls:tc}}]})}\n\n`);
        res.write(`data: ${JSON.stringify({id:'c'+id,object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'tool_calls'}]})}\n\n`);
        res.write('data: [DONE]\n\n'); return res.end();
      }
      res.writeHead(200,{'content-type':'application/json'});
      return res.end(JSON.stringify({id:'c'+id,object:'chat.completion',choices:[{index:0,message:{role:'assistant',content:pre,tool_calls:tc},finish_reason:'tool_calls'}]}));
    }
    const count = Math.max(1, Number(data.n) || 1);
    if (data.stream) {
      res.writeHead(200,{'content-type':'text/event-stream'});
      const parts = text.match(/.{1,8}/g);
      for (const p of parts) { if (res.destroyed) return; for (let k = 0; k < count; k++) res.write(`data: ${JSON.stringify({id:'c'+id,object:'chat.completion.chunk',choices:[{index:k,delta:{content:k ? `[alt ${k}] ${p}` : p}}]})}\n\n`); await new Promise(r=>setTimeout(r,delay)); }
      for (let k = 0; k < count; k++) res.write(`data: ${JSON.stringify({id:'c'+id,object:'chat.completion.chunk',choices:[{index:k,delta:{},finish_reason:'stop'}]})}\n\n`);
      res.write('data: [DONE]\n\n'); return res.end();
    }
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({id:'c'+id,object:'chat.completion',choices:Array.from({length:count},(_,k)=>({index:k,message:{role:'assistant',content:k?`[alt ${k}] ${text}`:text},finish_reason:'stop'}))}));
  });
}).listen(PORT,'127.0.0.1',()=>console.log('mock on',PORT));
