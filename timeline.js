/**
 * Timeline-bound cooldown state.
 *
 * Data lives on the chat messages themselves, so SillyTavern carries it through
 * swipes (swipe_info[i].extra), branches/checkpoints (cloned messages), deletions
 * and reloads. Verified against SillyTavern 1.19.0, see docs/VALIDATION.md.
 *
 *   anchor.extra.wsm.s = { id, round, auto, manual }   state at the start of the round
 *   reply.extra.wsm.d  = { anchor, round, inj, delay, cooldown }   what this reply's request injected; optional cap holds successful native-candidate reservations
 *   chatMetadata.wsm_draft = { base, ops }   manual freezes waiting for the next round
 */
import { applyInjection, prune, integer } from './core.js';

export const KEY = 'wsm';
export const DRAFT = 'wsm_draft';
export const VERSION = 1;

const plain = v => v && typeof v === 'object' && !Array.isArray(v);
/** A character reply (hidden replies included); narrator/system notes are neither replies nor anchors. */
export const isReply = m => Boolean(m) && !m.is_user && !m.extra?.type && !m.extra?.tool_invocations && !(m.is_system && !m.extra?.[KEY]?.d && !m.swipes);
/** System notes, tool-call records and narrator lines sit between turns without being one. */
export const isTransparent = m => !m || (!m.is_user && !isReply(m));
function nextTurn(chat, i, end) {
    for (let j = i + 1; j < end; j++) if (!isTransparent(chat[j])) return chat[j];
    return null;
}
/**
 * Does message `i` open a round?
 * - A user message does (hidden ones too: hiding only changes what the model sees),
 *   unless the next turn is another user message: consecutive user messages, e.g. one
 *   whose request failed followed by a new one, are a single round answered once.
 * - With `aiTurns`, a reply followed by another reply (tool records and system notes in
 *   between are skipped) also opens one: the second reply was a new AI turn.
 * `tip` marks the index a generation is about to answer; it always counts.
 */
export function isAnchorAt(chat, i, end, aiTurns = false, tip = -1) {
    const m = chat[i];
    if (!m) return false;
    if (i === tip) return true;
    if (m.is_user) return !nextTurn(chat, i, end)?.is_user;
    if (!aiTurns || !isReply(m)) return false;
    const next = nextTurn(chat, i, end);
    return Boolean(next && !next.is_user);
}
function cleanRules(value, kind) {
    const out = {};
    if (!plain(value)) return out;
    for (const [key, r] of Object.entries(value)) {
        if (kind === 'auto' && plain(r) && Number.isFinite(r.round)) out[key] = { round: r.round, delay: integer(r.delay), cooldown: integer(r.cooldown, 1) };
        if (kind === 'manual' && plain(r) && Number.isFinite(r.start) && Number.isFinite(r.end)) out[key] = { start: r.start, end: r.end };
    }
    return out;
}
export function readStart(m) {
    const s = m?.extra?.[KEY]?.s;
    if (!plain(s) || typeof s.id !== 'string' || !Number.isFinite(s.round)) return null;
    return { id: s.id, round: s.round, auto: cleanRules(s.auto, 'auto'), manual: cleanRules(s.manual, 'manual') };
}
export function readDelta(m) {
    const d = m?.extra?.[KEY]?.d;
    if (!plain(d) || typeof d.anchor !== 'string' || !Number.isFinite(d.round) || !Array.isArray(d.inj)) return null;
    const cap = Array.isArray(d.cap) ? { cap: d.cap.filter(x => Array.isArray(x) && x.length === 2).map(([w,u]) => [String(w),String(u)]) } : {};
    return { ...cap, anchor: d.anchor, round: d.round, inj: d.inj.filter(x => Array.isArray(x) && x.length === 2).map(([w, u]) => [String(w), String(u)]), delay: integer(d.delay), cooldown: integer(d.cooldown, 1) };
}
const emptyState = () => ({ clock: 0, auto: {}, manual: {} });

/**
 * Derive the state of the visible timeline `chat[0..end)`.
 * Returns the round of the latest anchor, the state after all recorded replies,
 * and where the latest anchor/snapshot sit.
 */
export function derive(chat, { aiTurns = false, end = chat.length, tip = -1 } = {}) {
    let snapIndex = -1, snap = null;
    for (let i = end - 1; i >= 0; i--) {
        if (!isAnchorAt(chat, i, end, aiTurns, tip)) continue;
        const s = readStart(chat[i]);
        if (s) { snapIndex = i; snap = s; break; }
    }
    const state = emptyState();
    let round = 0, tipIndex = -1;
    if (snap) {
        state.auto = structuredClone(snap.auto); state.manual = structuredClone(snap.manual);
        round = snap.round; tipIndex = snapIndex;
    }
    for (let i = snapIndex + 1; i < end; i++) {
        const m = chat[i];
        if (snap && !m?.is_user) {
            const d = readDelta(m);
            if (d && d.anchor === snap.id && d.round === snap.round) applyInjection(state, snap.round, d.inj, d.delay, d.cooldown);
        }
        if (isAnchorAt(chat, i, end, aiTurns, tip)) { round += 1; prune(state, round); tipIndex = i; }
    }
    state.clock = round;
    // Position of the visible end relative to the snapshot: a draft made here only applies
    // to timelines that still contain at least this much after the snapshot.
    let tail = end - 1;
    while (tail >= 0 && isTransparent(chat[tail])) tail--;
    return { state, round, tipIndex, snapIndex, lastSnapId: snap?.id ?? null, after: end - 1 - snapIndex, tailIsUser: Boolean(chat[tail]?.is_user) };
}
/** Round a brand-new turn would use (what the panel calls the next new round). */
export const nextRound = d => (d.tailIsUser ? d.round : d.round + 1);

