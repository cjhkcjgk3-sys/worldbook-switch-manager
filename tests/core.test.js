import test from 'node:test';
import assert from 'node:assert/strict';
import { freshState, settingsWithDefaults, completeRound, status, entryKey, managed, setEntrySelection, freeze, unfreeze, supportedVersion, isCompatibleVersion, selectGreenCapVictims } from '../core.js';
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

test('settingsWithDefaults migrates protectConstant to single includeConstant and normalizes cap settings', () => {
    const def = settingsWithDefaults();
    assert.equal(def.includeConstant, false);
    assert.equal(def.capEnabled, false);
    assert.equal(def.capLimit, 5);
    assert.equal('protectConstant' in def, false);

    const oldProtected = settingsWithDefaults({ protectConstant: true, capEnabled: 1, capLimit: 0 });
    assert.equal(oldProtected.includeConstant, false);
    assert.equal(oldProtected.capEnabled, true);
    assert.equal(oldProtected.capLimit, 1);
    assert.equal('protectConstant' in oldProtected, false);

    const oldUnprotected = settingsWithDefaults({ protectConstant: false, capLimit: 12.9 });
    assert.equal(oldUnprotected.includeConstant, true);
    assert.equal(oldUnprotected.capLimit, 12);
    assert.equal('protectConstant' in oldUnprotected, false);

    const explicitWins = settingsWithDefaults({ protectConstant: true, includeConstant: true, storageNoticeSeen: true });
    assert.equal(explicitWins.includeConstant, true);
    assert.equal(explicitWins.storageNoticeSeen, true);
    assert.equal('protectConstant' in explicitWins, false);
});

