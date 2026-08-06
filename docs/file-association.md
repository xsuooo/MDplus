# 文件关联功能

## 功能说明

MDPlus 支持双击 `.md` 或 `.markdown` 文件直接在应用中打开。应用采用单实例模式：如果 MDPlus 已在运行，双击文件会在已有窗口中新建标签页打开，并把窗口带到前台，不会启动第二个进程。

## 实现细节

### 1. 文件关联配置

在 `src-tauri/tauri.conf.json` 的 `bundle` 层配置：

```json
"bundle": {
  "fileAssociations": [
    {
      "ext": ["md", "markdown"],
      "name": "Markdown 文档",
      "description": "Markdown 文档",
      "role": "Editor",
      "mimeType": "text/markdown"
    }
  ]
}
```

### 2. 冷启动：命令行参数 → `take_startup_files`

应用未运行时双击文件属于冷启动，走托管状态：

- `src-tauri/src/lib.rs` 在 **WebView 创建之前**用 `markdown_files_from_args()` 从 `std::env::args()` 里筛出存在的 `.md` / `.markdown` 路径
- 路径存入 Tauri 托管状态 `StartupFiles`
- 前端 `src/App.tsx` 启动时 `invoke('take_startup_files')` 读取。该命令**只消费一次**（取出后清空），避免重复打开
- 命令返回空数组或调用失败时，`startupResolved` 仍会置为 `true`，不会让界面卡在空白

启动期间界面由 `src/lib/startup.ts` 的 `startupView()` 决定：未解析完显示占位视图，解析完毕后按标签数量决定进编辑器还是欢迎页。这样双击文件时不会先闪一下欢迎页。

### 3. 热启动：单实例插件 → `__TAURI_OPEN_FILES__`

应用已在运行时双击文件，由 `tauri-plugin-single-instance` 拦截第二个实例：

- 第二实例的命令行参数同样经 `markdown_files_from_args()` 筛选
- 已有窗口执行 `show()` / `unminimize()` / `set_focus()` 带到前台
- 有文件时通过 `window.eval()` 注入 `window.__TAURI_OPEN_FILES__`
- 前端监听并消费该全局变量（`src/App.tsx`），处理后立即 `delete`，避免重复打开

两条路径的参数筛选逻辑共用 `markdown_files_from_args()`，并有 cargo 测试覆盖「启动文件只消费一次」和「参数在 WebView 创建前被识别」。

## 使用方法

### 安装版本

1. 构建并安装应用：`npm run tauri build`
2. 右键点击任意 `.md` 文件
3. 选择「打开方式」→「MDPlus」
4. （可选）勾选「始终使用此应用打开 .md 文件」

之后直接双击 `.md` 文件即可打开。

### 手动注册（可选）

仓库根目录的 `register-file-association.bat` 可以手动写入注册表完成关联，适用于「打开方式」里找不到 MDPlus 的情况。脚本默认查找 `%LOCALAPPDATA%\MDPlus\MDPlus.exe`（NSIS 安装包的默认路径），装到其他位置时需要先改脚本里的 `MDPLUS_PATH`。

脚本只写 `HKCU`（当前用户），不需要管理员权限。

## 图标缓存

关联生效后如果资源管理器仍显示旧图标，重建图标缓存：

```bash
ie4uinit.exe -show
```

## 已知限制

- 文件关联仅在构建安装后的版本中生效，开发模式（`npm run tauri dev`）不支持
- 仅配置了 Windows 平台，macOS / Linux 的关联尚未处理
