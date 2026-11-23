# 唯一续接记录

当前目标：1.3.0 时间线模型（分支 `feat/v1.3.0-timeline`，待用户审 PR 后合并）。

版本：1.3.0。冷却/手动冻结不再放在页面内存，而是写在聊天楼层上：用户消息（锚点）`extra.wsm.s` 存回合开始时的状态快照，AI 回复及其当前备选的 `extra.wsm.d` 存那次请求实际注入的条目；手动冻结先存为 `chatMetadata.wsm_draft`（绑定当时最后一个快照 id），下一次回复完成时并入快照。状态 = 最后一个有快照的锚点 + 其后匹配的回复记录 + 之后的锚点计数。没有任何“修改历史就重置”的逻辑。

关键时序（1.19.0 实测，见 docs/VALIDATION.md）：流式 ENDED 在 MESSAGE_RECEIVED 之前，非流式相反；每次生成后有一次 dryRun 的 GENERATION_STARTED；工具调用后续请求以 GENERATION_STARTED('normal') 开始；swipe 在 GENERATION_STARTED 前已复制 extra；MESSAGE_RECEIVED 后酒馆自动保存聊天。

兼容：以 1.19.0（06bde939fb1e9c4c8d8641d810f0a916b5bce127）为准；1.18.x 能加载，未重测。

已验证：npm test 67/67；npm run check；模拟页三种尺寸；长聊天/1 万条目压力；官方 1.19.0 隔离实例 52/52 端到端（含酒馆助手 4.12.2 同时加载）。

未验证：用户自己的酒馆与真实模型；Text Completion 后端；SillyDroid 手机；MVU、记忆类插件与本插件同时写 extra 的情况；酒馆助手 `setChatMessages` 传入 `extra` 时会整体替换 extra（源码所见，运行中未丢失）。

下一步：用户审 PR 并实机试用；根据反馈调整默认值（蓝灯、AI 连续回复）。
