# MDPlus Icon Redesign Implementation Plan

**Goal:** 完成折页 M＋图标，并以单份 SVG 统一应用内和桌面资源。

**Architecture:** React 与 favicon 引用同一 SVG。Python 入口仅负责调用项目已有 Tauri CLI，并发布生成的六个桌面文件。

**Tech Stack:** SVG、React、Vite、Tauri CLI、Python 标准库。

## Global Constraints

- 保留编辑器、保存、窗口和文件关联行为。
- 保留无关工作区修改；不添加依赖，不暂存或提交。
- 不添加与视觉资源无关的行为测试；执行现有前端检查和实际图形核验。

## Task 1: 图形与生成链路

- [x] 查看现有图标、生成器、应用内组件、配色和构建配置。
- [x] 在 `icon-preview/redesign/` 对比折页、纸页、几何字标三种设计。
- [x] 保存原文件与跟踪文件 SHA-256，便于复核工作区边界。
- [x] 将选定图形保存为 `src/assets/app-icon.svg`。
- [x] 重写 `make_icon.py`，以 `subprocess.run([node, cli, 'icon', source, '--output', staging])` 调用本地工具；CLI 生成失败时不复制到正式目录。
- [x] 生成现有六个桌面资源，独立检查 PNG、ICO 和 ICNS 格式及尺寸。

## Task 2: 引用统一与交付

- [x] `IconBrand` 使用导入的 SVG URL，保留 SVG 外层的属性接口。
- [x] `index.html` 添加 SVG favicon；移除品牌图标重复配色 CSS。
- [x] 更新 `docs/update-notes.md` 的图标生成说明。
- [x] 用 `agent-browser` 检查欢迎页浅色与深色显示、favicon 和控制台。
- [x] 执行 `npm run check`、`npm run build`、`git diff --check`。
- [x] 对照初始 SHA-256 核验无关文件，提供图标预览和精确验证范围。
