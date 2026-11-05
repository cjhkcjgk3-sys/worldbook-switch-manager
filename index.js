import { Manager } from './controller.js';
import { createAdapter } from './host-adapter.js';
import { mountUI } from './ui.js';

let manager, ui;
let boot = 0;
let readyListener;
let failurePanel;

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
    ui?.destroy(); ui = undefined;
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
async function initialize() {
    if (manager) return;
    const run = ++boot;
    try {
        const response = await fetch('/version');
        if (!response.ok) throw new Error('无法读取酒馆版本。');
        const version = await response.json();
        // Internal read-only module contracts are verified for this minor series.
        if (!/^1\.19\.\d+(?:\+.*)?$/.test(version.pkgVersion ?? '')) {
            throw new Error(`当前版本 ${version.pkgVersion ?? '未知'}；此安装包支持 SillyTavern 1.19.x 正式版。`);
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
        const target = document.querySelector('#extensions_settings2') ?? document.querySelector('#extensions_settings');
        if (!target) throw new Error('未找到扩展设置面板。');
        manager = new Manager(getContext, createAdapter(wi, regex, openai), () => ui?.render());
        manager.start();
        ui = mountUI(manager, target);
    } catch (error) {
        if (run !== boot) return;
        manager?.stop(); manager = undefined;
        showFailure(error.message);
    }
}
