# MDPlus v0.1.1

简洁好用的 Markdown 编辑器

## 🎉 新功能

- **文件关联支持**：双击 `.md` 和 `.markdown` 文件直接在 MDPlus 中打开
- **全新图标**：现代化的蓝绿渐变设计，更加美观
- **中文界面**：安装包和应用描述全部中文化

## 📦 下载

### Windows 安装包

- **MSI 安装包**（推荐）：`MDPlus_0.1.1_x64_zh-CN.msi`
  - 适合企业环境部署
  - 支持静默安装
  
- **NSIS 安装包**：`MDPlus_0.1.1_x64-setup.exe`
  - 安装向导更友好
  - 体积更小

选择其中一个下载安装即可。

## ✨ 功能特性

- 所见即所得编辑
- 多标签页支持
- 源码模式切换
- 自动保存
- Mermaid 图表
- KaTeX 数学公式
- 代码语法高亮
- 任务列表
- 搜索替换
- 文档大纲

## 🚀 快速开始

1. 下载并安装 MSI 或 NSIS 安装包
2. 右键任意 `.md` 文件 → "打开方式" → 选择 MDPlus
3. 勾选"始终使用此应用打开"
4. 以后双击 `.md` 文件就能直接打开了

## 📝 更新内容

### 新增
- Windows 文件关联配置
- 命令行参数处理
- 启动时自动打开文件
- 全套应用图标（多尺寸）

### 改进
- README 改为中文
- 文件关联描述本地化
- 安装包语言改为中文

### 修复
- 修复构建错误（添加 Manager trait 导入）

## 🔧 技术栈

- React + TypeScript
- Tauri 2.0
- Milkdown 编辑器
- Mermaid 图表
- KaTeX 数学公式

## 📋 已知限制

- 双击文件会启动新实例（计划在后续版本实现单实例模式）
- 仅支持 Windows（macOS 和 Linux 支持计划中）

## 🐛 问题反馈

如有问题或建议，欢迎提交 Issue。

---

**完整更新日志**：[CHANGELOG.md](https://github.com/xsuooo/MDplus/blob/main/CHANGELOG.md)
