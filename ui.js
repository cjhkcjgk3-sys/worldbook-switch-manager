import { entryKey, hasSelection, managed, setEntrySelection, integer, selectionOf, VERSION } from './core.js';

/** Clamp popup dimensions within safe viewport bounds (guarded against tiny transient mobile IME viewports). */
export function clampPopupSize(size, viewport) {
    if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height)) return null;
    const vw = Math.max(300, Number(viewport?.width) || 390);
    const vh = Math.max(360, Number(viewport?.height) || 640);
    const maxW = Math.max(260, vw - 16);
    const maxH = Math.max(260, vh - 16);
    const minW = Math.min(280, maxW);
    const minH = Math.min(260, maxH);
    return {
        width: Math.round(Math.min(maxW, Math.max(minW, size.width))),
        height: Math.round(Math.min(maxH, Math.max(minH, size.height))),
    };
}

/** Attach a single bottom-right corner resize handle to SillyTavern's native popup dialog. */
export function attachPopupResize(dlg, { initialSize = null, onSizeChange } = {}) {
    if (!dlg) return null;
    dlg.classList.add('wsm-dialog');
    const prevPos = dlg.style.position;
    if (globalThis.getComputedStyle?.(dlg).position === 'static') dlg.style.position = 'relative';
    for (const stale of dlg.querySelectorAll('.wsm-resize-handle')) stale.remove();

    let currentSize = null;
    const applySize = size => {
        const clamped = clampPopupSize(size, { width: window.innerWidth, height: window.innerHeight });
        if (!clamped) {
            dlg.style.width = '';
            dlg.style.height = '';
            currentSize = null;
            return null;
        }
        dlg.style.width = `${clamped.width}px`;
        dlg.style.height = `${clamped.height}px`;
        currentSize = clamped;
        return clamped;
    };
    const resetSize = () => {
        applySize(null);
        onSizeChange?.(null);
    };
    if (initialSize) applySize(initialSize);

    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'wsm-resize-handle';
    handle.setAttribute('aria-label', '拖动右下角调整窗口大小，双击恢复默认');
    handle.title = '拖动调整大小（双击恢复默认）';
    const svgNs = 'http://www.w3.org/2000/svg';
    const grip = document.createElementNS(svgNs, 'svg');
    grip.setAttribute('viewBox', '0 0 16 16');
    grip.setAttribute('width', '16');
    grip.setAttribute('height', '16');
    grip.setAttribute('aria-hidden', 'true');
    for (const d of ['M4 14 L14 4', 'M9 14 L14 9']) {
        const line = document.createElementNS(svgNs, 'path');
        line.setAttribute('d', d);
        line.setAttribute('stroke', 'currentColor');
        line.setAttribute('stroke-width', '1.8');
        line.setAttribute('stroke-linecap', 'round');
        grip.append(line);
    }
    handle.append(grip);
    dlg.append(handle);

    let drag = null;
    let lastTapAt = 0;

    const onPointerDown = event => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.pointerType !== 'mouse') {
            const now = Date.now();
            if (now - lastTapAt <= 320) {
                lastTapAt = 0;
                resetSize();
                return;
            }
        }
        const rect = dlg.getBoundingClientRect();
        drag = {
            id: event.pointerId,
            pointerType: event.pointerType,
            startX: event.clientX,
            startY: event.clientY,
            startW: rect.width,
            startH: rect.height,
            moved: false,
        };
        dlg.classList.add('wsm-resizing');
        try { handle.setPointerCapture?.(event.pointerId); } catch { /* synthetic event without active pointer */ }
    };

    const onPointerMove = event => {
        if (!drag || event.pointerId !== drag.id) return;
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (!drag.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) drag.moved = true;
        if (!drag.moved) return;
        // Native <dialog> is centered in viewport, so doubling deltas keeps the bottom-right corner under the pointer.
        applySize({ width: drag.startW + dx * 2, height: drag.startH + dy * 2 });
    };

    const endDrag = event => {
        if (!drag || event.pointerId !== drag.id) return;
        const finished = drag;
        drag = null;
        dlg.classList.remove('wsm-resizing');
        try {
            if (handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture(event.pointerId);
        } catch { /* ignore */ }
        if (finished.moved && currentSize) {
            onSizeChange?.(currentSize);
        } else if (event.type === 'pointerup' && finished.pointerType !== 'mouse') {
            lastTapAt = Date.now();
        }
    };

    const onDblClick = event => {
        event.preventDefault();
        lastTapAt = 0;
        resetSize();
    };

    const onKeyDown = event => {
        const deltas = { ArrowRight: [24, 0], ArrowLeft: [-24, 0], ArrowDown: [0, 24], ArrowUp: [0, -24] };
        if (event.key === 'Home' || event.key === '0') {
            event.preventDefault();
            resetSize();
            return;
        }
        const step = deltas[event.key];
        if (!step) return;
        event.preventDefault();
        const rect = dlg.getBoundingClientRect();
        const applied = applySize({ width: rect.width + step[0], height: rect.height + step[1] });
        if (applied) onSizeChange?.(applied);
    };

    const onViewportResize = () => {
        if (!currentSize) return;
        const applied = applySize(currentSize);
        if (applied) onSizeChange?.(applied);
    };

    handle.addEventListener('pointerdown', onPointerDown);
    handle.addEventListener('pointermove', onPointerMove);
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
    handle.addEventListener('dblclick', onDblClick);
    handle.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onViewportResize);

    return {
        reset: resetSize,
        destroy() {
            drag = null;
            handle.removeEventListener('pointerdown', onPointerDown);
            handle.removeEventListener('pointermove', onPointerMove);
            handle.removeEventListener('pointerup', endDrag);
            handle.removeEventListener('pointercancel', endDrag);
            handle.removeEventListener('dblclick', onDblClick);
            handle.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('resize', onViewportResize);
            handle.remove();
            dlg.classList.remove('wsm-resizing', 'wsm-dialog');
            dlg.style.width = '';
            dlg.style.height = '';
            dlg.style.position = prevPos;
        },
    };
}

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
    const text = el('span', label);
    wrap.append(input, text);
    return { wrap, input, text };
}

