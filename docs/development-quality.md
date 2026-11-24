# 开发与质量检查

## 模块职责

`App.tsx` 保留页面组合、菜单和快捷键连接。文稿操作由以下模块拥有，避免把同一异步流程分散在多个组件的 effect 中。

| 模块                                                                     | 职责                                                                                                                               |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `useWorkspace`                                                           | 标签身份、当前视图、每标签运行时记录 `TabRuntime`（编辑器实例、内容镜像、内容版本、保存队列、磁盘同步、位置）及标签代次 `tabEpoch` |
| `useDocumentSave`                                                        | 自动／手动保存与另存为队列、图片迁移、条件写入与提交基线                                                                           |
| `useDocumentClose`                                                       | 标签／窗口关闭协调、独立取消代次、忙碌状态及异步后的重检查                                                                         |
| `useWindowLifecycle` + `services/windowPersistence`                      | 物理像素恢复、窗口监听及几何状态保存                                                                                               |
| `usePreferences` + `services/settingsStore`                              | 设置初始化、用户选择优先、失败重试及固定原生资源访问                                                                               |
| `useRecovery`                                                            | 恢复副本、恢复状态与恢复列表                                                                                                       |
| `useImagePreparation`                                                    | 延迟图片准备，保存、导出和恢复副本读取图片前共用；经 `useRecovery` 的返回值提供                                                    |
| `useDocumentFiles`                                                       | 打开、新建、启动文件与会话恢复编排                                                                                                 |
| `useRecentFiles`                                                         | 最近列表的加载、刷新与移除                                                                                                         |
| `useNativeOpenRequests`                                                  | 单实例传入的文件与窗口拖放；文稿交给打开流程，图片转给 `useImageDrop`                                                              |
| `useSessionPersistence` + `documentSession` + `position/sessionPosition` | 会话设置、保存文稿清单、短文本位置锚点、失败条目及退出前完整会话捕获                                                               |
| `useImageDrop` + `imageDrop`                                             | 捕获鼠标落点或选择器前的选区末尾、异步位置映射、整批导入与模式代次取消                                                             |
| `imageOps`（入口）+ `images/`                                            | 待存图片：`cache` 身份与回收，`stash` 字节暂存与路径辅助，`lease` 固定与恢复，`migration` 保存迁移，`references` 打开／粘贴／拖入  |
| `documentLinks` + 编辑器链接事件                                         | 以来源文稿解析相对 Markdown 路径，把 http(s) 网址交给原生 `open_external_link`，按编辑器焦点路由 Ctrl 操作                         |
| `replace` + `sourceEditorApi`                                            | 冻结匹配集、富文本格式保留、源码实时批量编辑及独立撤销边界                                                                         |
| `useExternalChanges`                                                     | 字节版本轮询、外改提示、重载并发校验                                                                                               |
| `useEditorView` + `position/editorPosition`                              | 输入、源码切换、选区／滚动位置                                                                                                     |
| `useTypography`                                                          | 正文／代码字体与版心宽度；变更前捕获阅读位置，字体加载后恢复                                                                       |
| `useSourceOutline` + `sourceOutline.worker`                              | 目录数据：富文本取自内容镜像，源码模式在 worker 中可取消地解析；目录跳转                                                           |
| `EditorZoom` + `editorZoom`                                              | 编辑区缩放：控件绑定、按键与本地保存                                                                                               |
| `useDocumentExport`                                                      | 冻结导出快照、图片准备与 HTML/PDF 导出状态                                                                                         |

同步内容镜像和代次用于跨异步步骤核对最新状态；React 状态用于显示。保存与关闭的代次独立，取消关闭不能使已发出的保存失效。新增异步步骤时，应先补延迟、失败、取消或并发编辑的回归，再调整该流程。状态存放位置、七条规则和代次计数器见[标签状态模型](state-model.md)。

保存单测通过公开的 `useWorkspace` 注入初始标签，不再依赖 App 的 `useState` 声明索引。设置和关闭协调器另有真实 React hook 测试；浏览器回归继续使用真实 React/Milkdown，仅模拟原生 IPC。

