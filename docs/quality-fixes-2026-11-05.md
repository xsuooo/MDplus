# 2026-11-05 代码审查修复与回归

本次修复审查确认的 7 个问题。隔离目录中的复现已纳入正式测试，新增 30 项前端单测、23 项浏览器回归和 1 项 Rust 文件系统回归。

## 修复范围

| 问题                                                           | 修复后的行为                                                                                                                                                              | 正式回归                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 确认最后一个脏标签后，关闭窗口仍会丢失其他标签的新输入         | 最终关闭统一经过恢复副本清理和窗口状态保存，并在每次异步操作后重新检查当前全部标签                                                                                        | `edit-after-final-close-confirm`、`edit-during-window-close`                                                                                                                                                                                                        |
| 保存关闭期间点击取消，保存完成后仍关闭标签                     | 关闭请求有独立代次；取消使旧关闭回调失效，磁盘保存可正常完成。执行中的保存／放弃按钮禁止重复确认，取消保持可用                                                            | `cancel-during-close-save`、`cancel-during-window-save`、`cancel-during-close-cleanup`、`duplicate-close-actions`                                                                                                                                                   |
| 保存物理像素，恢复时却使用逻辑像素                             | 窗口尺寸、坐标和显示器工作区统一使用物理像素，沿用已有持久化格式                                                                                                          | `window-restore-125`、`window-restore-150`、`tests/windowState.test.ts`                                                                                                                                                                                             |
| 每次输入同步解析整个 Markdown，1 MiB 文档输入回调阻塞约 1.4 秒 | 图片准备在停输 150 ms 后合并执行；无 `![` 的文档跳过图片语法解析。保存、另存为、导出等待当前原文的准备结果；恢复快照继续等待图片字节完整                                  | `large-source-input`、`large-source-image-input`、`large-new-source-image-input`、`tests/imagePreparation.test.ts`、`tests/imageParsing.test.ts`、`tests/appSave.test.tsx`                                                                                          |
| 外部替换文件但保留修改时间时，编辑器没有发现变化               | 每 2 秒对干净且没有进行保存／重载的标签检查字节版本；重新加载前后核对同一版本。后台提示延后到切回标签，拒绝重载不推进保存基线；仅更新时间戳仍可刷新图片                   | `external-change-same-mtime`、`disk-during-read-same-mtime`、`external-change-same-mtime-background`、`external-change-same-mtime-decline`、`image-reference-touch-refresh`                                                                                         |
| 等价路径把同一文档打开为多个标签，另存为也可能绕过冲突检查     | 原生文档接口返回经过校验的绝对目标路径；前端统一比较点路径、分隔符、大小写、扩展路径前缀和 UNC 路径。打开中的请求、另存为目标、最近记录和图片比较采用同一规则             | `same-file-path-alias`、`same-file-relative-path`、`same-file-extended-path`、`same-file-concurrent-open`、`saveas-path-collision`、`saveas-relative-current`、`tests/pathIdentity.test.ts`、Rust `document_commands_return_one_absolute_identity_for_path_aliases` |
| 设置 Store 首次加载失败后，失败 Promise 永久缓存               | 并发调用共享一次加载；加载失败后允许下一次读取或写入重试，成功的 Store 继续缓存，写队列保持顺序。启动回退值只初始化视图，用户更改才写回，避免重试后把已存偏好覆盖成默认值 | `tests/store.test.ts`、`settings-load-retry-startup`                                                                                                                                                                                                                |

图片准备缓存同时核对内容代次、原文、路径和磁盘版本。源码切换到渲染模式时会根据保留的原文重新建立恢复任务，`source-images-toggle` 和 `source-images-toggle-recovery` 验证四张粘贴图片的保存和恢复字节完整。

解析缓存最多保留 4 份原文，累计原文长度不超过 4 Mi 个 UTF-16 代码单元；超过此大小的文档不进入解析缓存。恢复快照的图片准备屏障、原生条件写入、失败副本保留和保存期间的新输入保护继续适用。

## 接口与维护规则

文件接口契约位于 [file_contract.json](../src-tauri/src/file_contract.json)，对应前端类型在 [fileOps.ts](../src/lib/fileOps.ts)。`read_document`、`document_revision`、`write_document` 的响应新增必填 `path`，包括尚不存在的另存为目标。原生测试和浏览器 mock 已同步该字段。

相对路径必须先由原生接口解析为绝对目标；[pathIdentity.ts](../src/lib/pathIdentity.ts) 不猜测进程工作目录。已有标签和进行中的打开请求按该身份去重。另存为选择当前文档的等价路径时转入普通保存；迁移图片后再次检查目标版本和其他已打开标签。

主题、大纲和快捷键的启动读取只更新视图。用户操作通过对应更改函数写回设置；较晚完成的启动读取会忽略已经被用户更改的偏好。

窗口状态中的 `width`、`height`、`x`、`y` 以及显示器工作区均为物理像素。Tauri 配置中的默认窗口／最小窗口尺寸仍遵循 Tauri 的配置单位，恢复时由原生窗口约束处理。

## 检查

检查入口与 [.github/workflows/ci.yml](../.github/workflows/ci.yml) 对齐：

```powershell
npm run check
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
./scripts/windows/test-browser.ps1 -ListCases -Cases all
./scripts/windows/test-browser.ps1 -Browser $browser -Cases all -EvidenceDirectory $browserEvidence
./scripts/windows/test-delivery.ps1 -EvidenceDirectory $deliveryEvidence
powershell.exe -NoProfile -NonInteractive -File ./scripts/windows/test-delivery.ps1 -EvidenceDirectory $ps51Evidence
```

`$browser` 指向原生 agent-browser Windows EXE；证据目录应为全新路径。交付脚本在 PowerShell 7 和 Windows PowerShell 5.1 下分别检查。本机 Windows PowerShell 5.1 的 `RemoteSigned` 策略拦截了工作区脚本，本次使用测试子进程参数 `-ExecutionPolicy Bypass` 执行已检查的交付脚本。

| 检查                            | 本次结果                                                               |
| ------------------------------- | ---------------------------------------------------------------------- |
| 两套 TypeScript 检查与前端单测  | 37 个文件、453 项通过                                                  |
| 前端生产构建                    | 通过                                                                   |
| Rust 单测                       | 57 项通过                                                              |
| Rust 格式与 Clippy              | 通过，Clippy 使用 `-D warnings`                                        |
| 完整浏览器目录                  | 171 项通过                                                             |
| PowerShell 7 交付脚本           | 19 项通过                                                              |
| Windows PowerShell 5.1 交付脚本 | 19 项通过                                                              |
| npm audit                       | 0 项漏洞                                                               |
| cargo-audit                     | `vulnerabilities` 为 0；2 条 `unsound`、9 条 `unmaintained` 信息性告警 |

依赖锁文件未在本次修复中升级。Rust 审计数据库更新时间为 2026-11-04，两条 `unsound` 公告涉及 glib 和 Tokio Unix `AsyncFd`；停维护告警仍需后续跟随上游处理。

1 MiB 输入性能回归记录实际 `SourceEditor` input 事件和 App 回调耗时，并检查立即保存包含最后一次输入与图片引用。该指标不包含完整绘制时间。修复前回调约 1.3–1.4 秒，修复后同机完整浏览器检查约 18–26 ms。

浏览器回归使用真实 React／Milkdown 和模拟原生 IPC；Rust 回归使用实际 Windows 临时文件。交付脚本使用合成安装包。本次验证范围不包含安装后的原生 DPI、IME、剪贴板或 PDF 人工验收。
