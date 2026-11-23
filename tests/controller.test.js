import test from 'node:test';
import assert from 'node:assert/strict';
import { preflight } from '../controller.js';
import { entryKey } from '../core.js';
import { DRAFT, readStart, readDelta } from '../timeline.js';
import { FakeST } from './sim.js';

const DRAGON = 1, CONST = 2, CASTLE = 3;
const injected = r => (r.active ?? []).map(e => e.uid);
async function round(st, text, opts) { await st.user(text); return st.generate('normal', opts); }
const snapshot = st => [DRAGON, CONST, CASTLE].map(uid => st.status(uid));

test('basic cycle: injected entry is filtered for the cooldown rounds, then returns', async () => {
    const st = new FakeST();
    assert.deepEqual(injected(await round(st, 'a dragon')), [DRAGON, CONST]);
    assert.equal(st.status(DRAGON).cooldown, 2);
    assert.deepEqual(injected(await round(st, 'dragon again')), [CONST]);
    assert.deepEqual(injected(await round(st, 'dragon again')), [CONST]);
    assert.deepEqual(injected(await round(st, 'dragon again')), [DRAGON, CONST]);
});
test('records live on the anchor and the reply, inside the active swipe, and survive save/reload', async () => {
    const st = new FakeST();
    await round(st, 'dragon');
    const [u, r] = st.chat.slice(-2);
    assert.equal(readStart(u).round, 1);
    assert.deepEqual(readDelta(r).inj, [['book', '1']]);
    assert.deepEqual(r.swipe_info[0].extra.wsm, r.extra.wsm);
    await st.reload();
    assert.equal(st.status(DRAGON).cooldown, 2);
    assert.equal(st.blocked(DRAGON), true);
});
test('constant (blue) entries are not cooled by default; opt-in cools them', async () => {
    const st = new FakeST();
    await round(st, 'x');
    assert.equal(st.status(CONST).cooldown, 0);
    st.manager.updateSettings({ includeConstant: true });
    await round(st, 'x');
    assert.equal(st.status(CONST).cooldown, 2);
    assert.equal(st.blocked(CONST), true);
});
test('swipes: each swipe keeps its own outcome; switching swipes switches the state', async () => {
    const st = new FakeST();
    await round(st, 'dragon');
    const r = await st.generate('swipe', { scanText: 'castle' });
    assert.deepEqual(injected(r), [CONST, CASTLE], 'swipe uses the round-start state, not the previous swipe');
    assert.equal(st.status(CASTLE).cooldown, 2); assert.equal(st.status(DRAGON).cooldown, 0);
    await st.swipeTo(0);
    assert.equal(st.status(DRAGON).cooldown, 2); assert.equal(st.status(CASTLE).cooldown, 0);
    await st.swipeTo(1);
    assert.equal(st.status(CASTLE).cooldown, 2);
    await st.reload();
    assert.equal(st.status(CASTLE).cooldown, 2);
});
test('swipe of a later round still sees cooldowns from earlier rounds', async () => {
    const st = new FakeST();
    await round(st, 'dragon');
    await round(st, 'dragon castle');
    const r = await st.generate('swipe');
    assert.deepEqual(injected(r), [CONST, CASTLE]);
});
test('failed swipe restores the previous swipe and its record; streaming new swipe works', async () => {
    const st = new FakeST();
    await round(st, 'dragon');
    await st.generate('swipe', { fail: true, scanText: 'castle' });
    assert.equal(st.status(DRAGON).cooldown, 2);
    await st.generate('swipe', { stream: true, scanText: 'castle' });
    assert.equal(st.status(CASTLE).cooldown, 2); assert.equal(st.status(DRAGON).cooldown, 0);
});
test('deleting the shown swipe shows the remaining swipe state', async () => {
    const st = new FakeST();
    await round(st, 'dragon');
    await st.generate('swipe', { scanText: 'castle' });
    await st.deleteSwipe();
    assert.equal(st.status(DRAGON).cooldown, 2); assert.equal(st.status(CASTLE).cooldown, 0);
});
test('regenerate replaces the reply and its outcome', async () => {
    const st = new FakeST();
    await round(st, 'dragon');
    await st.generate('regenerate', { scanText: 'castle' });
    assert.equal(st.status(DRAGON).cooldown, 0); assert.equal(st.status(CASTLE).cooldown, 2);
    assert.equal(readStart(st.chat.at(-2)).round, 1);
});
test('continue merges with the outcome of the reply it continues', async () => {
    const st = new FakeST();
    await round(st, 'dragon');
    await st.generate('continue', { scanText: 'castle', text: ' more' });
    assert.equal(st.status(DRAGON).cooldown, 2); assert.equal(st.status(CASTLE).cooldown, 2);
});
test('rollback: 20 floors, go back to floor 16 and delete the rest = state of floor 16', async () => {
    const st = new FakeST();
    const seen = [];
    const words = ['dragon', 'castle', 'x', 'dragon castle', 'x', 'dragon', 'castle', 'x', 'dragon', 'x'];
    for (const w of words) { await round(st, w); seen.push({ len: st.chat.length, status: snapshot(st) }); }
    assert.equal(st.chat.length, 21); // greeting + 20 floors
    const at16 = seen.find(s => s.len === 17);
    await st.truncate(17);
    assert.deepEqual(snapshot(st), at16.status);
    await st.reload();
    assert.deepEqual(snapshot(st), at16.status);
    // Rolling back to an unanswered user message: that round is replayed.
    await st.truncate(16);
    const r = await st.generate('normal');
    assert.equal(readDelta(st.chat.at(-1)).round, readStart(st.chat.at(-2)).round);
    assert.ok(injected(r));
});
test('deleting a middle floor never rewrites the present', async () => {
    const st = new FakeST();
    await round(st, 'dragon'); await round(st, 'castle'); await round(st, 'x');
    const before = snapshot(st);
    await st.deleteAt(2);
    assert.deepEqual(snapshot(st), before);
});
test('branch and checkpoint copy the timeline; branches evolve independently', async () => {
    const st = new FakeST();
    await round(st, 'dragon');
    const at2 = snapshot(st);
    await round(st, 'castle'); await round(st, 'x');
    const main = st.chatId, mainState = snapshot(st);
    await st.branch(2);
    assert.deepEqual(snapshot(st), at2);
    await round(st, 'castle'); // round 2 in the branch
    assert.equal(st.status(CASTLE).cooldown, 2);
    await st.open(main);
    assert.deepEqual(snapshot(st), mainState);
});
test('branch from a non-first swipe uses that swipe', async () => {
    const st = new FakeST();
    await round(st, 'dragon');
    await st.generate('swipe', { scanText: 'castle' });
    await st.branch(st.chat.length - 1);
    assert.equal(st.status(CASTLE).cooldown, 2); assert.equal(st.status(DRAGON).cooldown, 0);
});
test('stopped and failed generations leave no record and do not count', async () => {
    const st = new FakeST();
    await st.user('dragon');
    await st.generate('normal', { stream: true, stop: true });
    assert.equal(readDelta(st.chat.at(-1)), null);
    assert.equal(st.status(DRAGON).cooldown, 0);
    await st.truncate(st.chat.length - 1);
    await st.generate('normal', { fail: true });
    assert.equal(st.status(DRAGON).cooldown, 0);
    assert.equal(st.manager.view.round, 1, 'unanswered user message is still the next round');
    await st.generate('normal', { stream: true });
    assert.equal(st.status(DRAGON).cooldown, 2);
});
test('tool-call continuation keeps the first request evidence (stream and non-stream)', async () => {
    for (const stream of [true, false]) {
        const st = new FakeST();
        await st.user('dragon');
        await st.generate('normal', { tool: true, stream });
        assert.deepEqual(readDelta(st.chat.at(-1)).inj, [['book', '1']], `stream=${stream}`);
        assert.equal(st.status(DRAGON).cooldown, 2);
    }
});
test('quiet request inside another listener of MESSAGE_RECEIVED does not break commit', async () => {
    for (const stream of [true, false]) {
        const st = new FakeST();
        await st.user('dragon');
        await st.generate('normal', { stream, quietInside: true });
        assert.equal(st.status(DRAGON).cooldown, 2, `stream=${stream}`);
        assert.equal(st.status(CASTLE).cooldown, 0, 'quiet payload never counts');
    }
});
test('Text Completion: overlapping side request taints the round instead of guessing', async () => {
    const st = new FakeST();
    st.mainApi = 'textgenerationwebui';
    await st.user('dragon');
    await st.generate('normal', { quietInside: true });
    assert.equal(st.status(DRAGON).cooldown, 0);
    assert.match(st.manager.evidenceWarning, /后台请求/);
    await round(st, 'dragon');
    assert.equal(st.status(DRAGON).cooldown, 2);
});
test('dry runs and standalone quiet/impersonate never count', async () => {
    const st = new FakeST();
    await st.user('dragon');
    await st.emit('GENERATION_STARTED', 'normal', {}, true);
    await st.quiet();
    await st.emit('GENERATION_STARTED', 'impersonate', {}, false);
    await st.emit('GENERATION_ENDED');
    assert.equal(st.status(DRAGON).cooldown, 0);
    assert.equal(st.manager.pending, null);
});
test('hidden user messages still open a round', async () => {
    const st = new FakeST();
    await round(st, 'dragon');
    await st.user('hidden', { hidden: true });
    await st.generate('normal');
    assert.equal(st.status(DRAGON).cooldown, 1);
});
test('AI continuous replies: same round by default, a new round with aiTurns', async () => {
    const st = new FakeST();
    await round(st, 'dragon');
    await st.generate('normal', { scanText: 'castle' });
    assert.equal(st.status(DRAGON).cooldown, 2); assert.equal(st.status(CASTLE).cooldown, 2);
    const on = new FakeST({ aiTurns: true });
    await round(on, 'dragon');
    await on.generate('normal', { scanText: 'castle' });
    assert.equal(on.status(DRAGON).cooldown, 1); assert.equal(on.status(CASTLE).cooldown, 2);
    await on.reload();
    assert.equal(on.status(DRAGON).cooldown, 1);
});
test('group chat: several members answering one message share the round', async () => {
    const st = new FakeST();
    await st.user('dragon');
    await st.emit('GENERATION_STARTED', 'normal', {}, false); // outer group start
    await st.generate('normal');
    await st.generate('normal', { scanText: 'castle' });
    assert.equal(st.status(DRAGON).cooldown, 2); assert.equal(st.status(CASTLE).cooldown, 2);
    assert.equal(readStart(st.chat.at(-3)).round, 1);
});
test('manual freeze is a draft until the next reply, then follows the timeline', async () => {
    const st = new FakeST();
    await round(st, 'x');
    const key = entryKey('book', CASTLE);
    assert.equal(st.manager.manualFreeze([key], 2), true);
    assert.deepEqual(st.chatMetadata[DRAFT].ops[key], [2, 3]);
    assert.equal(st.status(CASTLE).manual, 2);
    await st.reload();
    assert.equal(st.status(CASTLE).manual, 2, 'draft is saved with the chat metadata');
    assert.deepEqual(injected(await round(st, 'castle')), [CONST]);
    assert.equal(st.chatMetadata[DRAFT], undefined, 'draft committed into the round start');
    assert.ok(readStart(st.chat.at(-2)).manual[key]);
    assert.equal(st.status(CASTLE).manual, 1);
    await round(st, 'castle');
    assert.deepEqual(injected(await round(st, 'castle')), [CONST, CASTLE]);
    // Roll back before the round that carried the freeze: it is gone.
    await st.truncate(3);
    assert.equal(st.status(CASTLE).manual, 0);
});
test('a draft copied into a branch from another point is ignored there', async () => {
    const st = new FakeST();
    await round(st, 'x'); await round(st, 'x');
    st.manager.manualFreeze([entryKey('book', CASTLE)], 3);
    await st.branch(2);
    assert.equal(st.status(CASTLE).manual, 0);
    await round(st, 'castle');
    assert.equal(st.status(CASTLE).cooldown, 2);
});
test('unfreeze removes a committed freeze from the next round on', async () => {
    const st = new FakeST();
    const key = entryKey('book', CASTLE);
    st.manager.manualFreeze([key], 5);
    await round(st, 'castle');
    assert.equal(st.status(CASTLE).manual, 4);
    st.manager.manualUnfreeze([key]);
    assert.equal(st.status(CASTLE).manual, 0);
    assert.deepEqual(injected(await round(st, 'castle')), [CONST, CASTLE]);
});
test('freezing is refused while a generation is running', async () => {
    const st = new FakeST();
    await st.user('x');
    await st.emit('GENERATION_STARTED', 'normal', {}, false);
    assert.equal(st.manager.busy, true);
    assert.equal(st.manager.manualFreeze([entryKey('book', 1)], 2), false);
});
test('paused manager neither filters nor writes; automatic off keeps manual freezes', async () => {
    const st = new FakeST();
    st.manager.updateSettings({ enabled: false });
    await round(st, 'dragon');
    assert.equal(st.chat.at(-1).extra.wsm, undefined);
    st.manager.updateSettings({ enabled: true, automatic: false });
    st.manager.manualFreeze([entryKey('book', CASTLE)], 1);
    assert.deepEqual(injected(await round(st, 'dragon castle')), [DRAGON, CONST]);
    assert.equal(st.status(DRAGON).cooldown, 0);
});
test('clearing the chat data removes every record and the draft', async () => {
    const st = new FakeST();
    await round(st, 'dragon'); await st.generate('swipe');
    st.manager.manualFreeze([entryKey('book', CASTLE)], 1);
    assert.ok((await st.manager.clearChatData()).removed > 0);
    assert.equal(JSON.stringify(st.chat).includes('"wsm"'), false);
    assert.equal(st.chatMetadata[DRAFT], undefined);
    assert.equal(st.status(DRAGON).cooldown, 0);
});
test('legacy chats without records start counting from their existing rounds', async () => {
    const st = new FakeST();
    for (let i = 0; i < 3; i++) st.chat.push({ is_user: true, mes: 'old' }, { is_user: false, mes: 'old reply', swipes: ['old reply'], swipe_id: 0, swipe_info: [{}] });
    await round(st, 'dragon');
    assert.equal(readStart(st.chat.at(-2)).round, 4);
    assert.equal(st.status(DRAGON).cooldown, 2);
});
test('switching chats mid-generation never writes into the other chat', async () => {
    const st = new FakeST();
    await st.user('dragon');
    await st.emit('GENERATION_STARTED', 'normal', {}, false);
    await st.emit('WORLDINFO_ENTRIES_LOADED', { globalLore: [] });
    st.chatId = 'other'; st.chat = [{ is_user: true, mes: 'u', extra: {} }, { is_user: false, mes: 'r', extra: {} }];
    await st.emit('CHAT_CHANGED');
    await st.emit('MESSAGE_RECEIVED', 1, 'normal');
    assert.equal(st.chat[1].extra.wsm, undefined);
});
test('editing a message keeps the records', async () => {
    const st = new FakeST();
    await round(st, 'dragon');
    st.chat.at(-2).mes = 'edited'; await st.emit('MESSAGE_EDITED', st.chat.length - 2);
    assert.equal(st.status(DRAGON).cooldown, 2);
});
test('book names that are Object.prototype keys stay plain data', async () => {
    const st = new FakeST();
    st.entries = [{ world: 'toString', uid: 1, key: ['dragon'], content: 'TOSTRING_LORE', position: 0 }, { world: '__proto__', uid: 1, key: ['dragon'], content: 'PROTO_LORE', position: 0 }];
    st.settings.selection = { toString: '*' };
    st.manager.updateSettings({ selection: { toString: '*' } });
    await round(st, 'dragon');
    assert.equal(st.status(1).cooldown, 2);
    assert.equal(st.manager.entryStatus(st.entries[1]).cooldown, 0);
});
test('missing capability blocks startup and stop removes every event subscription', async () => {
    const st = new FakeST();
    assert.ok(preflight({ ...st.ctx, eventTypes: {} }, st.manager.adapter).includes('WORLDINFO_ENTRIES_LOADED'));
    st.manager.stop();
    assert.equal([...st.events.events.values()].flat().length, 0);
});
test('async book loads from an old chat cannot overwrite the current list', async () => {
    const st = new FakeST();
    await st.manager.refresh();
    let release;
    st.manager.adapter.list = () => new Promise(resolve => { release = resolve; });
    const oldLoad = st.manager.refresh();
    await Promise.resolve();
    st.chatId = 'B';
    st.manager.adapter.list = async () => ({ books: ['B'], entries: [] });
    await st.manager.refresh();
    release({ books: ['A'], entries: [] }); await oldLoad;
    assert.deepEqual(st.manager.bookNames, ['B']);
});
test('chat-completion payload must keep the entry after final transformations', async () => {
    const st = new FakeST();
    await st.user('dragon');
    await st.emit('GENERATION_STARTED', 'normal', {}, false);
    const payload = { globalLore: structuredClone(st.entries) };
    await st.emit('WORLDINFO_ENTRIES_LOADED', payload);
    await st.emit('WORLD_INFO_ACTIVATED', payload.globalLore.filter(e => e.uid === DRAGON));
    await st.emit('GENERATE_AFTER_DATA', { prompt: 'DRAGON_LORE dragons breathe fire' }, false);
    await st.emit('CHAT_COMPLETION_SETTINGS_READY', { messages: [{ role: 'system', content: 'stripped' }], type: 'normal' });
    st.chat.push({ is_user: false, mes: 'r', swipes: ['r'], swipe_id: 0, swipe_info: [{}], extra: {} });
    await st.emit('MESSAGE_RECEIVED', st.chat.length - 1, 'normal');
    assert.equal(st.status(DRAGON).cooldown, 0);
});

