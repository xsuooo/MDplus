# MDPlus 完成度修复记录（代码收尾与验收边界）

用户批准按 1–4 → 5–6 → 7 → 8 的顺序推进。目标是补齐现有编辑器的内容安全、图片/搜索一致性和可重复交付，不重写架构，不新增云同步或 AI 功能。

## 范围与边界

- 基于当前工作树，不以 HEAD 单独代表候选源码。开始时 HEAD 为 `0b7a34cb7a9c6a8f9dd6f2db5752aceab1b61bed`。
- 上轮原有 37 个已修改/未跟踪源文件及补丁已保留在本地 `.audit/completion-20261102/baseline/`；不重置、不覆盖用户已有工作。
- Chief 负责前端接线、搜索、反馈和整体验收；架构线负责原生文件命令及随后图片缓存；质检线负责检查门禁、源码摘要及独立审查。
- 只构建隔离候选，不提交、推送、公开发布或自动覆盖本机安装。用户文档和正常配置不作为测试材料。
- 新 IPC 的唯一规范是 [file_contract.json](../src-tauri/src/file_contract.json)。文稿不会在条件写失败后回退到旧的无条件写入。

## 验收目标

| 编号 | 保证                                                                     | 状态                                                                                                 |
| ---- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| 1    | 正文与版本同时读取；保存校验期望字节版本；不确定结果保留本地与被替换版本 | 实现完成；原生库/前端回归已验证，真实 IPC 仍未运行                                                   |
| 2    | 损坏的 UTF-8 BOM / UTF-16 / GBK 明确拒绝，不静默丢字节                   | 严格拒绝及合法编码正例通过原生库测试                                                                 |
| 3    | 不同标签的同名图片由后端独占创建，不用先检查再覆盖                       | 实现完成；另修复写失败后误删后来文件的竞态，失败现场保留                                             |
| 4    | 浏览器测试类型检查与全量交互回归纳入门禁，漏跑/超时不能通过              | 两类类型检查、423 项单测和146项浏览器回归通过；原生IPC模拟，远端 CI 未执行                           |
| 5    | 打开、重载、源码新增引用共用图片解析；陈旧结果不能更新缓存               | 已接通准备/提交、保存/导出等待与恢复屏障；另存为并发编辑、编辑后撤销保留原图基准                     |
| 6    | 搜索当前源码；富文本跨样式匹配、计数和位置正确                           | 实现已完成并纳入当前完整回归，不再是仅 RED                                                           |
| 7    | 暂停保存、取消、拖放、文件身份、打印流程反馈明确且不误报                 | 已完成；持久暂停、取消保持、混合拖放、完整路径、打印/PDF准确标签定向验证通过                         |
| 8    | 测试、构建、候选包绑定同一源码摘要；浏览器和原生证据分开                 | 摘要工具及交付绑定已实现；隔离二进制候选已离线构建并同源绑定，未打安装包；PS交付脚本和原生冒烟未执行 |

## 最终冻结验证

最终源摘要下：**423/423 单测、146/146 浏览器回归、生产/浏览器类型检查通过**。另有36项相关Rust库测试、22项独立smoke静态检查通过。离线release构建成功，检查前/检查后/构建后的173项源码摘要一致。

候选二进制版本0.2.5，SHA-256：`DADD002BBA14D56F6114E4432A9C3F1BB1FAEA77955844445D6DCF2F063D3DED`。只构建及只读检查，未启动、未安装、未打NSIS/MSI包。**本轮仍不是候选原生验收或发布批准。**

详见[最终验证报告](<D:/My Project/MDplus/.audit/resume-20261102/integration/final-v2/verification.md>)及[机器可读验证记录](<D:/My Project/MDplus/.audit/resume-20261102/integration/final-v2/local-verification.json>)。

## 上轮历史证据（不替代本轮冻结验收）

本地证据根为 `.audit/completion-20261102/`，忽略目录不进入发布载荷。

- 保存迁移竞态：新增回归在旧实现中失败（1 失败、20 通过），最终复核移到迁移之后后 21/21 通过。证据：`save-red.log`、`save-check-after-migration-green.log`。
- 新文稿接口消费：5 个新增用例先失败，接入版本检查、写入回执和错误副本提示后 26/26 通过。证据：`revision-consumer-red.log`、`revision-consumer-green.log`。
- 同名图片共享目录：2 个用例先失败，改用后端独占分配接口后通过；连同既有图片和保存用例通过。证据：`image-asset-red.log`、`first-batch-frontend-green.log`。
- 第一批完整浏览器回归：133/133，通过，退出码 0。真实 React/Milkdown/CSS，原生 IPC 模拟。证据：`first-batch-browser/results.json`。
- 一次整合检查中，两项 TypeScript 检查通过、351 项单测通过；整条命令仍退出 1，因为同时进行的源码摘要工具 RED 用例引用的模块尚未实现。不能把这次整合检查记为全通过。证据：`first-batch-check.log`。
- 搜索准备：跨粗体/斜体/链接、Unicode 偏移和无匹配变有匹配的 5 个用例在旧实现失败，3 个相邻行为通过；两个实际浏览器搜索用例也失败。证据：`search-red.log`、`search-browser-red/results.json`。

