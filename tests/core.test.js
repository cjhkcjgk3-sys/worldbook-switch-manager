import test from 'node:test';
import assert from 'node:assert/strict';
import { freshState, settingsWithDefaults, completeRound, status, entryKey, managed, setEntrySelection, freeze, unfreeze, supportedVersion, isCompatibleVersion } from '../core.js';
const entry = { world: '人物', uid: 1 };
const key = entryKey(entry.world, entry.uid);
function complete(s, cfg, round, entries = []) { completeRound(s, cfg, `user-${round}`, round, entries); }

test('A11: delay 0 / cooldown 1, successful injection -> closed -> eligible, cycle repeats', () => {
    const s = freshState(), cfg = settingsWithDefaults();
    complete(s, cfg, 1, [entry]);
    assert.equal(status(s, cfg, entry.world, entry.uid, 1).blocked, false);
    assert.equal(status(s, cfg, entry.world, entry.uid, 2).blocked, true);
    complete(s, cfg, 2);
    assert.equal(status(s, cfg, entry.world, entry.uid, 3).blocked, false);
    complete(s, cfg, 3, [entry]);
    assert.equal(status(s, cfg, entry.world, entry.uid, 4).cooldown, 1);
});
test('A12: delay 2 / cooldown 2 is not reset by subsequent activations', () => {
    const s = freshState(), cfg = settingsWithDefaults({ delay: 2, cooldown: 2 });
    for (let n = 1; n <= 3; n++) complete(s, cfg, n, [entry]);
    assert.equal(s.auto[key].round, 1);
    assert.deepEqual([1, 2, 3, 4, 5, 6].map(n => status(s, cfg, entry.world, entry.uid, n).blocked), [false, false, false, true, true, false]);
});
test('A13: regeneration does not advance time or change eligibility for its logical round', () => {
    const s = freshState(), cfg = settingsWithDefaults();
    complete(s, cfg, 1, [entry]);
    complete(s, cfg, 1, [entry]);
    assert.equal(s.clock, 1);
    assert.equal(status(s, cfg, entry.world, entry.uid, 1).blocked, false);
    complete(s, cfg, 2);
    complete(s, cfg, 2);
    assert.equal(s.clock, 2);
    assert.equal(status(s, cfg, entry.world, entry.uid, 2).blocked, true);
});
test('A06–A08, A17: empty selection means all; persistent whole-book choice covers new entries', () => {
    const cfg = settingsWithDefaults();
    assert.equal(managed(cfg, '混合', 1), true);
    cfg.selection['混合'] = ['1'];
    assert.equal(managed(cfg, '混合', 2), false);
    cfg.selection['人物'] = '*';
    assert.equal(managed(cfg, '人物', 'new'), true);
    setEntrySelection(cfg, '人物', 1, false, [1, 2]);
    assert.deepEqual(cfg.selection['人物'], ['2']);
    cfg.selection = {};
    assert.equal(managed(cfg, '其他', 99), true);
});
test('A16: auto and manual close independently; cancelling manual never clears auto', () => {
    const s = freshState(), cfg = settingsWithDefaults({ cooldown: 2 });
    complete(s, cfg, 1, [entry]);
    freeze(s, [key], 4);
    assert.equal(status(s, cfg, entry.world, entry.uid).manual, 4);
    unfreeze(s, [key]);
    assert.equal(status(s, cfg, entry.world, entry.uid).blocked, true);
    freeze(s, [key], 4);
    assert.equal(status(s, cfg, entry.world, entry.uid, 4).cooldown, 0);
    assert.equal(status(s, cfg, entry.world, entry.uid, 4).manual, 2);
});
test('A19: master off releases every overlay and preserves rules', () => {
    const s = freshState(), cfg = settingsWithDefaults();
    complete(s, cfg, 1, [entry]); freeze(s, [key], 5);
    cfg.enabled = false;
    assert.equal(status(s, cfg, entry.world, entry.uid).blocked, false);
    assert.ok(s.auto[key]); assert.ok(s.manual[key]);
});
test('multiple books and same numeric UID never share a cycle', () => {
    const s = freshState(), cfg = settingsWithDefaults();
    complete(s, cfg, 1, [entry, { world: 'other', uid: 1 }]);
    assert.equal(Object.keys(s.auto).length, 2);
    assert.notEqual(entryKey('a.b', 'c'), entryKey('a', 'b.c'));
});
test('scope changes suspend only automatic rules, manual remains explicit', () => {
    const s = freshState(), cfg = settingsWithDefaults();
    complete(s, cfg, 1, [entry]);
    cfg.selection = { unrelated: '*' };
    assert.equal(status(s, cfg, entry.world, entry.uid).blocked, false);
    freeze(s, [key], 1);
    assert.equal(status(s, cfg, entry.world, entry.uid).blocked, true);
});
test('duration edits apply to future cycles and preserve already-established duration', () => {
    const s = freshState(), cfg = settingsWithDefaults({ delay: 1, cooldown: 2 });
    complete(s, cfg, 1, [entry]); cfg.cooldown = 20;
    assert.equal(status(s, cfg, entry.world, entry.uid, 4).cooldown, 1);
    assert.equal(status(s, cfg, entry.world, entry.uid, 5).blocked, false);
});

test('supports verified 1.18 and 1.19 stable versions, rejects prereleases and unrelated versions', () => {
    for (const v of ['1.18.0','1.18.1','1.19.0','1.18.2+test']) assert.equal(supportedVersion(v), true, v);
    for (const v of ['1.17.9','1.20.0','1.18.0-beta.1','2.18.0', null]) assert.equal(supportedVersion(v), false, v);
});

test('isCompatibleVersion accepts 1.18+ and prereleases, rejects <1.18', () => {
    for (const v of ['1.18.0', '1.18.1', '1.19.0', '1.20.0', '2.0.0', '1.18.0-beta.1', '1.19.0-rc1']) {
        assert.equal(isCompatibleVersion(v), true, v);
    }
    for (const v of ['1.17.9', '0.9.0', 'invalid', null, undefined, '']) {
        assert.equal(isCompatibleVersion(v), false, String(v));
    }
});
