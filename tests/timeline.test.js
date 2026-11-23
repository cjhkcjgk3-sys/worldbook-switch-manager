import test from 'node:test';
import assert from 'node:assert/strict';
import { derive, nextRound, readStart, readDelta, writeStart, writeDelta, clearInherited, stripAll, findAnchor, isReply, draftFor, applyDraft, buildStart, DRAFT } from '../timeline.js';
import { entryKey } from '../core.js';

const U = (mes = 'u', extra = {}) => ({ is_user: true, mes, extra });
const A = (mes = 'a', extra = {}) => ({ is_user: false, mes, extra, swipes: [mes], swipe_id: 0, swipe_info: [{ extra: {} }] });
const K = entryKey('b', '1');

test('rounds are counted by anchors; legacy chats derive plain counts', () => {
    const chat = [A('greet'), U(), A(), U(), A(), U()];
    const d = derive(chat);
    assert.equal(d.round, 3); assert.equal(nextRound(d), 3); assert.equal(d.lastSnapId, null);
    assert.equal(nextRound(derive(chat.slice(0, 5))), 3);
    assert.equal(derive([]).round, 0); assert.equal(nextRound(derive([])), 1);
});
test('snapshot + deltas: cycles apply after the reply, later anchors count and prune', () => {
    const u = U(), r = A();
    writeStart(u, { id: 's1', round: 5, auto: {}, manual: {} });
    writeDelta(r, { anchor: 's1', round: 5, inj: [['b', '1']], delay: 0, cooldown: 1 });
    const chat = [u, r];
    assert.deepEqual(derive(chat).state.auto[K], { round: 5, delay: 0, cooldown: 1 });
    chat.push(U(), A(), U());
    assert.equal(derive(chat).round, 7);
    assert.equal(derive(chat).state.auto[K], undefined, 'pruned after it can no longer matter');
});
test('a delta from another anchor or round is ignored', () => {
    const u = U(), r = A();
    writeStart(u, { id: 's1', round: 1, auto: {}, manual: {} });
    writeDelta(r, { anchor: 'other', round: 1, inj: [['b', '1']], delay: 0, cooldown: 3 });
    assert.deepEqual(derive([u, r]).state.auto, {});
});
test('writeDelta merges the same round and mirrors into the active swipe', () => {
    const r = A();
    writeDelta(r, { anchor: 's', round: 1, inj: [['b', '1']], delay: 0, cooldown: 1 });
    writeDelta(r, { anchor: 's', round: 1, inj: [['b', '1'], ['b', '2']], delay: 0, cooldown: 1 });
    assert.deepEqual(readDelta(r).inj, [['b', '1'], ['b', '2']]);
    assert.deepEqual(r.swipe_info[0].extra.wsm, r.extra.wsm);
    writeDelta(r, { anchor: 't', round: 2, inj: [], delay: 0, cooldown: 1 });
    assert.deepEqual(readDelta(r).inj, []);
    clearInherited(r);
    assert.equal(readDelta(r), null);
    assert.ok(r.swipe_info[0].extra.wsm, 'clearInherited only touches the shown copy');
});
test('malformed records are ignored instead of crashing', () => {
    const chat = [U('u', { wsm: { s: { id: 3, round: 'x' } } }), A('a', { wsm: { d: { anchor: 's', round: 1, inj: 'bad' } } }), U('u', { wsm: 'nope' })];
    assert.equal(readStart(chat[0]), null); assert.equal(readDelta(chat[1]), null);
    assert.equal(derive(chat).round, 2);
});
test('narrator notes are not replies; hidden replies are', () => {
    assert.equal(isReply({ is_user: false, mes: 'n', extra: { type: 'narrator' } }), false);
    assert.equal(isReply({ is_user: false, is_system: true, mes: 'help', extra: {} }), false);
    assert.equal(isReply({ is_user: false, is_system: true, mes: 'hidden', swipes: ['hidden'], extra: {} }), true);
});
test('findAnchor: last user message, or the previous reply with aiTurns', () => {
    const chat = [A(), U(), A(), A()];
    assert.equal(findAnchor(chat, 4), 1);
    assert.equal(findAnchor(chat, 4, true), 3);
    assert.equal(findAnchor(chat, 3, true), 2);
    assert.equal(findAnchor([A()], 1), -1);
});
test('aiTurns: a reply followed by a reply opens a round', () => {
    const chat = [U(), A(), A(), A()];
    assert.equal(derive(chat).round, 1);
    assert.equal(derive(chat, { aiTurns: true }).round, 3);
});
test('draft is valid only at the timeline point it was made', () => {
    const meta = { [DRAFT]: { base: 's1', ops: { [K]: [2, 3] } } };
    assert.equal(draftFor(meta, 's2'), null);
    const draft = draftFor(meta, 's1');
    const st = applyDraft({ auto: {}, manual: {} }, draft);
    assert.deepEqual(st.manual[K], { start: 2, end: 3 });
    assert.deepEqual(applyDraft(st, { ops: { [K]: 0 } }).manual, {});
    assert.equal(draftFor({ [DRAFT]: { base: null, ops: {} } }, null).base, null);
});
test('buildStart applies the draft and drops expired rules', () => {
    const s = buildStart('id', 5, { auto: { old: { round: 1, delay: 0, cooldown: 1 } }, manual: { gone: { start: 1, end: 2 } } }, { ops: { [K]: [5, 6] } });
    assert.deepEqual(s, { id: 'id', round: 5, auto: {}, manual: { [K]: { start: 5, end: 6 } } });
});
test('stripAll removes messages, swipes and draft records only', () => {
    const r = A('a', { wsm: { v: 1 }, other: 1 }); r.swipe_info[0].extra = { wsm: { v: 1 }, keep: true };
    const meta = { [DRAFT]: {}, keep: 1 };
    assert.equal(stripAll([U('u', { wsm: {} }), r], meta), 4);
    assert.deepEqual(r.extra, { other: 1 }); assert.deepEqual(r.swipe_info[0].extra, { keep: true }); assert.deepEqual(meta, { keep: 1 });
});
test('100 000 messages derive quickly from the last snapshot', () => {
    const chat = [];
    for (let i = 0; i < 50000; i++) chat.push(U(), A());
    writeStart(chat[99990], { id: 's', round: 49996, auto: {}, manual: {} });
    const t = performance.now();
    assert.equal(derive(chat).round, 50000);
    assert.ok(performance.now() - t < 200);
});