test('green cap + timeline cooldown staggers activations and skips recording capped entries', async () => {
    const st = new FakeST({ capEnabled: true, capLimit: 3, delay: 0, cooldown: 1 });
    st.entries = [
        { world: 'book', uid: 1, key: ['甲'], content: 'LORE_1', position: 0 },
        { world: 'book', uid: 2, key: ['乙'], content: 'LORE_2', position: 0 },
        { world: 'book', uid: 3, key: ['丙'], content: 'LORE_3', position: 0 },
        { world: 'book', uid: 4, key: ['丁'], content: 'LORE_4', position: 0 },
        { world: 'book', uid: 5, key: ['戊'], content: 'LORE_5', position: 0 },
        { world: 'book', uid: 6, key: ['己'], content: 'LORE_6', position: 0 },
    ];
    await st.user('甲 乙 丙');
    await st.generate('normal', { text: '甲 乙 丙', scanText: '甲 乙 丙' });
    // Round 2: user mentions 丁 戊 己 while prior AI reply mentioned 甲 乙 丙 (now in cooldown or Tier 2)
    const r2 = await round(st, '丁 戊 己', { scanText: '甲 乙 丙 丁 戊 己' });
    assert.deepEqual(injected(r2), [4, 5, 6]);
    assert.equal(st.manager.lastCapSkipped, 0);

    // Round 3: 4/5/6 are in cooldown; user mentions 甲 乙 丙 plus extra green entries
    st.entries.push(
        { world: 'book', uid: 7, key: ['庚'], content: 'LORE_7', position: 0 },
        { world: 'book', uid: 8, key: ['辛'], content: 'LORE_8', position: 0 },
    );
    const r3 = await round(st, '甲 乙 丙 庚 辛', { scanText: '甲 乙 丙 丁 戊 己 庚 辛' });
    assert.deepEqual(injected(r3), [1, 2, 3]);
    assert.equal(st.manager.lastCapSkipped, 2);
    assert.deepEqual(readDelta(st.chat.at(-1)).inj, [['book', '1'], ['book', '2'], ['book', '3']]);
    assert.equal(st.status(7).cooldown, 0, 'capped entries are not recorded or cooled');
    assert.equal(st.status(8).cooldown, 0);

    // Round 4: 1/2/3 enter cooldown, capped 7 & 8 activate naturally
    const r4 = await round(st, '继续看庚和辛', { scanText: '甲 乙 丙 庚 辛' });
    assert.deepEqual(injected(r4), [7, 8]);
    assert.equal(st.manager.lastCapSkipped, 0);
});

