import test from 'node:test';
import assert from 'node:assert/strict';
import { Manager, preflight } from '../controller.js';
import { ID, entryKey } from '../core.js';

class Events {
    events = new Map();
    on(name, fn) { this.events.set(name, [...(this.events.get(name) ?? []), fn]); }
    removeListener(name, fn) { this.events.set(name, (this.events.get(name) ?? []).filter(x => x !== fn)); }
    makeLast(name, fn) { this.removeListener(name, fn); this.on(name, fn); }
    async emit(name, ...args) { for (const fn of this.events.get(name) ?? []) await fn(...args); }
}
function setup() {
    const names = ['WORLDINFO_ENTRIES_LOADED', 'WORLD_INFO_ACTIVATED', 'GENERATE_AFTER_DATA', 'CHAT_COMPLETION_SETTINGS_READY', 'GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'MESSAGE_RECEIVED', 'CHAT_CHANGED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'WORLDINFO_SETTINGS_UPDATED', 'WORLDINFO_UPDATED', 'CHARACTER_EDITED', 'PERSONA_CHANGED'];
    const events = new Events();
    let ctx = { chat: [], chatMetadata: {}, extensionSettings: {}, eventTypes: Object.fromEntries(names.map(n => [n, n])), eventSource: events,
        characters: [{ avatar: 'a.png' }], characterId: 0, groupId: null, chatId: 'A',
        getCurrentChatId() { return ctx.chatId; }, saveMetadata: async () => {}, saveSettingsDebounced() {}, loadWorldInfo: async () => ({ entries: {} }),
    };
    const manager = new Manager(() => ctx, { list: async () => ({ entries: [], books: [] }), render: e => e.content });
    manager.start();
    function user(text = 'hello') { ctx.chat.push({ is_user: true, mes: text, send_date: ctx.chat.length }); }
    const entry = { world: 'book', uid: 1, content: 'unique worldbook evidence', disable: false };
    const emit = (name, ...args) => events.emit(name, ...args);
    async function prepare(type = 'normal', activated = [entry], prompt = entry.content) {
        await emit('GENERATION_STARTED', type, {}, false);
        const payload = { globalLore: structuredClone([entry]), characterLore: [], chatLore: [], personaLore: [] };
        await emit('WORLDINFO_ENTRIES_LOADED', payload);
        await emit('WORLD_INFO_ACTIVATED', activated);
        await emit('GENERATE_AFTER_DATA', { prompt }, false);
        return payload;
    }
    async function success({ streaming = false } = {}) {
        ctx.chat.push({ is_user: false, mes: 'reply', send_date: ctx.chat.length });
        if (streaming) { ctx.streamingProcessor = { isFinished: true, isStopped: false }; await emit('GENERATION_ENDED'); }
        await emit('MESSAGE_RECEIVED', ctx.chat.length - 1, 'normal');
        if (!streaming) await emit('GENERATION_ENDED');
        ctx.streamingProcessor = null;
    }
    return { manager, get ctx() { return ctx; }, set ctx(c) { ctx = c; }, user, entry, emit, prepare, success, events };
}

