# 维护说明

图标生成、构建检查与常见问题排查。文件关联的实现原理和使用方法见 [file-association.md](file-association.md)。

当前版本与下载见 [README](../README.md)。交付包的校验、导出、安装和回退详见 [Windows 交付说明](ops/windows-delivery.md)。

## 应用图标

### 图形来源

唯一正式源图为 `src/assets/app-icon.svg`：白色圆角底，黑色折线 M 与紧邻的等臂加号。应用欢迎页与浏览器 favicon 直接引用它；大小尺寸、浅色与深色背景保持同一品牌图形。

修改图标时只编辑该 SVG，再重新生成桌面资源。M 与加号作为整体垂直居中于画布，加号与 M 的墨迹间距为 24px；图形不依赖字体，CSS 不单独重定义品牌颜色。

### 重新生成

安装项目 npm 依赖后运行：

```bash
python make_icon.py
```

脚本仅使用 Python 标准库，调用项目已有的 Tauri CLI，不需要 Pillow、NumPy 或系统字体。先在临时目录生成，成功后只复制以下六个文件到 `src-tauri/icons/`：

- `icon.png`（512）、`128x128@2x.png`（256）、`128x128.png`（128）、`32x32.png`（32）
- `icon.ico`（Tauri 生成的 16 / 24 / 32 / 48 / 64 / 256 像素帧）
- `icon.icns`

Tauri 临时生成的移动端和商店图标不会写入仓库。需要独立预览、核对输出时：

```bash
python make_icon.py --output icon-preview/generated
```

正式资源使用选定设计，不再支持旧版脚本的 `paper`、`teal` 等方案切换参数。重新生成资源后需要重新构建应用，已安装的程序与任务栏图标不会仅随源码修改而更新。

## 图标缓存

更新图标后系统仍显示旧图标时，重建 Windows 图标缓存：

```bash
ie4uinit.exe -show
```

仍不生效可以删掉缓存文件后重启资源管理器：

```
C:\Users\<用户名>\AppData\Local\IconCache.db
```

## 构建与检查

提交前跑前端检查（类型检查 + 单元测试，CI 跑的是同一条命令）：

```bash
npm run check
```

Rust 侧三项，和 CI 完全一致：

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
```

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

```bash
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

打包安装程序：

```bash
npm run tauri -- build --bundles nsis
```

产物在 `src-tauri/target/release/bundle/nsis/`。当前只分发 Windows x64 NSIS 安装包；需要版本、SHA256 和安装包载荷校验时，使用 [交付脚本](ops/windows-delivery.md)。

## 平台支持

目前只针对 Windows。macOS / Linux 的文件关联和打包配置还没做。