test('green cap preserves consistency across timeline rollback and branching', async () => {
    const st = new FakeST({ capEnabled: true, capLimit: 2, delay: 0, cooldown: 2 });
    st.entries = [
        { world: 'book', uid: 1, key: ['k1'], content: 'LORE_1', position: 0 },
        { world: 'book', uid: 2, key: ['k2'], content: 'LORE_2', position: 0 },
        { world: 'book', uid: 3, key: ['k3'], content: 'LORE_3', position: 0 },
    ];
    const r1 = await round(st, 'k1 k2 k3', { scanText: 'k1 k2 k3' });
    assert.deepEqual(injected(r1), [1, 2]);
    assert.equal(st.manager.lastCapSkipped, 1);

    const branchPoint = st.chat.length - 1;
    const r2 = await round(st, 'k1 k2 k3', { scanText: 'k1 k2 k3' });
    assert.deepEqual(injected(r2), [3]);
    assert.equal(st.status(3).cooldown, 2);

    // Branch back to round 1 reply: uid 3 has no cooldown there and is eligible alongside uid 1/2 once they thaw
    const mainId = st.chatId;
    await st.branch(branchPoint);
    assert.equal(st.status(3).cooldown, 0);
    assert.equal(st.status(1).cooldown, 2);
    const rBranch = await round(st, 'k1 k2 k3', { scanText: 'k1 k2 k3' });
    assert.deepEqual(injected(rBranch), [3]);

    // Roll back main chat to before round 2 and verify uid 3 is free again
    await st.open(mainId);
    await st.truncate(branchPoint + 1);
    assert.equal(st.status(3).cooldown, 0);
    assert.equal(st.status(1).cooldown, 2);
});

