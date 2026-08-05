# 文件关联功能

## 功能说明

MDPlus 现在支持通过双击 `.md` 或 `.markdown` 文件直接在应用中打开。

## 实现细节

### 1. 文件关联配置

在 `src-tauri/tauri.conf.json` 中配置了 Windows 文件关联：

```json
"windows": {
  "fileAssociations": [
    {
      "ext": ["md", "markdown"],
      "name": "Markdown Document",
      "description": "Markdown Document",
      "role": "Editor",
      "mimeType": "text/markdown"
    }
  ]
}
```

### 2. 命令行参数处理

在 `src-tauri/src/lib.rs` 的 `run()` 函数中添加了 `.setup()` 钩子：

- 从 `std::env::args()` 读取命令行参数
- 过滤出 `.md` 和 `.markdown` 文件路径
- 通过 `window.eval()` 将文件路径数组注入到前端的 `window.__TAURI_STARTUP_FILES__`

### 3. 前端启动处理

在 `src/App.tsx` 中添加了 `useEffect` 钩子：

- 检测 `window.__TAURI_STARTUP_FILES__` 是否存在
- 如果存在，遍历所有文件路径并调用 `openFileFromPath()` 打开
- 处理完成后删除该全局变量，避免重复打开

## 使用方法

### 首次使用

1. 构建并安装应用：`npm run tauri build`
2. 安装生成的安装包
3. 右键点击任意 `.md` 文件
4. 选择"打开方式" → "MDPlus"
5. （可选）勾选"始终使用此应用打开 .md 文件"

### 打开文件

直接双击 `.md` 文件即可在 MDPlus 中打开。

## 已知限制

- 文件关联仅在构建后的安装版本中生效（开发模式下不支持）
- 如果应用已经运行，双击文件会启动新实例（未实现单实例模式）
