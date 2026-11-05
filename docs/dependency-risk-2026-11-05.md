# Rust 依赖告警跟踪（2026-11-05）

跟踪 issue：[xsuooo/MDplus#2](https://github.com/xsuooo/MDplus/issues/2)。

当前锁文件的 `cargo-audit` 漏洞条目为 0，另有 2 项 `unsound` 和 9 项停止维护公告。结论限于 `x86_64-pc-windows-msvc`：没有发现这两项内存／I/O 安全公告涉及的代码会进入当前 Windows 构建。停止维护公告仍属于需要处理的维护风险，不能用编译和测试通过证明依赖绝对安全。

核对使用 RustSec 数据库 2026-11-04 快照、锁定的 Cargo 依赖树及依赖源码中的条件编译；原生测试和 Clippy 均在 Windows 运行。

| 公告                                                                       | 锁定依赖                                                                                                   | Windows 结论／处置                                                                                                                                           |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html) | `glib 0.18.5`                                                                                              | 通过 GTK/WebKit 的非 Windows 依赖链引入；不在 Windows normal/build 依赖树中。需随 Tauri/GTK 升级到修复链，单独新增 `glib >=0.20` 不会移除旧实例              |
| [RUSTSEC-2026-0386](https://rustsec.org/advisories/RUSTSEC-2026-0386.html) | `tokio 1.53.1`                                                                                             | Tokio 在 Windows 使用，但受影响的 `io::unix::AsyncFd` 位于 `cfg(all(unix, feature = "net"))`，Windows 不编译该模块。升级窗口验证 `1.53.3` 或更新兼容补丁     |
| [RUSTSEC-2024-0370](https://rustsec.org/advisories/RUSTSEC-2024-0370.html) | `proc-macro-error 1.0.4`                                                                                   | 不在当前 Windows normal/build 依赖树中；随 GTK 宏依赖链处理                                                                                                  |
| RUSTSEC-2025-0081、0075、0080、0100、0098                                  | `unic-char-property`、`unic-char-range`、`unic-common`、`unic-ucd-ident`、`unic-ucd-version`，均为 `0.9.0` | 在 Windows 构建及运行依赖中，经 `urlpattern → tauri-utils` 引入。公告为停止维护；当前审计未列出对应漏洞条目。跟踪 Tauri/urlpattern 切换到维护中的 Unicode 库 |
| RUSTSEC-2026-0371、0370、0372                                              | `zbus_names 4.3.4`、`zvariant 5.13.1`、`zvariant_derive 5.13.1`                                            | 经单实例插件的非 Windows D-Bus 链引入，不在 Windows normal/build 依赖树中。随插件迁移至 zbus 6 处理                                                          |

## 升级窗口与缓解措施

- **2026-11-12 前**：验证 Tokio 兼容补丁，复跑 Windows 原生测试、Clippy、覆盖率和完整浏览器回归；检查 Tauri、urlpattern、single-instance 上游进展。
- **2026-12-03 前**：对其余链给出升级 PR 或再次评估的明确结论。若上游仍不兼容，记录阻塞版本、保留缓解措施，并设置下一次复查日期。
- **增加 Linux 构建之前**：重新评估 glib、D-Bus 和 AsyncFd，不能沿用 Windows 的不可达结论。

当前缓解措施：发布范围保持 Windows；能力仅授予本地主窗口，不开放远程来源；移除不用的 IPC/opener；文件与图片请求限制类型、路径和容量；固定设置目录并拒绝损坏设置。上述措施降低应用暴露面，不能替代上游修复。

## 复查命令

```powershell
cargo audit --file src-tauri/Cargo.lock --json
cargo tree --manifest-path src-tauri/Cargo.toml --locked --target x86_64-pc-windows-msvc --edges normal,build
cargo tree --manifest-path src-tauri/Cargo.toml --locked --target x86_64-pc-windows-msvc --invert unic-ucd-ident
cargo tree --manifest-path src-tauri/Cargo.toml --locked --target all --invert glib
cargo tree --manifest-path src-tauri/Cargo.toml --locked --target all --invert zvariant
```

npm 依赖保持 0 已知漏洞，CI 执行 `npm run audit:deps`。新 lint 工具使用的 minimatch 统一约束到 `^11.0.4`，修复 GHSA-g3hv-75wg-m249；已通过干净安装、lint、测试与生产构建验证兼容性。
