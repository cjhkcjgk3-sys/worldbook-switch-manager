# 唯一续接记录

当前目标：1.3.2（UI 层次重构 + 酒馆原生弹窗右下角单点位拖拽缩放）已完成全部代码改造与本地全套验证，准备合并至 `main` 并推送远端。

版本：1.3.2。核心冷却逻辑、楼层时间线持久化架构（`extra.wsm.s` / `extra.wsm.d` / `chatMetadata.wsm_draft`）、单一蓝灯开关 `includeConstant` 及 `WORLDINFO_SCAN_DONE` 单回合绿灯上限与 1.3.1 完全一致、零格式变更。UI 层在保留原生 `.popup` 底部固定「关闭」按钮的前提下，新增单一 `.wsm-resize-handle` 右下角拖拽调尺寸（双击/双点复位、会话内记忆、安全视口夹紧防安卓软键盘塌缩）、高/低频折叠分层、「自动管理范围 / 临时手动冻结」分段切换、快速筛选胶囊、320px 单行四字工具栏按钮、语义状态徽章及局部 DOM 增量更新（消除数字框失焦触发列表重建导致的首次点击被吞）。

关键时序（1.19.0 实测，见 docs/VALIDATION.md）：流式 ENDED 在 MESSAGE_RECEIVED 之前，非流式相反；每次生成后有一次 dryRun 的 GENERATION_STARTED；工具调用后续请求以 GENERATION_STARTED('normal') 开始；swipe 在 GENERATION_STARTED 前已复制 extra；regenerate 在 STARTED 后、WORLDINFO_ENTRIES_LOADED 前删除旧回复；MESSAGE_RECEIVED 后酒馆自动保存聊天。

兼容：以 1.19.0（06bde939fb1e9c4c8d8641d810f0a916b5bce127）为准；1.18.x 源码同样具备魔术棒菜单、`Popup` 与 `WORLDINFO_SCAN_DONE` 且保留设置面板退回分支，1.3.x 未完整重测。

已验证（1.3.2 本轮）：
- `npm test`：102/102 通过（原 99 项全部通过 + 新增 `tests/ui-helpers.test.js` 3 项视口尺寸夹紧与安卓软键盘缩窗边界检查）。
- `npm run check`：通过（manifest/package/core 版本 `1.3.2`、钩子导出、JS 语法、能力合同）。
- `npm run test:stress`：7/7 通过（含 4 万楼层 + 1 万有关键词条目开启上限 5 条扫描 p50 2.38ms / p95 5.13ms；600 种深度 128MB 检查 -10.48MB）。
- `npm run test:browser`（Playwright + 本机 Chrome 驱动 `tests/preview.html` 模拟原生 `.popup` 宿主）：6/6 通过（`1280×1000`、`390×844`、`320×568`、`740×360` 四视口无滚动首屏可见、右下角拖拽缩小/放大/边界夹紧/关闭重开记忆/双击及触摸双点复位、数字框输入直接点击 `<summary>` 首次即展开、320px 四字工具栏单行、分段标签与快速筛选、现场 `WORLDINFO_SCAN_DONE` 限额、`?mode=inline` 设置面板退回、以及 1 万条目堆增长 66,192 B），并人工逐图检查了四视口截图。
- 1.3.0 基线历史证据保留在 `docs/VALIDATION.md`（1.19.0 隔离实例 52/52、review 21/21、stop 24/24）。

未验证：1.3.1/1.3.2 尚未在官方 SillyTavern 1.19.0 隔离实例重跑端到端（`tests/e2e/e2e.mjs` E12 已同步新版选择器但未接入真实例跑完，且未测真实 1.19 弹窗主题 CSS 与多绿灯达标对照）；尚未在用户自己的酒馆、真实模型、Text Completion 后端、SillyDroid 安卓真机触摸手势验证；MVU、记忆类插件与本插件同时写 `extra` 未测。

下一步：在用户自己的酒馆与 SillyDroid 手机实机上按 `docs/ACCEPTANCE.md` 验收魔术棒弹窗拖拽手感（重点核对各主题下右下角手柄与「关闭」按钮间距、长列表滚动）及多绿灯 `continue`/`swipe` 联动。
