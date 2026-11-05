# 开发与质量检查

## 模块职责

`App.tsx` 保留页面组合、菜单和快捷键连接。文稿操作由以下模块拥有，避免把同一异步流程分散在多个组件的 effect 中。

| 模块                                          | 职责                                                               |
| --------------------------------------------- | ------------------------------------------------------------------ |
| `useDocumentSession`                          | 标签身份、当前视图、编辑器注册、内容镜像、内容／保存代次及共享队列 |
| `useDocumentSave`                             | 自动／手动保存与另存为队列、图片迁移、条件写入与提交基线           |
| `useDocumentClose`                            | 标签／窗口关闭协调、独立取消代次、忙碌状态及异步后的重检查         |
| `useWindowLifecycle` + `services/windowState` | 物理像素恢复、窗口监听及几何状态保存                               |
| `usePreferences` + `services/settingsStore`   | 设置初始化、用户选择优先、失败重试及固定原生资源访问               |
| `useRecovery`                                 | 延迟图片准备、恢复副本、恢复状态与恢复列表                         |
| `useDocumentFiles`                            | 打开、新建、原生启动／单实例／拖放输入及最近列表                   |
| `useExternalChanges`                          | 字节版本轮询、外改提示、重载并发校验                               |
| `useEditorView`                               | 输入、源码切换、选区／滚动位置、字体和缩放                         |
| `useDocumentExport`                           | 冻结导出快照、图片准备与 HTML/PDF 导出状态                         |

同步内容镜像和代次用于跨异步步骤核对最新状态；React 状态用于显示。保存与关闭的代次独立，取消关闭不能使已发出的保存失效。新增异步步骤时，应先补延迟、失败、取消或并发编辑的回归，再调整该流程。

保存单测通过公开的会话 hook 注入初始标签，不再依赖 App 的 `useState` 声明索引。设置和关闭协调器另有真实 React hook 测试；浏览器回归继续使用真实 React/Milkdown，仅模拟原生 IPC。

## 本地入口与 CI

需要 Node 22.13+（CI 使用 Node 22 / 浏览器使用 26.13）、Rust stable、rustfmt、Clippy 和 `llvm-tools-preview`。项目格式由 Prettier、EditorConfig 和 Git LF 规则统一；Rust 使用 rustfmt。

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
./scripts/windows/test-browser.ps1 -Browser $browser -Cases all -EvidenceDirectory $browserEvidence
./scripts/windows/test-delivery.ps1 -EvidenceDirectory $deliveryEvidence
```

`npm run check` 包含 lint、格式、配置同步、两套 TypeScript 和带覆盖率门槛的单测。CI 将这些步骤分别展示，并保留前端 LCOV/JSON、Rust LLVM JSON 和浏览器结果。交付脚本同时在 PowerShell 7 和 Windows PowerShell 5.1 验证。证据目录必须是新目录；浏览器参数必须指向原生 agent-browser EXE。

ESLint 对应用与测试启用 Hooks 调用规则和完整依赖规则。测试夹具允许 `any` 以注入损坏的原生数据；产品代码保持严格规则。两处控制字符正则有局部说明，因为它们用于拒绝或编码危险字符。

## 覆盖率基线与门槛

门槛来源为 [config/coverage.json](../config/coverage.json)，不使用全局忽略或空报告回退。前端覆盖 `src/**/*.{ts,tsx}`，排除启动挂载文件和类型声明。Rust 覆盖当前 Windows 生产代码，排除构建脚本与独立的 `*_tests.rs`；稳定 Rust 尚未报告分支覆盖，因此 Rust 门槛只检查行和函数。

| 前端指标 | 重构前基线 | 本次结果 | 最低门槛 |
| -------- | ---------: | -------: | -------: |
| 语句     |     44.52% |   47.47% |      44% |
| 分支     |     44.27% |   45.72% |      44% |
| 函数     |     37.55% |   41.47% |      37% |
| 行       |     47.36% |   48.81% |      47% |

Rust 将内嵌测试移到独立文件后，生产代码基线为行 **69.86%**、函数 **51.79%**，门槛分别为 **69%**、**51%**。早期探测的 76.05% 包含内嵌测试代码，不用于门槛或前后对比。后续应随核心行为测试提升覆盖率，不能为绕过失败随意降低门槛。

## 配置与构建标记

[config/application.json](../config/application.json) 管理开发端口、保存／轮询／恢复时延、图片解析缓存、历史记录、文件和恢复容量。前端常量和 Rust 生成常量共享该来源。修改开发地址后执行 `npm run config:sync`，同步 Tauri 必需的静态 `devUrl`；CI 的 `config:check` 拒绝漂移。构建来源清单包括 `config/` 和质量配置，排除自动生成的 Tauri 权限文件。

构建标记由 `config/build.ts` 提供并由 Vite 注入 `__MDPLUS_BUILD_ID__`：优先 `MDPLUS_BUILD_ID`、其次 CI 的 `GITHUB_SHA`，本地使用 Git 短哈希及 dirty 标记；无 Git 信息的开发包标为 `development`。Windows 交付脚本调用相同生成器，避免清单和界面标记分离。

接口修改遵循 [IPC 入口](ipc.md)。依赖告警及升级日期见 [Rust 依赖跟踪](dependency-risk-2026-11-05.md)；安装后的原生 DPI、IME、剪贴板和 PDF 人工验收仍属于发布验收范围。