查找替换、会话恢复和图片插入的浏览器用例分别位于 `tests/browser/replace.ts`、`session.ts` 和 `imageDrop.ts`；源码目录、文稿链接、提示和对比度位于 `polish.tsx`。各组注册在统一 runner 与 Windows 用例目录中，`-Cases all` 全部包含。源码的程序化替换与图片插入通过同一 `SourceEditorApi` 读取实时草稿，按操作前坐标提交整批编辑。会话记录只保存路径、标题和短文本锚点，不保存正文，也不复用草稿恢复 ID。

恢复回收在原生侧测试完整旧快照、在途批次、损坏 manifest、辅助失败及两套合法大附件过渡；前端测试删除回执失效缓存、重新缓存和 pending capture 保全。两个写命令的响应与测试模拟同步，独立撤销 stash 不参加恢复回收。2026-11-08 的实际验证见[本轮记录](history/quality-fixes-2026-11-08.md)。

## 条件式回归与迁移复核

仅在下表触发条件命中时执行对应复核；不新增全仓扫描、依赖或门槛。正例证明应接纳或继续的业务路径，反例证明破坏性操作的安全前置仍然有效。

| 已证实共因（提交）                                                      | 触发条件                                      | 执行方式：正例 / 反例                                                                                                                                                                                                                                                                                                                                                          | 验收入口                     |
| ----------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| 错误缺少业务含义（`a1d6c6f`、`e7e1ce6`、`bbbb57d`）                     | 修改打开、外改重载或设置冲突的错误分支        | 复用既有测试：已证实 missing 才移除 recent，图片准备失败保留正文，`CONFLICT` 且 `writeState=unchanged` 才合并重试；反例为锁定/网络不可达不删 recent，其他写入状态不重读或重写，重试冲突不无限循环。                                                                                                                                                                            | E1                           |
| 辅助失败影响主流程（`a740432`、`3639829`、`07ae81b`）                   | 调整关闭会话持久化、图片 stash 降级或恢复清理 | 复用既有失败注入：文稿已保护时 session 写失败仍可退出，`STASH_FULL` 下核验磁盘图片后保存，过期清理失败仍列出健康副本；反例为未保护的文稿不丢弃、其他 stash 错误不降级、摘要不符或缺失附件拒绝替换旧 manifest。不要把安全前置一并吞错。                                                                                                                                         | E2、N                        |
| 跨表示准入不一致（`07ae81b`）                                           | 修改文件名、正文、manifest 或传输容量         | 复用往返测试：合法长中文文件名按 Windows UTF-16 单元校验，最大正文经 JSON 最坏转义后仍能恢复；反例为正文超上限、路径逃逸或无效附件拒绝写入且保留旧副本。原生往返不等于真实桌面 IPC 覆盖；变更传输边界时另做宿主验收并记录结果，超时记未知而非通过。                                                                                                                            | N；桌面 IPC 为人工验收       |
| 拆分后依赖/证据指针未收拢（`7b19275`、`b211de8`、`3cebc23`、`5fcd78f`） | 拆分/迁移模块、扩大 exports 或调整历史导航    | 自动：仅禁止 `stash.ts` → `./references`（含扩展名），正例允许 `references` → `stash` 和 `stash` → `cache`，反例必须报 `no-restricted-imports`。人工：读迁移 diff 核对新增 exports 与调用点，更新本页当前职责导航；历史记录的源码行号保留当时版本，依据 [归档说明](history/README.md) 回读对应提交，不随当前重构重写。人工复核不是自动覆盖，其他依赖方向不在本规则保证范围内。 | E3；迁移 diff / 指针人工复核 |

以下命令均复用现有入口；按命中行选择，不要求每次全部运行：

```powershell
# E1：错误语义与有界 CAS 重试
npm test -- tests/sessionRestore.test.tsx tests/documentProtection.test.tsx tests/settingsStore.test.ts
# E2：辅助失败隔离与降级前置
npm test -- tests/sessionRestore.test.tsx tests/imageStashFull.test.ts tests/imageStashFullSave.test.tsx
# E3：真实项目 ESLint 配置的允许/拒绝反例；既有 lint 已纳入 npm run check
npm test -- tests/projectRules.test.ts
npm run lint
# N：恢复往返、拒绝危险输入、旧副本保全和清理失败隔离
cargo test --manifest-path src-tauri/Cargo.toml --locked recovery::tests -- --test-threads=1
```

