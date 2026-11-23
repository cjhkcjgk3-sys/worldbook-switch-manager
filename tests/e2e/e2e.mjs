// End-to-end checks of worldbook-switch-manager 1.3.0 on a real SillyTavern 1.19.0 + mock backend.
import fs from 'node:fs';
import { launch, load, openChar, idle, send, sleep, readJsonl, currentChatFile, waitSaved, DATA } from './harness.mjs';
const LOG = process.env.MOCK_LOG || new URL('./mock-requests.jsonl', import.meta.url).pathname;
const results = [];
const ok = (name, pass, info) => { results.push({ name, pass: !!pass, info }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${pass ? '' : ' ' + JSON.stringify(info)?.slice(0, 600)}`); };
const { browser, page } = await launch();
const slash = cmd => page.evaluate(async c => { await SillyTavern.getContext().executeSlashCommandsWithOptions(c); }, cmd);
const lastReq = () => { const l = fs.readFileSync(LOG, 'utf8').trim().split('\n'); return JSON.parse(l.at(-1)); };
const reqCount = () => fs.readFileSync(LOG, 'utf8').trim().split('\n').length;
const has = (req, marker) => req.all.some(m => m.role === 'system' && m.content.includes(marker));
const DRAGON = 'WSM_DRAGON_LORE', CASTLE = 'WSM_CASTLE_LORE', CONST = 'WSM_CONST_ALPHA';
async function setSettings(patch) {
    await page.evaluate(p => { const c = SillyTavern.getContext(); Object.assign(c.extensionSettings.worldbook_switch_manager, p); c.saveSettingsDebounced(); }, patch);
}
async function stream(on) { await page.evaluate(on => { SillyTavern.getContext().chatCompletionSettings.stream_openai = on; }, on); }
async function newChat() { await slash('/newchat'); await sleep(1500); }
async function say(text) { await send(page, text); await sleep(800); return lastReq(); }
async function seq(words) { const out = []; for (const w of words) out.push(has(await say(w), DRAGON)); return out; }
const mem = () => page.evaluate(() => SillyTavern.getContext().chat.map(m => ({ u: m.is_user, mes: m.mes.slice(0, 30), w: m.extra?.wsm ?? null, sid: m.swipe_id, si: m.swipe_info?.map(x => x.extra?.wsm ?? null) })));

await page.evaluate(() => { const c = SillyTavern.getContext(); if (c.mainApi !== 'openai') throw new Error('api'); });
const loaded = await page.evaluate(() => !!document.querySelector('#worldbook_switch_manager_storage #worldbook-switch-manager'));
ok('E0.extension_loaded', loaded);
await setSettings({ enabled: true, automatic: true, delay: 0, cooldown: 2, includeConstant: false, aiTurns: false, selection: {} });
await openChar(page);
await stream(true);

// E1 basic cooldown + storage
await newChat();
let r = await seq(['dragon 1', 'dragon 2', 'dragon 3', 'dragon 4']);
ok('E1.cooldown_pattern', r.join() === 'true,false,false,true', r);
ok('E1.constant_not_cooled', has(lastReq(), CONST));
let rows = await waitSaved(page, rows => rows.at(-1)?.extra?.wsm?.d);
ok('E1.saved_records', rows.at(-2).extra?.wsm?.s?.round === 4 && rows.at(-1).extra.wsm.d.inj.length === 1 && rows.at(-1).swipe_info?.[0]?.extra?.wsm?.d, rows.slice(-2).map(x => x.extra));

// E2 swipes: each swipe owns its outcome
await newChat();
await say('dragon a');
await setSettings({ automatic: false });
await page.evaluate(() => document.querySelector('#chat .last_mes .swipe_right').click()); await idle(page); await sleep(800);
await setSettings({ automatic: true });
let M = await mem();
ok('E2.new_swipe_round_start_state', has(lastReq(), DRAGON) && M.at(-1).si.length === 2 && M.at(-1).w?.d?.inj?.length === 0 && M.at(-1).si[0]?.d?.inj?.some(x => x.join() === 'WSMTest,0'), M.at(-1));
ok('E2.swipe1_shown_dragon_free', has(await say('dragon b'), DRAGON));
await slash('/cut 3-4'); await sleep(1000);
await page.evaluate(() => document.querySelector('#chat .last_mes .swipe_left').click()); await sleep(1200);
ok('E2.swipe0_shown_dragon_cooled', !has(await say('dragon b'), DRAGON));
await slash('/cut 3-4'); await sleep(1000);
await slash('/delswipe'); await sleep(1500);
M = await mem();
ok('E2.delswipe_remaining_shown', M.at(-1).si.length === 1 && M.at(-1).w?.d?.inj?.length === 0, M.at(-1));
ok('E2.after_delswipe_dragon_free', has(await say('dragon c'), DRAGON));

// E3 regenerate + continue (non-stream)
await stream(false);
await newChat();
await say('dragon r');
await page.evaluate(() => SillyTavern.getContext().generate('regenerate')); await idle(page); await sleep(800);
ok('E3.regenerate_same_round', has(lastReq(), DRAGON));
await page.evaluate(() => SillyTavern.getContext().generate('continue')); await idle(page); await sleep(800);
M = await mem();
ok('E3.continue_keeps_record', M.at(-1).w?.d?.round === 1 && M.at(-1).w.d.inj.some(x => x.join() === 'WSMTest,0'), M.at(-1));
ok('E3.next_round_cooled', !has(await say('dragon next'), DRAGON));
await stream(true);

// E5 rollback 20 floors -> 16 ; E6 middle delete
await newChat();
r = await seq(Array.from({ length: 10 }, (_, i) => `dragon ${i + 1}`));
ok('E5.ten_rounds', r.join() === 'true,false,false,true,false,false,true,false,false,true', r);
const main = await page.evaluate(() => SillyTavern.getContext().getCurrentChatId());
await slash('/cut 17-20'); await sleep(1200);
ok('E5.rollback_to_16_round9_cooled', !has(await say('dragon 9b'), DRAGON));
ok('E5.round10_free', has(await say('dragon 10b'), DRAGON));
await slash('/cut 16-20'); await sleep(1200); // leaves user floor 15 (round 8) unanswered
await page.evaluate(() => SillyTavern.getContext().generate('normal')); await idle(page); await sleep(800);
ok('E5.unanswered_user_round8_cooled', !has(lastReq(), DRAGON));
await slash('/cut 3'); await sleep(1200); // middle delete
ok('E6.middle_delete_no_effect', !has(await say('dragon 9c'), DRAGON) && has(await say('dragon 10c'), DRAGON));

// E7 branch and checkpoint
const before = (await mem()).length;
await page.evaluate(async () => (await import('/scripts/bookmarks.js')).branchChat(2)); await sleep(2000);
M = await mem();
ok('E7.branch_opened', M.length === 3, M.length);
ok('E7.branch_round2_cooled', !has(await say('dragon b2'), DRAGON));
ok('E7.branch_round3_cooled', !has(await say('dragon b3'), DRAGON));
ok('E7.branch_round4_free', has(await say('dragon b4'), DRAGON));
await page.evaluate(async f => { const s = await import('/script.js'); await s.openCharacterChat(f); }, main); await sleep(2000);
M = await mem();
ok('E7.back_to_main', M.length === before, [M.length, before]);
ok('E7.main_state_kept', !has(await say('dragon m'), DRAGON)); // round 10c was a fresh cycle
await newChat();
r = await seq(['dragon k1', 'dragon k2', 'dragon k3']);
const cp = await page.evaluate(async () => (await import('/scripts/bookmarks.js')).createNewBookmark(2, { forceName: 'wsm-e2e-checkpoint-' + Date.now() }));
ok('E7.checkpoint_created', !!cp, cp);
await page.evaluate(async f => { const s = await import('/script.js'); await s.openCharacterChat(f); }, cp); await sleep(2000);
ok('E7.checkpoint_round2_cooled', (await mem()).length === 3 && !has(await say('dragon cp2'), DRAGON));
ok('E7.checkpoint_round3_cooled', !has(await say('dragon cp3'), DRAGON));
ok('E7.checkpoint_round4_free', has(await say('dragon cp4'), DRAGON));

// E8 refresh
await newChat();
await say('dragon f1');
await load(page); await openChar(page); await sleep(1000);
ok('E8.after_reload_cooled', !has(await say('dragon f2'), DRAGON));

// E9 stop and failure
await newChat();
await page.evaluate(() => { const ta = document.querySelector('#send_textarea'); ta.value = 'dragon MOCKSLOW'; ta.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#send_but').click(); });
await sleep(1500); await page.evaluate(() => document.querySelector('#mes_stop').click()); await idle(page); await sleep(800);
M = await mem();
ok('E9.stopped_no_record', M.at(-1).u === false && M.at(-1).w === null && M.at(-2).w === null, M.slice(-2));
ok('E9.after_stop_free', has(await say('dragon after stop'), DRAGON));
await newChat();
let n0 = reqCount();
await send(page, 'dragon MOCKFAIL'); await sleep(1500); await page.evaluate(() => document.querySelector('.popup-button-ok, #dialogue_popup_ok')?.click()); await idle(page);
M = await mem();
ok('E9.failed_no_record', reqCount() > n0 && M.every(m => !m.w), M);
ok('E9.after_fail_free', has(await say('dragon after fail'), DRAGON));
// failed swipe keeps the shown swipe record
await page.evaluate(() => { const c = SillyTavern.getContext(); c.chat.at(-2).mes = 'MOCKFAIL dragon'; });
await page.evaluate(() => document.querySelector('#chat .last_mes .swipe_right').click()); await sleep(2000); await page.evaluate(() => document.querySelector('.popup-button-ok, #dialogue_popup_ok')?.click()); await idle(page);
M = await mem();
ok('E9.failed_swipe_restores', M.at(-1).si.length === 1 && M.at(-1).w?.d?.inj?.some(x => x.join() === 'WSMTest,0'), M.at(-1));

// E10 tool call continuation
await page.evaluate(() => SillyTavern.getContext().registerFunctionTool({ name: 'wsm_probe_tool', displayName: 'Probe', description: 'probe tool', parameters: { $schema: 'http://json-schema.org/draft-04/schema#', type: 'object', properties: {} }, action: async () => 'tool-ok', formatMessage: () => 'probe tool running' }));
for (const s of [true, false]) {
    await stream(s); await newChat();
    await send(page, `MOCKTOOL dragon ${s}`); await sleep(2500); await idle(page);
    M = await mem();
    ok(`E10.tool_${s ? 'stream' : 'nonstream'}_record`, M.at(-1).w?.d?.inj?.some(x => x[1] === '0'), M.slice(-3));
    ok(`E10.tool_${s ? 'stream' : 'nonstream'}_next_cooled`, !has(await say('dragon after tool'), DRAGON));
}
await page.evaluate(() => SillyTavern.getContext().unregisterFunctionTool('wsm_probe_tool'));
await stream(true);

// E11 constant toggle and aiTurns
await newChat();
await setSettings({ includeConstant: true });
await say('x c1');
ok('E11.constant_cooled_when_enabled', !has(await say('x c2'), CONST));
await setSettings({ includeConstant: false });
ok('E11.constant_back_when_disabled', has(await say('x c3'), CONST));
await newChat();
await say('dragon ai');
await page.evaluate(() => SillyTavern.getContext().generate('normal')); await idle(page); await sleep(800);
ok('E11.ai_continuous_same_round', !has(await say('dragon r2'), DRAGON) && !has(await say('dragon r3'), DRAGON));
await setSettings({ aiTurns: true });
await newChat();
await say('dragon ai1');
await page.evaluate(() => SillyTavern.getContext().generate('normal')); await idle(page); await sleep(800);
ok('E11.aiTurns_counts_ai_reply', !has(lastReq(), DRAGON) && !has(await say('dragon ai3'), DRAGON) && has(await say('dragon ai4'), DRAGON));
await setSettings({ aiTurns: false });

// E12 manual freeze via panel + clear data
await newChat();
await say('x m1');
await page.evaluate(() => document.querySelector('#extensionsMenuButton')?.click()); await sleep(400);
await page.evaluate(() => document.querySelector('#worldbook_switch_manager_wand_button').click());
await sleep(1200);
const panel = await page.evaluate(() => { const r = document.querySelector('.popup #worldbook-switch-manager'); return r ? { title: r.querySelector('summary').textContent, text: r.innerText.slice(0, 2000) } : null; });
ok('E12.panel_opens_title_version', panel && panel.title === '世界书自动开关管理器' && panel.text.includes('版本 1.3.0') && panel.text.includes('酒馆 1.19.0') && panel.text.includes('下一回合：第 2 回合'), panel);
await page.evaluate(async () => {
    const r = document.querySelector('.popup #worldbook-switch-manager');
    const sel = r.querySelector('select[aria-label="选择用途"]'); sel.value = 'manual'; sel.dispatchEvent(new Event('change'));
    const search = r.querySelector('input[type=search]'); search.value = 'castle'; search.dispatchEvent(new Event('input'));
    [...r.querySelectorAll('button')].find(b => b.textContent === '全选搜索结果').click();
    const rounds = [...r.querySelectorAll('.wsm-manual input[type=number]')][0]; rounds.value = '2'; rounds.dispatchEvent(new Event('change'));
    [...r.querySelectorAll('button')].find(b => b.textContent === '冻结所选').click();
});
await sleep(800);
const status = await page.evaluate(() => document.querySelector('.popup #worldbook-switch-manager .wsm-entry-status')?.textContent);
ok('E12.panel_shows_manual', /手动冻结剩余 2 回合/.test(status ?? ''), status);
await page.evaluate(() => document.querySelector('.popup .popup-button-ok')?.click()); await sleep(800);
rows = await waitSaved(page, rows => rows[0]?.chat_metadata?.wsm_draft);
ok('E12.draft_saved', !!rows[0]?.chat_metadata?.wsm_draft, rows[0]?.chat_metadata);
ok('E12.freeze_round2', !has(await say('castle m2'), CASTLE));
rows = await waitSaved(page, rows => !rows[0]?.chat_metadata?.wsm_draft);
ok('E12.draft_committed', !rows[0]?.chat_metadata?.wsm_draft && Object.keys(rows.at(-2).extra?.wsm?.s?.manual ?? {}).length === 1, rows.at(-2).extra);
ok('E12.freeze_round3', !has(await say('castle m3'), CASTLE));
ok('E12.freeze_over_round4', has(await say('castle m4'), CASTLE));
// clear data
await page.evaluate(() => document.querySelector('#extensionsMenuButton')?.click()); await sleep(400);
await page.evaluate(() => document.querySelector('#worldbook_switch_manager_wand_button').click());
await sleep(1000);
await page.evaluate(() => [...document.querySelectorAll('.popup #worldbook-switch-manager button')].find(b => b.textContent === '清除本聊天插件数据').click());
await sleep(800);
await page.evaluate(() => { const pops = [...document.querySelectorAll('dialog.popup[open]')]; pops.at(-1).querySelector('.popup-button-ok').click(); });
await sleep(1500);
await page.evaluate(() => { const pops = [...document.querySelectorAll('dialog.popup[open]')]; pops.at(-1)?.querySelector('.popup-button-ok')?.click(); });
rows = await waitSaved(page, rows => !JSON.stringify(rows).includes('"wsm"'));
ok('E12.clear_data_saved', !JSON.stringify(rows).includes('"wsm"'));
ok('E12.after_clear_castle_free', has(await say('castle m5'), CASTLE));

// E13 group chat (stream)
const gid = await page.evaluate(() => SillyTavern.getContext().groups.find(g => g.name === 'ProbeGroup')?.id);
await page.evaluate(async id => { const gc = await import('/scripts/group-chats.js'); await gc.openGroupById(id); }, gid); await sleep(2000);
await slash('/newchat'); await sleep(1500);
n0 = reqCount();
await send(page, 'dragon group'); await sleep(2000); await idle(page);
M = await mem();
const replies = M.filter(m => !m.u && m.w?.d);
ok('E13.group_members_recorded', replies.length >= 2 && replies.every(m => m.w.d.round === 1), M);
n0 = reqCount();
await send(page, 'dragon group 2'); await sleep(2000); await idle(page);
const reqs = fs.readFileSync(LOG, 'utf8').trim().split('\n').slice(n0).map(JSON.parse);
ok('E13.group_next_round_cooled', reqs.length >= 2 && reqs.every(q => !has(q, DRAGON)), reqs.length);

fs.writeFileSync(new URL('../../docs/e2e-1.19-results.json', import.meta.url), JSON.stringify(results, null, 2));
console.log(`\n${results.filter(x => x.pass).length}/${results.length} passed`);
await browser.close();
