/** Development only: npm install --no-save playwright, then npm run test:browser. */
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, relative } from 'node:path';
import assert from 'node:assert/strict';

const { chromium } = await import(process.env.WSM_PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(import.meta.dirname, '..');
const reviewDir = process.env.WSM_REVIEW_DIR ? resolve(process.env.WSM_REVIEW_DIR) : null;
if (reviewDir) await mkdir(reviewDir, { recursive: true });

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = createServer(async (req, res) => {
    const path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    if (relative(root, path).startsWith('..')) { res.writeHead(403).end(); return; }
    try {
        const data = await readFile(path);
        res.setHeader('Content-Type', mime[extname(path)] ?? 'application/octet-stream');
        res.end(data);
    } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

const browser = await chromium.launch({
    executablePath: process.env.WSM_CHROMIUM || '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox'],
});
const results = [];

function inViewport(box, vw, vh) {
    return box && box.width > 0 && box.height > 0 && box.x >= -1 && box.y >= -1 && box.x + box.width <= vw + 1 && box.y + box.height <= vh + 1;
}

function overlaps(a, b) {
    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

try {
    for (const viewport of [{ width: 1280, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 568 }, { width: 740, height: 360 }]) {
        const page = await browser.newPage({ viewport });
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.goto(`http://127.0.0.1:${server.address().port}/tests/preview.html`);
        await page.waitForFunction(() => window.harness?.manager.bookNames.length === 2);

        const wand = page.locator('#worldbook_switch_manager_wand_button');
        assert.equal(await wand.count(), 1);
        await wand.focus();
        await page.keyboard.press('Enter');
        await page.waitForSelector('dialog.popup.wsm-dialog[open]');
        assert.equal(await page.evaluate(() => window.harness.opened), 1);
        await page.locator('.popup .popup-button-ok').click();
        assert.equal(await page.locator('dialog.popup.wsm-dialog[open]').count(), 0);

        await wand.focus();
        await page.keyboard.press('Space');
        await page.waitForSelector('dialog.popup.wsm-dialog[open]');
        assert.equal(await page.evaluate(() => window.harness.opened), 2);
        await page.locator('.popup .popup-button-ok').click();

        await wand.click();
        await page.waitForSelector('dialog.popup.wsm-dialog[open]');
        assert.equal(await page.evaluate(() => window.harness.opened), 3);

        // WB-24: check default visibility and corner-handle geometry BEFORE any scroll calls.
        const dlg = page.locator('dialog.popup.wsm-dialog[open]');
        const closeBtn = dlg.locator('.popup-button-ok');
        const handle = dlg.locator('.wsm-resize-handle');
        const titleEl = dlg.locator('.wsm-title');
        const delayInput = page.getByRole('spinbutton', { name: '延迟回合', exact: true });
        const cooldownInput = page.getByRole('spinbutton', { name: '冷却回合', exact: true });

        assert.equal(await titleEl.innerText(), '世界书自动开关管理器');
        assert.match(await dlg.locator('.wsm-version').innerText(), /版本 1\.3\.2 · 酒馆 1\.19\.0/);
        assert.equal(await dlg.locator('.wsm-more').evaluate(el => el.open), false);

        const [dlgBox, closeBox, handleBox, titleBox, delayBox, cooldownBox, capVisible] = await Promise.all([
            dlg.boundingBox(),
            closeBtn.boundingBox(),
            handle.boundingBox(),
            titleEl.boundingBox(),
            delayInput.boundingBox(),
            cooldownInput.boundingBox(),
            page.getByRole('spinbutton', { name: '单回合绿灯上限（条）', exact: true }).isVisible(),
        ]);
        assert.ok(inViewport(dlgBox, viewport.width, viewport.height), `Dialog outside viewport at ${viewport.width}x${viewport.height}`);
        assert.ok(inViewport(closeBox, viewport.width, viewport.height), `Close button outside viewport at ${viewport.width}x${viewport.height}`);
        assert.ok(inViewport(handleBox, viewport.width, viewport.height), `Resize handle outside viewport at ${viewport.width}x${viewport.height}`);
        assert.ok(inViewport(titleBox, viewport.width, viewport.height), `Title outside viewport at ${viewport.width}x${viewport.height}`);
        assert.ok(Math.abs(delayBox.y - cooldownBox.y) < 4, 'Delay and cooldown inputs should align side-by-side');
        assert.equal(overlaps(closeBox, handleBox), false, 'Close button and resize handle must not overlap');
        assert.equal(capVisible, true);

        // Save default-state screenshots without expanding extra menus.
        await mkdir(resolve(root, 'docs'), { recursive: true });
        if (viewport.width === 390) await page.screenshot({ path: resolve(root, 'docs/mobile-preview.png') });
        if (reviewDir) await page.screenshot({ path: resolve(reviewDir, `${viewport.width}x${viewport.height}-default.png`) });

        // Toolbar buttons must stay crisp and single-line across all viewports (incl. 320px).
        for (const label of ['全选结果', '取消结果', '清空选择', '刷新列表']) {
            const btn = page.getByRole('button', { name: label, exact: true });
            const metrics = await btn.evaluate(el => {
                const r = el.getBoundingClientRect();
                return { h: r.height, sw: el.scrollWidth, cw: el.clientWidth };
            });
            assert.ok(metrics.h <= 48, `${label} wrapped tall (${metrics.h}px) at ${viewport.width}`);
            assert.ok(metrics.sw <= metrics.cw + 1, `${label} clipped (${metrics.sw}>${metrics.cw}) at ${viewport.width}`);
        }

        // Test single bottom-right corner drag resize: shrink -> remember across close/reopen -> enlarge & clamp -> double-click reset.
        const beforeResize = await dlg.boundingBox();
        const startX = handleBox.x + handleBox.width / 2;
        const startY = handleBox.y + handleBox.height / 2;
        await page.mouse.move(startX, startY);
        await page.mouse.down();
        await page.mouse.move(startX - 28, startY - 40, { steps: 6 });
        await page.mouse.up();

        const afterShrink = await dlg.boundingBox();
        assert.ok(afterShrink.width <= beforeResize.width - 10, `Width should shrink at ${viewport.width}`);
        assert.ok(afterShrink.height < beforeResize.height - 20, `Height should shrink at ${viewport.width}`);
        assert.ok(inViewport(await closeBtn.boundingBox(), viewport.width, viewport.height), 'Close button must remain inside viewport after shrink');
        assert.ok(inViewport(await handle.boundingBox(), viewport.width, viewport.height), 'Handle must remain inside viewport after shrink');
        assert.equal(await dlg.locator('.popup-content').evaluate(el => el.scrollWidth > el.clientWidth + 1), false, 'Popup content must not horizontally overflow after shrink');
        if (reviewDir) await page.screenshot({ path: resolve(reviewDir, `${viewport.width}x${viewport.height}-shrunk.png`) });

        await closeBtn.click();
        await wand.click();
        await page.waitForSelector('dialog.popup.wsm-dialog[open]');
        const reopenedBox = await dlg.boundingBox();
        assert.ok(Math.abs(reopenedBox.width - afterShrink.width) <= 2 && Math.abs(reopenedBox.height - afterShrink.height) <= 2, 'Remembered popup size should persist in session');

        const handleAfterReopen = await handle.boundingBox();
        const growStartX = handleAfterReopen.x + handleAfterReopen.width / 2;
        const growStartY = handleAfterReopen.y + handleAfterReopen.height / 2;
        await page.mouse.move(growStartX, growStartY);
        await page.mouse.down();
        await page.mouse.move(growStartX + 180, growStartY + 180, { steps: 6 });
        await page.mouse.up();

        const afterGrow = await dlg.boundingBox();
        assert.ok(afterGrow.width > afterShrink.width + 10, `Width should grow at ${viewport.width}`);
        assert.ok(afterGrow.height > afterShrink.height + 20, `Height should grow at ${viewport.width}`);
        assert.ok(afterGrow.width <= viewport.width - 15 && afterGrow.height <= viewport.height - 15, 'Expanded size must clamp within viewport');

        await handle.dblclick();
        const afterReset = await dlg.boundingBox();
        assert.equal(await dlg.evaluate(el => ({ w: el.style.width, h: el.style.height })).then(s => s.w === '' && s.h === ''), true, 'Double-click should clear inline size');
        assert.ok(Math.abs(afterReset.width - beforeResize.width) <= 2 && Math.abs(afterReset.height - beforeResize.height) <= 2, 'Double-click should restore default popup size');

        // Regression test: changing a number input and immediately clicking book <summary> WITHOUT .blur() must NOT swallow the click!
        const capInput = page.getByRole('spinbutton', { name: '单回合绿灯上限（条）', exact: true });
        await capInput.focus();
        await capInput.selectText();
        await page.keyboard.type('3');
        await page.getByText('原神综合世界书 · 2 条', { exact: true }).click();
        assert.equal(await page.evaluate(() => window.harness.manager.settings.capLimit), 3);
        assert.equal(await page.getByRole('checkbox', { name: '雷电将军', exact: true }).isVisible(), true, 'Book must open on first click even when blurring number input');

        // Verify touch-style double-tap reset path on handle as well (without breaking keyboard/mouse flow).
        if (viewport.width === 390) {
            const hb = await handle.boundingBox();
            const tx = hb.x + hb.width / 2;
            const ty = hb.y + hb.height / 2;
            await page.mouse.move(tx, ty);
            await page.mouse.down();
            await page.mouse.move(tx - 20, ty - 25, { steps: 4 });
            await page.mouse.up();
            assert.notEqual(await page.evaluate(() => window.harness.getPopupSize()), null);
            await handle.evaluate(el => {
                el.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 9, pointerType: 'touch', bubbles: true, cancelable: true }));
                el.dispatchEvent(new PointerEvent('pointerup', { pointerId: 9, pointerType: 'touch', bubbles: true, cancelable: true }));
                el.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 9, pointerType: 'touch', bubbles: true, cancelable: true }));
                el.dispatchEvent(new PointerEvent('pointerup', { pointerId: 9, pointerType: 'touch', bubbles: true, cancelable: true }));
            });
            assert.equal(await page.evaluate(() => window.harness.getPopupSize()), null, 'Touch double-tap should reset popup size');
        }

        const capToggle = page.getByRole('checkbox', { name: '启用单回合绿灯触发上限（用户提及优先）', exact: true });
        await capToggle.check();
        assert.match(await dlg.locator('.wsm-scope').innerText(), /绿灯上限 3 条/);
        assert.equal(await dlg.locator('.wsm-notice[role="status"]').isVisible(), false);
        await capToggle.uncheck();
        await capInput.fill('5');
        await capInput.blur();
        assert.equal(await page.evaluate(() => window.harness.manager.settings.capEnabled), false);
        assert.equal(await page.evaluate(() => window.harness.manager.settings.capLimit), 5);

        // Low-frequency collapsible section checks.
        await dlg.locator('.wsm-more > summary').click();
        assert.equal(await page.getByRole('checkbox', { name: '常驻（蓝灯）条目也参与自动冷却', exact: true }).isVisible(), true);
        assert.equal(await page.getByRole('checkbox', { name: 'AI 连续回复也算一回合', exact: true }).isVisible(), true);
        assert.equal(await page.getByRole('button', { name: '清除本聊天插件数据', exact: true }).isVisible(), true);
        await dlg.locator('.wsm-more > summary').click();

        await page.getByRole('checkbox', { name: '雷电将军', exact: true }).check();
        assert.match(await dlg.locator('.wsm-scope').innerText(), /精细管理/);
        const selection = await page.evaluate(() => JSON.stringify(window.harness.manager.settings.selection));
        assert.deepEqual(JSON.parse(selection), { '原神综合世界书': ['1'] });

        const first = await page.evaluate(() => window.harness.round());
        assert.ok(first.includes('雷电将军'));
        const second = await page.evaluate(() => window.harness.round());
        assert.ok(!second.includes('雷电将军'));
        assert.ok(second.includes('提瓦特世界规则'));
        const redo = await page.evaluate(() => window.harness.round({ regenerate: true }));
        assert.ok(!redo.includes('雷电将军'));
        assert.equal(await page.evaluate(() => window.harness.manager.state.clock), 2);
        const third = await page.evaluate(() => window.harness.round());
        assert.ok(third.includes('雷电将军'));

        // Quick filter pill: after round 3 injected 雷电将军, round 4 (next) shows it in auto-cooldown.
        await page.getByRole('button', { name: '冷却或冻结中', exact: true }).click();
        assert.equal(await page.getByRole('checkbox', { name: '雷电将军', exact: true }).isVisible(), true);
        assert.equal(await page.getByRole('checkbox', { name: '提瓦特世界规则', exact: true }).isVisible(), false);
        await page.getByRole('button', { name: '全部', exact: true }).click();

        // Segmented mode tab -> manual freeze.
        await page.getByRole('tab', { name: '临时手动冻结', exact: true }).click();
        assert.equal(await page.getByRole('tab', { name: '临时手动冻结', exact: true }).getAttribute('aria-selected'), 'true');
        await page.getByRole('checkbox', { name: '雷电将军', exact: true }).check();
        await page.getByRole('button', { name: '冻结所选', exact: true }).click();
        assert.equal(await page.evaluate(() => JSON.stringify(window.harness.manager.settings.selection)), selection);
        assert.match(await dlg.locator('.wsm-entry').first().innerText(), /手动冻结剩余 1 回合/);
        if (reviewDir && viewport.width === 390) {
            await dlg.locator('.wsm-entry-status').first().scrollIntoViewIfNeeded();
            await page.screenshot({ path: resolve(reviewDir, `${viewport.width}x${viewport.height}-manual.png`) });
            await dlg.locator('.wsm-version').scrollIntoViewIfNeeded();
            await page.screenshot({ path: resolve(reviewDir, `${viewport.width}x${viewport.height}-footer.png`) });
        }

        await page.getByRole('button', { name: '解除手动冻结', exact: true }).click();
        assert.match(await dlg.locator('.wsm-entry').first().innerText(), /自动冷却/);

        await page.getByRole('tab', { name: '自动管理范围', exact: true }).click();
        await page.getByRole('button', { name: '清空选择', exact: true }).click();
        assert.match(await dlg.locator('.wsm-scope').innerText(), /全部管理/);

        await page.getByRole('button', { name: '已勾选', exact: true }).click();
        assert.match(await dlg.locator('.wsm-books').innerText(), /没有匹配的条目/);
        await page.getByRole('button', { name: '全部', exact: true }).click();

        await page.evaluate(async () => { window.harness.ctx.chat = []; await window.harness.events.emit('CHAT_CHANGED'); });
        await capInput.fill('1');
        await capInput.blur();
        await capToggle.check();
        assert.equal(await dlg.locator('.wsm-notice[role="status"]').isVisible(), false);
        const capped = await page.evaluate(() => window.harness.round());
        assert.deepEqual(capped, ['雷电将军', '提瓦特世界规则']);
        assert.match(await dlg.locator('.wsm-scope').innerText(), /绿灯上限 1 条（上次跳过 1 条）/);

        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        assert.equal(await dlg.locator('.popup-content').evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
        await closeBtn.click();
        await page.evaluate(() => window.harness.launcher.destroy());
        assert.equal(await page.locator('#worldbook_switch_manager_wand_container').count(), 0);
        assert.deepEqual(errors, []);

        results.push({
            viewport,
            result: 'PASS',
            checks: [
                'magic wand menu item: Enter/Space/click opens popup,关闭 returns instance, destroy removes item',
                'zero-scroll initial visibility of title, version 1.3.2, side-by-side delay/cooldown, close button, and bottom-right resize handle without overlap',
                'single corner drag resize shrink/remember/enlarge-clamp/double-click reset',
                'first-click book expand directly from focused number input (no swallowed click)',
                'single-line toolbar buttons & segmented tabs & quick filters & semantic badges',
                'three-turn cooldown with regeneration, manual/auto co-existence, clear -> all, live green-cap via WORLDINFO_SCAN_DONE',
                'no horizontal overflow & zero page errors',
            ],
        });
        await page.close();
    }

    // Fallback inline drawer check (?mode=inline)
    {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.goto(`http://127.0.0.1:${server.address().port}/tests/preview.html?mode=inline`);
        await page.waitForFunction(() => window.harness?.manager.bookNames.length === 2);
        await page.locator('.wsm > details > summary').click();
        assert.equal(await page.locator('.wsm > details > summary').innerText(), '世界书自动开关管理器');
        assert.match(await page.locator('.wsm-version').innerText(), /版本 1\.3\.2/);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        assert.deepEqual(errors, []);
        results.push({ viewport: { width: 390, height: 844 }, mode: 'inline-fallback', result: 'PASS', checks: ['fallback details drawer opens cleanly without horizontal overflow or errors'] });
        await page.close();
    }

    // 10,000-entry UI stress check inside popup
    {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
        const stressErrors = [];
        page.on('pageerror', e => stressErrors.push(e.message));
        await page.goto(`http://127.0.0.1:${server.address().port}/tests/preview.html`);
        await page.waitForFunction(() => window.harness?.manager.bookNames.length === 2);
        await page.locator('#worldbook_switch_manager_wand_button').click();
        await page.waitForSelector('dialog.popup.wsm-dialog[open]');

        const loadMs = await page.evaluate(() => {
            const start = performance.now();
            const m = window.harness.manager;
            m.entries = Array.from({ length: 10000 }, (_, i) => ({ world: `压力世界书 ${Math.floor(i / 500)}`, uid: i % 500, comment: `压力人物 ${Math.floor(i / 500)}-${i % 500}`, key: [], content: 'test' }));
            m.bookNames = Array.from({ length: 20 }, (_, i) => `压力世界书 ${i}`);
            m.onChange();
            return performance.now() - start;
        });
        assert.equal(await page.locator('.wsm-entry').count(), 0);
        await page.getByText('压力世界书 0 · 500 条', { exact: true }).click();
        await page.waitForFunction(() => document.querySelectorAll('.wsm-entry').length === 100);
        await page.getByRole('button', { name: '显示更多（已显示 100 / 500 条）', exact: true }).click();
        assert.equal(await page.locator('.wsm-entry').count(), 200);
        await page.getByRole('button', { name: '全选结果', exact: true }).click();
        assert.equal(await page.evaluate(() => Object.values(window.harness.manager.settings.selection).reduce((n, v) => n + v.length, 0)), 10000);
        await page.getByRole('tab', { name: '临时手动冻结', exact: true }).click();
        await page.getByRole('button', { name: '全选结果', exact: true }).click();
        await page.getByRole('button', { name: '冻结所选', exact: true }).click();
        assert.equal(await page.evaluate(() => Object.keys(window.harness.manager.state.manual).length), 10000);

        const client = await page.context().newCDPSession(page);
        await client.send('HeapProfiler.collectGarbage');
        const before = (await client.send('Runtime.getHeapUsage')).usedSize;
        const repeatMs = await page.evaluate(() => {
            const start = performance.now();
            for (let i = 0; i < 200; i++) window.harness.manager.onChange();
            return performance.now() - start;
        });
        await page.waitForTimeout(100);
        await client.send('HeapProfiler.collectGarbage');
        const after = (await client.send('Runtime.getHeapUsage')).usedSize;
        assert.ok(after - before < 20 * 1024 * 1024, 'Repeated rendering retained more than 20 MiB');
        assert.equal(await page.locator('.wsm-entry').count(), 200);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);

        await page.evaluate(() => {
            const h = window.harness;
            h.ctx.chat = [];
            h.ctx.chatMetadata = {};
            return h.events.emit('CHAT_CHANGED');
        });
        assert.equal(await page.evaluate(() => Object.keys(window.harness.manager.state.manual).length), 0);
        assert.match(await page.locator('.wsm-manual').innerText(), /已选 0 项/);
        assert.deepEqual(stressErrors, []);

        results.push({
            viewport: { width: 390, height: 844 },
            result: 'PASS',
            stress: {
                entries: 10000,
                books: 20,
                initialRenderedEntryRows: 0,
                expandedEntryRows: 200,
                manualFrozenEntries: 10000,
                repeatRenders: 200,
                initialRenderMs: Math.round(loadMs),
                repeatRenderTotalMs: Math.round(repeatMs),
                retainedHeapGrowthBytes: after - before,
            },
            checks: [
                'lazy and paged rendering inside resizable popup',
                'bulk scope and manual selection across all 10,000 entries',
                'switching to another chat shows empty manual state and clears picks',
                'no horizontal overflow or browser exceptions',
                'bounded retained heap after garbage collection',
            ],
        });
        await page.close();
    }

    await writeFile(resolve(root, 'docs/browser-results.json'), JSON.stringify({ environment: 'Isolated mock host, Chromium; not live SillyTavern or physical Android', results }, null, 2) + '\n');
    console.log(JSON.stringify(results, null, 2));
} finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
}
