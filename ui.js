import { entryKey, hasSelection, managed, setEntrySelection, integer } from './core.js';

function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
}
function checkbox(label, checked, callback) {
    const wrap = el('label', undefined, 'wsm-check');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.addEventListener('change', () => callback(input.checked));
    wrap.append(input, el('span', label));
    return { wrap, input };
}
function button(label, callback) {
    const node = el('button', label, 'menu_button');
    node.type = 'button';
    node.addEventListener('click', callback);
    return node;
}
function numberField(label, min, value, callback) {
    const wrap = el('label', label, 'wsm-number');
    const input = document.createElement('input');
    input.type = 'number'; input.min = String(min); input.max = '100000'; input.step = '1'; input.value = value;
    input.className = 'text_pole';
    input.addEventListener('change', () => { input.value = integer(input.value, min); callback(Number(input.value)); });
    wrap.append(input);
    return { wrap, input };
}

export function mountUI(manager, target, { open = false } = {}) {
    const root = el('section', undefined, 'wsm');
    root.id = 'worldbook-switch-manager';
    root.setAttribute('aria-label', '世界书自动开关管理器');
    const drawer = el('details');
    drawer.open = open;
    const title = el('summary', '世界书自动开关管理器');
    drawer.append(title); root.append(drawer);
    const body = el('div', undefined, 'wsm-body'); drawer.append(body);
    const enabled = checkbox('启用管理器', manager.settings.enabled, enabled => manager.updateSettings({ enabled }));
    const automatic = checkbox('成功注入后自动冷却', manager.settings.automatic, automatic => manager.updateSettings({ automatic }));
    const delay = numberField('延迟回合', 0, manager.settings.delay, delay => manager.updateSettings({ delay }));
    const cooldown = numberField('冷却回合', 1, manager.settings.cooldown, cooldown => manager.updateSettings({ cooldown }));
    const rules = el('div', undefined, 'wsm-rules');
    rules.append(delay.wrap, cooldown.wrap);
    const summary = el('p', '', 'wsm-scope'); summary.setAttribute('role', 'status');
    const notice = el('p', '', 'wsm-notice'); notice.setAttribute('role', 'status');
    const purpose = el('select', undefined, 'text_pole');
    purpose.setAttribute('aria-label', '选择用途');
    for (const [value, label] of [['scope', '设置自动管理范围'], ['manual', '选择临时冻结条目']]) {
        const option = el('option', label); option.value = value; purpose.append(option);
    }
    const hint = el('p', '', 'wsm-help');
    const search = document.createElement('input');
    search.type = 'search'; search.placeholder = '搜索世界书、条目名称或关键词';
    search.className = 'text_pole'; search.setAttribute('aria-label', search.placeholder);
    const manualKeys = new Set();
    const expanded = new Set();
    const bookNodes = new Map();
    const limits = new Map();
    let session = manager.sessionRevision;
    let grouped = new Map();
    let groupedSource;
    const list = el('div', undefined, 'wsm-books');
    const toolbar = el('div', undefined, 'wsm-actions');
    const manualActions = el('div', undefined, 'wsm-manual');
    const rounds = numberField('手动冻结回合', 1, 1, () => {});
    const selectedCount = el('span', '', 'wsm-help');
    const freezeButton = button('冻结所选', () => manager.manualFreeze(validManualKeys(), Number(rounds.input.value)));
    const thawButton = button('解除所选手动冻结', () => manager.manualUnfreeze(validManualKeys()));
    manualActions.append(rounds.wrap, selectedCount, freezeButton, thawButton);
    function validManualKeys() {
        const active = manager.activeKeys;
        return [...manualKeys].filter(k => active.has(k));
    }
    function visibleEntries() {
        const term = search.value.trim().toLocaleLowerCase();
        return manager.entries.filter(e => [e.world, e.comment, ...(e.key ?? []), String(e.uid)].join(' ').toLocaleLowerCase().includes(term));
    }
    function isSelected(e) {
        return purpose.value === 'manual' ? manualKeys.has(entryKey(e.world, e.uid)) :
            manager.settings.selection[e.world] === '*' || manager.settings.selection[e.world]?.includes(String(e.uid));
    }
    function selectEntry(e, selected) {
        if (purpose.value === 'manual') {
            const k = entryKey(e.world, e.uid); selected ? manualKeys.add(k) : manualKeys.delete(k);
            render();
        } else {
            setEntrySelection(manager.settings, e.world, e.uid, selected, manager.entries.filter(x => x.world === e.world).map(x => x.uid));
            manager.updateSettings({});
        }
    }
    function batchSelection(selected) {
        const groups = new Map();
        for (const e of visibleEntries()) {
            if (!groups.has(e.world)) groups.set(e.world, []);
            groups.get(e.world).push(e);
        }
        for (const [world, entries] of groups) {
            if (purpose.value === 'manual') {
                for (const e of entries) { const key = entryKey(world, e.uid); selected ? manualKeys.add(key) : manualKeys.delete(key); }
            } else {
                const existing = manager.settings.selection[world];
                // Preserve the future-entry semantics of a whole-book selection.
                if (selected && existing === '*') continue;
                const values = new Set(existing === '*' ? grouped.get(world).map(e => String(e.uid)) : existing ?? []);
                for (const e of entries) selected ? values.add(String(e.uid)) : values.delete(String(e.uid));
                if (values.size) manager.settings.selection[world] = [...values];
                else delete manager.settings.selection[world];
            }
        }
        if (purpose.value === 'scope') manager.updateSettings({}); else render();
    }
    toolbar.append(
        button('全选搜索结果', () => batchSelection(true)),
        button('取消选择搜索结果', () => batchSelection(false)),
        button('清空全部选择', () => {
            if (purpose.value === 'manual') { manualKeys.clear(); render(); }
            else manager.updateSettings({ selection: {} });
        }),
        button('刷新世界书', () => manager.refresh()),
    );
    body.append(enabled.wrap, automatic.wrap, rules, summary, notice, purpose, hint, search, toolbar, manualActions, list,
        el('p', '冷却与手动冻结仅在当前会话有效；切换聊天、刷新页面或修改历史时重置。', 'wsm-help'),
        el('p', '状态显示下一次新回合；重新生成沿用原回合。解除手动冻结后，自动冷却仍可能生效。', 'wsm-help'));
    function render() {
        const focusToken = document.activeElement?.dataset.wsmFocus;
        if (session !== manager.sessionRevision) {
            manualKeys.clear(); expanded.clear(); limits.clear(); bookNodes.clear();
            session = manager.sessionRevision;
        }
        if (groupedSource !== manager.entries) {
            groupedSource = manager.entries;
            grouped = new Map();
            for (const e of manager.entries) {
                if (!grouped.has(e.world)) grouped.set(e.world, []);
                grouped.get(e.world).push(e);
            }
        }
        enabled.input.checked = manager.settings.enabled;
        automatic.input.checked = manager.settings.automatic;
        delay.input.value = manager.settings.delay;
        cooldown.input.value = manager.settings.cooldown;
        summary.textContent = `${manager.settings.enabled ? '管理已启用' : '管理已暂停'} · ${hasSelection(manager.settings) ? '精细管理：仅指定世界书或条目' : '全部管理：当前使用的所有条目'} · 已完成 ${manager.state.clock} 回合`;
        notice.textContent = manager.error || manager.evidenceWarning || manager.state.notice || '';
        notice.hidden = !notice.textContent;
        hint.textContent = purpose.value === 'scope' ? '清空精细选择 = 恢复默认管理全部。整本选择会包含以后新增的条目。' : '此处选择只用于临时操作，不会改变自动管理范围。手动冻结从下一次新回合起计时。';
        manualActions.hidden = purpose.value !== 'manual';
        const keys = validManualKeys();
        selectedCount.textContent = `已选 ${keys.length} 个当前条目`;
        freezeButton.disabled = thawButton.disabled = !keys.length || !manager.context().getCurrentChatId() || Boolean(manager.pending);
        for (const [world, node] of bookNodes) if (node.open) expanded.add(world); else expanded.delete(world);
        bookNodes.clear(); list.replaceChildren();
        const visible = new Map();
        for (const e of visibleEntries()) {
            if (!visible.has(e.world)) visible.set(e.world, []);
            visible.get(e.world).push(e);
        }
        for (const world of manager.bookNames) {
            const entries = visible.get(world) ?? [];
            const all = grouped.get(world) ?? [];
            if (!entries.length && search.value.trim()) continue;
            const book = el('details', undefined, 'wsm-book');
            book.open = expanded.has(world) || Boolean(search.value.trim());
            bookNodes.set(world, book);
            book.addEventListener('toggle', () => {
                if (!book.isConnected) return;
                if (book.open === expanded.has(world)) return;
                if (book.open) expanded.add(world); else expanded.delete(world);
                render();
            });
            const heading = el('summary', `${world} · ${all.length} 条`);
            book.append(heading);
            const entire = checkbox(purpose.value === 'scope' ? '整本管理（含新增条目）' : '选择本书全部条目',
                purpose.value === 'scope' ? manager.settings.selection[world] === '*' : Boolean(all.length && all.every(isSelected)), selected => {
                    if (purpose.value === 'scope') {
                        if (selected) manager.settings.selection[world] = '*'; else delete manager.settings.selection[world];
                        manager.updateSettings({});
                    } else {
                        for (const e of all) { const k = entryKey(e.world, e.uid); selected ? manualKeys.add(k) : manualKeys.delete(k); }
                        render();
                    }
                });
            entire.input.dataset.wsmFocus = `book:${world}`;
            if (purpose.value === 'scope' && Array.isArray(manager.settings.selection[world])) entire.input.indeterminate = true;
            book.append(entire.wrap);
            const limit = limits.get(world) ?? 100;
            for (const e of (book.open ? entries.slice(0, limit) : [])) {
                const row = el('div', undefined, 'wsm-entry');
                const name = e.comment?.trim() || (e.key ?? []).join('、') || `未命名条目 #${e.uid}`;
                const pick = checkbox(name, Boolean(isSelected(e)), selected => selectEntry(e, selected));
                pick.input.dataset.wsmFocus = entryKey(e.world, e.uid);
                const s = manager.entryStatus(e);
                const reasons = [];
                if (e.disable) reasons.push('原本已禁用');
                if (!managed(manager.settings, e.world, e.uid)) reasons.push('不参与自动管理');
                if (s.delay) reasons.push(`延迟剩余 ${s.delay} 回合`);
                if (s.cooldown) reasons.push(`自动冷却剩余 ${s.cooldown} 回合`);
                if (s.manual) reasons.push(`手动冻结剩余 ${s.manual} 回合`);
                if (!s.delay && !s.cooldown && !s.manual && !e.disable) reasons.push('开启资格');
                if (s.paused) reasons.push('管理暂停，冻结不生效');
                row.dataset.blocked = String(s.blocked);
                row.append(pick.wrap, el('span', reasons.join(' · '), 'wsm-entry-status'));
                book.append(row);
            }
            if (book.open && entries.length > limit) book.append(button(`显示更多（已显示 ${limit} / ${entries.length} 条）`, () => { limits.set(world, limit + 100); render(); }));
            if (!all.length) book.append(el('p', '这本世界书暂无条目。', 'wsm-help'));
            list.append(book);
        }
        if (!manager.bookNames.length) list.append(el('p', '当前没有挂载世界书。请先选择角色或聊天，并挂载世界书。', 'wsm-help'));
        else if (!list.childElementCount) list.append(el('p', '没有匹配的条目。', 'wsm-help'));
        if (focusToken) [...root.querySelectorAll('[data-wsm-focus]')].find(node => node.dataset.wsmFocus === focusToken)?.focus({ preventScroll: true });
    }
    purpose.addEventListener('change', render);
    search.addEventListener('input', () => { limits.clear(); render(); });
    target.append(root);
    render();
    return { render, destroy: () => root.remove(), root, drawer };
}
