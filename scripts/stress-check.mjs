import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { Manager } from '../controller.js';
import { completeRound, freshState, settingsWithDefaults, status, entryKey, freeze } from '../core.js';

const results=[];
function record(name, start, details) { results.push({name, result:'PASS', elapsedMs:Math.round(performance.now()-start), ...details}); }
let start=performance.now();
const state=freshState(), settings=settingsWithDefaults({delay:2,cooldown:3});
const entry={world:'large',uid:1};
for(let round=1;round<=100000;round++) {
    const offset=(round-1)%6;
    assert.equal(status(state,settings,'large',1,round).blocked,offset>=3);
    const injected=offset<3?[entry]:[];
    completeRound(state,settings,`u${round}`,round,injected);
    completeRound(state,settings,`u${round}`,round,injected); // regeneration
    assert.equal(state.clock,round);
    if(round%100===0) freeze(state,[entryKey('temporary',round)],1);
}
assert.ok(Object.keys(state.manual).length<=1);
assert.equal('turns' in state,false);
assert.equal('history' in state,false);
record('100000 rounds plus 100000 regenerations',start,{rounds:100000,regenerations:100000,retainedTurnRecords:1,retainedManualRules:Object.keys(state.manual).length});

class Events {
    events=new Map();
    on(n,f){this.events.set(n,[...(this.events.get(n)??[]),f]);}
    removeListener(n,f){this.events.set(n,(this.events.get(n)??[]).filter(x=>x!==f));}
    makeLast(n,f){this.removeListener(n,f);this.on(n,f);}
}
const names=['WORLDINFO_SCAN_DONE','WORLDINFO_ENTRIES_LOADED','WORLD_INFO_ACTIVATED','GENERATE_AFTER_DATA','CHAT_COMPLETION_SETTINGS_READY','GENERATION_STARTED','GENERATION_ENDED','GENERATION_STOPPED','MESSAGE_RECEIVED','CHAT_CHANGED','MESSAGE_EDITED','MESSAGE_UPDATED','MESSAGE_DELETED','MESSAGE_SWIPED','WORLDINFO_SETTINGS_UPDATED','WORLDINFO_UPDATED','CHARACTER_EDITED','PERSONA_CHANGED'];
const events=new Events();
const metadata={world_info:'large'};
const ctx={chat:[],chatMetadata:metadata,extensionSettings:{},eventTypes:Object.fromEntries(names.map(n=>[n,n])),eventSource:events,
    getCurrentChatId:()=> 'stress',saveSettingsDebounced(){},loadWorldInfo(){},characters:[]};
const manager=new Manager(()=>ctx,{list:async()=>({entries:[],books:[]}),render:e=>e.content});
start=performance.now();
for(let i=0;i<5000;i++){manager.start();manager.start();assert.equal([...events.events.values()].flat().length,names.length);manager.stop();}
assert.equal([...events.events.values()].flat().length,0);
record('5000 enable/disable cycles',start,{cycles:5000,remainingListeners:0,metadataUnchanged:JSON.stringify(ctx.chatMetadata)==='{"world_info":"large"}'});

manager.start();await manager.refresh();
const entries=Array.from({length:10000},(_,i)=>({world:`book-${Math.floor(i/500)}`,uid:i%500,disable:false,content:`entry-${i}`}));
manager.settings.selection={'book-0':Array.from({length:250},(_,i)=>String(i))};
manager.manualFreeze([entryKey('book-19',499)],2);
const times=[];
start=performance.now();
for(let i=0;i<200;i++){
    const payload={globalLore:entries.map(e=>({...e})),characterLore:[],chatLore:[],personaLore:[]};
    const t=performance.now();manager.filter(payload);times.push(performance.now()-t);
    assert.equal(payload.globalLore.at(-1).disable,true);
    assert.equal(payload.globalLore[1].disable,false);
}
assert.equal(entries.some(e=>e.disable),false);
times.sort((a,b)=>a-b);
// Scans on a long chat: state is derived from the last round snapshot.
const { writeStart, writeDelta } = await import('../timeline.js');
for(let i=0;i<20000;i++){ctx.chat.push({is_user:true,mes:'u',extra:{}},{is_user:false,mes:'a',extra:{},swipes:['a'],swipe_id:0,swipe_info:[{extra:{}}]});}
writeStart(ctx.chat[39998],{id:'s',round:20000,auto:{},manual:{}});
writeDelta(ctx.chat[39999],{anchor:'s',round:20000,inj:[['book-0','7']],delay:0,cooldown:3});
manager.touch();
const longTimes=[];
for(let i=0;i<50;i++){ctx.chat.push({is_user:true,mes:'u',extra:{}});manager.touch();const payload={globalLore:entries.map(e=>({...e}))};const t=performance.now();manager.filter(payload);longTimes.push(performance.now()-t);ctx.chat.pop();
    assert.equal(payload.globalLore[7].disable,true);}
