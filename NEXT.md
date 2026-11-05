# 唯一续接记录

当前目标：根据用户提供的世界书自动开关管理器 PRD v2.0 开发独立 SillyTavern UI 扩展。

已产出：1.0.0 开发包，支持 1.19.x 正式版；扫描副本冻结、全局统一规则、聊天独立进度、全部/精细/整本范围、手动冻结、历史失效处理、中文手机单列 UI、API 溯源、可复现测试和安装说明。

已验证：28 项 Node 测试；manifest/路径/lifecycle/语法检查；独立模拟宿主 Chromium 的 1280/390/320px 操作测试。详见 docs/VALIDATION.md。打包命令 npm run package，ZIP 生成在项目目录的上一级。

未验证：用户真实酒馆与 Android、PRD 9.1 真实生成演示。没有安装到用户酒馆。公开仓库为 https://github.com/cjhkcjgk3-sys/worldbook-switch-manager ，分支 main；提交状态以远端记录为准。

剩余实现边界：动态宏正则不重复执行取证；非前/后槽位或 Text Completion 的同文来源不明确时保守等待。以上详见 README.md 与 docs/VALIDATION.md，不计为全量 PRD 验收通过。

下一步：获得目标酒馆版本和可操作运行环境后，按 docs/ACCEPTANCE.md 对实际请求运行三回合、重生成、取消、预算和原书保护验收，再完善现场暴露的适配。用户当前仅授权开发，未授权操作其已有实例；若需修改用户酒馆安装应落实对应实例的授权。

本次上传范围：用户明确要求先上传现有版本，保留 6.2、6.3 的当前实现；仅更新仓库安装说明、项目链接与 MIT 分发信息。
