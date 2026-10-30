# MDPlus

Windows 上的 Markdown 桌面编辑器，所见即所得。

## 下载

当前版本 **[v0.2.5](https://github.com/xsuooo/MDplus/releases/tag/v0.2.5)** · **[下载 Windows x64 安装包](https://github.com/xsuooo/MDplus/releases/download/v0.2.5/MDPlus_0.2.5_x64-setup.exe)**

支持 Windows 10/11 x64，需要 WebView2。升级前请保存文档并退出 MDPlus。安装包未签名，不支持直接覆盖 MSI 安装的旧版。

## 功能

- 富文本与源码模式随时切换
- 多标签页、自动保存与草稿恢复
- Mermaid 图表、KaTeX 数学公式、代码高亮、任务列表
- 截图 Ctrl+V 直接插入，保存时写入文档同级 `assets/` 目录
- 界面／正文与源码／代码字体独立设置，内置字体离线可用
- 图片与图表支持放大查看，浅色／深色主题随时切换
- 文档内搜索、可调宽大纲栏、自定义快捷键与编辑器缩放
- 导出独立 HTML / PDF，保留字体、图片、公式与图表
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

需要 Node.js 20.19+ 或 22.12+（推荐当前 LTS）、Rust stable、Visual Studio C++ 构建工具和 WebView2。目前仅支持 Windows。

```bash
npm install
npm run tauri dev
```

运行检查和测试：

```bash
npm run check
```

构建 Windows 安装包：

```bash
npm run tauri -- build --bundles nsis
```

产物在 `src-tauri/target/release/bundle/nsis/`。完整的交付校验与回退流程见 [Windows 交付说明](docs/ops/windows-delivery.md)。

## 技术栈

Tauri · React · TypeScript · Vite · Milkdown · Mermaid · KaTeX

## 文档

- [更新日志](CHANGELOG.md) —— 每个版本的改进与修正
- [维护说明](docs/update-notes.md) —— 图标生成、构建检查与常见问题排查
- [文件关联](docs/file-association.md) —— 设置默认打开方式与单实例打开机制

## 许可证

MIT

本软件使用 MiSans 字体。内置字体的来源、版权及许可证见 [字体授权](public/font-licenses/README.txt)。