function button(label, callback, className = 'menu_button') {
    const node = el('button', label, className);
    node.type = 'button';
    node.addEventListener('click', callback);
    return node;
}

function numberField(label, min, value, callback) {
    const wrap = el('label', undefined, 'wsm-number');
    const labelNode = el('span', label, 'wsm-field-label');
    const input = document.createElement('input');
    input.type = 'number';
    input.min = String(min);
    input.max = '100000';
    input.step = '1';
    input.value = value;
    input.className = 'text_pole';
    input.addEventListener('change', () => {
        input.value = integer(input.value, min);
        callback(Number(input.value));
    });
    wrap.append(labelNode, input);
    return { wrap, input };
}

function pill(text, tone = 'neutral') {
    const node = el('span', text, 'wsm-pill');
    node.dataset.tone = tone;
    return node;
}

function entryBadges(manager, e, s) {
    const out = [];
    if (e.disable) out.push(['原本已禁用', 'muted']);
    if (e.constant && !manager.settings.includeConstant) out.push(['蓝灯·不自动冷却', 'info']);
    else if (!managed(manager.settings, e.world, e.uid, Boolean(e.constant))) out.push(['未纳管', 'muted']);
    if (s.delay) out.push([`延迟剩余 ${s.delay} 回合`, 'warn']);
    if (s.cooldown) out.push([`自动冷却剩余 ${s.cooldown} 回合`, 'warn']);
    if (s.manual) out.push([`手动冻结剩余 ${s.manual} 回合`, 'manual']);
    if (!s.delay && !s.cooldown && !s.manual && !e.disable) out.push(['可激活', 'ok']);
    if (s.paused) out.push(['管理已暂停', 'muted']);
    return out;
}

function syncStatusBadges(statusEl, badges) {
    const sig = badges.map(([text, tone]) => `${tone}:${text}`).join('|');
    if (statusEl.dataset.wsmBadges === sig) return;
    statusEl.dataset.wsmBadges = sig;
    const nodes = [];
    for (let i = 0; i < badges.length; i++) {
        if (i > 0) nodes.push(document.createTextNode(' '));
        const badge = el('span', badges[i][0], 'wsm-badge');
        badge.dataset.tone = badges[i][1];
        nodes.push(badge);
    }
    statusEl.replaceChildren(...nodes);
}

