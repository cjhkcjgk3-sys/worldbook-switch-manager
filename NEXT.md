# 唯一续接记录

当前目标：1.3.1 已完成最终缺陷修复与验证整合，准备合并至 `main`（分支 `fix/v1.3.1-native-cap-local`；原 2026-11-22 本地草稿仍保留于本地分支 `backup/local-v1.3.0-20261122`）。

版本：1.3.1。保留 1.3.0 聊天楼层时间线持久化架构（锚点 `extra.wsm.s`、回复/备选 `extra.wsm.d`、草稿 `chatMetadata.wsm_draft`、单一蓝灯开关 `includeConstant` 并自动兼容迁移旧 `protectConstant`），新增可设置的「启用单回合绿灯触发上限（用户提及优先）」（默认关）与常驻可调数字框「单回合绿灯上限（条）」（默认 5）。通过 `WORLDINFO_SCAN_DONE` 在原生完整扫描最后一轮（含达到 `maxRecursionSteps`）直接裁剪原生接受 Map，以 `extra.wsm.d.cap` 在可见时间线上记录同回合累计预留名额（与自动冷却 `d.inj` 独立；`continue` 与工具调用共享名额；停止/失败不提交；缺钩子时明确停用上限并提示）。

关键时序（1.19.0 实测，见 docs/VALIDATION.md）：流式 ENDED 在 MESSAGE_RECEIVED 之前，非流式相反；每次生成后有一次 dryRun 的 GENERATION_STARTED；工具调用后续请求以 GENERATION_STARTED('normal') 开始；swipe 在 GENERATION_STARTED 前已复制 extra；regenerate 在 STARTED 后、WORLDINFO_ENTRIES_LOADED 前删除旧回复；MESSAGE_RECEIVED 后酒馆自动保存聊天。

兼容：以 1.19.0（06bde939fb1e9c4c8d8641d810f0a916b5bce127）为准；1.18.x 源码同样具备 `WORLDINFO_SCAN_DONE` 且可加载，1.3.x 未完整重测。

已验证（1.3.1 本轮）：
- `npm test`：99/99 通过（含原生扫描裁剪、同回合 `d.cap` 预留与回退/分支/备选/工具链、`automatic: false` 不误报取证警告、`continue` 仅剩蓝灯时保留 `lastCapSkipped`、128MB 独立堆 600 深度回归、`MESSAGE_UPDATED` 共存等）。
- `npm run check`：通过（manifest/package/core 版本 `1.3.1`、钩子、JS 语法、能力合同）。
- `npm run test:stress`：7/7 通过（含 4 万楼层 + 1 万有关键词绿灯条目开启上限 5 条扫描 p50 2.86ms / p95 6.05ms；600 种不同深度 5.32MB 堆增长）。
- `npm run test:browser`（Playwright + 本机 Chrome 驱动 `tests/preview.html` 模拟宿主）：5/5 通过（`1280×1000`、`390×844`、`320×568`、`740×360` 四视口验证 `WORLDINFO_SCAN_DONE` 现场截断与「上次跳过 1 条」、无横向溢出、版本 `1.3.1` 与控件可调，以及 1 万条目内存压力 65,840 B）。
- 1.3.1 先前补充（d3a0c4a 阶段）：提取 ST 1.19.0 完整 `checkWorldInfo` 与提示词组装 CPU 7 个样例通过（部分依赖为测试替身）；仓库外 14/14 确定性交互通过；真实页面曾做部分加载与生成/继续冒烟（未建多绿灯同时激活对照，故绿灯上限实机效果未算通过）。
- 1.3.0 基线历史证据保留在 `docs/VALIDATION.md`（1.19.0 隔离实例 52/52、review 21/21、stop 24/24）。

未验证：1.3.1 尚未在官方 SillyTavern 1.19.0 隔离实例重跑完整 52/21/24 项 e2e 与多绿灯同时达标对照（含 `continue` 限额、停止重生成与 `swipe` 实机）；尚未在用户自己的酒馆、真实模型、Text Completion 后端、SillyDroid 手机实机验证；MVU、记忆类插件与本插件同时写 `extra` 未测；酒馆助手 `setChatMessages` 传入 `extra` 时会整体替换 extra（源码所见，运行中未丢失）。

下一步：在用户自己的酒馆与实机上按 `docs/ACCEPTANCE.md` 与多绿灯场景验收绿灯上限、`continue` 与 `swipe` 联动；确认后可视需要发布新版或关闭遗留 PR #1（`feat/v1.3.0-timeline` 已被 `main` 包含时会自动关联/可关闭）。