## 本轮多 Agent 收尾

- lead 负责前端接线与集成；smoke-engineer 补齐候选脚本；provenance-engineer 完成源码摘要与交付绑定；native-reviewer 独立复核并修复原生失败清理；frontend-reviewer 诊断并复核前端，另按独立任务授权实现恢复屏障。
- 当前冻结源码摘要：`e39d6dbe68acaf161ac0ad9961ac7804a48f8b3ccb4ed0e699ebcabf8bd97e95`，173 项选定输入；[完整清单](<D:/My Project/MDplus/.audit/resume-20261102/integration/final-v2/source-before.json>)。它描述当前工作树，而非只描述 HEAD。
- 本轮最终证据根：[集成目录](<D:/My Project/MDplus/.audit/resume-20261102/integration/final-v2/run-context.json>)。旧摘要 `1185f356…e9deaad` 的 422/145 验证与已取消构建只属历史，不能代表最终候选。
- 原生图片写后失败：真实临时文件 rename/替换回归先 2 RED 后 GREEN；最终 36 个不同 Rust 库测试、Clippy、格式检查通过。故障注入为测试钩子，不冒充物理磁盘故障；[原生证据](<D:/My Project/MDplus/.audit/resume-20261102/native-fix/report.md>)。
- 新图片准备先于恢复快照：恢复库原缺失字节/就绪屏障 RED 已修复；最终相关 57 项通过，真实浏览器单次源码输入也验证了字节先就绪、后写恢复快照。[恢复库作者记录](<D:/My Project/MDplus/.audit/resume-20261102/recovery/README.md>)。
- 另存为期间继续编辑、又撤销回原文：保留原路径、原缓存和最新正文，取消先前排队保存，暂停自动保存；明确提示新位置已写出快照，用户再次另存为才切换身份。不得靠比较最终文字相等跳过该保护。[前端独立复核](<D:/My Project/MDplus/.audit/resume-20261102/frontend-review/final-review.md>)。
- 候选脚本 v3 已完成独立 22/22 静态检查与 PowerShell 只读 AST（34 函数、0 解析错），没有执行脚本、候选或 Sandbox。[静态复核](<D:/My Project/MDplus/.audit/resume-20261102/smoke-review/report.md>)不构成 VM 运行、UIA、WinRT 或发布许可。
- 源码摘要工具与交付绑定：完整定向 27 项通过，随后新增退出码 scope 断言的 AST 2/2 单独通过；最终完整 check 再覆盖最终测试文件。[来源绑定记录](<D:/My Project/MDplus/.audit/resume-20261102/provenance/README.md>)。

### 排除误报的两类环境/夹具问题

1. HTML 卡住的根因是测试 mock 错把 `save({options})` 的标题当成顶层字段，导致 HTML 写进测试 Markdown 并被外改重载。已按实装 API 修正并增加“不得覆盖 Markdown”断言，没有削弱导出内容检查。
2. Vite watcher 在其他任务原子编辑的临时目录上发生 EBUSY；相关轮次标为环境中断，私有浏览器按记录的 session 正常关闭。最终专用验证 runner 显式关闭 watcher，源码前后摘要另行校验；中断轮不算通过。

## 原生保存保证的边界

Windows 文件替换并不提供基于内容 revision 的跨进程比较交换。实现须保留独立本地草稿、捕获被替换版本并做结果核验；若替换期间有外部写入或路径状态不确定，只提供保留位置，不自动回滚覆盖第三方后续编辑。成功返回的版本必须描述实际核验的写入字节。

[微软 ReplaceFileW 文档](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew)明确列出部分失败状态及同卷要求，并注明 `REPLACEFILE_WRITE_THROUGH` 不受支持。该标志不作为持久化保证。

## 尚不能宣称

尚未执行候选在 Windows Sandbox 中的真实运行、UIA/WinRT、IME、DPI 与实际 PDF 视觉检查，也没有运行远端 CI、PS交付发布链或安装候选。覆盖率未测量，项目未安装覆盖率 provider；这些项目不计作通过，也不自动计作功能失败。所有更改仍在工作树，未提交、推送、发布或覆盖用户安装。最终本地验证已收齐；后续只在授权的合规隔离环境补真实候选验收，不能据此自动安装或发布。

## 后续用户授权的本机测试安装

用户随后明确要求“安装最新版本让我测试”。2026-11-02 23:34（Asia/Shanghai），已通过既有受保护流程安装本轮候选：安装器exit 0，实际安装payload为BA2A324156E2A90AFBE2A71AF22C1AA7A81BCBF2A0B172DB2186CA1FC16EF816，版本0.2.5；首启前配置与备份字节一致。此前各阶段“未安装/未打包”的描述保留为当时边界，不再代表当前安装状态。未自动启动正常编辑器或编辑文稿，真实功能验收仍未完成。

详见[测试安装结果](<D:/My Project/MDplus/.audit/install-latest-20261102-a4b63479/postinstall-result.md>)及[完整回滚备份](C:/Users/49995/AppData/Local/MDPlus-Install-Recovery/20261102-before-latest-a4b63479/manifest.json)。本次安装授权不等于公开发布批准。
