# 真实酒馆端到端检查（开发用）

在**单独**的 SillyTavern 1.19 实例上运行，不要指向自己日常使用的酒馆。

1. 克隆官方 1.19.0，`npm ci`，用独立数据目录和端口启动：
   `node server.js --port 8123 --dataRoot <测试数据目录> --listen false --browserLaunchEnabled false`
2. 启动本地模拟模型：`node tests/e2e/mock-openai.mjs`（端口 8124，`MOCK_LOG` 指定请求日志）。
   用户消息含 `MOCKFAIL` 返回 500，含 `MOCKTOOL` 返回工具调用，含 `MOCKSLOW` 慢速流式。
3. 测试数据：Chat Completion → Custom，地址 `http://127.0.0.1:8124/v1`；全局世界书 `WSMTest`
   （uid0 关键词 dragon 正文 `WSM_DRAGON_LORE…`，uid1 常驻 `WSM_CONST_ALPHA…`，uid2 关键词 castle 正文 `WSM_CASTLE_LORE…`）；
   角色 Seraphina；群聊 `ProbeGroup`（两名成员）。把本仓库放进 `<数据目录>/default-user/extensions/`。
4. `npm i --no-save playwright-core` 后运行：`WSM_ST_DATA=<数据目录>/default-user MOCK_LOG=<日志> node tests/e2e/e2e.mjs`。
   结果写入 `docs/e2e-1.19-results.json`。