test('green cap excludes old swipe/regenerate reply, preserves continue reply and aiTurns anchor', async () => {
    const entries = [
        { world: 'book', uid: 1, key: ['oldA'], content: 'LORE_1', position: 0, disable: false },
        { world: 'book', uid: 2, key: ['oldB'], content: 'LORE_2', position: 0, disable: false },
        { world: 'book', uid: 3, key: ['userKey'], content: 'LORE_3', position: 0, disable: false },
    ];
    // 1) swipe: target still contains oldA/oldB before host clears it; swipe must ignore target's old text
    const s1 = new FakeST({ capEnabled: true, capLimit: 1, cooldown: 1 });
    s1.entries = structuredClone(entries);
    await s1.user('start');
    await s1.generate('normal', { text: 'clean', scanText: '' });
    await s1.user('userKey');
    await s1.generate('normal', { text: 'oldA oldB', scanText: '' });
    // Now swipe round 2 where target reply mentions oldA oldB
    const target = s1.chat[s1.chat.length - 1];
    target.swipe_info[0].extra = structuredClone(target.extra);
    target.swipes.push('oldA oldB');
    target.swipe_info.push({ extra: structuredClone(target.extra) });
    target.swipe_id = 1;
    target.mes = 'oldA oldB';
    await s1.emit('GENERATION_STARTED', 'swipe', {}, false);
    const swipePayload = { globalLore: structuredClone(s1.entries) };
    await s1.emit('WORLDINFO_ENTRIES_LOADED', swipePayload);
    assert.equal(swipePayload.globalLore.find(e => e.uid === 3).disable, false, 'userKey is not crowded out by replaced swipe');
    assert.equal(s1.manager.lastCapSkipped, 0);

    // 2a) regenerate with un-deleted trailing reply (aiTurns off) strips the trailing reply
    const s2a = new FakeST({ capEnabled: true, capLimit: 1, aiTurns: false, cooldown: 1 });
    s2a.entries = structuredClone(entries);
    await round(s2a, 'userKey', { text: 'oldA oldB', scanText: '' });
    await s2a.emit('GENERATION_STARTED', 'regenerate', {}, false);
    const regenUnpopped = { globalLore: structuredClone(s2a.entries) };
    await s2a.emit('WORLDINFO_ENTRIES_LOADED', regenUnpopped);
    assert.equal(regenUnpopped.globalLore.find(e => e.uid === 3).disable, false);
    assert.equal(s2a.manager.lastCapSkipped, 0);

    // 2b) regenerate with aiTurns on (1.19 pops trailing reply before scan) preserves previous AI anchor
    const s2b = new FakeST({ capEnabled: true, capLimit: 1, aiTurns: true, cooldown: 1 });
    s2b.entries = structuredClone(entries);
    await s2b.user('start');
    await s2b.generate('normal', { text: 'oldA', scanText: '' });
    await s2b.generate('normal', { text: 'oldB', scanText: '' });
    await s2b.emit('GENERATION_STARTED', 'regenerate', {}, false);
    s2b.chat.pop();
    await s2b.emit('MESSAGE_DELETED', s2b.chat.length);
    const regenPayload = { globalLore: structuredClone(s2b.entries) };
    await s2b.emit('WORLDINFO_ENTRIES_LOADED', regenPayload);
    assert.equal(regenPayload.globalLore.find(e => e.uid === 1).disable, false);
    assert.equal(s2b.manager.lastCapSkipped, 0);

    // 3) continue preserves partial reply text
    const s3 = new FakeST({ capEnabled: true, capLimit: 1, cooldown: 1 });
    s3.entries = structuredClone(entries);
    await round(s3, 'userKey', { text: 'oldA oldB', scanText: '' });
    await s3.emit('GENERATION_STARTED', 'continue', {}, false);
    const contPayload = { globalLore: structuredClone(s3.entries) };
    await s3.emit('WORLDINFO_ENTRIES_LOADED', contPayload);
    // userKey (Tier 0) kept, oldA & oldB (Tier 2 in partial reply) skipped -> 2 victims
    assert.equal(contPayload.globalLore.find(e => e.uid === 3).disable, false);
    assert.equal(contPayload.globalLore.find(e => e.uid === 1).disable, true);
    assert.equal(contPayload.globalLore.find(e => e.uid === 2).disable, true);
    assert.equal(s3.manager.lastCapSkipped, 2);
});