export function draftFor(meta, lastSnapId, after = Infinity) {
    const draft = meta?.[DRAFT];
    if (!plain(draft) || !plain(draft.ops)) return null;
    if ((draft.base ?? null) !== (lastSnapId ?? null)) return null;
    // Older drafts (no position) keep the previous rule.
    if (Number.isFinite(draft.after) && after < draft.after) return null;
    return draft;
}
/** Apply manual ops (freeze: [start, end]; unfreeze: 0) on top of a state. */
export function applyDraft(state, draft) {
    if (!draft) return state;
    for (const [key, op] of Object.entries(draft.ops)) {
        if (Array.isArray(op) && Number.isFinite(op[0]) && Number.isFinite(op[1])) state.manual[key] = { start: op[0], end: op[1] };
        else delete state.manual[key];
    }
    return state;
}
export function buildStart(id, round, state, draft) {
    const s = { auto: structuredClone(state.auto), manual: structuredClone(state.manual), clock: round };
    applyDraft(s, draft);
    prune(s, round);
    return { id, round, auto: s.auto, manual: s.manual };
}
function ensureExtra(m) { if (!plain(m.extra)) m.extra = {}; return m.extra; }
/** Write into the message and into the active swipe's own extra (1.19 syncs swipe_info before MESSAGE_RECEIVED). */
export function writeWsm(m, patch) {
    const extra = ensureExtra(m);
    extra[KEY] = { ...(plain(extra[KEY]) ? extra[KEY] : {}), v: VERSION, ...patch };
    const info = Array.isArray(m.swipe_info) && Number.isInteger(m.swipe_id) ? m.swipe_info[m.swipe_id] : null;
    if (plain(info)) {
        if (!plain(info.extra)) info.extra = {};
        info.extra[KEY] = structuredClone(extra[KEY]);
    }
}
export function writeStart(m, s) { writeWsm(m, { s }); }
/** Merge into an existing delta of the same round (continue, tool-call continuation); otherwise replace. */
export function writeDelta(m, d) {
    const old = readDelta(m);
    if (old && old.anchor === d.anchor && old.round === d.round) {
        const seen = new Set(old.inj.map(x => JSON.stringify(x)));
        const capSeen = new Set((old.cap ?? []).map(x => JSON.stringify(x)));
        const cap = old.cap || d.cap ? { cap: [...(old.cap ?? []), ...(d.cap ?? []).filter(x => !capSeen.has(JSON.stringify(x)))] } : {};
        d = { ...old, ...d, ...cap, delay: old.delay, cooldown: old.cooldown, inj: [...old.inj, ...d.inj.filter(x => !seen.has(JSON.stringify(x)))] };
    }
    writeWsm(m, { d });
}
/** A new swipe starts as a copy of the previous swipe's extra; its outcome must not be inherited. */
export function clearInherited(m) {
    if (plain(m?.extra?.[KEY])) delete m.extra[KEY];
}
/** Remove every trace of this extension from a chat. Returns the number of records removed. */
export function stripAll(chat, meta) {
    let n = 0;
    for (const m of chat) {
        if (plain(m?.extra?.[KEY])) { delete m.extra[KEY]; n++; }
        for (const info of Array.isArray(m?.swipe_info) ? m.swipe_info : []) if (plain(info?.extra?.[KEY])) { delete info.extra[KEY]; n++; }
    }
    if (meta && Object.hasOwn(meta, DRAFT)) { delete meta[DRAFT]; n++; }
    return n;
}
/**
 * Index of the message a generation answers. `end` is where the generated reply
 * sits (chat.length for a new message, the target index for swipe/continue).
 * Tool records and system notes right before the reply are skipped.
 */
export function findAnchor(chat, end, aiTurns = false) {
    let k = end - 1;
    while (k >= 0 && isTransparent(chat[k])) k--;
    if (k < 0) return -1;
    if (chat[k].is_user || (aiTurns && isReply(chat[k]))) return k;
    for (let i = k - 1; i >= 0; i--) if (chat[i]?.is_user) return i;
    return -1;
}
/** Also record `d` on swipes created by the same request (multi-choice, n > 1). */
export function writeDeltaToSwipes(m, d, from) {
    if (!Array.isArray(m?.swipe_info)) return;
    for (let i = Math.max(0, from); i < m.swipe_info.length; i++) {
        if (i === m.swipe_id || !plain(m.swipe_info[i])) continue;
        const info = m.swipe_info[i];
        if (!plain(info.extra)) info.extra = {};
        info.extra[KEY] = { ...(plain(info.extra[KEY]) ? info.extra[KEY] : {}), v: VERSION, d: structuredClone(d) };
    }
}
/** Undo a reply record (used when a tool chain turns out to continue). */
export function removeDelta(m, from = 0) {
    const drop = extra => { if (plain(extra?.[KEY])) { delete extra[KEY].d; if (Object.keys(extra[KEY]).every(k => k === 'v')) delete extra[KEY]; } };
    drop(m?.extra);
    if (Array.isArray(m?.swipe_info)) for (let i = Math.max(0, from); i < m.swipe_info.length; i++) drop(m.swipe_info[i]?.extra);
}
