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

### v0.2.6 候选版新增（未发布）

- 文档内查找替换：展开查找栏的替换行，支持单次、全部和空文本替换；富文本保留一致格式，跨不同格式的匹配会跳过并显示数量
- 继续上次会话：恢复已保存文稿的标签顺序、活动标签和阅读／编辑位置；可在「最近打开」菜单关闭，恢复失败的文稿可以重试
- 拖入或选择本地 PNG/JPG/JPEG 图片：拖入使用鼠标位置，工具栏「插入图片」保留选中文字并在选区末尾插入；多张自然排序，整批一次撤销，保存时复制到文稿同级 `assets/`
- 源码模式的目录跟随当前 Markdown 更新，点击标题直接定位原文
- 富文本中 `Ctrl+点击` 或链接内 `Ctrl+Enter` 打开相对 `.md`／`.markdown` 文稿；同路径复用已有标签
- 从正文空白处拖出矩形框选图片，半透明蒙版标明选中范围；仅复制、删除相交图片，保留中间正文，也支持连续拖选与 `Shift+点击` 扩选
- 双击图片打开查看器，`Ctrl+滚轮` 或 `Ctrl+=` / `Ctrl+-` 缩放，`Esc` 返回。编辑器的 `Ctrl+滚轮` 按帧预览缩放，滚动结束后完成排版

操作方式和恢复／插入边界见 [编辑工作流说明](docs/editor-workflows-2026-11-07.md)，本轮打磨与验证见 [修复记录](docs/quality-fixes-2026-11-08.md)。以上改动尚未包含在当前下载的 v0.2.5 安装包中。

## 快捷键

| 快捷键                        | 作用         |
| ----------------------------- | ------------ |
| `Ctrl+N`                      | 新建文档     |
| `Ctrl+O`                      | 打开文件     |
| `Ctrl+S`                      | 保存         |
| `Ctrl+F`                      | 查找         |
| `Ctrl+Z` / `Ctrl+Y`           | 撤销 / 重做  |
| `Ctrl+W`                      | 关闭当前标签 |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | 切换标签     |

## 开发

需要 Node.js 22.13+（推荐当前 LTS）、Rust stable、Visual Studio C++ 构建工具和 WebView2。目前仅支持 Windows。

```bash
npm ci
npm run tauri dev
```

运行检查和测试：

```bash
npm run check
```

该入口包括 ESLint / React Hooks、格式、配置同步、TypeScript 和带覆盖率门槛的单测。原生、浏览器与交付检查见 [开发与质量检查](docs/development-quality.md)。

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
- [开发与质量检查](docs/development-quality.md) —— 模块职责、回归检查、覆盖率门槛与共享配置
- [编辑工作流说明](docs/editor-workflows-2026-11-07.md)：候选版的查找替换、会话恢复、图片插入、目录与文稿链接
- [IPC 契约与安全边界](docs/ipc.md) —— 原生命令、参数校验与失败语义
- [Rust 依赖跟踪](docs/dependency-risk-2026-11-05.md) —— Windows 影响核查与升级窗口
- [文件关联](docs/file-association.md) —— 设置默认打开方式与单实例打开机制

## 许可证

MIT

本软件使用 MiSans 字体。内置字体的来源、版权及许可证见 [字体授权](public/font-licenses/README.txt)。