test('post-generation dryRun and nested quiet scans preserve lastCapSkipped; toggling off resets it', async () => {
    const st = new FakeST({ capEnabled: true, capLimit: 1, cooldown: 1 });
    st.entries = [
        { world: 'book', uid: 1, key: ['alpha'], content: 'L1', position: 0 },
        { world: 'book', uid: 2, key: ['beta'], content: 'L2', position: 0 },
        { world: 'book', uid: 3, key: ['gamma'], content: 'L3', position: 0 },
    ];
    await round(st, 'alpha beta gamma', { scanText: 'alpha beta gamma', quietInside: true });
    assert.equal(st.manager.lastCapSkipped, 2);

    // Post-generation dryRun scan (like 1.19 token recount) must not overwrite lastCapSkipped
    await st.emit('GENERATION_STARTED', 'normal', {}, true);
    await st.emit('WORLDINFO_ENTRIES_LOADED', { globalLore: structuredClone(st.entries) });
    assert.equal(st.manager.lastCapSkipped, 2);

    // Nested quiet scan while collecting must not overwrite lastCapSkipped
    await st.user('alpha beta gamma');
    await st.emit('GENERATION_STARTED', 'normal', {}, false);
    await st.emit('WORLDINFO_ENTRIES_LOADED', { globalLore: structuredClone(st.entries) });
    assert.equal(st.manager.lastCapSkipped, 1);
    await st.emit('GENERATION_STARTED', 'quiet', {}, false);
    await st.emit('WORLDINFO_ENTRIES_LOADED', { globalLore: [] });
    assert.equal(st.manager.lastCapSkipped, 1);
    await st.emit('GENERATION_ENDED');
    await st.emit('GENERATION_ENDED');

    // Toggling capEnabled off clears lastCapSkipped
    await round(st, 'alpha beta gamma', { scanText: 'alpha beta gamma' });
    assert.equal(st.manager.lastCapSkipped, 1); // uid 1 still in round 2 cooldown; uid 2 & 3 compete -> 1 skipped
    st.manager.updateSettings({ capEnabled: false });
    assert.equal(st.manager.lastCapSkipped, 0);
});

