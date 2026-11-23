/** Pure cooldown rules. A round is opened by an anchor message (normally a user message). */
export const ID = 'worldbook_switch_manager';
export const VERSION = '1.3.0';
export const DEFAULTS = Object.freeze({ enabled: true, automatic: true, delay: 0, cooldown: 1, includeConstant: false, aiTurns: false, selection: {} });
export const entryKey = (world, uid) => JSON.stringify([String(world), String(uid)]);
export const parseKey = key => { try { const [world, uid] = JSON.parse(key); return { world, uid }; } catch { return null; } };
export const integer = (value, min = 0) => Math.max(min, Math.min(100000, Math.trunc(Number(value) || min)));
const own = (object, key) => object != null && Object.hasOwn(object, key) ? object[key] : undefined;
/** Selection objects never inherit Object.prototype, so book names such as "toString" stay plain data. */
export function normalizeSelection(value) {
    const out = Object.create(null);
    if (!value || typeof value !== 'object') return out;
    for (const [world, v] of Object.entries(value)) {
        if (v === '*') out[world] = '*';
        else if (Array.isArray(v) && v.length) out[world] = [...new Set(v.map(String))];
    }
    return out;
}
export function selectionOf(settings, world) { return own(settings.selection, world); }
export function settingsWithDefaults(value = {}) {
    return {
        ...structuredClone({ ...DEFAULTS, selection: undefined }), ...value,
        enabled: value.enabled ?? DEFAULTS.enabled,
        automatic: value.automatic ?? DEFAULTS.automatic,
        includeConstant: Boolean(value.includeConstant ?? DEFAULTS.includeConstant),
        aiTurns: Boolean(value.aiTurns ?? DEFAULTS.aiTurns),
        delay: integer(value.delay), cooldown: integer(value.cooldown ?? 1, 1),
        selection: normalizeSelection(value.selection),
    };
}
export function freshState(reason = '') {
    return { clock: 0, auto: {}, manual: {}, lastTurn: null, notice: reason };
}
export function hasSelection(settings) {
    return Object.values(settings.selection).some(x => x === '*' || (Array.isArray(x) && x.length));
}
/** Automatic management scope. Constant (blue) entries are excluded unless explicitly included. */
export function managed(settings, world, uid, constant = false) {
    if (constant && !settings.includeConstant) return false;
    if (!hasSelection(settings)) return true;
    const selection = selectionOf(settings, world);
    return selection === '*' || (Array.isArray(selection) && selection.includes(String(uid)));
}
export function setEntrySelection(settings, world, uid, selected, allUids) {
    if (Object.getPrototypeOf(settings.selection) !== null) settings.selection = normalizeSelection(settings.selection);
    const current = selectionOf(settings, world);
    const values = new Set(current === '*' ? allUids.map(String) : Array.isArray(current) ? current : []);
    selected ? values.add(String(uid)) : values.delete(String(uid));
    if (values.size) settings.selection[world] = [...values];
    else delete settings.selection[world];
}
export function status(state, settings, world, uid, round = state.clock + 1, constant = false) {
    const key = entryKey(world, uid);
    const cycle = own(state.auto, key);
    let delay = 0, cooldown = 0;
    if (cycle && settings.automatic && managed(settings, world, uid, constant)) {
        if (round > cycle.round && round <= cycle.round + cycle.delay) delay = cycle.round + cycle.delay - round + 1;
        if (round > cycle.round + cycle.delay && round <= cycle.round + cycle.delay + cycle.cooldown) {
            cooldown = cycle.round + cycle.delay + cycle.cooldown - round + 1;
        }
    }
    const manualRule = own(state.manual, key);
    const manual = manualRule && round >= manualRule.start ? Math.max(0, manualRule.end - round + 1) : 0;
    return { delay, cooldown, manual, blocked: Boolean(settings.enabled && (cooldown || manual)), paused: !settings.enabled };
}
/** Start a cycle for each injected entry unless one is still running. Durations are captured per cycle. */
export function applyInjection(state, round, injected, delay, cooldown) {
    for (const item of injected) {
        const key = Array.isArray(item) ? entryKey(item[0], item[1]) : entryKey(item.world, item.uid);
        const cycle = own(state.auto, key);
        if (cycle && round <= cycle.round + cycle.delay + cycle.cooldown) continue;
        state.auto[key] = { round, delay: integer(delay), cooldown: integer(cooldown, 1) };
    }
}
/** Drop rules that can no longer affect `round` or any later round. */
export function prune(state, round) {
    for (const [key, rule] of Object.entries(state.auto)) if (rule.round + rule.delay + rule.cooldown < round) delete state.auto[key];
    for (const [key, rule] of Object.entries(state.manual)) if (rule.end < round) delete state.manual[key];
}
/** Legacy in-memory helper kept for the pure rule tests and stress checks. */
export function completeRound(state, settings, anchor, round, injected) {
    const prior = state.lastTurn?.anchor === anchor;
    if (!prior) {
        state.clock = Math.max(state.clock, round);
        state.lastTurn = { anchor, round };
        for (const [key, rule] of Object.entries(state.auto)) if (rule.round + rule.delay + rule.cooldown < round) delete state.auto[key];
        for (const [key, rule] of Object.entries(state.manual)) if (rule.end < round) delete state.manual[key];
    }
    if (!settings.enabled || !settings.automatic) return;
    applyInjection(state, round, injected.filter(e => managed(settings, e.world, e.uid, e.constant)), settings.delay, settings.cooldown);
}
export function freeze(state, keys, rounds, start = state.clock + 1) {
    for (const key of keys) state.manual[key] = { start, end: start + integer(rounds, 1) - 1 };
}
export function unfreeze(state, keys) {
    for (const key of keys) delete state.manual[key];
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

export function supportedVersion(version) {
    return /^1\.(18|19)\.\d+(?:\+[0-9A-Za-z.-]+)?$/.test(version ?? '');
}

export function isCompatibleVersion(version) {
    if (!version || typeof version !== 'string') return false;
    const match = version.match(/^(\d+)\.(\d+)(?:\.(\d+))?(?:[+-].*)?$/);
    if (!match) return false;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    return major > 1 || (major === 1 && minor >= 18);
}
