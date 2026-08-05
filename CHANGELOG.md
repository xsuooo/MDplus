# MDPlus v0.1.0 更新

## 新功能

### 1. 文件关联支持
- 双击 .md 和 .markdown 文件直接在 MDPlus 中打开
- 不再显示欢迎页，直接进入编辑
- 支持从文件资源管理器拖拽打开

### 2. 全新应用图标
- 现代化蓝绿渐变设计
- 简洁的 MD+ 标志
- 圆角矩形风格

## 改进

- README 改为中文，更易读
- 应用描述本地化
- 完善开发文档

## 技术细节

**文件关联实现：**
- Tauri 配置添加 fileAssociations
- Rust 后端解析命令行参数
- React 前端启动时自动打开传入的文件

**图标生成：**
- 使用 Python + Pillow 生成多尺寸图标
- 包含 ICO 和 PNG 格式
- 适配 Windows 各种显示场景

## 文件变更

```
新增：
- docs/file-association.md    # 文件关联功能说明
- docs/update-notes.md         # 详细更新说明
- generate_icon.py             # 图标生成脚本
- create-icon.html             # 图标生成工具（浏览器版）

修改：
- README.md                    # 中文化
- src-tauri/tauri.conf.json   # 文件关联配置
- src-tauri/src/lib.rs        # 命令行参数处理
- src-tauri/Cargo.toml        # 应用描述
- src/App.tsx                  # 启动文件打开逻辑
- src-tauri/icons/*           # 新图标文件
```

## 已知问题

- 双击文件会启动新实例（未实现单实例模式）
- 文件关联仅在安装版本生效

## 下一步计划

- 实现单实例模式
- 添加 macOS 支持
- 文件缩略图预览