test('green cap counts duplicate (world, uid) across lore buckets once and disables all copies', async () => {
    const st = new FakeST({ capEnabled: true, capLimit: 2 });
    const e1 = { world: 'book', uid: 1, key: ['k1'], content: 'L1', position: 0, disable: false };
    const e2 = { world: 'book', uid: 2, key: ['k2'], content: 'L2', position: 0, disable: false };
    const e3 = { world: 'book', uid: 3, key: ['k3'], content: 'L3', position: 0, disable: false };
    await st.user('k1 k2 k3');
    await st.emit('GENERATION_STARTED', 'normal', {}, false);
    const payload = {
        globalLore: [structuredClone(e1), structuredClone(e2), structuredClone(e3)],
        characterLore: [structuredClone(e1), structuredClone(e2), structuredClone(e3)],
    };
    await st.emit('WORLDINFO_ENTRIES_LOADED', payload);
    assert.equal(payload.globalLore[0].disable, false);
    assert.equal(payload.characterLore[0].disable, false);
    assert.equal(payload.globalLore[1].disable, false);
    assert.equal(payload.characterLore[1].disable, false);
    assert.equal(payload.globalLore[2].disable, true);
    assert.equal(payload.characterLore[2].disable, true);
    assert.equal(st.manager.lastCapSkipped, 1);
});

test('table/status plugin in-place MESSAGE_UPDATED preserves timeline cooldowns and manual freezes', async () => {
    const st = new FakeST({ cooldown: 2 });
    await round(st, 'dragon');
    const key = entryKey('book', CASTLE);
    st.manager.manualFreeze([key], 3);
    st.chat[st.chat.length - 1].mes += '\n<table data-plugin="status">HP:100</table>';
    await st.emit('MESSAGE_UPDATED', st.chat.length - 1);
    assert.equal(st.status(DRAGON).cooldown, 2);
    assert.equal(st.status(CASTLE).manual, 3);
    assert.equal(st.blocked(DRAGON), true);
    assert.equal(st.blocked(CASTLE), true);
});
