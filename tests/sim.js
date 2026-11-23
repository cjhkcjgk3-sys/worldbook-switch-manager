/**
 * Minimal SillyTavern 1.19 host model for scenario tests. Event order and data
 * movement (swipe_info extra, branch clone, metadata copy, save/reload) follow
 * what was observed on a real 1.19.0 instance (docs/VALIDATION.md, 1.3.0).
 */
import { Manager } from '../controller.js';
import { ID } from '../core.js';

export const NAMES = ['WORLDINFO_ENTRIES_LOADED', 'WORLD_INFO_ACTIVATED', 'GENERATE_AFTER_DATA', 'CHAT_COMPLETION_SETTINGS_READY', 'GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'MESSAGE_RECEIVED', 'CHAT_CHANGED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'WORLDINFO_SETTINGS_UPDATED', 'WORLDINFO_UPDATED', 'CHARACTER_EDITED', 'PERSONA_CHANGED', 'TOOL_CALLS_PERFORMED', 'MESSAGE_SWIPE_DELETED', 'MESSAGE_SENT'];
export class Events {
    events = new Map();
    on(name, fn) { this.events.set(name, [...(this.events.get(name) ?? []), fn]); }
    removeListener(name, fn) { this.events.set(name, (this.events.get(name) ?? []).filter(x => x !== fn)); }
    makeLast(name, fn) { this.removeListener(name, fn); this.on(name, fn); }
    async emit(name, ...args) { for (const fn of [...(this.events.get(name) ?? [])]) await fn(...args); }
}
export const ENTRIES = [
    { world: 'book', uid: 1, key: ['dragon'], content: 'DRAGON_LORE dragons breathe fire', position: 0 },
    { world: 'book', uid: 2, key: [], constant: true, content: 'CONST_RULE always on', position: 0 },
    { world: 'book', uid: 3, key: ['castle'], content: 'CASTLE_LORE castle on hill', position: 0 },
];
const clone = v => structuredClone(v);
let chatSeq = 0;

