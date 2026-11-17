# 0.2.6 发布收尾记录（2026-11-13）

状态（2026-11-16 更新）：**候选已按提交 `077fb6d` 重建并通过 CI；操作者在一台 Windows 11 宿主机上实测核心功能后批准合并 PR #4（候选验收，不含公开发布）。原生验收只覆盖了部分项目，依赖兼容性问题仍未解决（Issue #2 保持开放），尚未达到公开发布标准。** 当前正式版本仍为 [v0.2.5](https://github.com/xsuooo/MDplus/releases/tag/v0.2.5)。本文件保留依赖诊断和各轮检查范围；最终候选的 CI 与包身份以 [PR #4](https://github.com/xsuooo/MDplus/pull/4) 和文末“2026-11-16 按 `077fb6d` 重建”一节为准，验收范围见其中“本机验收与合并决定”。本记录不表示原生验收已全部通过或 Issue #2 已完成。

## 已确认范围与源码

维护者已确认冻结新功能，按 Windows 10/11 x64 公开发布标准准备 0.2.6；最终源码、安装包摘要、CI 和原生证据必须对应同一候选。依赖维护遵循 [Issue #2 Agent Brief](https://github.com/xsuooo/MDplus/issues/2#issuecomment-6810103965)：先验证 Tokio 同 minor 补丁，再验证仅更新 tauri-utils 的最小路线；失败后停止扩围，交由维护者重新裁定。

| 项目                | 本轮状态                                                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 本地准备分支        | `codex/release-0.2.6-closeout`                                                                                                                             |
| 实施前基线          | `af59d1a9ff9c7bdcddb11dcbfd72b03dbcfbe715`，原分支 `converge/0.2.6`                                                                                        |
| 已提交的 Tokio 更新 | `9a5bc5c5bff349a4e17ac96e7d5736e39c1071e1`，只修改 Cargo.lock 的版本和 checksum 两行                                                                       |
| 当前采用版本        | Tokio 1.53.3、tauri-utils 2.9.3、urlpattern 0.3.0；Tauri 2.11.5、单实例插件 2.4.3 保持原版本                                                               |
| 远端候选            | [PR #4](https://github.com/xsuooo/MDplus/pull/4) 保持 draft；实施前 head 为 `8b9d98429ccf76f486d873b37cac8d79ea472202`，本轮已同步源码并修正 CI 缺夹具问题 |

当前 Cargo.lock SHA-256：

```text
accfc291ddfdc5d454d9c623ac5a818da2b053b9d44f0354cb4fb83a1d370233
```

Cargo.toml 未修改，SHA-256 为 `41f49b47baf5b17cc65d3dae9f57df16e974ddd9926c9b61f6ecde9c2f93aa14`。原有未跟踪研究笔记 `docs/dependency-risk-recheck-2026-11-12.md` 未修改，SHA-256 仍为 `ac2f3ccabd41cec3de6cfe1edd6dbd317d3a334374f22f85518cfde103e4ea85`。本记录及历史文档的状态补充是后续文档改动，不是上述提交对应的最终交付来源清单。

## 实际检查结果

| 检查                    | 结果                                                                 | 证据范围                                                                              |
| ----------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 普通 Rust 测试          | 108 passed、0 failed、4 ignored                                      | 使用采用的 Tokio-only 锁文件；忽略项为三个真实符号链接回归和一个性能基线              |
| 真实 Windows 符号链接   | 3 passed、0 failed、0 ignored                                        | 在恢复 Tokio-only 锁文件后重新编译并运行原有三个断言，不复用 af59 基线结论            |
| Clippy                  | exit 0，`--all-targets -- -D warnings`                               | 使用采用的 Tokio-only 锁文件                                                          |
| 前端质量检查            | 78 文件、836 测试通过                                                | `npm run check`；lint、格式、配置同步检查、两套 TypeScript 与覆盖率门槛通过           |
| 前端构建与 npm 审计     | `npm run build` 和 `npm run audit:deps` 均 exit 0；0 vulnerabilities | 前端源码和 npm 锁文件未修改                                                           |
| 完整浏览器回归          | 269 项通过，native IPC mocked                                        | 沿用仓内完整入口；本机 agent-browser 0.41.1，当前 CI 固定 0.41.0                      |
| Rust 生产覆盖率         | 行 73.16%、函数 55.27%，原门槛 69% / 51% 通过                        | 续跑安装任务专用 cargo-llvm-cov 0.9.1；采用 Tokio-only 锁文件，108 passed / 4 ignored |
| Windows 交付脚本自检    | 20 项通过                                                            | 当前 PowerShell 7；只使用合成数据，没有在宿主机安装应用                               |
| release/NSIS 与安装验收 | 首轮 02a442c 已构建，但 CI 失败，不能作为最终通过候选                | 后续最终包身份以续跑结果为准；Windows 10/11 原生验收仍未通过                          |

前端覆盖率为语句 71.79%、分支 63.97%、函数 73.53%、行 73.63%。前端检查和构建开始时采用的是后来被拒绝的 utils 组合锁文件；浏览器也以该组合锁文件开始，运行期间锁文件恢复为 Tokio-only。相关前端、npm 锁文件和测试输入始终未修改，结束后与 `9a5bc5c` 的这些输入核对一致。因此这些结果证明本轮前端回归通过，不能充当新 utils 的 Rust 兼容性证据，也不冒充最终候选的完整 CI 和原生验收。

真实符号链接专项沿用 `scripts/windows/test-real-symlinks.ps1`。原测试 EXE 为 Low integrity，脚本按现有流程将相同字节写入项目 `_backup` 下的新普通目录再运行，未修改 ACL、完整性标签、进程令牌或系统设置。原件与执行件 SHA-256 均为 `c27204abeb619c0a92aa73cf65182b80693bf2d6730d2f08bbf8c872f25cf518`。

## tauri-utils：解析通过，测试构建不兼容

隔离的最小候选能够解析 tauri-utils 2.10.2 / urlpattern 0.6.0，保持 Tauri 核心、运行时和插件版本，并移除五个 unic 包。候选保留非必要变化之外的原依赖实例和边，Windows 与全目标的 `cargo metadata --locked --offline` 均通过。此结论只涉及解析。

实际 Rust 测试构建返回 101：

```text
error[E0063]: missing field `app_directories_override` in initializer of `AppConfig`
```

Tauri 2.11.5 的 `src/test/mod.rs:117` 初始化 `AppConfig` 时，未设置 tauri-utils 2.10.2 在 `src/config.rs:3512` 新增的 `app_directories_override` 字段。项目现有原生测试依赖 Tauri 的 `test` feature，所以这条最小路线未满足编译门槛。

这是已确认的 **test feature 编译不兼容**。新 utils 的测试没有运行，Clippy 未进入，生产 release 构建没有尝试；尚无依据将其描述为运行时故障。没有删除 feature、断言或门槛，没有修改 registry 源码、vendor 补丁或自动升级核心/插件。

拒绝采用的组合锁文件 SHA-256 为 `4ba7fc65e4efbf17171781d0553f5681842507dd1bf60929ac1528c74b78735b`；工作锁文件已恢复为上文的 Tokio-only 摘要。**五个 unic 0.9.0 包仍在当前 Windows normal/build 图中，去 unic 尚未完成。** Issue #2 仍 open；本轮没有写入远端评论或更改标签。

## 当前采用锁文件的审计与风险

采用 cargo-audit 0.22.2，重新获取官方 [RustSec advisory-db](https://github.com/RustSec/advisory-db) 后检查完整锁文件，并包含撤回发行版检查。

- 数据库提交：`af7b3ec33460b8e2de8d422e16d628518891a519`。
- 数据库提交时间：`2026-11-12T15:21:59+01:00`；获取时间：`2026-11-13T06:12:44.9520025+08:00`。
- 当前 477 个包：0 vulnerabilities、2 unsound、9 unmaintained、1 yanked、0 registry errors。
- Tokio 只有 1.53.3 一个实例；不再命中 RUSTSEC-2026-0386。

原始审计 JSON 的数据库提交字段为 null；数据库身份由独立 git 收据保存，不能从 null 字段推断数据库未获取。

| 剩余告警               | 版本与公告                                                                                                                          | Windows normal/build 范围与处置                                                                                                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2 项 unsound           | glib 0.18.5：RUSTSEC-2024-0429；rustix 1.1.4：RUSTSEC-2026-0486，patched >=1.1.6                                                    | 两者不在当前 Windows 图中；glib 随 GTK/Tauri 链处理，新增 rustix 纳入后续维护；增加其他平台前重新评估                                                                                                                        |
| 5 项 unmaintained      | unic-char-property、unic-char-range、unic-common、unic-ucd-ident、unic-ucd-version 0.9.0；RUSTSEC-2025-0081、0075、0080、0100、0098 | 五个包仍由 urlpattern 0.3.0 / tauri-utils 2.9.3 引入 Windows 构建及运行依赖；utils 更新受阻，风险保留                                                                                                                        |
| 其余 4 项 unmaintained | proc-macro-error 1.0.4、zbus_names 4.3.4、zvariant / zvariant_derive 5.13.1；RUSTSEC-2024-0370、RUSTSEC-2026-0371、0370、0372       | 不在当前 Windows 图中；继续跟踪上游链，不强制覆盖 zbus 6 或自动升级插件                                                                                                                                                      |
| 新发现 1 项 yanked     | async-executor 1.14.0                                                                                                               | [官方 crates.io API](https://crates.io/api/v1/crates/async-executor/1.14.0) 确认为 yanked，`yank_message` 为 null；全目标经 zbus 5.18.0 / 单实例插件 2.4.3 引入，Windows normal/build 反向图为空；不能推断撤回原因或绝对安全 |

本轮根据 `rustc -vV` 获取实际宿主 target，并核对 `rustc --print cfg` 的 `target_os="windows"` 后重新生成锁定的 normal/build 图，没有猜测 target triple。零漏洞条目、Windows 不可达和测试通过各有范围，均不等于整个依赖树绝对安全。

审计原始结果以 `tokio-audit-with-index.json` 为准：补齐任务专用 CARGO_HOME 的公开 registry 索引后，registry errors 为 0。初始 `tokio-audit.json` 的索引缺失结果不能使用。名称为 `final-audit.json` 的文件实际审计的是被拒绝的组合锁文件；其 484 包、4 项 unmaintained 结果不是当前采用状态。

原 **2026-11-12** 计划节点未按期完成；Tokio 实施、本地检查与续跑补做的生产覆盖率实际发生于 **2026-11-13**，完整发布验收仍缺失。其余链保留原 **2026-12-03** 的升级 PR 或明确阻塞、缓解措施及下次复查日期要求；本轮不修改截止日期、不创建定时任务。

既有缓解继续有效：发布范围保持 Windows，能力只授予本地主窗口，不开放远程来源，保留路径、类型、容量校验及文件/设置失败保全。缓解不能替代依赖修复。

## 发布门槛与当前阻塞

| 门槛                           | 当前缺口                                                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| 最终源码与安装包一致           | 首轮 02a442c 已取得来源清单和包摘要，但缺夹具修复改变了测试输入；最终包必须重新绑定来源，详见续跑结果      |
| 当前提交 CI 与生产覆盖率       | 本地生产覆盖率已通过；首轮 02a442c 的前端 CI 因两个缺失夹具失败，修复后必须确认新候选 CI，不沿用旧绿色结果 |
| Windows 10/11 x64 安装生命周期 | 全新安装、0.2.5 升级、回滚、再次升级和文件锁拒绝尚无本轮最终候选证据                                       |
| WebView2 原生文稿与系统交互    | 保存/恢复、中文 IME、100%/125%/150% DPI、真实图片剪贴板、离线 HTML 和系统 PDF 待集中验收                   |
| 干净验收环境与原问题复测       | 当前 Hyper-V 无已注册 VM；续跑通过官方 wsb CLI 重试 Sandbox，仍返回 0x80370106；原问题仍待安装版复测       |

本机仍安装先前 af59 修复 payload：`D:\Program Files\MDPlus\mdplus.exe`，版本 0.2.6，SHA-256 为 `bca382c9de76e0171fd38a6d75b5c7649d2b46d1474396cc47e1b3b22992aded`。这不是本轮 Tokio 更新后的安装包，原始文稿问题的安装版复测也未确认。

现有 candidate smoke 脚本明确限制 Sandbox 用户、Microsoft VM 和固定映射，不能直接用于普通 VM。若选择普通 VM，必须先按现有安全边界调整该流程，不能关闭宿主机、非空环境和真实数据保护守卫。本轮没有安装应用、修改系统设置或调整虚拟机配置。

## 本地证据与待裁定项

主执行证据目录（Git 忽略，本地文件，不是已发布的 GitHub 产物）：

```text
D:\My Project\MDplus\.audit\release-closeout-20261113-8b0e4913a87e4dd980d28868493d105c
```

| 文件                                                                                                          | 内容                                                             |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `baseline.json`、`tokio-stage.json`、`verification-summary.json`                                              | 基线、采用提交/锁摘要，以及核对后的结果范围                      |
| `tokio-tests.log`、`tokio-clippy.log`、`real-symlinks-tokio/result.json`                                      | 采用锁文件的 Rust 普通测试、Clippy 和本轮真实链接专项            |
| `frontend-checks.json`、`frontend-check.log`、`frontend-build.log`、`npm-audit.log`                           | 前端检查、构建与 npm 审计；原始收据标明执行时的组合锁文件        |
| `browser-receipt.json`、`browser-all/results.json`、`browser-all.log`                                         | 269 项完整浏览器结果、模拟 IPC 声明和完成时间                    |
| `utils-blocked.json`、`utils-rust-tests.log`                                                                  | utils 测试构建错误、候选摘要与恢复摘要                           |
| `rustsec-database.json`、`tokio-audit-with-index.json`、`tokio-windows-graph-confirmed.txt`                   | 官方数据库身份、当前完整审计与重新核对的 Windows normal/build 图 |
| `async-executor-crates-io.json`、`all-async-executor-inverse.txt`、`tokio-windows-async-executor-inverse.txt` | 撤回发行版的官方收据及平台依赖路径                               |

隔离解析、最小锁文件完整差异与依赖边保全证据另存于：

```text
D:\My Project\MDplus\.audit\grill-dependency-feasibility-318a4a45-149d-43dd-a92e-44a744a050fe
```

## 2026-11-13 续跑

维护者要求继续未完成任务，沿用已确认的 Q1–Q3 范围：冻结新增功能，准备 Windows 10/11 x64 的 0.2.6 交付，保留已通过检查的 Tokio 1.53.3，继续现有候选的 CI、打包与原生验收准备。utils 去 unic 仍未完成，Issue #2 保持开放；核心/插件升级仍需另行裁定，公开发布仍以所有门槛通过为前提。

续跑证据目录：

```text
D:\My Project\MDplus\.audit\release-closeout-resume-20261113-1b3e9d44
```

`rust-coverage.json`、`rust-coverage.log`、`rust-coverage-thresholds.log` 和 `rust-coverage-receipt.json` 记录 Tokio-only 源码的实际生产覆盖率。工具固定为 CI 使用的 0.9.1，安装在本次证据目录，没有加入项目依赖或修改全局 PATH。沿用 CI 的排除规则与原门槛，没有删除断言或将忽略的实链用例计入普通覆盖率运行。

`delivery-selftest.log` 记录 20 项交付自检；`environment.json`、`sandbox-before.json`、`sandbox-start.log`、`sandbox-start-receipt.json` 和 `sandbox-after.json` 记录本轮隔离环境核查与启动尝试。Sandbox 重试没有映射宿主机目录，返回“虚拟机或容器意外退出。 (0x80370106)”，没有执行候选安装器。系统设置未修改。最终 CI 和安装包证据随当前候选另行核对，不沿用旧候选结论。

### 干净检出后的测试夹具修复

首轮同步提交 `02a442c` 的 Push / PR 前端 CI 均报告 `tests/perf/fixtures/long-5000.md` 和 `table-1200.md` 缺失。这两个文件由性能夹具生成器产生并被 Git 忽略；本地已有文件，所以本地完整检查没有发现干净检出问题。首轮包已成功构建，但 CI 失败，不作为最终通过的候选，也没有安装或发布。

`tests/markdownCache.test.ts` 现在在该解析器测试组的 `beforeAll` 中调用现有 `generateFixtures()`，先生成合成夹具再读取。没有提交生成物、新增依赖、删断言或修改生产解析器。独立干净检出在没有夹具时复现 2 failed / 15 passed；仅带入修复后的测试文件后为 17 passed。原始记录为 `fixture-red.log`、`fixture-green.log` 和 `fixture-regression.json`。

最终候选的源码提交、输入摘要、安装包 / 包内 EXE 摘要和当前 CI 结果集中记录在本机续跑目录的 `closeout-result.md`、`closeout-result.json` 及交付 manifest 中；远端可公开核对的结果写入现有 PR #4。这里保留首轮失败，不将其改写成成功。

## 2026-11-16 按 `077fb6d` 重建

上文各节是 2026-11-13 两轮的记录，原样保留。其中的候选提交 `adbac67`、包摘要、发布门槛表和“本机仍安装先前 af59 修复 payload”的描述只反映当时的状态；当前候选以本节为准。

`adbac67` 之后有 11 个提交：8 个改动应用代码（`aebe6de`、`a740432`、`a1d6c6f`、`bbbb57d`、`e7e1ce6`、`5ef69de`、`c2a27b9`、`077fb6d`），1 个只改浏览器测试夹具（`2351ad7`），1 个只改文档（`028f888`），1 个固定 CI 的 Rust 工具链（`b23c89c`）；逐条说明见 [CHANGELOG](../../CHANGELOG.md)。其中 10 个提交改动了构建输入（共 19 个文件），旧安装包因此不再对应当前源码。2026-11-16 从干净的工作树按 `077fb6d` 重新构建，没有为调整构建标记另作提交。

### 候选与包身份

| 项目              | 值                                                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 分支与提交        | `codex/candidate-0.2.6`，`077fb6d6b51e0af2de5fb06d3c05907eb4a414e2`；构建前后工作树均干净                                         |
| 版本 / 构建标记   | 0.2.6 / `077fb6d6b51e`                                                                                                            |
| 源码输入摘要      | `5ef8bbbe4d26b5377fc7b26398dc1fcd2bdc3fadbd67e9969f0e767362934046`（策略 `mdplus-source-v1`，927 个文件，状态 `observed-stable`） |
| 安装包            | `MDPlus_0.2.6_x64-setup.exe`，48,433,605 字节，SHA-256 `9757880638C25BCFABCCD820F9944D4A39126099444875CA6A241435CF4AD33A`         |
| 包内 `mdplus.exe` | 53,394,432 字节，SHA-256 `F8326058F3FC39E5AF2EBD43ECE1743536F3DBB5AAB3FC63C5AFF7B922665CFF`                                       |
| 签名              | 安装包与包内 EXE 均为 `NotSigned`                                                                                                 |
| 编译器            | `rustc 1.99.1 (58cf8f9c3 2026-10-13)`                                                                                             |
| 构建时间          | 2026-11-16 01:14:10 至 01:20:17（+08:00）                                                                                         |

证据目录与交付目录都是本机文件：证据目录被 Git 忽略，安装包没有上传。

```text
D:\My Project\MDplus\.audit\release-closeout-rebuild-20261116-077fb6d
C:\Users\49995\Downloads\MDPlus-0.2.6-closeout-20261116-077fb6d\current
```

| 文件                                                                            | 内容                                   |
| ------------------------------------------------------------------------------- | -------------------------------------- |
| `closeout-result.md`                                                            | 本轮结果汇总                           |
| `final-binding-verification.json`                                               | 独立复核的 19 项检查与各项摘要         |
| `final-delivery\result.json`、`final-delivery\source-*.json`                    | 交付脚本的结果与构建前后的输入清单     |
| `final-delivery\check.log`、`final-delivery\build.log`、`delivery-selftest.log` | 本机检查、构建与交付脚本自测的原始输出 |
| `ci-final-push.json`、`ci-final-pr.json`（及同名 `.log`）、`pr-merge-ref.json`  | 两次 CI 运行与 PR 合成合并提交的记录   |

### 输入绑定的范围

输入摘要绑定的是本机工作树里 927 个输入文件的字节：309 个受 Git 跟踪，618 个是 `tests/perf` 下被 Git 忽略的文件。受跟踪的输入中 303 个与提交逐字节相同；另外 6 个只有 CRLF / LF 行尾差异（`.gitignore`、`src-tauri/.gitignore`、`src-tauri/installer/installer.nsi`、`src-tauri/src/main.rs`、`src/assets/app-icon.svg`、`tests/windows/phase1.ps1`），它们的字节与上一轮构建时相同。相对上一轮发生变化的 19 个输入，正是上述提交改动的文件。

换一个检出（行尾设置或 `tests/perf` 下的文件不同）可能得到不同的摘要。这是对已观察到的输入的绑定，不是可复现构建的证明，也不是签名或原生验收。包内 EXE 与编译产物 `target\release\mdplus.exe` 相差 3 个字节，是 Tauri 写入的打包类型标记。

### 实际运行的检查

| 检查                             | 本机，随构建（2026-11-16）                       | CI，提交 `077fb6d`（2026-11-15 UTC）                                        |
| -------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------- |
| lint、格式、配置、TypeScript     | 通过                                             | 通过                                                                        |
| 前端测试                         | 78 个文件，852 passed                            | 78 个文件，848 passed / 4 skipped（Ubuntu；跳过的 4 项只在 Windows 上运行） |
| 前端覆盖率                       | 语句 72.21%、分支 64.28%、函数 73.78%、行 74.11% | 相同                                                                        |
| npm 审计                         | 未运行                                           | 0 vulnerabilities                                                           |
| 前端构建                         | 通过                                             | 通过                                                                        |
| 浏览器回归（native IPC 为 mock） | 未运行                                           | 269 passed                                                                  |
| Rust 测试                        | 未运行                                           | 109 passed / 0 failed / 4 ignored；真实符号链接专项 3 passed                |
| Rust 格式与 Clippy               | 未运行                                           | 通过                                                                        |
| Rust 覆盖率                      | 未运行                                           | 行 73.62%、函数 56.23%（门槛 69% / 51%）                                    |
| 交付脚本自测                     | 20 项通过                                        | 两个 PowerShell 版本各 20 项通过                                            |
| 原生验收                         | 未运行                                           | 不适用                                                                      |

[Push 运行](https://github.com/xsuooo/MDplus/actions/runs/43735635929)与 [PR 运行](https://github.com/xsuooo/MDplus/actions/runs/43735640385)的结论均为 success。PR 运行检查的是合成合并提交 `885af30e52b1e6eb006c28b0145816eb116f8773`，基线为 `main` 的 `4d789bdd3939863be1e28afdec2ebe2eff20a15e`。浏览器回归以 mock 代替原生 IPC，不是原生验收。

2026-11-15 在本机多次运行 Rust 测试，结果不稳定：最好一次是 108 passed / 1 failed / 4 ignored，失败项 `tests::atomic_write_replaces_existing_file` 报 PermissionDenied；另有三次为 32 passed / 77 failed。原因没有查明，所以本候选的 Rust 结论只来自 CI。

`main`（`4d789bd`）的 CI 仍是红色：rustc 1.100.0 下 Rust 行覆盖率为 67.90%，低于 69% 的门槛；同一提交在 `release` 分支用 1.99.1 运行时为 69.86%。工具链是最可能的原因，但没有与运行环境的其他变化分开验证。候选分支已把 CI 的 Rust 工具链固定为 1.99.1，`main` 在 PR #4 合并前保持红色。

### 依赖状态

`Cargo.lock`、`package-lock.json`、`Cargo.toml` 和 `package.json` 自 `adbac67` 以来没有变化，上文 2026-11-13 的完整审计（0 vulnerabilities、2 unsound、9 unmaintained、1 yanked）对应的仍是当前锁文件。2026-11-15 用 cargo-audit 0.22.2 加 `--no-yanked` 重跑：477 个包，0 vulnerabilities、2 unsound、9 unmaintained；没有重做 yanked 检查和 Windows 可达性核对，记录在[依赖风险复查](../history/dependency-risk-recheck-2026-11-12.md)文末。重建期间没有再次审计。Issue #2 保持开放，原 2026-12-03 节点不变。

### 发布门槛（2026-11-16）

| 门槛                           | 状态                                                                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| 最终源码与安装包一致           | 已按 `077fb6d` 重新绑定，范围见上文                                                                                                    |
| 当前提交 CI 与生产覆盖率       | `077fb6d` 的 Push 与 PR 两次运行均通过                                                                                                 |
| Windows 10/11 x64 安装生命周期 | 部分：操作者报告在本机（Windows 11，原有安装）安装和启动正常；全新安装、0.2.5 升级、回滚、再次升级、文件锁拒绝和 Windows 10 未验收     |
| WebView2 原生文稿与系统交互    | 部分：操作者报告保存 / 关闭 / 重开、中文输入、剪贴板贴图、设置保存、查找和最近列表正常；异常退出恢复、DPI、离线 HTML 和系统 PDF 未验收 |
| 干净验收环境与原问题复测       | Sandbox 的 0x80370106 是 2026-11-13 的结果，此后没有重试；原始文稿问题仍待安装版复测                                                   |
| 依赖                           | Issue #2 开放，见上文                                                                                                                  |

2026-11-16 03:00 至 03:19（+08:00）只读核对本机：`D:\Program Files\MDPlus\mdplus.exe` 的大小和 SHA-256 与本候选包内 EXE 相同，注册版本为 0.2.6，同目录 `uninstall.exe` 的修改时间是当天 02:47:19。这只说明本机安装的字节是本候选；它不说明安装器的退出码、安装前是否做过备份、设置与文稿是否保全，也不说明功能正常。在以往使用的备份位置和证据目录里，没有找到当天由 `scripts/windows/install.ps1` 产生的备份或 `install-result.json`。本机原先已有安装，所以本机实测不能代替全新安装、0.2.5 升级 / 回滚链路和 Windows 10 的验收。

重建过程没有安装应用、修改系统设置、合并或发布；本机的安装和功能测试由操作者完成，见下一节。

### 本机验收与合并决定（2026-11-16）

操作者（xsuooo）于 2026-11-16 10:16（+08:00）报告：在当前 Windows 11 宿主机上实测，安装、启动、中文输入、剪贴板贴图、保存 / 关闭 / 重开、设置保存、查找和最近列表正常，其余项目记为未测；批准范围是“候选验收（合并 PR #4）”，不含公开发布。批准是操作者的明确决定，不是构建或测试产生的结果，流程见 [Windows delivery and rollback](windows-delivery.md)。

功能结果全部来自操作者的报告，没有随附截图或日志。10:27（+08:00）的只读核对只确认身份和环境：Windows 11 企业版 25H2（内部版本 26200.8973，64 位），WebView2 Runtime 157.0.4341.46，安装包和已安装的 `mdplus.exe` 的大小与 SHA-256 仍与上表一致。

报告和收据是本机文件，不随仓库提交：

```text
D:\My Project\MDplus\.audit\native-acceptance-0.2.6-077fb6d
```

| 文件                   | 内容                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `acceptance-report.md` | 验收报告：操作者原文、逐项结果、未测清单和决定；SHA-256 `3084B30A974FA4F8039807C390E055319A97A06E1229777C895F309B901E000F` |
| `approval.json`        | 批准收据：`status` 为 `approved`，绑定安装包与报告的 SHA-256，`publicReleaseApproved` 为 `false`                           |
| `host-facts.json`      | 只读核对的原始读数                                                                                                         |

仍然没有证据的项目：

- 安装：全新安装；0.2.5 升级、回滚、再次升级；文件锁拒绝；安装器退出码、安装前备份、设置与文稿的字节保全。
- 文稿与系统交互：取消关闭后继续编辑；异常退出后的草稿与图片恢复；损坏设置重试和重启后的设置持久化；贴图后保存并重开；DPI 与窗口恢复；原生 HTML / PDF。
- 环境：Windows 10 x64；干净环境；原始文稿问题的安装版复测。
- `adbac67` 之后的修复里只有自动化测试的几项：设置文件在应用外改动后的保存、文末空段落、会话写入失败时关窗、图片无法准备和暂存已满的提示。

[候选验收记录](candidate-0.2.6.md)的“剩余验收”表仍是此前的状态，以本节为准。

记录本节的提交只改 `CHANGELOG.md` 和本文件，两者都不在构建输入之内，安装包对应的仍是 `077fb6d`。批准的范围不含发布：没有创建 tag 或 GitHub Release，没有上传安装包，当前正式下载仍为 v0.2.5。
