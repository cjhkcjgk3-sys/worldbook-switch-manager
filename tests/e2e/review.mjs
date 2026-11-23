// Reproductions for the external review of PR #1 (real SillyTavern 1.19 + mock backend).
import fs from 'node:fs';
import { launch, load, openChar, idle, send, sleep, readJsonl, currentChatFile, waitSaved } from './harness.mjs';
const LOG = process.env.MOCK_LOG || new URL('./mock-requests.jsonl', import.meta.url).pathname;
const OUT = process.env.REVIEW_OUT || new URL('../../docs/review-1.19-results.json', import.meta.url);
const results = [];
const want = n => !process.env.ONLY || process.env.ONLY.split(',').includes(n);
const ok = (name, pass, info) => { results.push({ name, pass: !!pass, info }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${pass ? '' : ' ' + JSON.stringify(info)?.slice(0, 700)}`); };
const { browser, page } = await launch();
const slash = cmd => page.evaluate(async c => { await SillyTavern.getContext().executeSlashCommandsWithOptions(c); }, cmd);
const lines = () => fs.readFileSync(LOG, 'utf8').trim().split('\n');
const lastReq = () => JSON.parse(lines().at(-1));
const has = (req, marker) => req.all.some(m => m.role === 'system' && m.content.includes(marker));
const DRAGON = 'WSM_DRAGON_LORE', CASTLE = 'WSM_CASTLE_LORE';
const setSettings = patch => page.evaluate(p => { const c = SillyTavern.getContext(); Object.assign(c.extensionSettings.worldbook_switch_manager, p); c.saveSettingsDebounced(); }, patch);
const cc = patch => page.evaluate(p => Object.assign(SillyTavern.getContext().chatCompletionSettings, p), patch);
const newChat = async () => { await slash('/newchat'); await sleep(1500); };
const say = async text => { await send(page, text); await sleep(800); return lastReq(); };
const mem = () => page.evaluate(() => SillyTavern.getContext().chat.map(m => ({ u: !!m.is_user, sys: !!m.is_system, mes: m.mes.slice(0, 40), s: m.extra?.wsm?.s ?? null, d: m.extra?.wsm?.d ?? null, sid: m.swipe_id, si: m.swipe_info?.map(x => x.extra?.wsm?.d ?? null) })));
const dismiss = () => page.evaluate(() => document.querySelectorAll('.popup-button-ok, #dialogue_popup_ok').forEach(b => b.offsetParent && b.click()));
async function openPanel() {
    await page.evaluate(() => document.querySelector('#extensionsMenuButton')?.click()); await sleep(300);
    await page.evaluate(() => document.querySelector('#worldbook_switch_manager_wand_button').click()); await sleep(1000);
}
const closePanel = async () => { await page.evaluate(() => document.querySelector('.popup #worldbook-switch-manager')?.closest('dialog')?.querySelector('.popup-button-ok')?.click()); await sleep(600); };
async function freeze(term, rounds) {
    await openPanel();
    await page.evaluate(({ term, rounds }) => {
        const r = document.querySelector('.popup #worldbook-switch-manager');
        const sel = r.querySelector('select[aria-label="选择用途"]'); sel.value = 'manual'; sel.dispatchEvent(new Event('change'));
        const search = r.querySelector('input[type=search]'); search.value = term; search.dispatchEvent(new Event('input'));
        [...r.querySelectorAll('button')].find(b => b.textContent === '全选搜索结果').click();
        const n = r.querySelector('.wsm-manual input[type=number]'); n.value = String(rounds); n.dispatchEvent(new Event('change'));
        [...r.querySelectorAll('button')].find(b => b.textContent === '冻结所选').click();
        sel.value = 'scope'; sel.dispatchEvent(new Event('change')); search.value = ''; search.dispatchEvent(new Event('input'));
    }, { term, rounds });
    await sleep(500); await closePanel();
}
const chatId = () => page.evaluate(() => SillyTavern.getContext().getCurrentChatId());
const openChat = f => page.evaluate(async f => { const s = await import('/script.js'); await s.openCharacterChat(f); }, f).then(() => sleep(2000));

await setSettings({ enabled: true, automatic: true, delay: 0, cooldown: 2, includeConstant: false, aiTurns: false, selection: {} });
await openChar(page);
await cc({ stream_openai: true, function_calling: true, n: 1 });

if (want('R1')) {
// R1 multi-swipe in one request (n=2)
for (const stream of [true, false]) {
    await cc({ stream_openai: stream, n: 2 }); await newChat();
    await say(`dragon multi ${stream}`);
    let M = await mem();
    ok(`R1.${stream ? 'stream' : 'nonstream'}.both_generated_swipes_recorded`, M.at(-1).si?.length === 2 && M.at(-1).si.every(d => d?.inj?.some(x => x.join() === 'WSMTest,0')), M.at(-1));
    await page.evaluate(() => document.querySelector('#chat .last_mes .swipe_right').click()); await sleep(1500); await idle(page);
    M = await mem();
    const selected = M.at(-1).sid;
    await cc({ n: 1 });
    ok(`R1.${stream ? 'stream' : 'nonstream'}.second_swipe_selected_next_cooled`, selected === 1 && M.at(-1).si.length === 2 && !has(await say('dragon after multi'), DRAGON), { selected, len: M.at(-1).si.length });
    await load(page); await openChar(page);
    M = await mem();
    ok(`R1.${stream ? 'stream' : 'nonstream'}.after_reload_records_kept`, M.at(-3)?.si?.every(d => d?.inj?.length), M.slice(-3));
}
await cc({ stream_openai: true, n: 1 });

}
if (want('R2')) {
// R2 failed request must not consume a cooldown round (cooldown 1)
await setSettings({ cooldown: 1 });
await newChat();
ok('R2.round1_injected', has(await say('dragon 1'), DRAGON));
await send(page, 'dragon MOCKFAIL 2'); await sleep(1500); await dismiss(); await idle(page);
ok('R2.new_message_after_failure_still_cooled', !has(await say('dragon 3'), DRAGON), (await mem()).slice(-3));
ok('R2.next_round_free', has(await say('dragon 4'), DRAGON));
await newChat();
await say('dragon 1');
await send(page, 'dragon MOCKFAIL 2'); await sleep(1500); await dismiss(); await idle(page);
await page.evaluate(() => { const c = SillyTavern.getContext(); c.chat.at(-1).mes = 'dragon retry 2'; });
await page.evaluate(() => SillyTavern.getContext().generate('normal')); await idle(page); await sleep(800);
ok('R2.retry_same_floor_still_cooled', !has(lastReq(), DRAGON), (await mem()).slice(-2));
ok('R2.retry_then_next_free', has(await say('dragon 3'), DRAGON));
await setSettings({ cooldown: 2 });

}
if (want('R3')) {
// R3 draft made after round 1 must not leak into a branch taken at the user floor of round 1
await newChat();
await say('x 1');
await freeze('castle', 2);
const main = await chatId();
await load(page); await openChar(page);
const rows = await waitSaved(page, r => r[0]?.chat_metadata?.wsm_draft);
ok('R3.draft_survives_reload', !!rows[0]?.chat_metadata?.wsm_draft);
await page.evaluate(async () => (await import('/scripts/bookmarks.js')).branchChat(1)); await sleep(2000);
ok('R3.branch_at_user_floor_ignores_later_draft', (await mem()).length === 2 && has(await say('castle in branch'), CASTLE), await mem());
await openChat(main);
ok('R3.main_still_frozen', !has(await say('castle main'), CASTLE));

}
if (want('R6')) {
// R6 aiTurns with a tool message between two AI replies
await setSettings({ aiTurns: true });
await page.evaluate(() => SillyTavern.getContext().registerFunctionTool({ name: 'wsm_probe_tool', displayName: 'Probe', description: 'probe tool', parameters: { $schema: 'http://json-schema.org/draft-04/schema#', type: 'object', properties: {} }, action: async () => 'tool-ok', formatMessage: () => 'probe tool running' }));
await newChat();
await say('dragon AITOOL 1');
await page.evaluate(() => SillyTavern.getContext().generate('normal')); await sleep(2500); await idle(page); await sleep(800);
await say('dragon after ai tool');
const M = await mem();
ok('R6.user_after_ai_tool_turn_is_round3', M.at(-2).s?.round === 3, M.map(m => [m.u, m.sys, m.s?.round, m.d?.round]));
await load(page); await openChar(page);
ok('R6.after_reload_round_kept', has(await say('dragon r4'), DRAGON), (await mem()).map(m => [m.u, m.sys, m.s?.round, m.d?.round]));
await setSettings({ aiTurns: false });

}
if (want('R4')) {
// R4 visible text + tool call, then the tool follow-up request fails
await page.evaluate(() => SillyTavern.getContext().registerFunctionTool({ name: 'wsm_probe_tool', displayName: 'Probe', description: 'probe tool', parameters: { $schema: 'http://json-schema.org/draft-04/schema#', type: 'object', properties: {} }, action: async () => 'tool-ok', formatMessage: () => 'probe tool running' }));
for (const stream of [true, false]) {
    await cc({ stream_openai: stream }); await newChat();
    await send(page, 'dragon MOCKTOOLTEXT FOLLOWFAIL'); await sleep(2500); await dismiss(); await idle(page); await sleep(800);
    const M = await mem();
    const textMsg = M.find(m => m.mes.startsWith('I will check'));
    const next = has(await say('dragon next'), DRAGON);
    ok(`R4.${stream ? 'stream' : 'nonstream'}.no_record_on_failed_tool_chain`, !textMsg?.d && next, { textMsgHasRecord: !!textMsg?.d?.inj?.length, nextDragonInjected: next, shape: M.map(m => [m.u, m.sys, m.mes.slice(0, 20), !!m.d]) });
}
await cc({ stream_openai: true });
await page.evaluate(() => SillyTavern.getContext().unregisterFunctionTool('wsm_probe_tool'));

}
if (want('R7')) {
// R7 clearing data when the chat save fails must not claim success
await newChat();
await say('dragon c1');
await page.route('**/api/chats/save', r => r.fulfill({ status: 503, body: 'unavailable' }));
await openPanel();
await page.evaluate(() => [...document.querySelectorAll('.popup #worldbook-switch-manager button')].find(b => b.textContent === '清除本聊天插件数据').click());
await sleep(800);
await page.evaluate(() => [...document.querySelectorAll('dialog.popup[open]')].at(-1).querySelector('.popup-button-ok').click());
await sleep(2500);
const notice = await page.evaluate(() => document.querySelector('#worldbook-switch-manager .wsm-notice[role=status]')?.textContent);
const disk = fs.readFileSync(await currentChatFile(page), 'utf8').includes('"wsm"');
ok('R7.save_failure_reported', disk && !/^已清除/.test(notice ?? '') && /保存/.test(notice ?? ''), { notice, disk });
await page.unroute('**/api/chats/save');
await closePanel();
await openPanel();
await page.evaluate(() => [...document.querySelectorAll('.popup #worldbook-switch-manager button')].find(b => b.textContent === '清除本聊天插件数据').click());
await sleep(800);
await page.evaluate(() => [...document.querySelectorAll('dialog.popup[open]')].at(-1).querySelector('.popup-button-ok').click());
await sleep(2500);
const notice2 = await page.evaluate(() => document.querySelector('#worldbook-switch-manager .wsm-notice[role=status]')?.textContent);
ok('R7.retry_after_recovery_saved', !fs.readFileSync(await currentChatFile(page), 'utf8').includes('"wsm"') && /已清除|没有插件记录/.test(notice2 ?? ''), notice2);
await closePanel();

}
if (want('R8')) {
// R8 clearing in a group chat reads the group chat file back to confirm the save.
await cc({ stream: true, n: 1 });
const gid = await page.evaluate(() => SillyTavern.getContext().groups.find(g => g.name === 'ProbeGroup')?.id);
await page.evaluate(async id => { const gc = await import('/scripts/group-chats.js'); await gc.openGroupById(id); }, gid); await sleep(2000);
await newChat();
await send(page, 'dragon group clear'); await sleep(2000); await idle(page); await sleep(1500);
const r = await page.evaluate(() => { const c = SillyTavern.getContext(); return { chatId: c.getCurrentChatId(), group: !!c.groupId, hadRecords: c.chat.some(m => m.extra?.wsm) }; });
await openPanel();
await page.evaluate(() => [...document.querySelectorAll('.popup #worldbook-switch-manager button')].find(b => b.textContent === '清除本聊天插件数据').click());
await sleep(800);
await page.evaluate(() => [...document.querySelectorAll('dialog.popup[open]')].at(-1).querySelector('.popup-button-ok').click());
await sleep(2500);
const notice = await page.evaluate(() => document.querySelector('#worldbook-switch-manager .wsm-notice[role=status]')?.textContent);
await closePanel();
const file = `${process.env.WSM_ST_DATA || '/workspace/st119-data/default-user'}/group chats/${r.chatId}.jsonl`;
const disk = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
ok('R8.group_clear_verified', r.group && r.hadRecords && /已确认保存/.test(notice ?? '') && disk && !disk.includes('"wsm"'), { r, notice, fileExists: !!disk });
}

fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log(`\n${results.filter(x => x.pass).length}/${results.length} passed`);
await browser.close();
process.exitCode = results.every(x => x.pass) ? 0 : 1;
