// Minimal cooldown cycle on any host version (used for the 1.18 compatibility check).
import fs from 'node:fs';
import { launch, load, openChar, send, sleep } from './harness.mjs';
const LOG = process.env.MOCK_LOG || new URL('./mock-requests.jsonl', import.meta.url).pathname;
const { browser, page } = await launch();
const lastReq = () => JSON.parse(fs.readFileSync(LOG, 'utf8').trim().split('\n').at(-1));
const has = (req, m) => req.all.some(x => x.role === 'system' && x.content.includes(m));
await page.evaluate(() => { const c = SillyTavern.getContext(); Object.assign(c.extensionSettings.worldbook_switch_manager, { enabled: true, automatic: true, delay: 0, cooldown: 2, aiTurns: false, includeConstant: false, selection: {} }); });
await openChar(page);
if (process.env.PREVIEW) {
    // Reproduce the review's 1.18 order: a prompt-manager dry run starts right after the real
    // generation and scans before the user message is added.
    await page.evaluate(async () => {
        const c = SillyTavern.getContext(); const oai = await import('/scripts/openai.js');
        c.eventSource.on(c.eventTypes.GENERATION_STARTED, (type, o, dry) => { if (!dry && type === 'normal') { window.__previews = (window.__previews || 0) + 1; oai.promptManager.tryGenerate(); } });
    });
}
await page.evaluate(() => Object.assign(SillyTavern.getContext().chatCompletionSettings, { stream_openai: true, n: 1 }));
const version = await page.evaluate(async () => (await (await fetch('/version')).json()).pkgVersion);
const out = { version, runs: [] };
for (let run = 0; run < 2; run++) {
    await page.evaluate(async () => SillyTavern.getContext().executeSlashCommandsWithOptions('/newchat')); await sleep(1500);
    const pattern = [];
    for (let i = 1; i <= 4; i++) { await send(page, `dragon ${i}`); await sleep(800); pattern.push(has(lastReq(), 'WSM_DRAGON_LORE')); }
    await load(page); await openChar(page);
    for (let i = 5; i <= 7; i++) { await send(page, `dragon ${i}`); await sleep(800); pattern.push(has(lastReq(), 'WSM_DRAGON_LORE')); }
    out.runs.push({ pattern, pass: pattern.join() === 'true,false,false,true,false,false,true' });
}
out.previews = await page.evaluate(() => window.__previews || 0).catch(() => 0);
console.log(JSON.stringify(out));
fs.writeFileSync(process.env.OUT || '/dev/null', JSON.stringify(out, null, 2));
await browser.close();
process.exitCode = out.runs.every(r => r.pass) ? 0 : 1;
