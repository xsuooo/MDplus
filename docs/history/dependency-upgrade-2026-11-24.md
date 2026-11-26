# Tauri 2.12 依赖升级记录（2026-11-24）

跟踪 issue：[xsuooo/MDplus#2](https://github.com/xsuooo/MDplus/issues/2)。基线是 `dev/0.2.7` 的 `9b1e3d8`；应用版本号保持 0.2.6，应用源码没有改动。

## 结论

- 「只升 tauri-utils」的最小路线在 Tauri 2.11 线上走不通：2.11.5 和 2.11.6 的 `test` 模块都缺少 tauri-utils 2.10 新增的 `AppConfig.app_directories_override` 字段，修复只在 2.12.x。
- 维护者 2026-11-24 批准把范围扩大到 Tauri 核心。升到 2.12.7 后，五个 unic 包从锁文件和 Windows normal/build 图中消失。
- 同日审计发现原锁文件新增两条漏洞条目（url、cookie），已升到修复版本。
- 剩余 6 条公告卡在上游，都不在 Windows normal/build 图中；阻塞版本、缓解措施和下次复查日期见[仍卡在上游的公告](#仍卡在上游的公告)。
- 截至本记录，安装版的原生验收没有做，只做了一次隔离标识的启动冒烟。

## 最小路线的失败证据

在 `9b1e3d8` 的干净检出上，原锁文件的 `cargo test --locked` 为 116 通过、4 忽略。`cargo update -p tauri-utils --precise 2.10.2` 能解析（tauri-utils 2.9.3 → 2.10.2，urlpattern 0.3.0 → 0.6.0，五个 unic 包移除），随后 `cargo test --locked` 退出码 101：

```text
error[E0063]: missing field `app_directories_override` in initializer of `AppConfig`
   --> tauri-2.11.5\src\test\mod.rs:117:12
    |
117 |       app: AppConfig {
    |            ^^^^^^^^^ missing `app_directories_override`
error: could not compile `tauri` (lib) due to 1 previous error
```

| 尝试                                    | 结果                                                                                                      |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 只升 tauri-utils 2.10.2                 | 生产目标的 `cargo check --locked` 通过；测试构建报上面的 E0063                                            |
| 去掉 dev-dependencies 里的 `tauri/test` | `tests/perf/native.rs:11` 报 E0432：固定性能基线用到 `tauri::test`。已还原                                |
| Tauri 2.11.6 + tauri-utils 2.10.2       | 同一处 E0063。2.11.6 是 2.11 线的最后一个版本（2026-09-19）                                               |
| Tauri 2.12.7                            | `src/test/mod.rs` 已有 `app_directories_override: None`；2.12.x 把 tauri-utils 锁在 `~2.10`，测试构建通过 |

没有修改 registry 里的上游源码，没有删除 feature、断言或门槛。

## 采用的版本

| 包                                             | 之前                 | 之后                 |
| ---------------------------------------------- | -------------------- | -------------------- |
| tauri                                          | 2.11.5               | 2.12.7               |
| tauri-build、tauri-codegen、tauri-macros       | 2.6.3                | 2.7.6                |
| tauri-utils                                    | 2.9.3                | 2.10.4               |
| tauri-runtime、tauri-runtime-wry               | 2.11.3、2.11.4       | 2.12.4、2.12.5       |
| wry、tao                                       | 0.55.1、0.35.3       | 0.57.3、0.37.3       |
| webview2-com、windows                          | 0.38.2、0.61.3       | 0.39.1、0.62.2       |
| urlpattern                                     | 0.3.0                | 0.6.0                |
| tauri-plugin-dialog、tauri-plugin-fs、rfd      | 2.7.2、2.5.1、0.16.0 | 2.8.4、2.7.1、0.17.2 |
| url、form_urlencoded、cookie                   | 2.5.8、1.2.2、0.18.1 | 2.5.9、1.2.3、0.18.3 |
| tauri-plugin-single-instance、tokio            | 2.4.3、1.53.3        | 不变                 |
| `@tauri-apps/api`、`plugin-dialog`（锁定版本） | 2.11.1、2.7.2        | 2.12.5、2.8.4        |
| `@tauri-apps/cli`（锁定版本）                  | 2.11.4               | 不变                 |

锁文件从 477 个包条目变为 491 个。按包名计，新增 6 个、移除 8 个（含五个 unic），另有 69 个包名的版本有变化，其中一部分是新增了并存的第二个版本。

清单只改了两行：`webview2-com` 0.38 → 0.39、`windows-core` 0.61 → 0.62。`lib.rs` 里关闭 WebView2 浏览器加速键的代码直接使用这两个 crate 的类型，必须和 Tauri 传递依赖里的实例一致。`package.json` 的范围（`^2`）没有变，只更新了 `package-lock.json`。

单实例插件保持 2.4.3：它声明 `tauri = "2.10"`，与 2.12.7 兼容；最新的 2.5.5 仍依赖 zbus 5，升级它清不掉 zbus 相关公告。

`@tauri-apps/cli` 保持 2.11.4。安装器模板 `src-tauri/installer/installer.nsi` 派生自这一版 CLI 的模板，打包时还会用到 CLI 自带的 `utils.nsh` 等辅助脚本。上游 2.12.6 的模板和辅助脚本有改动：进程检测改用 Restart Manager，静默／被动／更新模式的降级拦截提前，文件关联的命令行给程序路径加了引号。升级 CLI 之前要先核对自定义模板并做安装验收，不在本次范围。保持旧 CLI 的代价是 release 构建多一条 `STATIC_VCRUNTIME is deprecated` 提示（旧 CLI 用这个环境变量要求静态链接 VC 运行库，tauri-build 2.7 把它标为弃用）；新旧 CLI 构建出的可执行文件大小和导入表相同。

## 上游变更中与本应用有关的部分

摘自 Tauri 2.12.0–2.12.7、wry 0.56–0.57.3、tao 0.36–0.37.3 的发布说明，只列涉及 Windows 的条目：

- `windows` 0.62 和 `webview2-com` 0.39 起上游不再支持 Windows 7；MSRV 升到 1.90，改用 edition 2024。本项目的发布范围是 Windows 10/11，CI 固定的工具链是 1.99.1。
- Tauri 2.12.0 的发布说明列有一项安全修复 GHSA-w28w-mhc8-qvjv：通道数据队列按 webview 绑定；2.11.6 也包含这项修复。本应用只有一个 webview。
- 运行时 ACL 修正了 deny 权限的作用范围。本应用的能力文件没有 deny 条目，也不开放远程来源。
- tao 0.36–0.37 改动了初始隐藏的无边框窗口：延后最大化／还原，修正带阴影窗口的客户区和最小／最大尺寸，修正多显示器缩放比例不同时按逻辑坐标定位选错显示器的问题，并重构了部分键盘与输入法处理。
- wry 0.57.2 修正了 Windows 文件拖放（260 字符以上的路径；被拒绝的拖放不再发出空的 Drop 事件），0.57.0 起只在注册了 IPC 处理器时注入 `window.ipc`。
- 对话框插件 2.8.4 依赖 rfd 0.17（之前是 0.16）。

后三项对应窗口位置恢复、输入法、图片拖放和打开／保存对话框，自动化检查覆盖不到，需要在安装版里确认。

## 检查结果

本机 Windows 11，rustc 1.99.1，Node 26.13.1。除另行注明外，结果对应最终锁文件。

| 检查                                                     | 结果                                                                   |
| -------------------------------------------------------- | ---------------------------------------------------------------------- |
| `cargo test --locked`                                    | 116 通过、0 失败、4 忽略（三个真实符号链接回归和一个性能基线）         |
| `scripts/windows/test-real-symlinks.ps1`                 | 3 通过                                                                 |
| `cargo clippy --locked --all-targets -- -D warnings`     | 通过                                                                   |
| `cargo fmt --all -- --check`                             | 通过                                                                   |
| `npm run check`                                          | 93 个文件、992 项测试通过；覆盖率与升级前相同                          |
| `npm run audit:deps`                                     | 0 个漏洞                                                               |
| 完整浏览器回归                                           | 281 项通过；原生 IPC 为模拟，agent-browser 0.41.0                      |
| release 构建与 NSIS 打包（`tauri build --bundles nsis`） | 通过，CLI 没有报告 Tauri 各包版本不一致；生成的安装包没有运行          |
| `scripts/windows/test-delivery.ps1`                      | PowerShell 7 下 20 项通过；Windows PowerShell 被本机执行策略拦截，未跑 |
| Rust 生产覆盖率                                          | 本机没有 cargo-llvm-cov，未跑，以 CI 为准                              |
| 固定性能基线，安装包的安装、升级与卸载                   | 未跑                                                                   |

同一份源码的 release 可执行文件，旧依赖链（已含 url／cookie 补丁）为 53,446,656 字节，新依赖链为 53,676,544 字节，增加 229,888 字节（0.43%）。导入表新增 `combase.dll`、`imm32.dll` 和 `api-ms-win-core-winrt-error-l1-1-0.dll`，都是 Windows 10/11 自带的系统库；新旧两个文件都不导入 `vcruntime140.dll`。

### 隔离标识的启动冒烟

用 `--config` 把标识改为 `com.mdplus.smoke20261124` 另行构建 release（不是要发布的二进制），在本机启动：

- 主窗口正常显示（窗口类 `Tauri Window`，1216×809）。
- stderr 输出 `[mdplus] WebView2 browser accelerator keys enabled=false`，说明 `ICoreWebView2Settings3` 的调用在 webview2-com 0.39 下生效。
- 带文件参数启动第二个实例：第二个进程以退出码 0 结束，第一个实例继续运行，进程数仍为 1；退出后设置文件里出现了该文件的路径。单实例转发、`open-files` 事件、文稿读取和设置保存这条链路可用。
- 向主窗口发送关闭消息后，进程以退出码 0 结束。
- 运行前后，正式标识 `com.mdplus.desktop` 的设置文件摘要、WebView 数据目录的文件数和最新修改时间都没有变化；冒烟用的两个配置目录已删除。

这不是安装版验收，没有覆盖：打开／保存对话框、图片拖放与粘贴、`mdplus-image-stash` 协议的图片预览、F 键等实际按键、窗口位置在多显示器和不同缩放下的恢复、输入法、HTML／PDF 导出，以及安装、升级和卸载。

## 审计

- cargo-audit 0.22.2：`audit --file src-tauri/Cargo.lock --db <本地公告库> --no-fetch --json`，没有加 `--no-yanked`，没有忽略任何公告。
- 公告库为当天重新克隆的 [RustSec advisory-db](https://github.com/rustsec/advisory-db)，提交 `52384ab5581a4487b62c549eef95cf7ba7e8bad5`（2026-11-23T17:01:22+01:00），1563 条公告。输出 JSON 的数据库提交字段为 null，身份由 `git log` 确认。

| 锁文件                    | SHA-256                                                            | 包数 | 漏洞 | unsound | unmaintained |
| ------------------------- | ------------------------------------------------------------------ | ---- | ---- | ------- | ------------ |
| 升级前（`9b1e3d8`）       | `b87d58153f2cc52460c8a7dde4363252129930e495e3d8665e1afeb4c237bf4a` | 477  | 2    | 1       | 10           |
| 只升 url／cookie          | `5e01f5f7409db2dc2d1a776323e8c041799ea00d08be50d84ceb4aed32cb349a` | 477  | 0    | 1       | 10           |
| 最终（Tauri 2.12.7 整链） | `825840d6cfd486c28265076b6a387bca29a19fb83836cd8ef69f91a58b87c53e` | 491  | 0    | 1       | 5            |

三次都没有 yanked 条目，stderr 没有 registry 错误；同一命令对 `1c0ded5` 之前的锁文件能报出已撤回的 async-executor 1.14.0，说明撤回检查在工作。

与 [2026-11-15 复审](dependency-risk-recheck-2026-11-12.md)（0 个漏洞、2 项 unsound、9 项停止维护）相比：

- **RUSTSEC-2026-0592，url 2.5.8，漏洞。** 嵌套 `blob:` 地址调用 `Url::origin()` 时栈溢出；公告日期 2026-11-20，修复版本 ≥ 2.5.9。url 在 Windows 图中。在本应用源码和直接依赖 url 的包（tauri、tauri-utils、tauri-runtime、tauri-runtime-wry、tauri-codegen、tao、urlpattern、schemars 和两个插件）里没有检索到对 `Url::origin()` 或 `url::quirks::origin()` 的调用。这是静态检索，不是不可利用的证明。
- **RUSTSEC-2026-0594，cookie 0.18.1，漏洞。** 进程 fork 后 `PrivateJar` 的随机数重复；公告日期 2026-11-23，修复版本 ≥ 0.18.3。公告的受影响系统不含 Windows，本应用的依赖图也没有启用 cookie 的 `private` feature。
- **RUSTSEC-2026-0543，chrono 0.4.45，停止维护。** 2026-11-17 进入公告库，不在 Windows 图中。
- **RUSTSEC-2026-0486，rustix。** 已在 2026-11-17 随 1.1.6 消失（`1c0ded5`）。
- 五条 unic 公告（RUSTSEC-2025-0081、0075、0080、0100、0098）随本次升级消失。

最终锁文件的 Windows normal/build 图（`cargo tree --locked --offline --target x86_64-pc-windows-msvc --edges normal,build`）有 255 个包：包含 url 2.5.9、cookie 0.18.3、tokio 1.53.3、urlpattern 0.6.0、serde_with 3.21.0；不含五个 unic 包、glib、proc-macro-error、zbus、zbus_names、zvariant、zvariant_derive、chrono 和 rustix。

漏洞条目为 0、Windows 图不含某个包、测试通过，三者各有范围，都不等于整个依赖树绝对安全。

## 仍卡在上游的公告

| 公告                          | 锁定版本                                                  | 引入路径                                                       | 阻塞版本                                                                                         |
| ----------------------------- | --------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| RUSTSEC-2024-0429（unsound）  | glib 0.18.5                                               | gtk 0.18.2 ← tauri 2.12.7（Linux／BSD 目标）                   | Tauri 2.12.7（2026-11-18，最新的 2.x 正式版）仍要求 `gtk = "0.18"`；公告的修复版本是 glib ≥ 0.20 |
| RUSTSEC-2024-0370             | proc-macro-error 1.0.4                                    | gtk3-macros 0.18.2、glib-macros 0.18.5，同一条 GTK3 链         | 同上；公告没有修复版本                                                                           |
| RUSTSEC-2026-0371、0370、0372 | zbus_names 4.3.4、zvariant 5.13.1、zvariant_derive 5.13.1 | zbus 5.18.0 ← tauri-plugin-single-instance 2.4.3（Linux 目标） | 插件最新的 2.5.5（2026-10-28）仍要求 `zbus = "5.9"`；三个包已并入 zbus 6                         |
| RUSTSEC-2026-0543             | chrono 0.4.45                                             | serde_with 3.21.0 的可选依赖 ← tauri-utils 2.10.4              | 公告没有修复版本                                                                                 |

六个包都不在 Windows normal/build 图中。chrono 只以 serde_with 可选依赖的形式出现在锁文件里；其他目标是否编译它，本次没有核对。

缓解措施不变：发布范围保持 Windows；能力只授予本地主窗口，不开放远程来源；文件与图片请求限制类型、路径和容量；固定设置目录并拒绝损坏设置。这些措施降低应用暴露面，不能替代上游修复。增加 Linux 或其他平台的构建之前，必须重新评估这六条，不能沿用 Windows 的不可达结论。

**下次复查：2027-01-07**（维护者 2026-11-24 确定）。Tauri 或单实例插件在此之前发布迁移到 GTK4／zbus 6 的版本时提前复查。

## 原定节点与实际完成时间

- 原 2026-11-12 节点（Tokio 同 minor 补丁）未按期完成，实际完成于 2026-11-13（`9a5bc5c`，Tokio 1.53.3）。
- rustix 于 2026-11-17 升到 1.1.6（`1c0ded5`）。
- 原 2026-12-03 节点（其余链给出升级 PR 或明确阻塞）：本记录和对应的升级 PR 于 2026-11-24 提交；升级本身还要等原生验收和合并。

本机日志、审计 JSON 和各阶段锁文件副本保存在 `.audit/issue-2-tauri-2.12-2026-11-24/`，不随仓库提交。

## 2026-11-26 补记：验收、合并与关闭

以上写于 2026-11-24，当时原生验收和合并都还没有发生；「结论」和「原定节点与实际完成时间」两节里的相应说法是当时的状态，没有回改。本节时间按 +08:00；GitHub 显示的是 UTC，早 8 小时，合并和关闭在那里记为 2026-11-25。

### 原生验收

维护者（xsuooo）在本机（Windows 11）安装独立标识的测试版手测。

- **测试版一**（2026-11-25）按 `a828e2c` 构建。维护者事先说明要测对话框、拖放、F 键、输入法和安装卸载；测后报告标签栏观感和切换主题卡顿两处问题，「其他地方暂时没发现什么问题」。
- 标签栏是样式问题；切换主题的卡顿在 Tauri 2.11.5 和 2.12.7 上逐帧测量结果相同。两处都与本次升级无关，在 `dev/0.2.7` 修复（`4d5ddc8`、`b2d8d15`）。
- **测试版二**（2026-11-25）是 `a828e2c` 加这两处修改，状态栏显示的构建标识为 `a828e2cf60d6+ui.20261125`。它的应用源码、测试和依赖与合并提交相同，只有 `CHANGELOG.md` 不同。维护者拿到后回复「可以」。
- 2026-11-25 23:44 维护者报告「验收通过」，要求合并 PR #5 并关闭 Issue #2。

两个测试版都用 `--config` 改了产品名（MDPlus Test）、标识（`com.mdplus.testa828e2c`）和窗口标题，并去掉文件关联；其余构建配置与正式版相同。验收结论来自维护者的报告，没有逐项记录和日志，截图只有标签栏一张。

没有覆盖：

- 从 0.2.5 就地升级。测试版以独立产品安装，不覆盖正式版。
- 双击 `.md` 打开。测试版不注册文件关联；应用已运行时再次打开文件，由上文的启动冒烟覆盖。
- Windows 10。多显示器和不同缩放比例是否测过没有记录。
- 用正式标识从合并提交构建的安装包。
- 固定性能基线。

### 合并与复审

- [PR #5](https://github.com/xsuooo/MDplus/pull/5) 于 2026-11-26 00:42 合入 `dev/0.2.7`，合并提交 `eaa08e6`。合并前 PR 分支先合入了 `dev/0.2.7` 的两个界面提交（`548aa28`），合并提交与它是同一棵树。
- `548aa28` 上的 CI：前端 95 个文件，997 项通过、4 项 Windows 专用用例按平台跳过；浏览器回归 283 项通过（原生 IPC 为模拟）；Rust 116 通过、4 忽略，生产覆盖率行 73.17%、函数 56.67%（门槛 69%／51%），真实符号链接回归 3 项通过，Clippy 通过。[合并提交 `eaa08e6` 的 CI](https://github.com/xsuooo/MDplus/actions/runs/45656823116) 三个任务同样通过。
- 合并后的锁文件与上文「最终」一行是同一份（SHA-256 `825840d6…c53e`）。用合并后重新克隆的公告库 `b9b8a3c2cb1f2a3c76ab17a551193568c9f8b7a4`（2026-11-25T12:10:30+01:00，1568 条）复审：0 个漏洞、1 项 unsound、5 项停止维护，与 2026-11-24 的结果相同。
- 原 2026-12-03 节点实际完成于 2026-11-26。Issue #2 同日关闭。

### 关闭之后

- 「仍卡在上游的公告」一节的六个包和缓解措施不变；2027-01-07 的复查由 [Issue #6](https://github.com/xsuooo/MDplus/issues/6) 跟踪。
- CI 不运行 cargo-audit。上文两条漏洞公告是在公布后 1–4 天的人工复审里发现的，新公告不会让 CI 变红。
- 修复只在 `dev/0.2.7`。默认分支 `main` 的锁文件仍是 Tauri 2.11.5、url 2.5.8、cookie 0.18.1、rustix 1.1.4，五个 unic 包也还在。
