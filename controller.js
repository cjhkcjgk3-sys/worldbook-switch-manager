import { ID, settingsWithDefaults, status, managed, entryKey, promptText, integer } from './core.js';
import { DRAFT, derive, nextRound, draftFor, applyDraft, buildStart, readStart, writeStart, writeDelta, clearInherited, stripAll, findAnchor, isReply } from './timeline.js';

const EVENTS = ['WORLDINFO_ENTRIES_LOADED', 'WORLD_INFO_ACTIVATED', 'GENERATE_AFTER_DATA', 'CHAT_COMPLETION_SETTINGS_READY', 'GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'MESSAGE_RECEIVED', 'CHAT_CHANGED', 'MESSAGE_EDITED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED', 'WORLDINFO_SETTINGS_UPDATED', 'WORLDINFO_UPDATED', 'CHARACTER_EDITED', 'PERSONA_CHANGED'];
const OPTIONAL_EVENTS = ['TOOL_CALLS_PERFORMED', 'MESSAGE_SWIPE_DELETED', 'MESSAGE_SENT'];
/** Generation types that answer the chat. quiet/impersonate never count. */
const SIDE = new Set(['quiet', 'impersonate']);
/** MESSAGE_RECEIVED types that are never the reply of a pending generation. */
const FOREIGN = new Set(['first_message', 'command', 'extension', 'quiet', 'impersonate']);

export function preflight(ctx, adapter) {
    const missing = EVENTS.filter(name => !ctx.eventTypes?.[name]);
    for (const name of ['saveSettingsDebounced', 'getCurrentChatId', 'loadWorldInfo']) {
        if (typeof ctx[name] !== 'function') missing.push(name);
    }
    for (const name of ['on', 'removeListener', 'makeLast']) {
        if (typeof ctx.eventSource?.[name] !== 'function') missing.push(`eventSource.${name}`);
    }
    if (!ctx.extensionSettings || !ctx.chatMetadata || !Array.isArray(ctx.chat)) missing.push('chat/settings');
    if (typeof adapter?.list !== 'function' || typeof adapter?.render !== 'function') missing.push('world-info adapter');
    return missing;
}
const uuid = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/**
 * Event glue. Cooldown state is never kept here: it is derived from the
 * visible chat (see timeline.js), so swipes, branches, deletions and reloads
 * are handled by SillyTavern's own message storage.
 */
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
        this.evidenceWarning = '';
        this.notice = '';
        this.sessionRevision = 0;
        this.viewCache = null;
    }
    get settings() {
        const ctx = this.context();
        if (!ctx.extensionSettings[ID]) ctx.extensionSettings[ID] = settingsWithDefaults();
        return ctx.extensionSettings[ID];
    }
    get chatIdentity() {
        const c = this.context();
        return JSON.stringify([c.groupId ?? null, c.groupId ? null : c.characters?.[c.characterId]?.avatar ?? null, c.getCurrentChatId()]);
    }
    start() {
        if (this.listeners.length) return;
        const ctx = this.context();
        const missing = preflight(ctx, this.adapter);
        if (missing.length) throw new Error(`酒馆缺少所需能力：${missing.join('、')}`);
        ctx.extensionSettings[ID] = settingsWithDefaults(ctx.extensionSettings[ID]);
        const handlers = {
            GENERATION_STARTED: (type, options, dryRun) => this.begin(type, dryRun),
            WORLDINFO_ENTRIES_LOADED: payload => this.filter(payload),
            WORLD_INFO_ACTIVATED: entries => this.activated(entries),
            GENERATE_AFTER_DATA: (data, dryRun) => { if (this.context().mainApi !== 'openai') this.payload(data?.prompt, dryRun); },
            CHAT_COMPLETION_SETTINGS_READY: data => { if (!SIDE.has(data?.type)) this.payload(data?.messages, false); },
            GENERATION_STOPPED: () => this.stopped(),
            GENERATION_ENDED: () => this.ended(),
            MESSAGE_RECEIVED: (id, type) => this.received(id, type),
            TOOL_CALLS_PERFORMED: () => { const p = this.pending; if (p && p.phase !== 'done') p.toolContinuation = true; },
            CHAT_CHANGED: () => this.changeChat(),
            MESSAGE_EDITED: () => this.touch(),
            MESSAGE_UPDATED: () => this.touch(),
            MESSAGE_DELETED: () => this.touch(),
            MESSAGE_SWIPED: () => this.touch(),
            MESSAGE_SWIPE_DELETED: () => this.touch(),
            MESSAGE_SENT: () => this.touch(),
            WORLDINFO_SETTINGS_UPDATED: () => this.refresh(),
            WORLDINFO_UPDATED: () => this.refresh(),
            CHARACTER_EDITED: () => this.refresh(),
            PERSONA_CHANGED: () => this.refresh(),
        };
        for (const [name, fn] of Object.entries(handlers)) {
            const event = ctx.eventTypes[name];
            if (!event) continue; // optional events (OPTIONAL_EVENTS) on older hosts
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
        this.sessionRevision++;
        this.viewCache = null;
    }
    touch() { this.viewCache = null; this.onChange(); }
    updateSettings(patch) {
        Object.assign(this.settings, patch);
        this.context().saveSettingsDebounced();
        this.touch();
    }
    changeChat() {
        this.pending = null;
        this.error = '';
        this.evidenceWarning = '';
        this.notice = '';
        this.entries = [];
        this.bookNames = [];
        this.sessionRevision++;
        this.touch();
        this.refresh();
    }
    refresh() {
        const chat = this.chatIdentity;
        if (this.refreshTask?.chat === chat && this.refreshTask.revision === this.revision) {
            this.refreshTask.again = true;
            return this.refreshTask.promise;
        }
        const task = { chat, revision: ++this.revision, again: false };
        this.refreshTask = task;
        task.promise = (async () => {
            // Merge same-tick notifications, then allow at most one trailing reload.
            await Promise.resolve();
            do {
                task.again = false;
                try {
                    const { entries, books } = await this.adapter.list(this.context());
                    if (task.revision !== this.revision || chat !== this.chatIdentity) return;
                    this.error = '';
                    this.entries = entries;
                    this.bookNames = books;
                    this.touch();
                } catch {
                    if (task.revision !== this.revision || chat !== this.chatIdentity) return;
                    this.error = '世界书读取失败，请检查连接后点击刷新。';
                    this.touch();
                }
            } while (task.again && task.revision === this.revision);
        })().finally(() => { if (this.refreshTask === task) this.refreshTask = null; });
        return task.promise;
    }

    /** Derived state of the visible chat, used by the panel and by scans outside a tracked generation. */
    get view() {
        const ctx = this.context();
        const chat = ctx.chat ?? [];
        const key = [chat, chat.length, chat[chat.length - 1], chat[chat.length - 1]?.swipe_id, this.settings.aiTurns, ctx.chatMetadata?.[DRAFT]];
        if (this.viewCache && this.viewCache.key.every((v, i) => v === key[i])) return this.viewCache.value;
        const d = derive(chat, { aiTurns: this.settings.aiTurns });
        const draft = draftFor(ctx.chatMetadata, d.lastSnapId);
        const state = applyDraft(structuredClone(d.state), draft);
        const value = { state, round: nextRound(d), completed: d.tailIsUser ? d.round - 1 : d.round, lastSnapId: d.lastSnapId, draft };
        this.viewCache = { key, value };
        return value;
    }
    /** Compatibility view used by the panel and older scripts. */
    get state() { const v = this.view; return { clock: v.completed, auto: v.state.auto, manual: v.state.manual, notice: this.notice }; }
    get busy() { const p = this.pending; return Boolean(p && p.phase !== 'done' && !p.ended); }

    begin(type = 'normal', dryRun = false) {
        // Dry runs (token counting, prompt previews) never take part.
        if (dryRun) return;
        const p = this.pending;
        if (SIDE.has(type)) {
            // A side request that overlaps a tracked one emits its own events. Chat
            // Completion payloads carry a type and are filtered; Text Completion ones
            // cannot be told apart, so that round is not counted (no cooldown starts).
            if (p && p.phase !== 'done') {
                p.nested++;
                if (this.context().mainApi !== 'openai') p.tainted = true;
            }
            return;
        }
        if (p && p.toolContinuation && p.phase !== 'done' && p.chat === this.chatIdentity) {
            // Tool-call follow-up request: same reply, same round, keep earlier evidence.
            p.toolContinuation = false;
            p.phase = 'collecting';
            p.ended = false;
            return;
        }
        const ctx = this.context();
        if (type === 'swipe') {
            // The new swipe starts as a copy of the shown one; never inherit its record.
            const last = ctx.chat[ctx.chat.length - 1];
            if (isReply(last)) clearInherited(last);
        }
        this.pending = { id: uuid(), type, chat: this.chatIdentity, phase: 'collecting', bound: false, anchor: null, round: 0, base: null, filterState: null,
            activated: new Map(), injected: new Map(), tainted: false, stopped: false, ended: false, nested: 0, toolContinuation: false, cache: null };
        this.touch();
    }
    bind() {
        const p = this.pending;
        if (!p || p.phase !== 'collecting' || p.chat !== this.chatIdentity) return null;
        if (p.bound) return p;
        p.bound = true;
        const ctx = this.context();
        const chat = ctx.chat;
        const aiTurns = this.settings.aiTurns;
        const last = chat[chat.length - 1];
        // swipe/continue answer the existing last reply; everything else appends one.
        const end = ['swipe', 'continue', 'append', 'appendFinal'].includes(p.type) && isReply(last) && chat.length > 0 ? chat.length - 1 : chat.length;
        const a = findAnchor(chat, end, aiTurns);
        if (a < 0) return p; // nothing to answer (e.g. greeting swipe): filter only
        const s = readStart(chat[a]);
        const d = derive(chat, { aiTurns, end: a + 1, tip: a });
        p.anchor = chat[a];
        p.round = s ? s.round : d.round;
        p.base = s ? { auto: s.auto, manual: s.manual } : { auto: d.state.auto, manual: d.state.manual };
        const full = derive(chat, { aiTurns });
        p.draft = draftFor(ctx.chatMetadata, full.lastSnapId);
        p.filterState = applyDraft(structuredClone({ ...p.base, clock: p.round }), p.draft);
        return p;
    }
    filter(payload) {
        if (!payload || !this.settings.enabled) return;
        const p = this.bind();
        const tracked = p?.anchor ? p : null;
        const state = tracked ? tracked.filterState : this.view.state;
        const round = tracked ? tracked.round : this.view.round;
        for (const entries of Object.values(payload)) {
            if (!Array.isArray(entries)) continue;
            for (const e of entries) {
                if (status(state, this.settings, e.world, e.uid, round, Boolean(e.constant)).blocked) e.disable = true;
            }
        }
    }
    activated(entries) {
        const p = this.bind();
        if (!p?.anchor || !Array.isArray(entries)) return;
        const settings = this.settings;
        if (!settings.enabled || !settings.automatic) return;
        const ctx = this.context();
        p.cache ??= this.adapter.prepare?.(ctx);
        for (const e of entries) {
            if (e.disable || !managed(settings, e.world, e.uid, Boolean(e.constant))) continue;
            const key = entryKey(e.world, e.uid);
            if (p.activated.has(key)) continue;
            p.activated.set(key, { world: e.world, uid: e.uid, position: e.position, rendered: this.adapter.render(e, ctx, p.cache ?? undefined) });
        }
    }
    payload(prompt, dryRun) {
        if (dryRun || prompt == null) return;
        const p = this.bind();
        if (!p) return;
        p.phase = 'sent';
        if (!p.anchor) return;
        const ctx = this.context();
        const text = promptText(prompt);
        let unconfirmed = 0;
        for (const [key, e] of p.activated) {
            if (p.injected.has(key)) continue;
            const needle = e.rendered?.trim();
            const ok = needle && text.includes(needle) && (this.adapter.included ? this.adapter.included(e, ctx, p.cache ?? undefined) : true);
            if (ok) p.injected.set(key, [String(e.world), String(e.uid)]); else unconfirmed++;
        }
        this.evidenceWarning = unconfirmed ? '部分已激活条目未能确认实际注入，暂未启动这些条目的自动冷却。请核对插入位置、正则与实际请求。' : '';
    }
    stopped() {
        const p = this.pending;
        if (p && p.phase !== 'done') p.stopped = true;
        this.touch();
    }
    ended() {
        const p = this.pending;
        if (!p || p.phase === 'done') return this.touch();
        if (p.nested > 0) { p.nested--; return; } // a side request finished first
        if (p.toolContinuation) return;
        const ctx = this.context();
        // Non-streaming: the reply (if any) was already received. Streaming: the
        // reply arrives right after this event, while the processor still exists.
        if (p.phase === 'collecting' || !ctx.streamingProcessor) p.phase = 'done';
        else p.ended = true;
        this.touch();
    }
    received(id, type) {
        const p = this.pending;
        const ctx = this.context();
        if (!p || p.phase !== 'sent' || p.chat !== this.chatIdentity || FOREIGN.has(type)) return this.touch();
        const sp = ctx.streamingProcessor;
        if (p.ended && !sp) { p.phase = 'done'; return this.touch(); }
        if (p.stopped || (sp && (sp.isStopped || sp.abortController?.signal?.aborted || !sp.isFinished))) { p.phase = 'done'; return this.touch(); }
        const m = ctx.chat[id];
        // Tool-call placeholders and empty replies are not the answer (yet).
        if (!isReply(m) || m.is_system || !String(m.mes ?? '').trim() || m.mes === '...' || m.extra?.tool_invocations) return this.touch();
        const a = p.anchor ? ctx.chat.indexOf(p.anchor) : -1;
        if (a < 0 || a >= id) { p.phase = 'done'; return this.touch(); }
        this.commit(p, m);
    }
    commit(p, reply) {
        p.phase = 'done';
        const settings = this.settings;
        if (!settings.enabled) return this.touch();
        const ctx = this.context();
        let s = readStart(p.anchor);
        const draft = draftFor(ctx.chatMetadata, derive(ctx.chat, { aiTurns: settings.aiTurns }).lastSnapId);
        if (!s) {
            s = buildStart(uuid(), p.round, { ...p.base, clock: p.round }, draft);
            writeStart(p.anchor, s);
        } else if (draft) {
            const merged = applyDraft({ auto: s.auto, manual: s.manual }, draft);
            s = { ...s, manual: merged.manual };
            writeStart(p.anchor, s);
        }
        if (draft && ctx.chatMetadata) delete ctx.chatMetadata[DRAFT];
        const inj = p.tainted || !settings.automatic ? [] : [...p.injected.values()];
        writeDelta(reply, { anchor: s.id, round: p.round, inj, delay: integer(settings.delay), cooldown: integer(settings.cooldown, 1) });
        if (p.tainted) this.evidenceWarning = '本回合生成期间有并行的后台请求，无法区分注入内容，本回合不启动自动冷却。';
        // SillyTavern saves the chat right after MESSAGE_RECEIVED; no extra save here.
        this.touch();
    }
    /** Manual freezes are stored as a draft bound to the current timeline point; the next reply commits them. */
    editDraft(update) {
        const ctx = this.context();
        if (!ctx.getCurrentChatId() || !ctx.chatMetadata) return false;
        const v = this.view;
        const current = draftFor(ctx.chatMetadata, v.lastSnapId);
        const draft = { base: v.lastSnapId, ops: { ...(current?.ops ?? {}) } };
        update(draft.ops, v);
        ctx.chatMetadata[DRAFT] = draft;
        (ctx.saveMetadataDebounced ?? ctx.saveMetadata)?.call(ctx);
        this.touch();
        return true;
    }
    manualFreeze(keys, rounds) {
        if (this.busy) return false;
        return this.editDraft((ops, v) => {
            const start = v.round, end = start + integer(rounds, 1) - 1;
            for (const key of keys) ops[key] = [start, end];
        });
    }
    manualUnfreeze(keys) {
        if (this.busy) return false;
        return this.editDraft(ops => { for (const key of keys) ops[key] = 0; });
    }
    /** Remove every record this extension wrote into the current chat. */
    clearChatData() {
        const ctx = this.context();
        if (this.busy || !ctx.getCurrentChatId()) return 0;
        const n = stripAll(ctx.chat, ctx.chatMetadata);
        this.pending = null;
        if (typeof ctx.saveChat === 'function') ctx.saveChat(); else (ctx.saveMetadataDebounced ?? ctx.saveMetadata)?.call(ctx);
        this.notice = n ? `已清除本聊天中的 ${n} 条插件记录。` : '本聊天没有插件记录。';
        this.touch();
        return n;
    }
    entryStatus(e) { const v = this.view; return status(v.state, this.settings, e.world, e.uid, v.round, Boolean(e.constant)); }
    get activeKeys() { return new Set(this.entries.map(e => entryKey(e.world, e.uid))); }
}
