import { ID, settingsWithDefaults, freshState, status, managed, completeRound, latestUser, historyDigest, entryKey, freeze, unfreeze, promptText } from './core.js';

const EVENTS = ['WORLDINFO_ENTRIES_LOADED', 'WORLD_INFO_ACTIVATED', 'GENERATE_AFTER_DATA', 'CHAT_COMPLETION_SETTINGS_READY', 'GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'MESSAGE_RECEIVED', 'CHAT_CHANGED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'WORLDINFO_SETTINGS_UPDATED', 'WORLDINFO_UPDATED', 'CHARACTER_EDITED', 'PERSONA_CHANGED'];

export function preflight(ctx, adapter) {
    const missing = EVENTS.filter(name => !ctx.eventTypes?.[name]);
    for (const name of ['saveSettingsDebounced', 'saveMetadata', 'getCurrentChatId', 'loadWorldInfo']) {
        if (typeof ctx[name] !== 'function') missing.push(name);
    }
    for (const name of ['on', 'removeListener', 'makeLast']) {
        if (typeof ctx.eventSource?.[name] !== 'function') missing.push(`eventSource.${name}`);
    }
    if (!ctx.extensionSettings || !ctx.chatMetadata || !Array.isArray(ctx.chat)) missing.push('chat/settings');
    if (typeof adapter?.list !== 'function' || typeof adapter?.render !== 'function') missing.push('world-info adapter');
    return missing;
}

