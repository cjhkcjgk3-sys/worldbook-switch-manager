import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdapter } from '../host-adapter.js';
import { settingsWithDefaults, managed, setEntrySelection } from '../core.js';
function setup() {
    const wi = { selected_world_info: ['global'], world_info: { charLore: [{ name: 'a', extraBooks: ['attached'] }] }, world_info_position: { atDepth: 4 }, DEFAULT_DEPTH: 4 };
    const calls = [];
    const regex = { getRegexScripts: () => [], regex_placement: { WORLD_INFO: 9 }, getRegexedString: (content, placement, options) => { calls.push({ placement, options }); return content.replace('before-regex', 'after-regex'); } };
    const openai = { promptManager: { messages: { collection: [{ identifier: 'worldInfoBefore', collection: [{ content: 'Lore: confirmed after-regex' }] }] } } };
    const adapter = createAdapter(wi, regex, openai);
    const ctx = { chatMetadata: { world_info: 'chat' }, powerUserSettings: { persona_description_lorebook: 'persona' }, characters: [{ avatar: 'a.png', data: { extensions: { world: 'primary' } } }], characterId: 0,
        loadWorldInfo: async name => { calls.push(name); return { entries: name === 'persona' ? {} : { 1: { uid: 1 } } }; }, chat: [], mainApi: 'openai' };
    return { wi, calls, regex, openai, adapter, ctx };
}
test('A09/A18: primary, attached, global, chat and persona books, empty books, no unrelated loading', async () => {
    const h = setup();
    const result = await h.adapter.list(h.ctx);
    assert.deepEqual(new Set(result.books), new Set(['global', 'chat', 'persona', 'primary', 'attached']));
    assert.equal(result.entries.length, 4);
    assert.deepEqual(new Set(h.calls), new Set(result.books));
    h.wi.selected_world_info = [];
    const next = await h.adapter.list(h.ctx);
    assert.equal(next.books.includes('global'), false);
});
test('group books include enabled participating members only', async () => {
    const h = setup();
    h.ctx.groupId = 'g';
    h.ctx.characters.push({ avatar: 'b.png', data: { extensions: { world: 'disabled-member' } } });
    h.ctx.groups = [{ id: 'g', members: ['a.png', 'b.png'], disabled_members: ['b.png'] }];
    const result = await h.adapter.list(h.ctx);
    assert.equal(result.books.includes('primary'), true);
    assert.equal(result.books.includes('disabled-member'), false);
});
test('render follows native regex prompt flags and native default depth', () => {
    const h = setup();
    assert.equal(h.adapter.render({ position: 4, content: 'before-regex' }), 'after-regex');
    assert.deepEqual(h.calls[0], { placement: 9, options: { depth: 4, isMarkdown: false, isPrompt: true } });
});
test('disabled prompt slot does not count even if the exact entry text is in chat history', () => {
    const h = setup(); const e = { position: 0, rendered: 'confirmed after-regex' };
    h.ctx.chat = [{ mes: e.rendered }];
    assert.equal(h.adapter.included(e, h.ctx), true);
    h.openai.promptManager.messages.collection = [{ identifier: 'chatHistory', collection: [{ content: e.rendered }] }];
    assert.equal(h.adapter.included(e, h.ctx), false);
});
test('ambiguous nonstandard insertion positions conservatively wait for verifiable evidence', () => {
    const h = setup(); const e = { position: 4, rendered: 'unique' };
    assert.equal(h.adapter.included(e, h.ctx), true);
    h.ctx.chat.push({ mes: 'unique' });
    assert.equal(h.adapter.included(e, h.ctx), false);
});
test('worldbook filenames matching JavaScript object properties remain valid selections', () => {
    const cfg = settingsWithDefaults();
    setEntrySelection(cfg, '__proto__', 1, true, [1, 2]);
    assert.equal(managed(cfg, '__proto__', 1), true);
    assert.equal(managed(cfg, '__proto__', 2), false);
    assert.equal(Object.getPrototypeOf(cfg.selection), null);
});

test('evidence collection never re-evaluates regex macros that may write variables', () => {
    const h = setup();
    h.regex.getRegexScripts = () => [{ promptOnly: true, placement: [9], substituteRegex: 0, replaceString: '{{setvar::x::1}}' }];
    assert.equal(h.adapter.render({ position: 0, content: 'before-regex' }), '');
    assert.equal(h.calls.length, 0);
});

test('render safely expands basic macros like {{char}} and {{user}}', () => {
    const h = setup();
    h.ctx.characters = [{ name: 'Alice', avatar: 'a.png', data: { extensions: { world: 'primary' } } }];
    h.ctx.characterId = 0;
    h.ctx.name1 = 'Bob';

    // Before regex substitution, {{char}} and {{user}} are safely expanded
    const entry = { position: 4, content: '{{char}} and {{user}} before-regex' };
    const rendered = h.adapter.render(entry, h.ctx);
    assert.equal(rendered, 'Alice and Bob after-regex');
});

test('render extracts longest static chunk when unknown macros exist', () => {
    const h = setup();
    const entry = { position: 4, content: '{{getvar::faction}} a significant static chunk before-regex' };
    const rendered = h.adapter.render(entry, h.ctx);
    assert.equal(rendered, 'a significant static chunk after-regex');
});

test('list gracefully tolerates partial worldbook load failures', async () => {
    const h = setup();
    h.wi.selected_world_info = ['healthy_book', 'broken_book'];
    h.ctx.loadWorldInfo = async name => {
        if (name === 'broken_book') throw new Error('Disk read error');
        return { entries: { 1: { uid: 1, comment: 'test' } } };
    };
    const result = await h.adapter.list(h.ctx);
    assert.equal(result.books.includes('healthy_book'), true);
    assert.equal(result.books.includes('broken_book'), false);
    assert.equal(result.entries.length > 0, true);
});
