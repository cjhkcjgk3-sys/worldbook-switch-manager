// "Stop, then do something" combinations on a real SillyTavern 1.19 + mock backend.
// Assertions use what the mock actually received (is the dragon entry in the request?) and the message extra.
import fs from 'node:fs';
import { launch, openChar, idle, sleep, waitSaved } from './harness.mjs';
const LOG = process.env.MOCK_LOG || new URL('./mock-requests.jsonl', import.meta.url).pathname;
const MOCK = process.env.WSM_MOCK_URL || 'http://127.0.0.1:8124';
const OUT = process.env.STOP_OUT || new URL('../../docs/stop-1.19-results.json', import.meta.url);
const results = [];
const want = n => !process.env.ONLY || process.env.ONLY.split(',').includes(n);
const ok = (name, pass, info) => { results.push({ name, pass: !!pass, info }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${pass ? '' : ' ' + JSON.stringify(info)?.slice(0, 900)}`); };
const { browser, page } = await launch();
const slash = cmd => page.evaluate(async c => { await SillyTavern.getContext().executeSlashCommandsWithOptions(c); }, cmd);
const lines = () => fs.readFileSync(LOG, 'utf8').trim().split('\n');
const reqCount = () => lines().length;
const reqsSince = n0 => lines().slice(n0).map(l => JSON.parse(l));
const DRAGON = 'WSM_DRAGON_LORE';
const has = (req, marker = DRAGON) => !!req && req.all.some(m => m.role === 'system' && m.content.includes(marker));
const control = c => fetch(`${MOCK}/mock/control`, { method: 'POST', body: JSON.stringify(c) }).then(r => r.json());
const setSettings = patch => page.evaluate(p => { const c = SillyTavern.getContext(); Object.assign(c.extensionSettings.worldbook_switch_manager, p); c.saveSettingsDebounced(); }, patch);
const cc = patch => page.evaluate(p => Object.assign(SillyTavern.getContext().chatCompletionSettings, p), patch);
const newChat = async () => { await slash('/newchat'); await sleep(1500); };
const mem = () => page.evaluate(() => SillyTavern.getContext().chat.map(m => ({ u: !!m.is_user, sys: !!m.is_system, mes: m.mes.slice(0, 24), s: m.extra?.wsm?.s ?? null, d: m.extra?.wsm?.d ?? null, sid: m.swipe_id, si: m.swipe_info?.map(x => x.extra?.wsm?.d ?? null) })));
const dragonIn = d => !!d?.inj?.some(x => x.join() === 'WSMTest,0');
const dismiss = () => page.evaluate(() => document.querySelectorAll('dialog[open] .popup-button-ok, #dialogue_popup_ok').forEach(b => b.offsetParent && b.click()));
// Start an action without waiting for it, wait until the slow request is streaming, then press Stop.
async function startThenStop(start, { minReqs = 1, wait = 1500 } = {}) {
    const n0 = reqCount();
    await page.evaluate(start.fn, start.arg);
    const end = Date.now() + 20000;
    while (reqCount() - n0 < minReqs && Date.now() < end) await sleep(100);
    await sleep(wait);
    const generating = await page.evaluate(() => getComputedStyle(document.querySelector('#mes_stop')).display !== 'none');
    await page.evaluate(() => document.querySelector('#mes_stop').click());
    await idle(page); await sleep(800);
    return { reqs: reqsSince(n0), generating };
}
const typeAndSend = { fn: t => { const ta = document.querySelector('#send_textarea'); ta.value = t; ta.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#send_but').click(); } };
const sendText = t => ({ ...typeAndSend, arg: t });
const gen = type => ({ fn: t => { SillyTavern.getContext().generate(t); }, arg: type });
const swipeRight = { fn: () => document.querySelector('#chat .last_mes .swipe_right').click() };
async function run(action) { const n0 = reqCount(); await page.evaluate(action.fn, action.arg); await sleep(1200); await idle(page); await sleep(800); return reqsSince(n0); }
const say = t => run(sendText(t));

await setSettings({ enabled: true, automatic: true, delay: 0, cooldown: 1, includeConstant: false, aiTurns: false, selection: {} });
await openChar(page);
await cc({ n: 1 });

if (want('S1')) {
// S1 stream: stop mid-way, then Regenerate.
await cc({ stream_openai: true }); await newChat(); await control({ slow: 1 });
const st = await startThenStop(sendText('dragon s1'));
let M = await mem();
ok('S1.stopped_partial_has_no_record', st.generating && has(st.reqs[0]) && !M.at(-1).u && !M.at(-1).d && !(M.at(-1).si || []).some(Boolean), { st: st.generating, last: M.at(-1) });
const regen = await run(gen('regenerate'));
M = await mem();
ok('S1.regenerate_injects_and_records', has(regen.at(-1)) && dragonIn(M.at(-1).d) && M.at(-1).d.round === 1 && M.at(-1).si.filter(Boolean).length === 1 && M.at(-1).si.length === 1, { regen: regen.map(r => has(r)), last: M.at(-1) });
const next = await say('dragon s1 next');
M = await mem();
ok('S1.next_round_cooled', !has(next.at(-1)) && M.at(-2).s?.round === 2, { s: M.at(-2).s });
const rows = (await waitSaved(page, r => r.at(-1)?.extra?.wsm?.d)).filter(r => typeof r.mes === 'string');
ok('S1.saved_file_matches', rows.filter(r => r.extra?.wsm?.d && dragonIn(r.extra.wsm.d)).length === 1 && !rows.some(r => /^partial#/.test(r.mes)), rows.map(r => [r.is_user, r.mes.slice(0, 12), !!r.extra?.wsm?.d]));
}

if (want('S2')) {
// S2 stream: stop, swipe right for a new reply, then swipe back to the stopped one.
await cc({ stream_openai: true }); await newChat(); await control({ slow: 1 });
const st2 = await startThenStop(sendText('dragon s2'));
const sw = await run(swipeRight);
let M = await mem();
ok('S2.swipe_after_stop_records_only_new_swipe', st2.generating && has(sw.at(-1)) && M.at(-1).sid === 1 && !M.at(-1).si[0] && dragonIn(M.at(-1).si[1]) && dragonIn(M.at(-1).d), M.at(-1));
await page.evaluate(() => document.querySelector('#chat .last_mes .swipe_left').click()); await sleep(1500);
M = await mem();
ok('S2.back_on_stopped_swipe_not_injected', M.at(-1).sid === 0 && !M.at(-1).d, M.at(-1));
const next = await say('dragon s2 next');
M = await mem();
ok('S2.next_round_free_because_shown_reply_did_not_inject', has(next.at(-1)) && M.at(-2).s?.round === 2 && dragonIn(M.at(-1).d) && M.at(-1).d.round === 2, { s: M.at(-2).s, last: M.at(-1) });
}

if (want('S3')) {
// S3 stream: stop, then Continue to finish the partial reply.
await cc({ stream_openai: true }); await newChat(); await control({ slow: 1 });
const st3 = await startThenStop(sendText('dragon s3'));
const cont = await run(gen('continue'));
let M = await mem();
ok('S3.continue_completes_and_records', st3.generating && has(cont.at(-1)) && /^partial#/.test(M.at(-1).mes) && dragonIn(M.at(-1).d) && M.at(-1).d.round === 1, { cont: cont.map(r => has(r)), last: M.at(-1) });
const next = await say('dragon s3 next');
M = await mem();
ok('S3.next_round_cooled', !has(next.at(-1)) && M.at(-2).s?.round === 2, M.at(-2).s);
}

if (want('S4')) {
// S4 stream: stop, regenerate and stop again, then regenerate to completion.
await cc({ stream_openai: true }); await newChat(); await control({ slow: 2 });
const a = await startThenStop(sendText('dragon s4'));
const b = await startThenStop(gen('regenerate'));
let M = await mem();
ok('S4.two_stops_no_record', a.generating && b.generating && has(a.reqs[0]) && has(b.reqs.at(-1)) && !M.at(-1).d && M.filter(m => !m.u).length === 2, { a: a.generating, b: b.generating, M: M.slice(-2) });
const regen = await run(gen('regenerate'));
M = await mem();
ok('S4.final_regenerate_records', has(regen.at(-1)) && dragonIn(M.at(-1).d) && M.at(-1).d.round === 1 && M.at(-1).si.length === 1, M.at(-1));
const next = await say('dragon s4 next');
M = await mem();
ok('S4.next_round_cooled', !has(next.at(-1)) && M.at(-2).s?.round === 2, M.at(-2).s);
}

if (want('S5')) {
// S5 stream: stop, leave the partial reply in history and send a new message.
await cc({ stream_openai: true }); await newChat(); await control({ slow: 1 });
const st5 = await startThenStop(sendText('dragon s5'));
const r2 = await say('dragon s5 next');
let M = await mem();
ok('S5.partial_kept_without_record', st5.generating && /^partial#/.test(M.at(-3).mes) && !M.at(-3).d, M.at(-3));
ok('S5.new_message_is_round2_and_dragon_free', has(r2.at(-1)) && M.at(-2).s?.round === 2 && dragonIn(M.at(-1).d) && M.at(-1).d.round === 2, { s: M.at(-2).s, last: M.at(-1) });
const r3 = await say('dragon s5 third');
M = await mem();
ok('S5.round3_cooled', !has(r3.at(-1)) && M.at(-2).s?.round === 3, M.at(-2).s);
}

if (want('S6')) {
// S6 stream: a floor with a complete reply; start a new swipe, stop it, then go back to the old swipe.
await cc({ stream_openai: true }); await newChat();
const first = await say('dragon s6');
await control({ slow: 1 });
const st = await startThenStop(swipeRight);
let M = await mem();
ok('S6.stopped_swipe_has_no_record', has(first.at(-1)) && st.generating && M.at(-1).si.length === 2 && dragonIn(M.at(-1).si[0]) && !M.at(-1).si[1] && M.at(-1).sid === 1 && !M.at(-1).d, M.at(-1));
await page.evaluate(() => document.querySelector('#chat .last_mes .swipe_left').click()); await sleep(1500);
M = await mem();
ok('S6.old_swipe_record_back', M.at(-1).sid === 0 && dragonIn(M.at(-1).d) && M.at(-1).d.round === 1, M.at(-1));
const next = await say('dragon s6 next');
M = await mem();
ok('S6.next_round_cooled', !has(next.at(-1)) && M.at(-2).s?.round === 2, M.at(-2).s);
}

if (want('S7')) {
// S7 non-stream: stop while waiting for the response, then regenerate.
await cc({ stream_openai: false }); await newChat(); await control({ slow: 1 });
const st = await startThenStop(sendText('dragon s7'));
let M = await mem();
ok('S7.stopped_nonstream_no_record', st.generating && has(st.reqs[0]) && !M.some(m => m.d), M.slice(-2));
const regen = await run(gen('regenerate'));
M = await mem();
ok('S7.regenerate_records', has(regen.at(-1)) && !M.at(-1).u && dragonIn(M.at(-1).d) && M.at(-1).d.round === 1 && M.filter(m => m.u).length === 1, { regen: regen.length, M: M.slice(-2) });
const next = await say('dragon s7 next');
M = await mem();
ok('S7.next_round_cooled', !has(next.at(-1)) && M.at(-2).s?.round === 2, M.at(-2).s);
}

if (want('S8')) {
// S8 stream: tool call, stop during the tool follow-up, then regenerate.
await cc({ stream_openai: true });
await page.evaluate(() => SillyTavern.getContext().registerFunctionTool({ name: 'wsm_probe_tool', displayName: 'Probe', description: 'probe tool', parameters: { $schema: 'http://json-schema.org/draft-04/schema#', type: 'object', properties: {} }, action: async () => 'tool-ok', formatMessage: () => 'probe tool running' }));
await newChat(); await control({ slowFollow: 1 });
const st = await startThenStop(sendText('MOCKTOOL dragon s8'), { minReqs: 2, wait: 1500 });
let M = await mem();
ok('S8.stopped_tool_followup_no_record', st.generating && st.reqs.length >= 2 && has(st.reqs[0]) && !M.some(m => m.d), { gen: st.generating, n: st.reqs.length, M: M.slice(-3).map(m => [m.u, m.sys, m.mes, !!m.d]) });
const regen = await run(gen('regenerate')); await sleep(1500); await idle(page);
M = await mem();
const reply = M.at(-1);
ok('S8.regenerate_after_tool_stop_records_final_reply', has(regen[0]) && !reply.u && !reply.sys && dragonIn(reply.d) && reply.d.round === 1 && M.filter(m => m.d).length === 1, { regen: regen.map(r => has(r)), M: M.map(m => [m.u, m.sys, m.mes, m.d && m.d.round]) });
const next = await say('dragon s8 next');
M = await mem();
ok('S8.next_round_cooled', !has(next.at(-1)) && M.findLast(m => m.u).s?.round === 2, M.findLast(m => m.u).s);
await page.evaluate(() => SillyTavern.getContext().unregisterFunctionTool('wsm_probe_tool'));
}

await control({ slow: 0, slowFollow: 0 });
await cc({ stream_openai: true });
fs.writeFileSync(OUT, JSON.stringify({ host: 'SillyTavern 1.19.0', generatedAt: new Date().toISOString(), results }, null, 2));
console.log(`\n${results.filter(x => x.pass).length}/${results.length} passed`);
await browser.close();
process.exitCode = results.every(x => x.pass) && results.length ? 0 : 1;