longTimes.sort((a,b)=>a-b);
record('40000-message chat, 10000 entries, 50 scans',start,{messages:40001,entries:10000,scans:50,p50Ms:+longTimes[25].toFixed(2),p95Ms:+longTimes[47].toFixed(2)});
record('10000 entries across 20 books, 200 scans',start,{entries:10000,scans:200,p50Ms:+times[100].toFixed(2),p95Ms:+times[190].toFixed(2),originalEntriesUnchanged:true});

// 40,000-message chat + 10,000 keyed green entries with green cap enabled
const capEntries=Array.from({length:10000},(_,i)=>({world:`book-${Math.floor(i/500)}`,uid:i%500,disable:false,constant:false,key:[`kw_${i%40}`],content:`entry-${i}`}));
ctx.chat[ctx.chat.length-1].mes='kw_0 kw_1 kw_2 kw_3 kw_4 kw_5 kw_6 kw_7';
manager.updateSettings({selection:{},capEnabled:true,capLimit:5});
const capTimes=[];
const capStart=performance.now();
for(let i=0;i<50;i++){
    ctx.chat.push({is_user:true,mes:'kw_0 kw_1 kw_2 kw_3 kw_4 kw_5 kw_6 kw_7',extra:{}});
    manager.touch();
    const payload={globalLore:capEntries.map(e=>({...e}))};
    manager.filter(payload);
    const beforeCap=payload.globalLore.filter(e=>!e.disable).length;
    const accepted=new Map(payload.globalLore.filter(e=>!e.disable && e.key.some(k=>ctx.chat.at(-1).mes.includes(k))).map(e=>[entryKey(e.world,e.uid),e]));
    const t=performance.now();manager.scanDone({state:{next:0,loopCount:1},activated:{entries:accepted}});capTimes.push(performance.now()-t);
    ctx.chat.pop();
    assert.equal(accepted.size,5); // Only native accepted entries compete; originals stay untouched.
    assert.equal(payload.globalLore.filter(e=>!e.disable).length,beforeCap);
}
capTimes.sort((a,b)=>a-b);
record('40000-message chat, 10000 keyed entries, green cap (limit 5), 50 scans',capStart,{messages:40001,entries:10000,capLimit:5,scans:50,p50Ms:+capTimes[25].toFixed(2),p95Ms:+capTimes[47].toFixed(2)});
// Distinct scan depths used to retain O(sum(depth)) copies of chat text (A05).
const varied=Array.from({length:600},(_,uid)=>({world:'depths',uid,key:['absent'],content:'x',scanDepth:uid+1}));
const savedChat=ctx.chat;ctx.chat=Array.from({length:600},(_,i)=>({is_user:!!(i%2),mes:'x'.repeat(1000)}));
const memStart=process.memoryUsage().heapUsed, depthStart=performance.now();
const variedMap=new Map(varied.map(e=>[String(e.uid),e]));
manager.scanDone({state:{next:0,loopCount:1},activated:{entries:variedMap}});
assert.equal(variedMap.size,5);
record('600 distinct depths, 600 x 1KB messages, bounded native-candidate ranking',depthStart,{heapGrowthMB:+((process.memoryUsage().heapUsed-memStart)/1024**2).toFixed(2),retained:variedMap.size});
ctx.chat=savedChat;
manager.updateSettings({capEnabled:false});

start=performance.now();let loads=0;
manager.adapter.list=async()=>{loads++;await new Promise(r=>setTimeout(r,10));return {books:['latest'],entries:[]};};
await Promise.all(Array.from({length:2000},()=>manager.refresh()));
assert.ok(loads<=2);assert.deepEqual(manager.bookNames,['latest']);
record('2000 concurrent refresh notifications',start,{notifications:2000,actualLoads:loads});
manager.adapter.list=async()=>{throw new Error('offline');};await manager.refresh();assert.match(manager.error,/读取失败/);
manager.adapter.list=async()=>({entries:[],books:['recovered']});await manager.refresh();assert.equal(manager.error,'');
manager.stop();assert.equal([...events.events.values()].flat().length,0);
const output={environment:`Node ${process.version}; isolated deterministic event tests, no paid model calls`,results};
await writeFile(new URL('../docs/stress-results.json',import.meta.url),JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify(output,null,2));