test('selectGreenCapVictims enforces tier/age/pos/seq priority, exclusions, regex, selectiveLogic, whole-word, scanDepth 0, dedup, and long chat tail', () => {
    const mk = (uid, key, extra = {}) => ({ world: 'book', uid, key, constant: false, disable: false, scanDepth: 4, ...extra });
    const chat = [
        { is_user: true, mes: '早前提过迪卢克' },
        { is_user: false, mes: '刚才提到了凯亚、丽莎和芭芭拉' },
        { is_user: true, mes: '我们去找安柏，再找琴团长' },
    ];
    const list = [
        mk(1, ['凯亚']),
        mk(2, ['丽莎']),
        mk(3, ['芭芭拉']),
        mk(4, ['琴团长']),
        mk(5, ['安柏']),
        mk(6, ['迪卢克']),
        mk(98, ['零深度'], { scanDepth: 0 }),
        mk(99, ['规则'], { constant: true }),
        mk(100, ['向量'], { vectorized: true }),
        mk(101, ['安柏'], { disable: true }),
    ];
    assert.deepEqual(selectGreenCapVictims(list, chat, settingsWithDefaults({ capEnabled: false, capLimit: 1 })), []);
    assert.deepEqual(selectGreenCapVictims(list, chat, settingsWithDefaults({ enabled: false, capEnabled: true, capLimit: 1 })), []);

    // capLimit = 3: Tier 0 = 安柏 (pos 4), 琴团长 (pos 9); Tier 1 = 迪卢克; Tier 2 = 凯亚, 丽莎, 芭芭拉 dropped!
    const victims = selectGreenCapVictims(list, chat, settingsWithDefaults({ capEnabled: true, capLimit: 3 }));
    assert.deepEqual(victims.map(v => v.uid), [1, 2, 3]);

    // Unmanaged entries do not consume green cap slots
    const scoped = settingsWithDefaults({ capEnabled: true, capLimit: 2, selection: { book: ['1', '2', '3', '4', '5'] } });
    assert.deepEqual(selectGreenCapVictims(list, chat, scoped).map(v => v.uid), [1, 2, 3]);

    // msgAge tie-breaker inside Tier 1 (earlier user message age 1 beats age 2) and seq tie-breaker at same pos
    const multiUserChat = [
        { is_user: true, mes: 'oldUser' },
        { is_user: true, mes: 'midUser' },
        { is_user: true, mes: 'latestUser' },
    ];
    const tieEntries = [
        mk(21, ['oldUser'], { scanDepth: 5 }),
        mk(22, ['midUser'], { scanDepth: 5 }),
        mk(23, ['latestUser'], { scanDepth: 5 }),
        mk(24, ['latestUser'], { scanDepth: 5 }),
    ];
    assert.deepEqual(
        selectGreenCapVictims(tieEntries, multiUserChat, settingsWithDefaults({ capEnabled: true, capLimit: 2 })).map(v => v.uid),
        [22, 21],
    );

    // Regex (including invalid regex fallback), selectiveLogic (0..3), caseSensitive, matchWholeWords
    const edgeChat = [{ is_user: true, mes: 'cat and dog with Amber, NOT bob; alpha' }];
    const edgeEntries = [
        mk(10, ['[unclosed', '/\\bAmber\\b/']),
        mk(11, ['/cat/'], { selective: true, keysecondary: ['dog', 'bird'], selectiveLogic: 0 }), // AND_ANY -> pass
        mk(12, ['/cat/'], { selective: true, keysecondary: ['dog', 'bird'], selectiveLogic: 3 }), // AND_ALL -> fail
        mk(13, ['/cat/'], { selective: true, keysecondary: ['bob'], selectiveLogic: 2 }), // NOT_ANY -> fail
        mk(14, ['/cat/'], { selective: true, keysecondary: ['dog', 'bird'], selectiveLogic: 1 }), // NOT_ALL -> pass
        mk(15, ['alpha'], { caseSensitive: true }),
        mk(16, ['ALPHA'], { caseSensitive: true }), // fail
        mk(17, ['cat'], { matchWholeWords: true }),
        mk(18, ['og'], { matchWholeWords: true }), // fail whole-word inside dog
    ];
    const edgeVictims = selectGreenCapVictims(edgeEntries, edgeChat, settingsWithDefaults({ capEnabled: true, capLimit: 2 }));
    assert.deepEqual(edgeVictims.map(v => v.uid), [17, 10, 15]);

    // Deduplicate duplicate (world, uid) copies across buckets
    const fourDup = [1, 2, 3, 4].flatMap((uid, i) => {
        const k = ['安柏', '凯亚', '丽莎', '可莉'][i];
        return [mk(uid, [k]), mk(uid, [k])];
    });
    const dupChat = [{ is_user: true, mes: '安柏 凯亚 丽莎 可莉 温迪' }];
    assert.deepEqual(selectGreenCapVictims(fourDup, dupChat, settingsWithDefaults({ capEnabled: true, capLimit: 4 })), []);
    const fiveDup = [...fourDup, mk(5, ['温迪']), mk(5, ['温迪'])];
    assert.deepEqual(selectGreenCapVictims(fiveDup, dupChat, settingsWithDefaults({ capEnabled: true, capLimit: 4 })).map(v => v.uid), [5, 5]);

    // scanDepth === 0 is ignored even if keys appear in chat
    const zeroDepthEntries = [mk(31, ['alpha'], { scanDepth: 0 }), mk(32, ['alpha'], { scanDepth: 2 }), mk(33, ['alpha'], { scanDepth: 2 })];
    assert.deepEqual(selectGreenCapVictims(zeroDepthEntries, [{ is_user: true, mes: 'alpha' }], settingsWithDefaults({ capEnabled: true, capLimit: 1 })).map(v => v.uid), [33]);

    // Long chat backwards tail scan respects per-entry scanDepth accurately
    const longChat = Array.from({ length: 10000 }, (_, i) => ({ is_user: i % 2 === 0, mes: `noise-${i}` }));
    longChat.push(
        { is_user: true, mes: 'farUser' },
        { is_user: false, mes: 'sysHidden', is_system: true },
        { is_user: false, mes: 'nearModel' },
        { is_user: true, mes: 'topUser' },
    );
    const tailEntries = [
        mk(41, ['farUser'], { scanDepth: 2 }), // outside depth 2
        mk(42, ['farUser'], { scanDepth: 3 }), // inside depth 3 (system message skipped)
        mk(43, ['nearModel'], { scanDepth: 2 }),
        mk(44, ['topUser'], { scanDepth: 2 }),
    ];
    // Matched: 44 (tier 0), 42 (tier 1), 43 (tier 2); 41 excluded by scanDepth 2
    assert.deepEqual(selectGreenCapVictims(tailEntries, longChat, settingsWithDefaults({ capEnabled: true, capLimit: 1 })).map(v => v.uid), [42, 43]);
});
