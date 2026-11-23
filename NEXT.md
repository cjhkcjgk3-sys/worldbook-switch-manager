# 分支修复续接（未发布）

- 工作树：`/workspace/wsm-fix-v131-local`；本地分支：`fix/v1.3.1-native-cap-local`；基于`89841eb6632a5ef89e91100ac98ecc154736874f`修复；当前提交以`git log`为准。
- 原生最终接受Map裁剪，同回合成功名额写`d.cap`；用户已接受先前递归/预算/分组不回滚，最多N不保证填满。旧模拟扫描、多深度全文缓存和regenerate再次截尾已移除。
- 默认关闭；缺钩子时上限明确停用；冷却/冻结保留。候选保守名额与实际注入`inj`不同，旧无cap记录不追溯。
- 97/97单测、check、7/7压力、14/14矩阵及7个提取原生扫描CPU样例通过；真实页面仅确认加载并观察过生成/继续；多个绿灯候选对照未建立，限额/continue未验收，停止重生成/swipe未测；完整前端和手机尚未验收。
- 用户已授权提交并推送独立修复分支；不开PR、不评论、不合并、不打包。推送不代表真实验收通过。原工作区和审核报告/证据保留。

---

以下为原提交续接记录（历史）：

# 唯一续接记录

当前目标：1.3.1 深度融合完成（分支 `feat/v1.3.1-timeline-greencap`，基于 `origin/feat/v1.3.0-timeline` 融合 2026-11-22 本地未提交改动；原本地草稿已备份于本地分支 `backup/local-v1.3.0-20261122`，均暂未推送远端）。

版本：1.3.1。保留 1.3.0 聊天楼层时间线持久化架构（锚点 `extra.wsm.s`、回复/备选 `extra.wsm.d`、草稿 `chatMetadata.wsm_draft`、单一蓝灯开关 `includeConstant` 并自动兼容迁移旧 `protectConstant`），新增可设置的「启用单回合绿灯触发上限（用户提及优先）」（默认关）与常驻可调数字框「单回合绿灯上限（条）」（默认 5）。`selectGreenCapVictims` 采用聊天尾部逆向截取最多 `maxDepth` 条非系统消息，按「最新用户消息 > 较早用户消息 > 仅模型回复」优先级保留前 N 条并按 `(world, uid)` 去重，支持 `scanDepth === 0` 跳过；`controller.filter` 对 `swipe`/`regenerate` 精准排除旧回复（不误伤 `continue` 与 `aiTurns` 锚点），且仅主生成扫描更新 `lastCapSkipped`。

关键时序（1.19.0 实测，见 docs/VALIDATION.md）：流式 ENDED 在 MESSAGE_RECEIVED 之前，非流式相反；每次生成后有一次 dryRun 的 GENERATION_STARTED；工具调用后续请求以 GENERATION_STARTED('normal') 开始；swipe 在 GENERATION_STARTED 前已复制 extra；regenerate 在 STARTED 后、WORLDINFO_ENTRIES_LOADED 前删除旧回复；MESSAGE_RECEIVED 后酒馆自动保存聊天。

兼容：以 1.19.0（06bde939fb1e9c4c8d8641d810f0a916b5bce127）为准；1.18.x 能加载，1.3.x 未完整重测。

已验证（1.3.1 本轮）：
- `npm test`：85/85 通过（含迁移、绿灯上限优先级/逻辑/`scanDepth===0`/尾部扫描、时间线回退/分支/重摇/静默与预览防覆盖/`MESSAGE_UPDATED` 共存回归）。
- `npm run check`：通过（manifest/package/core 版本 `1.3.1`、钩子、语法、能力合同）。
- `npm run test:stress`：6 项全通过，含 4 万楼层 + 1 万有关键词绿灯条目开启上限（上限 5 条）50 次扫描（p50 11.51ms / p95 22.4ms）。
- `npm run test:browser`（Playwright + 本机 Chrome 驱动 `tests/preview.html` 模拟宿主）：1280×1000、390×844、320×568、740×360 四种视口及 1 万条目滚动/堆内存压力全通过（0 横向溢出，0 报错，核对版本 `1.3.1` 及「单回合绿灯上限（条）」控件可见与状态联动）。
- 1.3.0 基线历史证据保留在 `docs/VALIDATION.md`（1.19.0 隔离实例 52/52、review 21/21、stop 24/24）。

未验证：1.3.1 尚未在官方 SillyTavern 1.19.0 隔离实例重跑 e2e；尚未在用户自己的酒馆与真实模型、Text Completion 后端、SillyDroid 手机实机验证；MVU、记忆类插件与本插件同时写 extra 的情况未测；酒馆助手 `setChatMessages` 传入 `extra` 时会整体替换 extra（源码所见，运行中未丢失）。

下一步：由用户审阅本地分支 `feat/v1.3.1-timeline-greencap` 改动后决定是否推送远端（或合并 PR #1），并在真实酒馆与实机上按 `docs/ACCEPTANCE.md` 试跑绿灯上限与时间线联动。
