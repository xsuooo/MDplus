# MDPlus

一个专为 Windows 设计的 Markdown 桌面编辑器。

## 特性

- **所见即所得编辑**：实时预览，边写边看
- **多标签页**：同时编辑多个文档
- **源码模式**：需要的时候可以直接编辑 Markdown 源码
- **自动保存**：写完就保存，不用担心丢失内容
- **图表支持**：内置 Mermaid 图表和 KaTeX 数学公式
- **代码高亮**：支持各种编程语言的语法高亮
- **任务列表**：勾选框直接点击就能切换状态
- **搜索功能**：快速查找和替换
- **文档大纲**：长文档也能快速跳转
- **文件关联**：双击 .md 文件直接打开

## 开发环境

需要安装：

- Node.js 20 或更新版本
- Rust 稳定版本
- Windows WebView2（一般系统自带）

启动开发服务器：

```bash
npm install
npm run dev
```

启动桌面应用：

```bash
npm run tauri dev
```

## 构建

运行检查：

```bash
npm run typecheck
npm test
```

构建安装包：

```bash
npm run tauri build
```

构建完成后，安装包在 `src-tauri/target/release/bundle/` 目录下。

## 项目结构

```
src/              前端界面和编辑器逻辑
src/lib/          文件操作、编辑器插件、模板
src-tauri/        后端文件读写和打包配置
```

## 技术栈

- React + TypeScript - 界面开发
- Vite - 构建工具
- Tauri - 桌面应用框架
- Milkdown - Markdown 编辑器内核
- Mermaid - 图表渲染
- KaTeX - 数学公式

## 许可证

MIT

