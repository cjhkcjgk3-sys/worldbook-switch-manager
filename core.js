/** Pure cooldown rules. Rounds are successful user/assistant pairs, not requests. */
export const ID = 'worldbook_switch_manager';
export const DEFAULTS = Object.freeze({ enabled: true, automatic: true, delay: 0, cooldown: 1, selection: {} });
export const entryKey = (world, uid) => JSON.stringify([String(world), String(uid)]);
export const integer = (value, min = 0) => Math.max(min, Math.min(100000, Math.trunc(Number(value) || min)));
export function settingsWithDefaults(value = {}) {
    return { ...structuredClone(DEFAULTS), ...value, delay: integer(value.delay), cooldown: integer(value.cooldown ?? 1, 1), selection: Object.assign(Object.create(null), Object.fromEntries(Object.entries(value.selection ?? {}).filter(([, v]) => v === '*' || Array.isArray(v)).map(([k, v]) => [k, v === '*' ? v : v.map(String)]))) };
}
export function freshState(reason = '') {
    return { version: 1, clock: 0, auto: {}, manual: {}, turns: {}, history: null, notice: reason };
}
export function hasSelection(settings) {
    return Object.values(settings.selection).some(x => x === '*' || (Array.isArray(x) && x.length));
}
export function managed(settings, world, uid) {
    if (!hasSelection(settings)) return true;
    const selection = settings.selection[world];
    return selection === '*' || (Array.isArray(selection) && selection.includes(String(uid)));
}
export function setEntrySelection(settings, world, uid, selected, allUids) {
    const current = settings.selection[world];
    const values = new Set(current === '*' ? allUids.map(String) : current ?? []);
    selected ? values.add(String(uid)) : values.delete(String(uid));
    if (values.size) settings.selection[world] = [...values];
    else delete settings.selection[world];
}
export function status(state, settings, world, uid, round = state.clock + 1) {
    const key = entryKey(world, uid);
    const cycle = state.auto[key];
    let delay = 0, cooldown = 0;
    if (cycle && settings.automatic && managed(settings, world, uid)) {
        if (round > cycle.round && round <= cycle.round + cycle.delay) delay = cycle.round + cycle.delay - round + 1;
        if (round > cycle.round + cycle.delay && round <= cycle.round + cycle.delay + cycle.cooldown) {
            cooldown = cycle.round + cycle.delay + cycle.cooldown - round + 1;
        }
    }
    const manualRule = state.manual[key];
    const manual = manualRule && round >= manualRule.start ? Math.max(0, manualRule.end - round + 1) : 0;
    return { delay, cooldown, manual, blocked: Boolean(settings.enabled && (cooldown || manual)), paused: !settings.enabled };
}
export function completeRound(state, settings, anchor, round, injected) {
    const prior = state.turns[anchor];
    if (!prior) {
        state.clock = Math.max(state.clock, round);
        state.turns[anchor] = { round };
    }
    if (!settings.enabled || !settings.automatic) return;
    for (const { world, uid } of injected) {
        if (!managed(settings, world, uid)) continue;
        const key = entryKey(world, uid);
        const cycle = state.auto[key];
        // A delay-stage activation cannot postpone a cycle. Regeneration is the same round.
        if (cycle && round <= cycle.round + cycle.delay + cycle.cooldown) continue;
        state.auto[key] = { round, delay: settings.delay, cooldown: settings.cooldown };
    }
}
export function freeze(state, keys, rounds) {
    const start = state.clock + 1;
    for (const key of keys) state.manual[key] = { start, end: start + integer(rounds, 1) - 1 };
}
export function unfreeze(state, keys) {
    for (const key of keys) delete state.manual[key];
}
/** Non-cryptographic identity only; never store raw message content in metadata. */
export function digest(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    let a = 2166136261, b = 5381;
    for (let i = 0; i < text.length; i++) {
        a = Math.imul(a ^ text.charCodeAt(i), 16777619);
        b = Math.imul(b, 33) ^ text.charCodeAt(i);
    }
    return `${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}`;
}
export function latestUser(chat) {
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (m.is_user && !m.is_system) return { index: i, anchor: digest([i, m.send_date, m.mes]) };
    }
    return null;
}
export function historyDigest(chat) {
    return digest(chat.map(m => [m.is_user, m.is_system, m.send_date, m.mes]));
}
export function promptText(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(promptText).filter(Boolean).join('\n');
    if (value && typeof value === 'object') {
        if (value.type === 'text') return value.text ?? '';
        if ('content' in value) return promptText(value.content);
    }
    return '';
}
