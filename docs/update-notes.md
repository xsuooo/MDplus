# 维护说明

图标生成、构建检查与常见问题排查。文件关联的实现原理和使用方法见 [file-association.md](file-association.md)。

## 应用图标

### 重新生成

```bash
pip install Pillow
python make_icon.py
```

脚本在 1024×1024 超采样绘制后降采样，一次性输出 Tauri 需要的全套图标到 `src-tauri/icons/`：

- `icon.png`（512）、`128x128@2x.png`（256）、`128x128.png`、`32x32.png`
- Windows Store 用的各 Square / StoreLogo 尺寸
- `icon.ico`（内含 16 / 24 / 32 / 48 / 64 / 128 / 256 多个尺寸）
- `icon.icns`（512）

同时输出三套配色的预览到 `icon-preview/`，用 `icon-preview/index.html` 可以在各尺寸和深浅背景下比对。

仓库里还有个早期的 `generate_icon.py`（手绘线条版）和 `create-icon.html`（浏览器手动导出），都已被 `make_icon.py` 取代，不要再用。

### 当前设计

纯白「MD+」一行居中，字号相同，衬在圆角渐变磁贴上。文字用系统 Arial Bold（`C:/Windows/Fonts/arialbd.ttf`）渲染，比手绘线条清晰，缩到 16px 仍可读。

脚本内置三套配色，写入 `src-tauri/icons/` 的是**方案 A**：

| 方案 | 磁贴渐变 |
| --- | --- |
| A | Indigo #6366f1 → Cyan #06b6d4 |
| B | Dark Slate #1e293b → #334155 |
| C | Violet #8b5cf6 → Pink #ec4899 |

换配色要改 `main()` 里 `renders["A"]` 取的 key，改 `THEMES` 的颜色值只影响渐变本身。

### 字号自适应的坑

`render_mdplus()` 里从 600 开始递减试字号，判断宽度必须用 `bb[2] - bb[0]`。`textbbox` 在 `anchor='mm'` 下以原点为中心返回坐标，直接取 `bb[2]` 拿到的只是**半宽**，会让循环提前退出，「MD+」被渲染得比磁贴还宽而在裁切时截断。

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
npm run tauri build
```

产物在 `src-tauri/target/release/bundle/` 下，MSI 和 NSIS 两种安装包都会生成。

## 平台支持

目前只针对 Windows。macOS / Linux 的文件关联和打包配置还没做。
