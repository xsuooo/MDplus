# Rust 依赖风险复查（2026-11-12）

> 本文正文是 `9a5bc5c`（Tokio 升级到 1.53.3）之前的快照：其中的 tokio 1.53.1、锁文件 SHA、分支名 `converge/0.2.6` 和 3 项 unsound 都是当时的状态，未改写。升级后的结果见文末「2026-11-15 复审」。文中 `D:/Dev/rust/cargo/registry` 和 `.audit/` 下的链接指向调查机器的本地文件，仓库里没有。

**2026-11-12 的结论以文末主诊断补充为准：完整锁文件审计为 0 个漏洞条目、3 项 unsound、9 项停止维护；独立研究前文只核验旧清单的 11 个指定公告。**

检索日期：2026-11-12，Asia/Singapore。研究对象：[xsuooo/MDplus#2](https://github.com/xsuooo/MDplus/issues/2)。本次为独立、只读技术调查，仅新增本笔记，不修改业务代码、依赖声明、锁文件、issue 或台账，不提交或推送。

**结论：Tokio 1.53.3 是已发布且被 RustSec 列为修复的同 minor 补丁；替换 unic 的 urlpattern 和 Tauri 2 正式发行链已经存在；single-instance 2.5.5 的正式发布仍使用 zbus 5，没有完成 zbus 6 迁移。Windows 条件编译边界支持降低相关 Unix/GTK/D-Bus 暴露，但不支持宣布当前完整依赖树安全。**

## 复用的旧材料及不足

- [dependency-risk-2026-11-05.md](dependency-risk-2026-11-05.md)：一句话结论是，2026-11-04 数据库快照记录 0 条漏洞、2 条 unsound、9 条 unmaintained，Windows 未发现两条 unsound 的受影响路径。
- [quality-fixes-2026-11-05.md](quality-fixes-2026-11-05.md#L49-L65)：一句话结论是，旧修复与回归通过，但未升级 Rust 锁文件，审计仍基于 2026-11-04 快照。

这两份笔记可复用为历史版本、平台范围和既有回归记录，不能证明今天仍为“0 漏洞”，也不能证明候选修复版本存在、上游迁移已经发布或对 MDplus 兼容。本次以官方公告当前原文及正式发布标签重新核验，不把上游 main/dev 分支当作发行证据。

## 当前源码与锁定版本

已读取 [Cargo.toml](../../src-tauri/Cargo.toml#L24-L53) 和完整 [Cargo.lock](../../src-tauri/Cargo.lock)。源码声明 Tauri、tauri-build、single-instance 为 2，没有直接声明 Tokio 或 urlpattern；源码声明范围不等于已锁定版本。

| 依赖组             | 当前锁定版本                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| Tauri              | tauri 2.11.5；tauri-build 2.6.3；tauri-utils 2.9.3；tauri-runtime-wry 2.11.4；wry 0.55.1                        |
| 本次单独核验的公告 | glib 0.18.5；tokio 1.53.1；proc-macro-error 1.0.4                                                               |
| URL/Unicode        | urlpattern 0.3.0；unic-char-property、unic-char-range、unic-common、unic-ucd-ident、unic-ucd-version 均为 0.9.0 |
| 单实例/D-Bus       | tauri-plugin-single-instance 2.4.3；zbus 5.18.0；zbus_names 4.3.4；zvariant 和 zvariant_derive 均为 5.13.1      |

本机已缓存的官方发行源码进一步确认：tauri-utils 2.9.3 要求 urlpattern 0.3；urlpattern 0.3.0 要求 unic-ucd-ident 0.9.0；single-instance 2.4.3 仅在 Linux target 下要求 zbus 5.9。锁文件包含所有 target 的包，不能仅凭存在某个包推断 Windows 实际编译或执行它。

## 正式公告、受影响范围与类别

以下 11 个指定 ID 的 advisory-db 当前原文最终均返回 **HTTP 200**。glib、Tokio、proc-macro-error 的 RustSec 官方展示页也均返回 HTTP 200。本次没有遇到最终无法取得的指定公告，也没有把不存在的 ID 补成推测条目。

### 两条 unsound

| 公告及一手原文                                                                                                                                                                          | 类别、受影响与修复范围                                                                                                                                                                                                        | 当前锁定版本判断                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [RUSTSEC-2024-0429 官方页](https://rustsec.org/advisories/RUSTSEC-2024-0429.html)；[原文](https://raw.githubusercontent.com/rustsec/advisory-db/main/crates/glib/RUSTSEC-2024-0429.md)  | informational = unsound；VariantStrIter 的 Iterator/DoubleEndedIterator 实现写入不可变引用，可能发生未定义行为或空指针崩溃。受影响 >=0.15.0,<0.20.0；unaffected <0.15.0；patched >=0.20.0。                                   | glib 0.18.5 落入受影响范围；不因 Windows 路径未进入构建而变成修复版本。 |
| [RUSTSEC-2026-0386 官方页](https://rustsec.org/advisories/RUSTSEC-2026-0386.html)；[原文](https://raw.githubusercontent.com/rustsec/advisory-db/main/crates/tokio/RUSTSEC-2026-0386.md) | 正式公告：Reported 2026-10-13，Issued 2026-10-23。informational = unsound；categories = memory-corruption；涉及 I/O safety 和 use-after-free。unaffected <0.3.2；patched >=1.51.6,<1.52.0 或 >=1.53.3，其余匹配版本仍受影响。 | tokio 1.53.1 不在 patched 范围；1.53.2 也不是公告列出的修复版本。       |

Tokio 公告列出的函数为 AsyncFd::new、with_interest（自 0.3.2 起）以及 try_new、try_with_interest（自 1.37.0 起）。AsRawFd 不证明描述符的所有权、有效性或生命周期，错误使用可造成无效 BorrowedFd 和驱动事件访问已释放内存，不能把 informational 误读为“没有安全后果”。[来源](https://raw.githubusercontent.com/rustsec/advisory-db/main/crates/tokio/RUSTSEC-2026-0386.md)

### 九条停止维护公告

旧笔记的“9 条”是 **proc-macro-error 1 条 + unic 5 条 + zbus/zvariant 3 条**；unic 和 zbus/zvariant 本身合计 8 条，不是另外 9 条。以下各条均为 informational = unmaintained，且 patched = []，没有同名 crate 的已公布修复版本。这是维护风险分类，不是九个已证明可利用的内存漏洞，也不是安全豁免。

| 公告当前原文（各 HTTP 200）                                                                                                    | 包及锁定版本             | 公告给出的状态或迁移方向                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [RUSTSEC-2024-0370](https://raw.githubusercontent.com/rustsec/advisory-db/main/crates/proc-macro-error/RUSTSEC-2024-0370.md)   | proc-macro-error 1.0.4   | 维护者长期无活动；公告列出 manyhow、proc-macro2-diagnostics 作为可能替代方案。[官方页](https://rustsec.org/advisories/RUSTSEC-2024-0370.html) |
| [RUSTSEC-2025-0081](https://raw.githubusercontent.com/rustsec/advisory-db/main/crates/unic-char-property/RUSTSEC-2025-0081.md) | unic-char-property 0.9.0 | rust-unic 系列停止维护；建议 icu_properties。                                                                                                 |
| [RUSTSEC-2025-0075](https://raw.githubusercontent.com/rustsec/advisory-db/main/crates/unic-char-range/RUSTSEC-2025-0075.md)    | unic-char-range 0.9.0    | rust-unic 系列停止维护；公告提到 Rust 标准库的 char 范围迭代。                                                                                |
| [RUSTSEC-2025-0080](https://raw.githubusercontent.com/rustsec/advisory-db/main/crates/unic-common/RUSTSEC-2025-0080.md)        | unic-common 0.9.0        | rust-unic 系列停止维护。                                                                                                                      |
| [RUSTSEC-2025-0100](https://raw.githubusercontent.com/rustsec/advisory-db/main/crates/unic-ucd-ident/RUSTSEC-2025-0100.md)     | unic-ucd-ident 0.9.0     | rust-unic 系列停止维护；公告建议 icu_properties 或 unicode-ident。                                                                            |
| [RUSTSEC-2025-0098](https://raw.githubusercontent.com/rustsec/advisory-db/main/crates/unic-ucd-version/RUSTSEC-2025-0098.md)   | unic-ucd-version 0.9.0   | rust-unic 系列停止维护。                                                                                                                      |
| [RUSTSEC-2026-0371](https://raw.githubusercontent.com/rustsec/advisory-db/main/crates/zbus_names/RUSTSEC-2026-0371.md)         | zbus_names 4.3.4         | 不再作为独立 crate 维护；自 zbus 6.0.0 起并入 names 模块。                                                                                    |
| [RUSTSEC-2026-0370](https://raw.githubusercontent.com/rustsec/advisory-db/main/crates/zvariant/RUSTSEC-2026-0370.md)           | zvariant 5.13.1          | 不再作为独立 crate 维护；D-Bus wire 格式并入 zbus 6.0.0 的 wire 模块；GVariant 使用者应迁移 zgvariant。                                       |
| [RUSTSEC-2026-0372](https://raw.githubusercontent.com/rustsec/advisory-db/main/crates/zvariant_derive/RUSTSEC-2026-0372.md)    | zvariant_derive 5.13.1   | 独立 crate 停止维护；派生宏由 zbus 6.0.0 起提供。                                                                                             |

## Windows 可达性：可确认的边界

1. **Tokio 在 Windows 使用，但此公告针对 Unix AsyncFd。** 已读锁定 1.53.1 的 io 模块及 cfg_net_unix 宏；实际条件为 cfg(all(unix, feature = "net"))。常规 x86_64-pc-windows-msvc 构建不会编译该模块。这个结论只排除指定函数，不排除 Tokio 的其他 Windows 缺陷，也不适用于将来 Linux 发行。[官方锁定版本条件编译源码](https://raw.githubusercontent.com/tokio-rs/tokio/tokio-1.53.1/tokio/src/macros/cfg.rs)
2. **glib 与 proc-macro-error 的已查路径属于 GTK 链。** Tauri 2.11.5 在 Linux/BSD target 区域引入 GTK/WebKit；缓存的 GTK 0.18.2 要求 glib 0.18 和 gtk3-macros 0.18，gtk3-macros 0.18.2 再要求 proc-macro-error 1.0。这支持旧笔记对这条链的 Windows 排除判断，不能宣称 glib 本身仅支持 Unix，或证明所有未来依赖路径都不可达。[Tauri 锁定版本原文](https://raw.githubusercontent.com/tauri-apps/tauri/tauri-v2.11.5/crates/tauri/Cargo.toml)；[缓存 GTK 发行源码](D:/Dev/rust/cargo/registry/src/index.crates.io-1949cf8c6b5b557f/gtk-0.18.2/Cargo.toml#L83-L87)；[缓存宏发行源码](D:/Dev/rust/cargo/registry/src/index.crates.io-1949cf8c6b5b557f/gtk3-macros-0.18.2/Cargo.toml#L55-L56)
3. **zbus 的排除依据是调用方 target 条件，不是 D-Bus 天然不能出现在 Windows。** single-instance 2.4.3 仅在 cfg(target_os = "linux") 依赖 zbus；Windows 使用另一套实现。本次已查插件路径不进入 Windows。锁文件中 zbus 的 Windows 相关依赖也说明不能靠包名做全局平台判断。[插件锁定版本原文](https://raw.githubusercontent.com/tauri-apps/plugins-workspace/single-instance-v2.4.3/plugins/single-instance/Cargo.toml)；[锁文件](../../src-tauri/Cargo.lock)
4. **unic 不能按平台排除。** 当前 tauri-utils 对 urlpattern 的依赖没有 Unix target gate，urlpattern 对 unic-ucd-ident 的依赖也没有；五个 unic 包继续属于 Windows 相关的构建/运行依赖维护风险。[缓存 tauri-utils 原文](D:/Dev/rust/cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tauri-utils-2.9.3/Cargo.toml#L202-L203)；[缓存 urlpattern 原文](D:/Dev/rust/cargo/registry/src/index.crates.io-1949cf8c6b5b557f/urlpattern-0.3.0/Cargo.toml#L41-L43)

本次没有重算完整 Windows normal/build 依赖图、feature 合并或所有调用点，没有复现未定义行为，也没有运行原生/浏览器回归。以上为锁定版本源码静态证据及旧笔记路径复核，不是新的动态“不可利用”证明。即使发行范围保持 Windows，也不能用平台排除解释为锁文件已修复。

## 已发布修复与上游迁移

### Tokio：1.53.3 可作为同 minor 最小候选

[正式发布页](https://github.com/tokio-rs/tokio/releases/tag/tokio-1.53.3)、[tag Cargo.toml](https://raw.githubusercontent.com/tokio-rs/tokio/tokio-1.53.3/tokio/Cargo.toml) 均 HTTP 200，版本确为 1.53.3；发布页时间为 2026-10-13T20:49:48Z，CHANGELOG 标注 October 13th, 2026。正式发布增加 unsafe 的 AsyncFd::register/register_with_interest，并弃用旧安全构造器。已检索的[官方发布 feed](https://github.com/tokio-rs/tokio/releases.atom)与[CHANGELOG](https://raw.githubusercontent.com/tokio-rs/tokio/master/tokio/CHANGELOG.md)未见更新的 1.53.x 补丁；1.54.x 是另一 minor，不是本次最小同 minor 候选。

**“RustSec 列为 patched”不等于旧 API 已移除。** 1.53.3 的[正式 tag 源码](https://raw.githubusercontent.com/tokio-rs/tokio/tokio-1.53.3/tokio/src/io/async_fd.rs)仍保留 deprecated 的 new/with_interest/try_new/try_with_interest，并在内部调用 unsafe register。未来 Unix 支持必须另查调用方是否保证描述符整个 AsyncFd 生命周期有效、保持打开且不被替换。升级可满足该公告的版本判定，但不能替任意调用方证明 I/O safety。该 tag 标明 rust-version = 1.71；未验证 MDplus 的实际解析及回归。

### unic：已有正式替代链，不必再把问题描述成“等待上游开始迁移”

- urlpattern **0.4.0** 已有[正式标签/发布入口](https://github.com/denoland/rust-urlpattern/releases/tag/0.4.0)，时间为 2025-09-17；其[Cargo.toml](https://raw.githubusercontent.com/denoland/rust-urlpattern/0.4.0/Cargo.toml)已用 icu_properties = "2" 代替 unic，其[tokenizer 源码](https://raw.githubusercontent.com/denoland/rust-urlpattern/0.4.0/src/tokenizer.rs)实际使用 ICU IdStart/IdContinue 属性，不只是修改声明。
- urlpattern **0.6.0** 也出现在[官方发布 feed](https://github.com/denoland/rust-urlpattern/releases.atom)，时间为 2026-02-12；[正式 tag 清单](https://raw.githubusercontent.com/denoland/rust-urlpattern/0.6.0/Cargo.toml)仍用 icu_properties = "2"，edition = "2024"。
- **tauri-utils 2.10.2 已正式发布**，不是 main/dev 推断：[发布页](https://github.com/tauri-apps/tauri/releases/tag/tauri-utils-v2.10.2)时间为 2026-10-14T18:47:18Z，其[对应 tag 清单](https://raw.githubusercontent.com/tauri-apps/tauri/tauri-utils-v2.10.2/crates/tauri-utils/Cargo.toml)要求 urlpattern = "0.6"。
- 已发布的 **Tauri 2.12.5** 提供一条明确的 Tauri 2 正式候选链：[发布页](https://github.com/tauri-apps/tauri/releases/tag/tauri-v2.12.5)时间为 2026-10-21T11:54:49Z；[workspace 清单](https://raw.githubusercontent.com/tauri-apps/tauri/tauri-v2.12.5/Cargo.toml)要求 tauri-utils ~2.10.2，且[utils 清单](https://raw.githubusercontent.com/tauri-apps/tauri/tauri-v2.12.5/crates/tauri-utils/Cargo.toml)要求 urlpattern 0.6。无须以 Tauri 3 alpha 作为此次替代证据。

当前 tauri-utils 2.9.3 的 urlpattern = "0.3" 不接受 0.4/0.6；向 MDplus 额外添加新版 urlpattern 不会替换旧实例。另一方面，Tauri 2.11.5 对 tauri-utils 使用 version = "2.9.3"，不是 ~2.9.3，声明范围本身允许后续 2.x；因此本调查**不声称必须升级 Tauri 核心至 2.12.5 才能替换 unic**。能否仅解析到新版 utils、是否仍有其他旧路径，需要后续锁定解析与回归才能判断，当前锁文件没有变化。[锁定 Tauri 声明](https://raw.githubusercontent.com/tauri-apps/tauri/tauri-v2.11.5/crates/tauri/Cargo.toml)

Tauri 2.12.5 正式 workspace 的 **MSRV 为 Rust 1.90，edition 为 2024**；发行存在与 semver 范围允许都不等于工具链和应用兼容性已验证。[正式 workspace 原文](https://raw.githubusercontent.com/tauri-apps/tauri/tauri-v2.12.5/Cargo.toml)

### single-instance：最新已查正式版仍未迁移 zbus 6

[官方筛选发布列表](https://github.com/tauri-apps/plugins-workspace/releases?q=single-instance&expanded=true)及[2.5.5 发布页](https://github.com/tauri-apps/plugins-workspace/releases/tag/single-instance-v2.5.5)均 HTTP 200，发布页明确记录成功 Published 到 crates-io，时间为 2026-10-28T00:04:10Z。

该正式 tag 的[插件清单](https://raw.githubusercontent.com/tauri-apps/plugins-workspace/single-instance-v2.5.5/plugins/single-instance/Cargo.toml)仍从 Linux target 引用 workspace zbus；[workspace 清单](https://raw.githubusercontent.com/tauri-apps/plugins-workspace/single-instance-v2.5.5/Cargo.toml)实际为 zbus = "5.9"，不是 6。因此升级到已查正式版 2.5.5 **不能据此消除独立 zbus_names/zvariant/zvariant_derive 的停止维护风险**。强行覆盖为 zbus 6 不满足其现有 major 约束，也未证明调用 API 兼容。该 tag 同时要求 Tauri 2.12、Rust 1.90、edition 2024，不能当成只修改 Linux 依赖的无成本补丁。

## 检索失败与未验证边界

- 内置 web_fetch 的实际中介端点 https://api.exa.ai/fetch 返回 **HTTP 404**；这是取数服务配置错误，不是 RustSec/GitHub 源站或公告 ID 不存在。后续使用只读直接 HTTP 获取上述官方来源，没有改取数配置或安装工具。
- [advisory-db HEAD API](https://api.github.com/repos/rustsec/advisory-db/commits?per_page=1)和 Tokio/Tauri/插件匿名 GitHub releases API 返回 **HTTP 403，API rate limit exceeded**。改用官方原文、发布 HTML 和 Atom feed 验证指定条目与发行；没有获取全量最新数据库及可固定的完整快照 commit，也没有覆盖旧笔记未提到的新公告。不能把本次定点复核写成新的完整 cargo-audit 结果。
- unic-char-property 原文首次直接请求发生 fetch failed，未取得可报告的 HTTP 状态；重试取得 HTTP 200。尝试 GTK 宏 https://raw.githubusercontent.com/gtk-rs/gtk3-rs/0.18.2/gtk3-macros/Cargo.toml 返回源站 **HTTP 404**，因此没有假定该 Git tag 存在，改读本机已缓存的 0.18.2 官方发行源码确认依赖。
- 本机 cargo audit 本次不可用；未安装工具、未执行旧缓存审计二进制、未重跑 cargo-audit。未运行 cargo update、构建、测试、Clippy、浏览器回归或发布包验收。
- 新版候选链的实际锁定解析、重复旧实例是否消失、MSRV/工具链兼容、Unicode 行为及单实例 Windows 回归均未验证。glib >=0.20 的兼容 GTK/Tauri 迁移链也未在本次最小调查中完成发行级验证；不将单独加 glib >=0.20 当作现有传递实例已修复。

## 主诊断补充：完整锁文件审计与平台图（2026-11-12）

前文记录独立研究子任务的定点调查范围；以下是主诊断实际补做的审计与依赖图证据。它补齐前文没有取得完整数据库、没有运行审计和完整 Windows 图的缺口，不把研究子任务的失败改写成成功。

- 工作树基线为 converge/0.2.6、af59d1a。本机 rustc 1.99.1 已高于研究所见新版 Tauri workspace 的 Rust 1.90 要求；发行存在和本机编译器版本仍不证明依赖解析或应用兼容性。
- 复用现有 cargo-audit 0.22.2。默认数据库因 Rust 安装目录只读而无法取得锁，主诊断没有改 ACL 或删除锁，改用工作区内独立的新数据库目录。首次成功获取的数据库含 1458 条公告，提交为 [fd6f39814c4d3c359fdbe223d0280dec4933f78f](https://github.com/rustsec/advisory-db/commit/fd6f39814c4d3c359fdbe223d0280dec4933f78f)，更新时间为 2026-11-11T13:22:32+01:00。
- 实际审计 477 个锁定包，结果是 vulnerabilities=0、unsound=3、unmaintained=9。新增 [RUSTSEC-2026-0486 原文](https://raw.githubusercontent.com/rustsec/advisory-db/fd6f39814c4d3c359fdbe223d0280dec4933f78f/crates/rustix/RUSTSEC-2026-0486.md)：rustix 1.1.4 的 xattr 零长度 Buffer 处理会错误标记未写入内存已初始化，patched >=1.1.6，unaffected <1.0.0。不能继续把旧清单的 2 条 unsound 写成当前总数。
- 已实际复跑 Windows normal/build 图：包含 Tokio 1.53.1 和 5 个 unic 0.9.0 包；不含 glib、proc-macro-error、zbus/zvariant 或 rustix。Tokio 的指定 Unix AsyncFd 模块由前文源码条件排除。全目标 rustix 反向图经 async-io/polling/zbus 和 tempfile 引入，但 Windows 反向图为空。三个 unsound 的指定受影响路径未进入本次 Windows 构建，维护风险仍需记录。
- Cargo.lock 前后 SHA-256 均为 1a665bbe6867118bcab3e4e17bbfac863fdb52254f315100bd8c8371b3ecb4be。没有执行升级、构建、安装或升级后回归；--no-yanked 明确排除了撤回发行版检查。图和版本核查不是运行时利用测试，也不代表已发布安装包已验收。

实际命令与本地原始收据：

```bash
.audit/review-20261105/tools/bin/cargo-audit.exe audit --file src-tauri/Cargo.lock --db .audit/triage-2-rustsec-28d4819b-aeb7-4e58-941d-159c4b8525b5 --json --no-yanked
cargo tree --manifest-path src-tauri/Cargo.toml --locked --offline --target x86_64-pc-windows-msvc --edges normal,build
cargo tree --manifest-path src-tauri/Cargo.toml --locked --offline --target x86_64-pc-windows-msvc --edges normal,build --invert rustix
cargo tree --manifest-path src-tauri/Cargo.toml --locked --offline --target all --edges normal,build --invert rustix
git -C .audit/triage-2-rustsec-28d4819b-aeb7-4e58-941d-159c4b8525b5 rev-parse HEAD
```

[本地审计 JSON](../../.audit/triage-2-rustsec-28d4819b-aeb7-4e58-941d-159c4b8525b5-audit.json)来自 --no-fetch 重读，数据库提交/时间字段为 null；数据库身份由首次成功获取结果及独立 git rev-parse 确认，不手改原始 JSON。

主诊断建议最小执行边界是先单独验证 Tokio 同 minor 补丁，再单独验证仅更新 tauri-utils 至正式去 unic 链是否可行；不预设必须升级 Tauri 核心或插件，不强行覆盖 zbus 6。Windows-only 范围和 2026-12-03 复查点已经在票面给定，不重复询问这两个前提。实际升级和正式 Agent Brief 均等待维护者确认分流，研究不构成实施授权。

## 研究阶段提出的待议事项（供主诊断筛选）

1. 是否授权后续把 Tokio 1.53.3 作为最小补丁候选，并单独安排真正的最新数据库审计及 Windows 回归？本笔记不构成实施授权。
2. 是否接受 Rust 1.90 的 Tauri 2 新版候选链，并优先验证仅更新 tauri-utils 的最小方案，还是继续保留当前锁定版本？unic 的阻塞应从“上游尚未替换”改为“本项目尚未验证并采纳已发布替代链”。
3. 是否继续以 Windows-only 发行接受已查 Linux/GTK/D-Bus 路径的暂存风险，并沿用旧笔记 2026-12-03 复查点？增加 Linux 支持前必须重新评估 AsyncFd 调用与 glib/D-Bus 迁移；single-instance 的 zbus 6 迁移仍需跟踪正式发行，而不是 main 分支。

## 2026-11-15 复审（Tokio 1.53.3 之后）

对候选分支 `codex/candidate-0.2.6` 的 `2351ad7` 重跑了完整锁文件审计：

- 命令：`cargo-audit 0.22.2`，`audit --file src-tauri/Cargo.lock --no-yanked`。
- 公告库：提交 `4ef2df8e806a65e2f1ecc14f56f51249062b23d6`（2026-11-13），1509 条公告。
- 锁文件：477 个包，SHA-256 `accfc291ddfdc5d454d9c623ac5a818da2b053b9d44f0354cb4fb83a1d370233`，tokio 1.53.3。
- 结果：0 个漏洞条目、2 项 unsound、9 项停止维护。

与 2026-11-12 相比，RUSTSEC-2026-0386（tokio）已消失。剩余 unsound 为 RUSTSEC-2024-0429（glib 0.18.5）和 RUSTSEC-2026-0486（rustix 1.1.4）。9 项停止维护与上次相同：proc-macro-error 1.0.4、五个 unic 0.9.0 包、zbus_names 4.3.4、zvariant 5.13.1、zvariant_derive 5.13.1。

本次只重跑了审计，没有重做 `cargo tree` 的平台可达性分析，也没有检查撤回（yanked）版本。上面三个待议事项仍未决定。