export function mountUI(manager, target, { open = false, inPopup = false } = {}) {
    const root = el('section', undefined, inPopup ? 'wsm wsm-in-popup' : 'wsm');
    root.id = 'worldbook-switch-manager';
    root.setAttribute('aria-label', '世界书自动开关管理器');

    const body = el('div', undefined, 'wsm-body');
    let drawer = { open: true };
    if (inPopup) {
        const header = el('header', undefined, 'wsm-header');
        header.append(el('h2', '世界书自动开关管理器', 'wsm-title'));
        root.append(header, body);
    } else {
        drawer = el('details');
        drawer.open = open;
        drawer.append(el('summary', '世界书自动开关管理器'), body);
        root.append(drawer);
    }

    const storageNotice = el('div', undefined, 'wsm-notice');
    storageNotice.append(
        el('p', '从 1.3.0 起，冷却和手动冻结记录保存在聊天楼层里：切换备选回复、开分支、删楼回退或刷新页面后，都会按当前看得到的楼层恢复。导出或分享聊天文件时会带上这些记录（只有世界书名和条目编号）。'),
        button('知道了', () => manager.updateSettings({ storageNoticeSeen: true })),
    );

    const summary = el('div', undefined, 'wsm-scope');
    summary.setAttribute('role', 'status');

    const notice = el('p', '', 'wsm-notice');
    notice.setAttribute('role', 'status');
    const orphans = el('div', undefined, 'wsm-notice wsm-orphans');

    const coreCard = el('div', undefined, 'wsm-card');
    const enabled = checkbox('启用管理器', manager.settings.enabled, enabled => manager.updateSettings({ enabled }));
    const automatic = checkbox('成功注入后自动冷却', manager.settings.automatic, automatic => manager.updateSettings({ automatic }));
    const mainToggles = el('div', undefined, 'wsm-toggles');
    mainToggles.append(enabled.wrap, automatic.wrap);

    const delay = numberField('延迟回合', 0, manager.settings.delay, delay => manager.updateSettings({ delay }));
    const cooldown = numberField('冷却回合', 1, manager.settings.cooldown, cooldown => manager.updateSettings({ cooldown }));
    const rules = el('div', undefined, 'wsm-rules');
    rules.append(delay.wrap, cooldown.wrap);

    const capEnabled = checkbox('启用单回合绿灯触发上限（用户提及优先）', manager.settings.capEnabled, capEnabled => manager.updateSettings({ capEnabled }));
    const capLimit = numberField('单回合绿灯上限（条）', 1, manager.settings.capLimit, capLimit => manager.updateSettings({ capLimit }));
    const capRow = el('div', undefined, 'wsm-cap');
    capRow.append(capEnabled.wrap, capLimit.wrap);
    coreCard.append(mainToggles, rules, capRow);

    let mode = 'scope';
    let filterMode = 'all';
    const modeTabs = el('div', undefined, 'wsm-tabs');
    modeTabs.setAttribute('role', 'tablist');
    modeTabs.setAttribute('aria-label', '选择用途');
    const scopeTab = button('自动管理范围', () => {
        if (mode === 'scope') return;
        mode = 'scope';
        render();
    }, 'wsm-tab');
    scopeTab.setAttribute('role', 'tab');
    scopeTab.dataset.mode = 'scope';
    const manualTab = button('临时手动冻结', () => {
        if (mode === 'manual') return;
        mode = 'manual';
        render();
    }, 'wsm-tab');
    manualTab.setAttribute('role', 'tab');
    manualTab.dataset.mode = 'manual';
    modeTabs.append(scopeTab, manualTab);

    const hint = el('p', '', 'wsm-help wsm-mode-hint');

    const manualActions = el('div', undefined, 'wsm-manual');
    const rounds = numberField('手动冻结回合', 1, 1, () => {});
    const selectedCount = el('span', '', 'wsm-pill wsm-selected-pill');
    const manualTop = el('div', undefined, 'wsm-manual-top');
    manualTop.append(rounds.wrap, selectedCount);
    const freezeButton = button('冻结所选', () => manager.manualFreeze(validManualKeys(), Number(rounds.input.value)));
    const thawButton = button('解除手动冻结', () => manager.manualUnfreeze(validManualKeys()));
    const manualBtns = el('div', undefined, 'wsm-manual-btns');
    manualBtns.append(freezeButton, thawButton);
    manualActions.append(manualTop, manualBtns);

    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = '搜索世界书、条目名称或关键词';
    search.className = 'text_pole';
    search.setAttribute('aria-label', search.placeholder);

    const filters = el('div', undefined, 'wsm-filters');
    filters.setAttribute('role', 'group');
    filters.setAttribute('aria-label', '快速筛选');
    const filterButtons = new Map();
    for (const [id, label] of [['all', '全部'], ['blocked', '冷却或冻结中'], ['selected', '已勾选']]) {
        const btn = button(label, () => {
            if (filterMode === id) return;
            filterMode = id;
            limits.clear();
            userCollapsedFiltered.clear();
            render();
        }, 'wsm-filter');
        filterButtons.set(id, btn);
        filters.append(btn);
    }

    const manualKeys = new Set();
    const expanded = new Set();
    const userCollapsedFiltered = new Set();
    const limits = new Map();
    const bookCache = new Map();
    let mountedSig = '';
    let lastAutoOpen = false;
    let session = manager.sessionRevision;
    let grouped = new Map();
    let groupedSource;

    const list = el('div', undefined, 'wsm-books');
    const toolbar = el('div', undefined, 'wsm-actions');

    function validManualKeys() {
        const active = manager.activeKeys;
        return [...manualKeys].filter(k => active.has(k));
    }

    function isSelected(e) {
        return mode === 'manual'
            ? manualKeys.has(entryKey(e.world, e.uid))
            : selectionOf(manager.settings, e.world) === '*' || Boolean(selectionOf(manager.settings, e.world)?.includes(String(e.uid)));
    }

    function visibleEntries() {
        const term = search.value.trim().toLocaleLowerCase();
        return manager.entries.filter(e => {
            if (term && ![e.world, e.comment, ...(e.key ?? []), String(e.uid)].join(' ').toLocaleLowerCase().includes(term)) return false;
            if (filterMode === 'blocked') {
                const s = manager.entryStatus(e);
                return Boolean(s.delay || s.cooldown || s.manual);
            }
            if (filterMode === 'selected') return isSelected(e);
            return true;
        });
    }

    function selectEntry(e, selected) {
        if (mode === 'manual') {
            const k = entryKey(e.world, e.uid);
            if (selected) manualKeys.add(k); else manualKeys.delete(k);
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
            if (mode === 'manual') {
                for (const e of entries) {
                    const key = entryKey(world, e.uid);
                    if (selected) manualKeys.add(key); else manualKeys.delete(key);
                }
            } else {
                const existing = selectionOf(manager.settings, world);
                // Preserve the future-entry semantics of a whole-book selection.
                if (selected && existing === '*') continue;
                const values = new Set(existing === '*' ? (grouped.get(world) ?? []).map(e => String(e.uid)) : existing ?? []);
                for (const e of entries) {
                    if (selected) values.add(String(e.uid)); else values.delete(String(e.uid));
                }
                if (values.size) manager.settings.selection[world] = [...values];
                else delete manager.settings.selection[world];
            }
        }
        if (mode === 'scope') manager.updateSettings({}); else render();
    }

    toolbar.append(
        button('全选结果', () => batchSelection(true)),
        button('取消结果', () => batchSelection(false)),
        button('清空选择', () => {
            if (mode === 'manual') {
                manualKeys.clear();
                render();
            } else {
                manager.updateSettings({ selection: {} });
            }
        }),
        button('刷新列表', () => manager.refresh()),
    );

    const includeConstant = checkbox('常驻（蓝灯）条目也参与自动冷却', manager.settings.includeConstant, includeConstant => manager.updateSettings({ includeConstant }));
    const aiTurns = checkbox('AI 连续回复也算一回合', manager.settings.aiTurns, aiTurns => manager.updateSettings({ aiTurns }));
    const clearButton = button('清除本聊天插件数据', async () => {
        const ctx = manager.context();
        const text = '将删除当前聊天所有楼层（含备选回复）里本插件写入的冷却记录和手动冻结草稿，不影响世界书和聊天内容。确定吗？';
        const ok = typeof ctx.callGenericPopup === 'function' && ctx.POPUP_TYPE?.CONFIRM !== undefined
            ? await ctx.callGenericPopup(text, ctx.POPUP_TYPE.CONFIRM)
            : globalThis.confirm(text);
        if (ok) await manager.clearChatData();
    });
    const dataActions = el('div', undefined, 'wsm-data-actions');
    dataActions.append(clearButton);

    const moreDetails = el('details', undefined, 'wsm-more');
    moreDetails.append(
        el('summary', '更多设置与数据'),
        (() => {
            const inner = el('div', undefined, 'wsm-more-body');
            inner.append(
                includeConstant.wrap,
                aiTurns.wrap,
                el('p', '一个用户消息开启一回合（隐藏的也算）；同一回合内的备选回复、重新生成、继续都沿用该回合。状态显示下一次新回合。解除手动冻结后，自动冷却仍可能生效。', 'wsm-help'),
                dataActions,
            );
            return inner;
        })(),
    );

    const versionNote = el('p', '', 'wsm-help wsm-version');

    body.append(
        storageNotice,
        summary,
        notice,
        orphans,
        coreCard,
        modeTabs,
        hint,
        manualActions,
        search,
        filters,
        toolbar,
        list,
        moreDetails,
        versionNote,
    );

    let lastOrphansKey = '';
    function renderOrphans() {
        const known = manager.adapter.allBooks?.();
        const stale = known ? Object.keys(manager.settings.selection).filter(world => !known.includes(world)) : [];
        const key = stale.join('\0');
        orphans.hidden = !stale.length;
        if (!stale.length) {
            if (lastOrphansKey) { orphans.replaceChildren(); lastOrphansKey = ''; }
            return;
        }
        if (key === lastOrphansKey) return;
        lastOrphansKey = key;
        orphans.replaceChildren(
            el('p', `自动管理范围里有 ${stale.length} 本已不存在的世界书：${stale.join('、')}。它们不会生效，但会让“精细管理”保持开启。`),
            button('清理失效选择', () => {
                const selection = { ...manager.settings.selection };
                for (const world of stale) delete selection[world];
                manager.updateSettings({ selection });
            }),
        );
    }

    function renderControls() {
        enabled.input.checked = manager.settings.enabled;
        automatic.input.checked = manager.settings.automatic;
        includeConstant.input.checked = manager.settings.includeConstant;
        aiTurns.input.checked = manager.settings.aiTurns;
        capEnabled.input.checked = manager.settings.capEnabled;
        capRow.dataset.active = String(Boolean(manager.settings.capEnabled));
        if (document.activeElement !== capLimit.input) capLimit.input.value = manager.settings.capLimit;
        if (document.activeElement !== delay.input) delay.input.value = manager.settings.delay;
        if (document.activeElement !== cooldown.input) cooldown.input.value = manager.settings.cooldown;

        storageNotice.hidden = Boolean(manager.settings.storageNoticeSeen);
        versionNote.textContent = `版本 ${VERSION}` + (manager.hostVersion ? ` · 酒馆 ${manager.hostVersion}` : '') + (manager.hostVersion && !/^1\.19\./.test(manager.hostVersion) ? '（本版本主要在 1.19 上验证）' : '');
        clearButton.disabled = manager.busy || !manager.context().getCurrentChatId();
        renderOrphans();

        const pills = [
            pill(manager.settings.enabled ? '管理已启用' : '管理已暂停', manager.settings.enabled ? 'ok' : 'warn'),
            pill(hasSelection(manager.settings) ? '精细管理' : '全部管理', hasSelection(manager.settings) ? 'accent' : 'neutral'),
            pill(`下一回合：第 ${manager.view.round} 回合`, 'neutral'),
        ];
        if (manager.settings.capEnabled) {
            pills.push(pill(`绿灯上限 ${manager.settings.capLimit} 条${manager.lastCapSkipped > 0 ? `（上次跳过 ${manager.lastCapSkipped} 条）` : ''}`, 'accent'));
        }
        if (manager.view.draft) pills.push(pill('有待生效的手动冻结', 'manual'));
        summary.replaceChildren(...pills);

        notice.textContent = manager.error || (manager.settings.capEnabled && manager.capWarning) || manager.evidenceWarning || manager.notice || '';
        notice.hidden = !notice.textContent;

        scopeTab.setAttribute('aria-selected', String(mode === 'scope'));
        scopeTab.dataset.active = String(mode === 'scope');
        manualTab.setAttribute('aria-selected', String(mode === 'manual'));
        manualTab.dataset.active = String(mode === 'manual');
        hint.dataset.mode = mode;
        hint.textContent = mode === 'scope'
            ? '清空精细选择 = 恢复默认管理全部。整本选择会包含以后新增的条目。'
            : '此处选择只用于临时操作，不会改变自动管理范围。手动冻结从下一次新回合起计时。';

        manualActions.hidden = mode !== 'manual';
        const keys = validManualKeys();
        selectedCount.textContent = `已选 ${keys.length} 项`;
        freezeButton.disabled = thawButton.disabled = !keys.length || !manager.context().getCurrentChatId() || manager.busy;

        for (const [id, btn] of filterButtons) btn.setAttribute('aria-pressed', String(filterMode === id));
    }

    function createBookRecord(world) {
        const book = el('details', undefined, 'wsm-book');
        const heading = el('summary', `${world} · 0 条`);
        const entire = checkbox('整本管理（含新增条目）', false, selected => {
            const all = grouped.get(world) ?? [];
            if (mode === 'scope') {
                if (selected) manager.settings.selection[world] = '*';
                else delete manager.settings.selection[world];
                manager.updateSettings({});
            } else {
                for (const e of all) {
                    const k = entryKey(e.world, e.uid);
                    if (selected) manualKeys.add(k); else manualKeys.delete(k);
                }
                render();
            }
        });
        entire.input.dataset.wsmFocus = `book:${world}`;
        const entriesHost = el('div', undefined, 'wsm-book-entries');
        const emptyNote = el('p', '这本世界书暂无条目。', 'wsm-help');
        emptyNote.hidden = true;
        book.append(heading, entire.wrap, entriesHost, emptyNote);

        const rec = {
            book,
            heading,
            entire,
            entriesHost,
            emptyNote,
            syncingOpen: false,
            lastVisible: [],
            wasOpen: false,
            sliceKey: '',
            rowData: [],
            moreBtn: null,
        };

        book.addEventListener('toggle', () => {
            if (rec.syncingOpen || !book.isConnected) return;
            const autoOpen = Boolean(search.value.trim()) || filterMode !== 'all';
            if (book.open) {
                expanded.add(world);
                userCollapsedFiltered.delete(world);
            } else {
                expanded.delete(world);
                if (autoOpen) userCollapsedFiltered.add(world);
            }
            syncBookEntries(world, rec, rec.lastVisible);
        });

        bookCache.set(world, rec);
        return rec;
    }

    function syncBookEntries(world, rec, entries) {
        rec.lastVisible = entries;
        const limit = limits.get(world) ?? 100;
        const isOpen = rec.book.open;

        if (!isOpen) {
            if (rec.wasOpen || rec.rowData.length || rec.moreBtn) {
                rec.entriesHost.replaceChildren();
                rec.moreBtn = null;
                rec.rowData = [];
                rec.sliceKey = '';
            }
            rec.wasOpen = false;
            return;
        }

        const slice = entries.slice(0, limit);
        const nextSliceKey = `${slice.map(e => `${e.uid}:${e.comment ?? ''}:${(e.key ?? []).join(',')}`).join('\0')}#${entries.length}#${limit}`;
        const needsMore = entries.length > limit;

        if (rec.wasOpen && rec.sliceKey === nextSliceKey) {
            for (const item of rec.rowData) {
                item.pick.input.checked = Boolean(isSelected(item.entry));
                const s = manager.entryStatus(item.entry);
                item.row.dataset.blocked = String(s.blocked);
                syncStatusBadges(item.statusEl, entryBadges(manager, item.entry, s));
            }
            if (rec.moreBtn) rec.moreBtn.textContent = `显示更多（已显示 ${limit} / ${entries.length} 条）`;
            return;
        }

        rec.wasOpen = true;
        rec.sliceKey = nextSliceKey;
        rec.rowData = [];
        const nodes = [];
        for (const e of slice) {
            const row = el('div', undefined, 'wsm-entry');
            const name = e.comment?.trim() || (e.key ?? []).join('、') || `未命名条目 #${e.uid}`;
            const pick = checkbox(name, Boolean(isSelected(e)), selected => selectEntry(e, selected));
            pick.input.dataset.wsmFocus = entryKey(e.world, e.uid);
            const s = manager.entryStatus(e);
            const statusEl = el('div', undefined, 'wsm-entry-status');
            syncStatusBadges(statusEl, entryBadges(manager, e, s));
            row.dataset.blocked = String(s.blocked);
            row.append(pick.wrap, statusEl);
            nodes.push(row);
            rec.rowData.push({ entry: e, row, pick, statusEl });
        }
        if (needsMore) {
            const moreBtn = button(`显示更多（已显示 ${limit} / ${entries.length} 条）`, () => {
                limits.set(world, limit + 100);
                render();
            });
            rec.moreBtn = moreBtn;
            nodes.push(moreBtn);
        } else {
            rec.moreBtn = null;
        }
        rec.entriesHost.replaceChildren(...nodes);
    }

    function renderBooks() {
        const autoOpen = Boolean(search.value.trim()) || filterMode !== 'all';
        if (!autoOpen && lastAutoOpen) userCollapsedFiltered.clear();
        lastAutoOpen = autoOpen;

        const visible = new Map();
        for (const e of visibleEntries()) {
            if (!visible.has(e.world)) visible.set(e.world, []);
            visible.get(e.world).push(e);
        }

        const displayWorlds = manager.bookNames.filter(world => !autoOpen || (visible.get(world)?.length ?? 0) > 0);
        const sig = !manager.bookNames.length
            ? 'empty:no-books'
            : !displayWorlds.length
                ? 'empty:no-match'
                : `books:${displayWorlds.join('\0')}`;

        if (sig !== mountedSig) {
            mountedSig = sig;
            if (!manager.bookNames.length) {
                list.replaceChildren(el('p', '当前没有挂载世界书。请先选择角色或聊天，并挂载世界书。', 'wsm-help'));
                return;
            }
            if (!displayWorlds.length) {
                list.replaceChildren(el('p', '没有匹配的条目。', 'wsm-help'));
                return;
            }
            const nodes = [];
            for (const world of displayWorlds) {
                const rec = bookCache.get(world) ?? createBookRecord(world);
                nodes.push(rec.book);
            }
            list.replaceChildren(...nodes);
        }

        const knownSet = new Set(manager.bookNames);
        for (const world of [...bookCache.keys()]) {
            if (!knownSet.has(world)) bookCache.delete(world);
        }

        for (const world of displayWorlds) {
            const rec = bookCache.get(world) ?? createBookRecord(world);
            const entries = visible.get(world) ?? [];
            const all = grouped.get(world) ?? [];

            const headingText = autoOpen && entries.length !== all.length
                ? `${world} · 匹配 ${entries.length} / ${all.length} 条`
                : `${world} · ${all.length} 条`;
            if (rec.heading.textContent !== headingText) rec.heading.textContent = headingText;

            const wholeLabel = mode === 'scope' ? '整本管理（含新增条目）' : '选择本书全部条目';
            if (rec.entire.text.textContent !== wholeLabel) rec.entire.text.textContent = wholeLabel;
            rec.entire.input.checked = mode === 'scope'
                ? selectionOf(manager.settings, world) === '*'
                : Boolean(all.length && all.every(isSelected));
            rec.entire.input.indeterminate = mode === 'scope' && Array.isArray(selectionOf(manager.settings, world));
            rec.emptyNote.hidden = all.length > 0;

            const shouldOpen = expanded.has(world) || (autoOpen && !userCollapsedFiltered.has(world));
            if (rec.book.open !== shouldOpen) {
                rec.syncingOpen = true;
                rec.book.open = shouldOpen;
                rec.syncingOpen = false;
            }
            syncBookEntries(world, rec, entries);
        }
    }

    function render() {
        const focusToken = document.activeElement?.dataset?.wsmFocus;
        if (session !== manager.sessionRevision) {
            manualKeys.clear();
            expanded.clear();
            userCollapsedFiltered.clear();
            limits.clear();
            bookCache.clear();
            mountedSig = '';
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
        renderControls();
        renderBooks();
        if (focusToken && document.activeElement?.dataset?.wsmFocus !== focusToken) {
            [...root.querySelectorAll('[data-wsm-focus]')].find(node => node.dataset.wsmFocus === focusToken)?.focus({ preventScroll: true });
        }
    }

    search.addEventListener('input', () => {
        limits.clear();
        userCollapsedFiltered.clear();
        render();
    });

    target.append(root);
    render();
    return { render, destroy: () => root.remove(), root, drawer };
}