test('native scan copies close, storage remains untouched; originally disabled entries stay disabled', async () => {
    const h = setup(); h.user(); await h.prepare(); await h.success(); h.user('next');
    const original = JSON.stringify(h.entry);
    const payload = await h.prepare();
    assert.equal(payload.globalLore[0].disable, true);
    assert.equal(JSON.stringify(h.entry), original);
    h.manager.settings.enabled = false;
    const disabled = { ...h.entry, disable: true };
    await h.emit('WORLDINFO_ENTRIES_LOADED', { globalLore: [disabled] });
    assert.equal(disabled.disable, true);
    h.manager.stop();
});
test('A01/A02: keywords alone or a budget-rejected entry do not start cooldown', async () => {
    const h = setup(); h.user(); await h.prepare('normal', []); await h.success();
    assert.deepEqual(h.manager.state.auto, {});
    h.user('second'); await h.prepare('normal', [h.entry], 'final payload without this entry'); await h.success();
    assert.deepEqual(h.manager.state.auto, {});
    assert.equal(h.manager.state.clock, 2);
});
test('empty rendered content, omitted final payload and previews cannot start a cycle', async () => {
    const h = setup(); h.user();
    await h.emit('GENERATION_STARTED', 'normal', {}, true);
    await h.emit('WORLD_INFO_ACTIVATED', [h.entry]);
    await h.emit('GENERATE_AFTER_DATA', { prompt: h.entry.content }, true);
    await h.success();
    assert.equal(h.manager.state.clock, 0);
    await h.prepare('normal', [{ ...h.entry, content: '' }]); await h.success();
    assert.deepEqual(h.manager.state.auto, {});
});
test('A14: failed and cancelled requests neither count nor establish a cycle', async () => {
    const h = setup(); h.user(); await h.prepare(); await h.emit('GENERATION_ENDED');
    assert.equal(h.manager.state.clock, 0); assert.deepEqual(h.manager.state.auto, {});
    await h.prepare(); await h.emit('GENERATION_STOPPED'); await h.success();
    assert.equal(h.manager.state.clock, 0); assert.deepEqual(h.manager.state.auto, {});
    await h.prepare(); await h.success(); assert.equal(h.manager.state.clock, 1);
});
test('stream success counts after end-then-receive; failed partial stream never counts', async () => {
    const h = setup(); h.user(); await h.prepare();
    h.ctx.streamingProcessor = { isStopped: true, isFinished: false };
    h.ctx.chat.push({ is_user: false, mes: 'partial' });
    await h.emit('GENERATION_ENDED'); await h.emit('MESSAGE_RECEIVED', 1, 'normal');
    assert.equal(h.manager.state.clock, 0);
    h.ctx.streamingProcessor = null; await h.prepare(); await h.success({ streaming: true });
    assert.equal(h.manager.state.clock, 1);
});
test('A13: regenerate and swipe keep the successful turn and freeze snapshot', async () => {
    const h = setup(); h.user(); await h.prepare(); await h.success();
    const first = await h.prepare('regenerate');
    h.ctx.chat.pop(); await h.emit('MESSAGE_DELETED', h.ctx.chat.length);
    assert.equal(first.globalLore[0].disable, false);
    await h.success(); assert.equal(h.manager.state.clock, 1);
    h.user('next'); await h.prepare('normal', []); await h.success();
    const second = await h.prepare('swipe', []);
    assert.equal(second.globalLore[0].disable, true);
    await h.success(); await h.emit('MESSAGE_SWIPED'); assert.equal(h.manager.state.clock, 2);
});
test('A15: chats carry independent metadata and share settings', async () => {
    const h = setup(); h.user(); await h.prepare(); await h.success();
    const a = h.ctx;
    h.ctx = { ...a, chat: [], chatMetadata: {}, chatId: 'B' };
    await h.emit('CHAT_CHANGED');
    assert.equal(h.manager.state.clock, 0); assert.deepEqual(h.manager.state.auto, {});
    h.user('B'); await h.prepare('normal', []); await h.success();
    h.ctx = a; await h.emit('CHAT_CHANGED');
    assert.equal(h.manager.state.clock, 1); assert.ok(h.manager.state.auto[entryKey('book', 1)]);
});
test('refresh persists progress, and a failed new turn appended to history does not reset prior cycles', async () => {
    const h = setup(); h.user(); await h.prepare(); await h.success();
    const snapshot = structuredClone(h.manager.state);
    h.user('failed'); await h.prepare(); await h.emit('GENERATION_ENDED');
    await h.emit('CHAT_CHANGED');
    assert.equal(h.manager.state.clock, 1);
    assert.deepEqual(h.manager.state.auto, snapshot.auto);
});
test('history edit/deletion/branch rollback clear invalidated timers with a visible explanation', async () => {
    const h = setup(); h.user(); await h.prepare(); await h.success();
    const saved = structuredClone(h.manager.state);
    h.ctx.chat[0].mes = 'rewritten offline'; await h.emit('CHAT_CHANGED');
    assert.equal(h.manager.state.clock, 0); assert.match(h.manager.state.notice, /历史/);
    h.ctx.chatMetadata[ID] = saved;
    await h.emit('MESSAGE_EDITED', 1);
    assert.deepEqual(h.manager.state.auto, {}); assert.match(h.manager.state.notice, /历史/);
});
test('missing capability blocks startup and stop removes every event subscription', () => {
    const h = setup();
    assert.ok(preflight({ ...h.ctx, eventTypes: {} }, h.manager.adapter).includes('WORLDINFO_ENTRIES_LOADED'));
    h.manager.stop();
    assert.equal([...h.events.events.values()].flat().length, 0);
});
test('async book loads from an old chat cannot overwrite the current list', async () => {
    const h = setup();
    let release;
    h.manager.adapter.list = () => new Promise(resolve => { release = resolve; });
    const oldLoad = h.manager.refresh();
    h.ctx = { ...h.ctx, chatId: 'B', chatMetadata: {} };
    h.manager.adapter.list = async () => ({ books: ['B'], entries: [] });
    await h.manager.refresh();
    release({ books: ['A'], entries: [] }); await oldLoad;
    assert.deepEqual(h.manager.bookNames, ['B']);
});

test('actual chat-completion request must retain the entry after final settings transformations', async () => {
    const h = setup(); h.ctx.mainApi = 'openai'; h.user(); await h.prepare();
    await h.emit('CHAT_COMPLETION_SETTINGS_READY', { messages: [{ role: 'system', content: 'stripped' }] });
    await h.success();
    assert.deepEqual(h.manager.state.auto, {});
    h.user('next'); await h.prepare();
    await h.emit('CHAT_COMPLETION_SETTINGS_READY', { messages: [{ role: 'system', content: h.entry.content }] });
    await h.success();
    assert.ok(h.manager.state.auto[entryKey('book', 1)]);
});
