/**
 * Entry point: mount the manager panel behind the main-page magic wand menu.
 * Clicking the wand item opens the panel in a host popup; closing the popup
 * returns the same panel instance to a hidden host so its transient UI state
 * (search, expanded books, manual selection) survives between openings.
 */
import { supportedVersion, isCompatibleVersion } from './core.js';
import { Manager } from './controller.js';
import { createAdapter } from './host-adapter.js';
import { createLauncher } from './launcher.js';
import { mountUI } from './ui.js';

let manager, ui, popup, launcher, uiHost, failurePanel;
let boot = 0;
let readyListener;

export function activate() {
    // Synchronous load hook: attach only; asynchronous setup runs after APP_READY.
    const ctx = globalThis.SillyTavern?.getContext?.();
    if (!ctx) return showFailure('无法读取酒馆运行环境。');
    if (readyListener || manager) return;
    readyListener = () => { void initialize(); };
    ctx.eventSource.on(ctx.eventTypes.APP_READY, readyListener);
}
export function enable() { void initialize(); }
export function disable() {
    boot++;
    const ctx = globalThis.SillyTavern?.getContext?.();
    if (readyListener) ctx?.eventSource.removeListener(ctx.eventTypes.APP_READY, readyListener);
    readyListener = null;
    manager?.stop(); manager = undefined;
    const openPopup = popup; popup = undefined;
    if (openPopup?.complete) {
        try { Promise.resolve(openPopup.complete(ctx?.POPUP_RESULT?.NEGATIVE ?? 0)).catch(() => {}); } catch { /* popup already gone */ }
    }
    const view = ui; ui = undefined; view?.destroy();
    launcher?.destroy(); launcher = undefined;
    uiHost?.remove(); uiHost = undefined;
    failurePanel?.remove(); failurePanel = undefined;
}
function showFailure(message) {
    failurePanel?.remove();
    const node = document.createElement('p');
    node.className = 'wsm wsm-notice';
    node.textContent = `世界书自动开关管理器未启动：${message}`;
    (document.querySelector('#extensions_settings2') ?? document.querySelector('#extensions_settings') ?? document.body).append(node);
    failurePanel = node;
}
function openPanel() {
    if (!ui || popup) return;
    const ctx = globalThis.SillyTavern?.getContext?.();
    if (typeof ctx?.Popup !== 'function') return;
    ui.drawer.open = true;
    const content = document.createElement('div');
    content.className = 'wsm-popup';
    content.append(ui.root);
    popup = new ctx.Popup(content, ctx.POPUP_TYPE.TEXT, '', {
        okButton: '关闭',
        wide: true,
        allowVerticalScrolling: true,
        leftAlign: true,
        onClosing: () => {
            popup = undefined;
            if (uiHost && ui?.root) uiHost.append(ui.root);
            return true;
        },
    });
    const instance = popup;
    // Let the host's document click handler close the wand dropdown before the
    // modal opens; opening it synchronously keeps the menu floating behind it.
    setTimeout(() => {
        if (popup !== instance) return;
        Promise.resolve(instance.show()).catch(() => {
            if (popup === instance) popup = undefined;
            if (uiHost && ui?.root) uiHost.append(ui.root);
        });
    }, 0);
}
async function initialize() {
    if (manager) return;
    const run = ++boot;
    try {
        const response = await fetch('/version');
        if (!response.ok) throw new Error('无法读取酒馆版本。');
        const version = await response.json();
        // Internal read-only module contracts are verified for this minor series.
        if (!supportedVersion(version.pkgVersion)) {
            if (!isCompatibleVersion(version.pkgVersion)) {
                throw new Error(`当前版本 ${version.pkgVersion ?? '未知'} 过低；此扩展需要 SillyTavern 1.18.0 或更高版本。`);
            }
            console.warn(`世界书自动开关管理器：当前酒馆版本 (${version.pkgVersion}) 未在 1.18/1.19 正式版核对列表中，将尝试通过能力契约检查进行兼容运行。`);
        }
        const [wi, regex, openai] = await Promise.all([
            import('/scripts/world-info.js'),
            import('/scripts/extensions/regex/engine.js'),
            import('/scripts/openai.js'),
        ]);
        if (run !== boot) return;
        if (!Array.isArray(wi.selected_world_info) || typeof wi.world_info !== 'object' || !wi.world_info_position || typeof regex.getRegexedString !== 'function' || typeof regex.getRegexScripts !== 'function') {
            throw new Error('原生世界书模块与支持版本不一致。');
        }
        const getContext = () => globalThis.SillyTavern.getContext();
        manager = new Manager(getContext, createAdapter(wi, regex, openai), () => ui?.render());
        manager.start();
        const ctx = getContext();
        const menu = document.querySelector('#extensionsMenu');
        if (menu && typeof ctx.Popup === 'function' && typeof ctx.POPUP_TYPE?.TEXT === 'number') {
            uiHost = document.createElement('div');
            uiHost.id = 'worldbook_switch_manager_storage';
            uiHost.hidden = true;
            document.body.append(uiHost);
            ui = mountUI(manager, uiHost, { open: false });
            launcher = createLauncher(menu, openPanel);
        } else {
            // Hosts without the wand menu keep the previous settings-panel entry.
            const target = document.querySelector('#extensions_settings2') ?? document.querySelector('#extensions_settings');
            if (!target) throw new Error('未找到扩展设置面板。');
            console.warn('世界书自动开关管理器：未找到魔术棒菜单，退回扩展设置面板。');
            ui = mountUI(manager, target);
        }
    } catch (error) {
        if (run !== boot) return;
        manager?.stop(); manager = undefined;
        const view = ui; ui = undefined; view?.destroy();
        launcher?.destroy(); launcher = undefined;
        uiHost?.remove(); uiHost = undefined;
        showFailure(error.message);
    }
}