N 遇到临时目录权限问题时按下文的进程级 TEMP/TMP 方案处理；必须确认筛选实际执行了用例，零用例、未执行断言或环境失败不能记为通过。查找步进、空段缓存、卸载 timer 等单点修改沿用 `tests/searchBar.test.tsx`、`tests/markdownCache.test.ts`、`tests/tabSwitchSync.test.tsx` 的现有回归，不因此扩充流程。

## 本地入口与 CI

需要 Node 22.13+（CI 使用 Node 22 / 浏览器使用 26.13）、Rust stable、rustfmt、Clippy 和 `llvm-tools-preview`。项目格式由 Prettier、EditorConfig 和 Git LF 规则统一；Rust 使用 rustfmt。CI 的 Rust 任务固定为 1.99.1（见 [ci.yml](../.github/workflows/ci.yml)），不随 stable 自动更新；升级时修改该处的版本号，并确认覆盖率门槛仍然通过。

```powershell
npm ci
npm run check
npm run build
npm run audit:deps
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
cargo install cargo-llvm-cov --version 0.9.1 --locked
cargo llvm-cov --manifest-path src-tauri/Cargo.toml --locked --json --output-path .audit/rust-coverage.json --ignore-filename-regex '(_tests\.rs|build\.rs)'
node scripts/check-rust-coverage.mjs .audit/rust-coverage.json
./scripts/windows/test-real-symlinks.ps1
./scripts/windows/test-browser.ps1 -Browser $browser -Cases all -EvidenceDirectory $browserEvidence
./scripts/windows/test-delivery.ps1 -EvidenceDirectory $deliveryEvidence
```

`npm run check` 包含 lint、格式、配置同步、两套 TypeScript 和带覆盖率门槛的单测。CI 将这些步骤分别展示，并保留前端 LCOV/JSON、Rust LLVM JSON 和浏览器结果。交付脚本同时在 PowerShell 7 和 Windows PowerShell 5.1 验证。证据目录必须是新目录；浏览器参数必须指向原生 agent-browser EXE。

ESLint 对应用与测试启用 Hooks 调用规则和完整依赖规则。测试夹具允许 `any` 以注入损坏的原生数据；产品代码保持严格规则。两处控制字符正则有局部说明，因为它们用于拒绝或编码危险字符。

## 真实 Windows 符号链接回归的环境前提

同字节外链图片复用、文稿读取／修订探测的叶节点替换竞态、条件写入的叶节点替换竞态，需要在能创建**真实文件符号链接**的 Windows 环境中执行。测试位于[图片资产测试](../src-tauri/src/image_asset_tests.rs)和[文稿读写测试](../src-tauri/src/safe_files_tests.rs)，名称均以 `review_p2_` 开头。

这些测试在 Windows 上显式标记 `#[ignore]`，原因包含权限前提及运行命令；测试体保留完整断言和链接创建 `expect`，不会捕获权限错误后直接返回。2026-11-06 已实际补跑，结果为 **3 passed / 0 failed / 0 ignored**，退出码 0。完整本地证据见 `.audit/symlink-verification-ac09ba5789214fca841bcaaf978fdb06.log`。