export class FakeST {
    constructor(settings = {}) {
        this.events = new Events();
        this.chat = [{ is_user: false, mes: 'greeting', swipes: ['greeting'], swipe_id: 0, swipe_info: [{ extra: {} }], extra: {} }];
        this.chatMetadata = {};
        this.chatId = `chat-${++chatSeq}`;
        this.mainApi = 'openai';
        this.streamingProcessor = null;
        this.entries = clone(ENTRIES);
        this.extensionSettings = { [ID]: { cooldown: 2, ...settings } };
        this.files = new Map(); // chatId -> saved jsonl model
        this.saves = 0;
        const st = this;
        this.ctx = {
            get chat() { return st.chat; }, get chatMetadata() { return st.chatMetadata; }, get mainApi() { return st.mainApi; },
            get streamingProcessor() { return st.streamingProcessor; }, get extensionSettings() { return st.extensionSettings; },
            eventTypes: Object.fromEntries(NAMES.map(n => [n, n])), eventSource: this.events,
            characters: [{ avatar: 'a.png', name: 'A' }], characterId: 0, groupId: null,
            getCurrentChatId: () => st.chatId, saveSettingsDebounced() {}, saveMetadataDebounced: () => st.save(), saveChat: async () => { st.save(); },
            loadWorldInfo: async () => ({ entries: {} }),
        };
        this.manager = new Manager(() => this.ctx, {
            list: async () => ({ books: ['book'], entries: clone(this.entries) }),
            render: e => e.content, prepare: () => ({}), included: () => true,
            readSavedChat: async () => { const f = this.files.get(this.chatId); if (!f) throw new Error('no file'); return [{ chat_metadata: f.meta }, ...f.chat]; },
        });
        this.manager.start();
    }
    emit(name, ...args) { return this.events.emit(name, ...args); }
    get settings() { return this.manager.settings; }
    save() { this.saves++; if (this.saveFails) return; this.files.set(this.chatId, JSON.parse(JSON.stringify({ meta: this.chatMetadata, chat: this.chat }))); }
    async reload() {
        const f = this.files.get(this.chatId);
        this.chat = clone(f.chat); this.chatMetadata = clone(f.meta);
        await this.emit('CHAT_CHANGED', this.chatId);
    }
    async user(text = 'hello', { hidden = false } = {}) {
        this.chat.push({ is_user: true, mes: text, is_system: hidden, extra: {} });
        await this.emit('MESSAGE_SENT', this.chat.length - 1);
    }
    /** Entries the native scan would activate for the current chat. */
    scan(payload, scanText) {
        const active = [];
        for (const list of Object.values(payload)) for (const e of list) {
            if (e.disable) continue;
            if (e.constant || e.key.some(k => scanText.includes(k))) active.push(e);
        }
        return active;
    }
    /**
     * One generation following 1.19's order.
     * opts: stream, fail, stop, tool, text, quiet (overlapping side request), sideApi
     */
    async generate(type = 'normal', opts = {}) {
        const { stream = false, fail = false, stop = false, tool = false, text = `reply ${this.chat.length}`, quietInside = false, continuation = false, n = 1, send = null, preview = false, toolText = '', followFail = false } = opts;
        let target;
        if (type === 'swipe' && !continuation) {
            // Swiping past the last swipe adds a new one (copying the shown extra) before generating.
            target = this.chat[this.chat.length - 1];
            target.swipe_info[target.swipe_id].extra = clone(target.extra);
            target.swipes.push(''); target.swipe_info.push({ extra: clone(target.extra) });
            target.swipe_id = target.swipes.length - 1; target.mes = ''; target.extra = clone(target.extra);
        }
        await this.emit('GENERATION_STARTED', type, {}, false);
        if (preview && !continuation) {
            // 1.18: a prompt-manager dry run can scan before the user message is added.
            await this.emit('GENERATION_STARTED', 'normal', {}, true);
            await this.emit('WORLDINFO_ENTRIES_LOADED', { globalLore: clone(this.entries) });
        }
        if (send != null && !continuation) { this.chat.push({ is_user: true, mes: send, extra: {} }); await this.emit('MESSAGE_SENT', this.chat.length - 1); }
        if (type === 'regenerate' && !continuation) {
            this.chat.pop(); await this.emit('MESSAGE_DELETED', this.chat.length);
        }
        const payload = { globalLore: clone(this.entries), characterLore: [], chatLore: [], personaLore: [] };
        await this.emit('WORLDINFO_ENTRIES_LOADED', payload);
        const lastUser = [...this.chat].reverse().find(m => m.is_user);
        const active = this.scan(payload, tool && continuation ? '' : (opts.scanText ?? lastUser?.mes ?? ''));
        await this.emit('WORLD_INFO_ACTIVATED', active);
        const prompt = active.map(e => e.content).join('\n') + '\n' + this.chat.map(m => m.mes).join('\n');
        await this.emit('GENERATE_AFTER_DATA', { prompt }, false);
        if (this.mainApi === 'openai') await this.emit('CHAT_COMPLETION_SETTINGS_READY', { messages: [{ role: 'system', content: prompt }], type });
        if (fail || (followFail && continuation)) {
            if (target) { target.swipes.pop(); target.swipe_info.pop(); target.swipe_id = target.swipes.length - 1; target.mes = target.swipes[target.swipe_id]; target.extra = clone(target.swipe_info[target.swipe_id].extra); }
            await this.emit('GENERATION_ENDED', this.chat.length);
            return { payload, active };
        }
        if (tool && !continuation) {
            if (toolText) {
                // Visible text in the same response as the tool call: it is kept as its own reply.
                this.chat.push({ is_user: false, mes: toolText, swipes: [toolText], swipe_id: 0, swipe_info: [{ extra: {} }], extra: {} });
                await this.emit('MESSAGE_RECEIVED', this.chat.length - 1, type);
            } else if (!stream) {
                this.chat.push({ is_user: false, mes: '', swipes: [''], swipe_id: 0, swipe_info: [{ extra: {} }], extra: {} });
                await this.emit('MESSAGE_RECEIVED', this.chat.length - 1, type);
                this.chat.pop(); await this.emit('MESSAGE_DELETED', this.chat.length);
            }
            this.chat.push({ is_user: false, is_system: true, mes: 'tool', extra: { tool_invocations: [{}] } });
            await this.emit('TOOL_CALLS_PERFORMED', []);
            return this.generate('normal', { ...opts, continuation: true });
        }
        let id;
        if (type === 'swipe') { target.mes = text; target.swipes[target.swipe_id] = text; id = this.chat.length - 1; }
        else if (type === 'continue') { target = this.chat[this.chat.length - 1]; target.mes += text; target.swipes[target.swipe_id] = target.mes; id = this.chat.length - 1; }
        else { this.chat.push({ is_user: false, mes: text, swipes: [text], swipe_id: 0, swipe_info: [{ extra: {} }], extra: {} }); id = this.chat.length - 1; }
        const m = this.chat[id];
        for (let k = 1; k < n; k++) { m.swipes.push(`${text} alt ${k}`); m.swipe_info.push({ extra: clone(m.extra) }); }
        const receive = async () => {
            if (quietInside) await this.quiet();
            await this.emit('MESSAGE_RECEIVED', id, type);
            // 1.19 copies the message extra into the active swipe on save.
            if (m.swipe_info?.[m.swipe_id]) m.swipe_info[m.swipe_id].extra = clone(m.extra);
            this.save();
        };
        if (stream) {
            this.streamingProcessor = { isFinished: true, isStopped: false, abortController: { signal: { aborted: stop } }, messageId: id };
            if (stop) await this.emit('GENERATION_STOPPED');
            await this.emit('GENERATION_ENDED', this.chat.length);
            await receive();
            this.streamingProcessor = null;
        } else {
            await receive();
            await this.emit('GENERATION_ENDED', this.chat.length);
        }
        return { payload, active, id };
    }
    async quiet() {
        await this.emit('GENERATION_STARTED', 'quiet', {}, false);
        const payload = { globalLore: clone(this.entries) };
        await this.emit('WORLDINFO_ENTRIES_LOADED', payload);
        const active = this.scan(payload, 'dragon castle');
        await this.emit('WORLD_INFO_ACTIVATED', active);
        const prompt = active.map(e => e.content).join('\n');
        await this.emit('GENERATE_AFTER_DATA', { prompt }, false);
        if (this.mainApi === 'openai') await this.emit('CHAT_COMPLETION_SETTINGS_READY', { messages: [{ role: 'system', content: prompt }], type: 'quiet' });
        await this.emit('GENERATION_ENDED', this.chat.length);
    }
    async swipeTo(i) {
        const m = this.chat[this.chat.length - 1];
        m.swipe_info[m.swipe_id].extra = clone(m.extra);
        m.swipe_id = i; m.mes = m.swipes[i]; m.extra = clone(m.swipe_info[i].extra ?? {});
        await this.emit('MESSAGE_SWIPED', this.chat.length - 1);
    }
    async deleteSwipe() {
        const m = this.chat[this.chat.length - 1];
        m.swipes.splice(m.swipe_id, 1); m.swipe_info.splice(m.swipe_id, 1);
        m.swipe_id = Math.max(0, m.swipe_id - 1); m.mes = m.swipes[m.swipe_id]; m.extra = clone(m.swipe_info[m.swipe_id].extra ?? {});
        await this.emit('MESSAGE_SWIPE_DELETED', {});
        this.save();
    }
    /** Delete every message from index `i` on (rollback). */
    async truncate(i) { this.chat.splice(i); await this.emit('MESSAGE_DELETED', i); this.save(); }
    async deleteAt(i) { this.chat.splice(i, 1); await this.emit('MESSAGE_DELETED', i); this.save(); }
    /** Branch / checkpoint: clone messages 0..i and the metadata, then open the new chat. */
    async branch(i) {
        const chat = clone(this.chat.slice(0, i + 1)), meta = clone(this.chatMetadata);
        const old = this.chatId;
        this.save();
        this.chatId = `${old}-branch-${i}`;
        this.chat = chat; this.chatMetadata = meta; this.save();
        await this.emit('CHAT_CHANGED', this.chatId);
        return old;
    }
    async open(id) {
        this.save();
        this.chatId = id; const f = this.files.get(id);
        this.chat = clone(f.chat); this.chatMetadata = clone(f.meta);
        await this.emit('CHAT_CHANGED', id);
    }
    /** Is the entry allowed in the next scan? */
    blocked(uid) {
        const payload = { globalLore: clone(this.entries) };
        this.manager.filter(payload);
        return payload.globalLore.find(e => e.uid === uid).disable === true;
    }
    status(uid) { const e = this.entries.find(x => x.uid === uid); return this.manager.entryStatus(e); }
}
