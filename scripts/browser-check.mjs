/** Development only: npm install --no-save playwright, then npm run test:browser. */
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, relative } from 'node:path';
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.WSM_PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(import.meta.dirname, '..');
const server = createServer(async (req, res) => {
    const path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    if (relative(root, path).startsWith('..')) { res.writeHead(403).end(); return; }
    try {
        const data = await readFile(path);
        res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[extname(path)] ?? 'application/octet-stream');
        res.end(data);
    } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: process.env.WSM_CHROMIUM || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const results = [];
try {
    for (const viewport of [{ width: 1280, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 720 }]) {
        const page = await browser.newPage({ viewport });
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.goto(`http://127.0.0.1:${server.address().port}/tests/preview.html`);
        await page.waitForFunction(() => window.harness?.manager.bookNames.length === 2);
        await page.locator('.wsm > details > summary').click();
        await page.getByText('原神综合世界书 · 2 条', { exact: true }).click();
        await page.getByRole('checkbox', { name: '雷电将军', exact: true }).check();
        assert.match(await page.locator('.wsm-scope').innerText(), /精细管理/);
        const selection = await page.evaluate(() => JSON.stringify(window.harness.manager.settings.selection));
        assert.deepEqual(JSON.parse(selection), { '原神综合世界书': ['1'] });
        const first = await page.evaluate(() => window.harness.round());
        assert.ok(first.includes('雷电将军'));
        const second = await page.evaluate(() => window.harness.round());
        assert.ok(!second.includes('雷电将军'));
        assert.ok(second.includes('提瓦特世界规则'));
        const redo = await page.evaluate(() => window.harness.round({ regenerate: true }));
        assert.ok(!redo.includes('雷电将军'));
        assert.equal(await page.evaluate(() => window.harness.manager.state.clock), 2);
        const third = await page.evaluate(() => window.harness.round());
        assert.ok(third.includes('雷电将军'));
        await page.getByRole('combobox', { name: '选择用途' }).selectOption('manual');
        await page.getByRole('checkbox', { name: '雷电将军', exact: true }).check();
        await page.getByRole('button', { name: '冻结所选', exact: true }).click();
        assert.equal(await page.evaluate(() => JSON.stringify(window.harness.manager.settings.selection)), selection);
        await page.getByRole('button', { name: '解除所选手动冻结', exact: true }).click();
        assert.match(await page.locator('.wsm-entry').first().innerText(), /自动冷却/);
        await page.getByRole('combobox', { name: '选择用途' }).selectOption('scope');
        await page.getByRole('button', { name: '清空全部选择', exact: true }).click();
        assert.match(await page.locator('.wsm-scope').innerText(), /全部管理/);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
        assert.equal(overflow, false);
        assert.deepEqual(errors, []);
        await mkdir(resolve(root, 'docs'), { recursive: true });
        if (viewport.width === 390) await page.screenshot({ path: resolve(root, 'docs/mobile-preview.png'), fullPage: true });
        results.push({ viewport, result: 'PASS', checks: ['UI scope and independent manual selection', 'three-turn cooldown with regeneration', 'unselected blue entry', 'manual/auto co-existence', 'clear -> all', 'no horizontal overflow', 'no browser exceptions'] });
        await page.close();
    }
    const page = await browser.newPage({viewport:{width:390,height:844}});
    const stressErrors=[];page.on('pageerror',e=>stressErrors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/tests/preview.html`);
    await page.waitForFunction(()=>window.harness?.manager.bookNames.length===2);
    await page.locator('.wsm > details > summary').click();
    const loadMs=await page.evaluate(()=>{
        const start=performance.now();const m=window.harness.manager;
        m.entries=Array.from({length:10000},(_,i)=>({world:`压力世界书 ${Math.floor(i/500)}`,uid:i%500,comment:`压力人物 ${Math.floor(i/500)}-${i%500}`,key:[],content:'test'}));
        m.bookNames=Array.from({length:20},(_,i)=>`压力世界书 ${i}`);m.onChange();
        return performance.now()-start;
    });
    assert.equal(await page.locator('.wsm-entry').count(),0);
    await page.getByText('压力世界书 0 · 500 条',{exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.wsm-entry').length===100);
    await page.getByRole('button',{name:'显示更多（已显示 100 / 500 条）',exact:true}).click();
    assert.equal(await page.locator('.wsm-entry').count(),200);
    await page.getByRole('button',{name:'全选搜索结果',exact:true}).click();
    assert.equal(await page.evaluate(()=>Object.values(window.harness.manager.settings.selection).reduce((n,v)=>n+v.length,0)),10000);
    await page.getByRole('combobox',{name:'选择用途'}).selectOption('manual');
    await page.getByRole('button',{name:'全选搜索结果',exact:true}).click();
    await page.getByRole('button',{name:'冻结所选',exact:true}).click();
    assert.equal(await page.evaluate(()=>Object.keys(window.harness.manager.state.manual).length),10000);
    const client=await page.context().newCDPSession(page);
    await client.send('HeapProfiler.collectGarbage');
    const before=(await client.send('Runtime.getHeapUsage')).usedSize;
    const repeatMs=await page.evaluate(()=>{
        const start=performance.now();for(let i=0;i<200;i++)window.harness.manager.onChange();return performance.now()-start;
    });
    await page.waitForTimeout(100);
    await client.send('HeapProfiler.collectGarbage');
    const after=(await client.send('Runtime.getHeapUsage')).usedSize;
    assert.ok(after-before<20*1024*1024,'Repeated rendering retained more than 20 MiB');
    assert.equal(await page.locator('.wsm-entry').count(),200);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.evaluate(()=>window.harness.events.emit('CHAT_CHANGED'));
    assert.equal(await page.evaluate(()=>Object.keys(window.harness.manager.state.manual).length),0);
    assert.match(await page.locator('.wsm-manual').innerText(),/已选 0 个/);
    assert.deepEqual(stressErrors,[]);
    results.push({viewport:{width:390,height:844},result:'PASS',stress:{entries:10000,books:20,initialRenderedEntryRows:0,expandedEntryRows:200,manualFrozenEntries:10000,repeatRenders:200,initialRenderMs:Math.round(loadMs),repeatRenderTotalMs:Math.round(repeatMs),retainedHeapGrowthBytes:after-before},checks:['lazy and paged rendering','bulk scope and manual selection across all entries','session switch clears manual state and picks','no horizontal overflow or browser exceptions','bounded retained heap after garbage collection']});
    await page.close();
    await writeFile(resolve(root, 'docs/browser-results.json'), JSON.stringify({ environment: 'Isolated mock host, Chromium; not live SillyTavern or physical Android', results }, null, 2) + '\n');
    console.log(JSON.stringify(results, null, 2));
} finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
}
