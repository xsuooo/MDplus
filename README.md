# MDPlus

Windows 上的 Markdown 桌面编辑器，所见即所得。

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

## 许可证

MIT
