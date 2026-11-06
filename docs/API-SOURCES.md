# API 依据与依赖合同

核对日期：2026-11-06。目标为 SillyTavern 前端 UI Extension。官方 `release` 分支只用于定位，实际施工固定到以下提交。

- 版本：`1.18.0`（主验收）及 `1.19.0`（保留支持）
- 1.18.0 提交：`51ad27fb86d39a3daca3adaa970375c9670c12df`
- [1.18.0 固定源码](https://github.com/SillyTavern/SillyTavern/tree/51ad27fb86d39a3daca3adaa970375c9670c12df)
- 提交：`06bde939fb1e9c4c8d8641d810f0a916b5bce127`
- [固定源码快照](https://github.com/SillyTavern/SillyTavern/tree/06bde939fb1e9c4c8d8641d810f0a916b5bce127)
- 分发支持：1.18.x / 1.19.x 正式版，启动前检查 `/version` 的 `pkgVersion`，再检查所需符号。更高次版本不能由版本号自动推定兼容。

| 使用的符号/行为 | 固定源码路径与定位 | 用途 | 证据 |
| --- | --- | --- | --- |
| `SillyTavern.getContext()` | `public/script.js`；`public/scripts/st-context.js:getContext` | 新鲜读取聊天、扩展设置、聊天元数据与事件 | 源码已核对；目标宿主待验 |
| `eventSource.on/removeListener/makeLast` | `public/lib/eventemitter.js` | 订阅、清理、将观察者排到已有监听者之后 | 源码已核对；模拟事件测试通过 |
| `WORLDINFO_ENTRIES_LOADED` 的 `{globalLore,characterLore,chatLore,personaLore}` | `public/scripts/world-info.js:getSortedEntries` | 原生选择书籍后、扫描前临时设置副本的 `disable`；原数据经映射/克隆隔离 | 源码已核对；目标宿主待验 |
| `WORLD_INFO_ACTIVATED(entries)` | `public/scripts/world-info.js:getWorldInfoPrompt` | 捕获通过原生预算的激活条目；dry run 不发该事件 | 源码已核对；事件测试通过 |
| `GENERATE_AFTER_DATA(data,dryRun)` | `public/script.js:Generate` | 观察原生最终组合后的 `data.prompt`，不写入请求 | 源码已核对；事件测试通过 |
| `CHAT_COMPLETION_SETTINGS_READY(generate_data)` | `public/scripts/openai.js:sendOpenAIRequest` | 发送前再次核对 `generate_data.messages` | 源码已核对；最终设置裁剪测试通过 |
| `GENERATION_STARTED(type,options,dryRun)` | `public/script.js:Generate` | 区分预览、正常、重生成、候选、静默和代写用户 | 源码已核对 |
| `MESSAGE_RECEIVED(id,type)` / `GENERATION_ENDED` / `GENERATION_STOPPED` | `public/script.js:saveReply/StreamingProcessor/hideStopButton/stopGeneration` | 完整回复与生成结束双重确认；失败流检查 `isStopped/isFinished` | 源码已核对；两种事件顺序测试通过 |
| `chatMetadata.world_info` | `public/scripts/st-context.js`；`public/scripts/world-info.js:getChatLore` | 只读取当前聊天挂载的世界书；不存储插件进度，不调用 `saveMetadata` | 1.18 原生流程确认插件无聊天元数据写入 |
| `extensionSettings` / `saveSettingsDebounced()` | `public/scripts/st-context.js` | 全局共享设置与精细范围，保留未知设置字段 | 源码已核对 |
| `loadWorldInfo(name)` | `public/scripts/world-info.js` | 只读取当前使用世界书，包含空书 | 源码已核对；范围测试通过 |
| `selected_world_info/world_info.charLore` | `public/scripts/world-info.js:getGlobalLore/getCharacterLore` | 全局与角色附加书；结合角色 `data.extensions.world`、聊天 `world_info`、persona 书构成范围 | 源码已核对 |
| `getRegexScripts/getRegexedString/regex_placement.WORLD_INFO` | `public/scripts/extensions/regex/engine.js` | 按原生正则提示词标志得到静态渲染结果；拒绝再次执行动态宏 | 源码已核对；静态正则与动态宏保护测试通过 |
| `promptManager.messages.collection` | `public/scripts/openai.js`；`public/scripts/PromptManager.js:setChatCompletion` | 核对 `worldInfoBefore/worldInfoAfter` 槽位，排除纯历史同文 | 源码已核对；目标宿主待验 |
| `hooks.activate/enable/disable/clean/delete` | `public/scripts/extensions.js:callExtensionHook` | 幂等注册、异步初始化、解绑监听与移除界面 | 源码已核对；入口静态检查通过 |

上述内部模块只读导入是本项目明确声明的版本依赖，不是跨版本稳定 API。冻结不依赖 Tavern Helper 写世界书接口，因为那会持久改写条目；也不使用私有 DOM 来推测生成结果。

所有运行依赖由酒馆宿主提供。没有嵌入角色卡的资产，没有远程加载器，没有地区镜像。Node.js/Python/Playwright 仅为开发工具，用户安装扩展时不需要它们。

置信度：源码签名与顺序为 high；官方 1.18.0 的隔离实例已运行三回合及重生成请求检查；在用户所安装版本、其他扩展组合及真实模型后端的行为仍待核验，不能以离线测试替代。特别是后续监听器或服务端重写、工具调用递归、多窗口并发、非标准世界书插入位置仍需真机验收。

工作资料路由：`sillytavern-extension-dev`，手动加载 ST-A0/ST-D5/ST-E5；路由快照 2026-09-13，文档清单快照 2026-08-18。随包脚本未物化，未运行技能包路由与验证脚本；本项目提供自己的静态验证器。不分发技能参考原文，无设计候选采用。

1.1.0 的内存状态不再使用旧版历史摘要或逐聊天进度恢复。保留最近一个用户消息的身份用于防止重新生成重复计数，空间不随对话回合数增长。过期冻结记录及时清理，同时保留上一完整回合重生成所需的规则。
