# MDPlus

Windows 上的 Markdown 桌面编辑器，所见即所得。

## 当前状态与下载

当前正式发布版本为 **`0.2.5`**，构建标识 **`release-20261031.1`**，发布分支为 `release`，标签为 `v0.2.5`。保留阶段 1～6 与全局字体补修，不新增功能；安装包是否已公开以 [v0.2.5 发布页面](https://github.com/xsuooo/MDplus/releases/tag/v0.2.5) 为准。

下载发布页中的 **`MDPlus_0.2.5_x64-setup.exe`** 与对应 `.sha256` 校验文件。本版只提供 Windows x64 NSIS 安装包；不提供 MSI，不支持直接覆盖既有 MSI 安装。包未配置代码签名，安装前请核对来源和 SHA256，遵循本机安全策略。

旧 v0.2.4 Release、标签及安装包已于 2026-10-30 撤下，本次不复用该标签。详细变更、验证边界和回滚方法见 [v0.2.5 发布说明](docs/ops/release-notes-v0.2.5.md)。浏览器测试使用真实 React/Milkdown/CSS/字体，但模拟原生 IPC，不等于 Windows 原生逐项验收。

本次发布不自动更新开发者本机；原 `0.2.5-phase6.2` 安装及回退资料保留。构建、单一当前包目录、归档与回退统一遵循 [Windows 交付与回退入口](docs/ops/windows-delivery.md)，不要直接运行工作区内的低完整性构建包。

## 功能

- 富文本编辑 + 源码模式随时切换
- 多标签页，自动保存
- Mermaid 图表、KaTeX 数学公式、代码高亮、任务列表
- 截图 Ctrl+V 直接插入，首次保存时自动迁移到文档同级 `assets/` 目录
- 图片／图表单击选中，通过独立入口放大查看；图表使用“编辑图表”进入源码，输入即时参与保存和恢复保护
- 文档内搜索、大纲导航
- 导出浅色单文件 HTML（内嵌字体、图片、公式与图表，显示文件体积）；PDF 使用同一份独立页面，经系统打印对话框保存，不改变编辑器主题
- 状态栏实时显示词数 / 字符数 / 行数
- 双击 `.md` 文件直接打开，单实例复用窗口
- 记住窗口大小、位置、最大化状态和大纲栏状态
- 右下角“排版”全局设置界面／正文和源码／代码字体，带实时预览，独立记忆；菜单、弹窗及按钮跟随界面／正文选择，快捷键按键跟随代码选择；默认 MiSans 和 JetBrains Mono + 更纱黑体，离线可用，不改变 Windows 系统对话框字体

本软件使用 MiSans 字体。字体来源、版权及完整授权协议见 [字体授权](public/font-licenses/README.txt)；其余字体采用 SIL OFL 1.1。

## 快捷键

| 快捷键 | 作用 |
| --- | --- |
| `Ctrl+N` | 新建文档 |
| `Ctrl+O` | 打开文件 |
| `Ctrl+S` | 保存 |
| `Ctrl+F` | 查找 |
| `Ctrl+Z` / `Ctrl+Y` | 撤销 / 重做 |
| `Ctrl+W` | 关闭当前标签 |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | 切换标签 |

## 开发

需要 Node.js 20.19+ 或 22.12+（推荐当前 LTS）、Rust stable、Windows WebView2。

支持范围：Windows 10/11 + WebView2；macOS / Linux 与非 Chromium WebView 不在支持范围内。

```bash
npm install
npm run tauri dev
```

运行检查和测试：

```bash
npm run check
```

构建并导出安装包（Windows PowerShell / PowerShell，另需 7-Zip；不会安装）：

```powershell
.\scripts\windows\deliver.ps1 -Build -OutputRoot "$env:USERPROFILE\Downloads\MDPlus-Delivery"
```

仅把交付目录 `current` 中的包作为当前候选；旧包保存在 `archive`。脚本校验 npm/Cargo/Tauri 版本、提取真实 NSIS 载荷、校验哈希并以新字节文件导出。安装是另一个需要显式参数、验收记录和备份的步骤，详见交付入口。

脚本合成回归（不安装，不触碰用户配置）：

```powershell
.\scripts\windows\test-delivery.ps1
```

## 技术栈

Tauri · React · TypeScript · Vite · Milkdown · Mermaid · KaTeX

## 文档

- [v0.2.5 发布说明](docs/ops/release-notes-v0.2.5.md) —— 变更、安装条件、验证边界与回滚
- [Windows 交付与回退入口](docs/ops/windows-delivery.md) —— 构建、唯一当前包、备份、显式安装、失败停止与回退
- [收尾验收报告](docs/stable-closeout.md) —— 本次验证、历史证据边界、未执行项与字体人工检查
- [阶段 1](docs/phase1-execution.md) · [阶段 2](docs/phase2-execution.md) · [阶段 3](docs/phase3-execution.md) · [阶段 4](docs/phase4-execution.md) · [阶段 5](docs/phase5-execution.md) · [阶段 6](docs/phase6-execution.md) · [全局字体补修](docs/global-font-update.md) —— 历史执行记录，保留当时结论
- [更新日志](CHANGELOG.md) —— 每个版本的变更、验收结论与已知限制
- [维护说明](docs/update-notes.md) —— 图标生成、构建检查与常见问题排查
- [文件关联](docs/file-association.md) —— `.md` 文件关联的实现原理与手动注册方法
- [快捷键改造说明](docs/fn-key-shortcuts-plan.md) —— v0.2.4 功能键快捷入口的开发与测试记录

## 许可证

MIT
