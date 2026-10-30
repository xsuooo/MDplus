# MDPlus

Windows 上的 Markdown 桌面编辑器，所见即所得。

## 下载

旧 v0.2.4 Release、标签及安装包已于 2026-10-30 撤下。当前分支保留此前的功能和安全更新，并包含本轮图片、列表、主题切换及字体修复，尚未重新发布安装包。

历史版本见 [Releases](https://github.com/xsuooo/MDplus/releases)，不包含本轮修复。需要当前修复版时，请按下方开发说明从源码构建。

## 功能

- 富文本编辑 + 源码模式随时切换
- 多标签页，自动保存
- Mermaid 图表、KaTeX 数学公式、代码高亮、任务列表
- 截图 Ctrl+V 直接插入，首次保存时自动迁移到文档同级 `assets/` 目录
- 文档内搜索、大纲导航
- 导出 HTML / PDF（经系统打印对话框）
- 状态栏实时显示词数 / 字符数 / 行数
- 双击 `.md` 文件直接打开，单实例复用窗口
- 记住窗口大小、位置、最大化状态和大纲栏状态

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

构建安装包：

```bash
npm run tauri build
```

产物在 `src-tauri/target/release/bundle/`。

## 技术栈

Tauri · React · TypeScript · Vite · Milkdown · Mermaid · KaTeX

## 文档

- [更新日志](CHANGELOG.md) —— 每个版本的变更、验收结论与已知限制
- [维护说明](docs/update-notes.md) —— 图标生成、构建检查与常见问题排查
- [文件关联](docs/file-association.md) —— `.md` 文件关联的实现原理与手动注册方法
- [快捷键改造说明](docs/fn-key-shortcuts-plan.md) —— v0.2.4 功能键快捷入口的开发与测试记录

## 许可证

MIT