此前的 Win32 **1314** 发生在夹具准备阶段。运行时诊断确认：测试 EXE 继承了项目目录的 Low 完整性标签；即使父 PowerShell 为管理员 High，新测试进程仍为 Low，无法启用符号链接特权。相同字节的 EXE 在项目内正常标签目录运行后，实际进程为 High，创建真实链接及原有行为断言均通过。这与 [Windows 完整性规则](https://learn.microsoft.com/en-us/windows/win32/secauthz/mandatory-integrity-control)一致。

普通原生套件仍报告 **94 passed / 3 ignored**；专项单独报告 **3 passed / 0 failed / 0 ignored**。两次执行合计覆盖 97 个不同测试，但不能把普通套件的忽略项写成该次执行通过。CI 通过以下脚本显式启用专项：

```powershell
./scripts/windows/test-real-symlinks.ps1
```

脚本构建最新库测试产物，只读检查完整性标签，设置项目内 `TEMP/TMP` 并在结束后恢复。正常标签的 EXE 直接执行；Low/Untrusted EXE 才复制原始字节到项目 `_backup` 下的全新正常目录，核对 SHA-256 一致后执行。目标也为 Low/Untrusted 时立即失败，不修改 ACL、完整性标签、系统 Developer Mode 或 token。结果必须恰好为三项通过，空过滤、缺项、忽略或创建失败都不能通过门禁。构建、标签、哈希和测试结果保存在 `.audit/real-symlinks-*/`。

只有该次实际执行显示三项通过，才能记录真实链接覆盖。若仍报 1314，应报告环境不满足、断言未执行；不要删断言、用普通文件替代符号链接或将环境失败转换成通过。Windows PowerShell 5.1 若因执行策略拒绝已检查的脚本，可在单独子进程使用 `-ExecutionPolicy Bypass -File`，不更改持久执行策略。

## 已知环境问题：本机 cargo test 的临时目录

在部分本机环境里，默认临时目录（`%LOCALAPPDATA%\Temp`）下由测试创建的 `.tmpXXXX` 目录会被拒绝访问（os error 5），`export_validation_tests`、`image_asset_tests`、`image_import`、`image_stash` 的用例因此失败。这是环境问题，不是断言失败。只为该次命令改用项目内临时目录，不要修改项目默认配置：

```bash
mkdir -p src-tauri/target/tmp
T=$(cygpath -w "$(pwd)/src-tauri/target/tmp")
(cd src-tauri && TMP="$T" TEMP="$T" cargo test --locked)
```

2026-11-18 以此方式执行：**111 passed / 0 failed / 4 ignored**。四个忽略项是三个 `review_p2_` 真实符号链接测试（见上节）和 `safe_files::perf_native::perf_native`（固定性能基线，需 `--release --ignored --nocapture --test-threads=1` 单独运行）。CI 不受影响。

## 覆盖率基线与门槛

门槛来源为 [config/coverage.json](../config/coverage.json)，不使用全局忽略或空报告回退。前端覆盖 `src/**/*.{ts,tsx}`，排除启动挂载文件和类型声明。Rust 覆盖当前 Windows 生产代码，排除构建脚本与独立的 `*_tests.rs`；稳定 Rust 尚未报告分支覆盖，因此 Rust 门槛只检查行和函数。

| 前端指标 | 重构前基线 | 本次结果 | 最低门槛 |
| -------- | ---------: | -------: | -------: |
| 语句     |     44.52% |   47.47% |      44% |
| 分支     |     44.27% |   45.72% |      44% |
| 函数     |     37.55% |   41.47% |      37% |
| 行       |     47.36% |   48.81% |      47% |

上表是 2026-11-05 质量重构的记录；2026-11-06 文稿安全修复后的前端行覆盖率为 **58.16%**，完整范围见[本轮修复记录](history/quality-fixes-2026-11-06.md)。Rust 将内嵌测试移到独立文件后，生产代码基线为行 **69.86%**、函数 **51.79%**，门槛分别为 **69%**、**51%**。早期探测的 76.05% 包含内嵌测试代码，不用于门槛或前后对比。后续应随核心行为测试提升覆盖率，不能为绕过失败随意降低门槛。

## 配置与构建标记

[config/application.json](../config/application.json) 管理开发端口、保存／轮询／恢复时延、图片解析缓存、历史记录、文件和恢复容量。前端常量和 Rust 生成常量共享该来源。修改开发地址后执行 `npm run config:sync`，同步 Tauri 必需的静态 `devUrl`；CI 的 `config:check` 拒绝漂移。构建来源清单包括 `config/` 和质量配置，排除自动生成的 Tauri 权限文件。

构建标记由 `config/build.ts` 提供并由 Vite 注入 `__MDPLUS_BUILD_ID__`：优先 `MDPLUS_BUILD_ID`、其次 CI 的 `GITHUB_SHA`，本地使用 Git 短哈希及 dirty 标记；无 Git 信息的开发包标为 `development`。Windows 交付脚本调用相同生成器，避免清单和界面标记分离。

接口修改遵循 [IPC 入口](ipc.md)。依赖告警及升级日期见 [Rust 依赖跟踪](history/dependency-risk-2026-11-05.md)；安装后的原生 DPI、IME、剪贴板和 PDF 人工验收仍属于发布验收范围。