export class Manager {
    constructor(getContext, adapter, onChange = () => {}) {
        this.context = getContext;
        this.adapter = adapter;
        this.onChange = onChange;
        this.listeners = [];
        this.entries = [];
        this.bookNames = [];
        this.pending = null;
        this.revision = 0;
        this.error = '';
    }
    get settings() {
        const ctx = this.context();
        if (!ctx.extensionSettings[ID]) ctx.extensionSettings[ID] = settingsWithDefaults();
        return ctx.extensionSettings[ID];
    }
    get state() {
        const ctx = this.context();
        if (!ctx.chatMetadata[ID] || ctx.chatMetadata[ID].version !== 1) ctx.chatMetadata[ID] = freshState();
        return ctx.chatMetadata[ID];
    }
    get chatIdentity() {
        const c = this.context();
        return JSON.stringify([c.groupId ?? null, c.groupId ? null : c.characters?.[c.characterId]?.avatar ?? null, c.getCurrentChatId()]);
    }
    start() {
        const ctx = this.context();
        const missing = preflight(ctx, this.adapter);
        if (missing.length) throw new Error(`酒馆缺少所需能力：${missing.join('、')}`);
        ctx.extensionSettings[ID] = settingsWithDefaults(ctx.extensionSettings[ID]);
        const handlers = {
            GENERATION_STARTED: (type, options, dryRun) => this.begin(type, dryRun),
            WORLDINFO_ENTRIES_LOADED: payload => this.filter(payload),
            WORLD_INFO_ACTIVATED: entries => this.activated(entries),
            GENERATE_AFTER_DATA: (data, dryRun) => this.payload(data, dryRun),
            CHAT_COMPLETION_SETTINGS_READY: data => this.payload({ prompt: data.messages }, false, true),
            GENERATION_STOPPED: () => { this.pending = null; this.onChange(); },
            GENERATION_ENDED: () => this.ended(),
            MESSAGE_RECEIVED: (id, type) => this.received(id, type),
            CHAT_CHANGED: () => this.changeChat(),
            MESSAGE_EDITED: () => this.invalidate(),
            MESSAGE_UPDATED: () => this.invalidate(),
            MESSAGE_DELETED: () => {
                if (!this.pending || !['regenerate', 'continue'].includes(this.pending.type)) this.invalidate();
            },
            MESSAGE_SWIPED: () => { this.save(); this.onChange(); },
            WORLDINFO_SETTINGS_UPDATED: () => this.refresh(),
            WORLDINFO_UPDATED: () => this.refresh(),
            CHARACTER_EDITED: () => this.refresh(),
            PERSONA_CHANGED: () => this.refresh(),
        };
        for (const [name, fn] of Object.entries(handlers)) {
            const event = ctx.eventTypes[name];
            ctx.eventSource.on(event, fn);
            // Observe the final payload after existing extension listeners.
            if (['GENERATE_AFTER_DATA', 'CHAT_COMPLETION_SETTINGS_READY', 'WORLDINFO_ENTRIES_LOADED'].includes(name)) ctx.eventSource.makeLast(event, fn);
            this.listeners.push([ctx.eventSource, event, fn]);
        }
        this.changeChat();
    }
    stop() {
        for (const [source, event, fn] of this.listeners) source.removeListener(event, fn);
        this.listeners = [];
        this.pending = null;
        this.revision++;
    }
    save(length) {
        const ctx = this.context();
        if (!ctx.getCurrentChatId()) return;
        const count = length ?? (this.pending ? (latestUser(ctx.chat)?.index ?? ctx.chat.length - 1) + 1 : ctx.chat.length);
        this.state.history = { length: count, digest: historyDigest(ctx.chat.slice(0, count)) };
        // Native saveMetadata persists the chat-local metadata with the chat.
        Promise.resolve(ctx.saveMetadata()).catch(() => {
            this.error = '聊天进度保存失败，请检查酒馆连接后重试。';
            this.onChange();
        });
    }
    updateSettings(patch) {
        Object.assign(this.settings, patch);
        this.context().saveSettingsDebounced();
        this.onChange();
    }
    invalidate(reason = '历史消息已修改或删除，已清除本聊天的旧冷却与手动冻结。') {
        this.pending = null;
        this.context().chatMetadata[ID] = freshState(reason);
        this.save();
        this.onChange();
    }
    changeChat() {
        this.pending = null;
        this.error = '';
        this.evidenceWarning = '';
        this.entries = [];
        this.bookNames = [];
        const state = this.state;
        if (state.history && (typeof state.history !== 'object' || state.history.length > this.context().chat.length || state.history.digest !== historyDigest(this.context().chat.slice(0, state.history.length)))) {
            this.invalidate('检测到历史回退、分支变化或未完成的生成，已清除旧进度，重新等待成功注入。');
        }
        this.refresh();
    }
    async refresh() {
        const revision = ++this.revision;
        const chat = this.chatIdentity;
        try {
            const { entries, books } = await this.adapter.list(this.context());
            if (revision !== this.revision || chat !== this.chatIdentity) return;
            this.entries = entries;
            this.bookNames = books;
            this.onChange();
        } catch {
            if (revision !== this.revision) return;
            this.error = '世界书读取失败，请检查连接后点击刷新。';
            this.onChange();
        }
    }
    begin(type = 'normal', dryRun = false) {
        // Dry runs and quiet/impersonation requests must never create cooldowns.
        if (dryRun || ['quiet', 'impersonate'].includes(type)) {
            this.pending = null;
            return;
        }
        this.pending = { type, chat: this.chatIdentity, anchor: null, round: null, activated: [], injected: [], received: false, ended: false };
        if (['regenerate', 'swipe', 'continue'].includes(type)) this.save();
        this.onChange();
    }
    bindRound() {
        const p = this.pending;
        if (!p || p.chat !== this.chatIdentity) return null;
        const user = latestUser(this.context().chat);
        if (!user) return null;
        p.anchor = user.anchor;
        p.userIndex = user.index;
        p.round = this.state.turns[user.anchor]?.round ?? this.state.clock + 1;
        return p;
    }
    filter(payload) {
        const p = this.bindRound();
        // Also suppress frozen entries in dry-run/quiet scans, but never count them.
        const round = p?.round ?? this.state.clock + 1;
        for (const entries of Object.values(payload)) {
            if (!Array.isArray(entries)) continue;
            for (const e of entries) {
                if (status(this.state, this.settings, e.world, e.uid, round).blocked) e.disable = true;
            }
        }
    }
    activated(entries) {
        const p = this.bindRound();
        if (!p) return;
        p.activated = entries.filter(e => !e.disable).map(e => ({ ...e, rendered: this.adapter.render(e) }));
    }
    payload(data, dryRun, outgoing = false) {
        if (dryRun || !data) return;
        const p = this.bindRound();
        if (!p) return;
        const text = promptText(data.prompt);
        p.injected = p.activated.filter(e => {
            if (!e.rendered?.trim() || !text.includes(e.rendered.trim())) return false;
            return this.adapter.included ? this.adapter.included(e, this.context(), data) : true;
        }).map(({ world, uid }) => ({ world, uid }));
        p.sent = outgoing || this.context().mainApi !== 'openai';
        const confirmed = new Set(p.injected.map(e => entryKey(e.world, e.uid)));
        this.evidenceWarning = this.settings.enabled && this.settings.automatic && p.activated.some(e => managed(this.settings, e.world, e.uid) && !confirmed.has(entryKey(e.world, e.uid)))
            ? '部分已激活条目未能确认实际注入，暂未启动这些条目的自动冷却。请核对插入位置、正则与实际请求。' : '';
    }
    received(id, type) {
        const p = this.pending;
        const ctx = this.context();
        if (!p || !p.sent || p.chat !== this.chatIdentity || type === 'first_message') return;
        const m = ctx.chat[id];
        const stream = ctx.streamingProcessor;
        if (stream && (stream.isStopped || !stream.isFinished)) return;
        if (!m || m.is_user || m.is_system || !m.mes?.trim() || m.mes === '...' || m.extra?.tool_invocations) return;
        p.received = true;
        if (p.ended) this.commit();
    }
    ended() {
        const p = this.pending;
        if (!p) return;
        p.ended = true;
        if (p.received) this.commit();
        else if (!this.context().streamingProcessor || this.context().streamingProcessor.isStopped) {
            this.pending = null;
            this.onChange();
        }
    }
    commit() {
        const p = this.pending;
        if (!p || p.chat !== this.chatIdentity || !p.anchor) return;
        completeRound(this.state, this.settings, p.anchor, p.round, p.injected);
        this.pending = null;
        this.save();
        this.onChange();
    }
    manualFreeze(keys, rounds) {
        if (!this.context().getCurrentChatId()) return;
        freeze(this.state, keys, rounds);
        this.save();
        this.onChange();
    }
    manualUnfreeze(keys) {
        unfreeze(this.state, keys);
        this.save();
        this.onChange();
    }
    entryStatus(e) { return status(this.state, this.settings, e.world, e.uid); }
    get activeKeys() { return new Set(this.entries.map(e => entryKey(e.world, e.uid))); }
}
