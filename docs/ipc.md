# IPC 契约与安全边界

[file_contract.json](../src-tauri/src/file_contract.json) 是应用命令的统一 JSON 契约。请求字段使用 camelCase。新增或删除命令时，同步修改契约、[命令目录](../src-tauri/src/ipc_commands.rs)、原生 `generate_handler!`、[主窗口能力](../src-tauri/capabilities/default.json)及前端适配器。

`tauri-build::AppManifest` 将目录中的命令纳入 Tauri 权限检查；仅本地主窗口 `main` 获准使用，不配置远程来源或窗口通配符。`tests/ipcContract.test.ts` 核对这四处声明、原生参数名称及容量配置；Rust 文件测试核对真实序列化响应。请求类型、文件路径、容量及内容版本仍由原生代码校验，前端校验不能替代原生边界。

| 命令                                                                            | 用途与边界                                                                                                                                  |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `read_document`、`document_revision`                                            | 返回绑定字节版本的快照或版本，以及原生校验后的绝对路径；拒绝设备命名空间、控制字符、非法文件名、目录、文件链接和过大文件                    |
| `write_document`                                                                | 必须提交当前版本；`expectedRevision: null` 只允许创建不存在的目标；冲突或替换不确定时保留稿件副本                                           |
| `save_image_asset`                                                              | 校验文件名、图片类型与容量；只在文稿旁的 `assets` 中排他创建，不覆盖同名图片                                                                |
| `read_image_file`                                                               | 文稿必须是常规文件；图片只能来自规范化后的文稿目录以内，并通过扩展名和内容类型校验                                                          |
| `export_html`                                                                   | 只接受 `.html` 常规文件目标，遵守文本容量限制，并使用文档条件写入机制完成输出                                                               |
| `load_settings`                                                                 | 无路径参数；仅加载应用数据目录的 `mdplus-settings.json`。损坏 JSON、目录、重解析点或超过 1 MiB 的设置文件均拒绝，原文件保留，允许修复后重试 |
| `take_startup_files`、`take_pending_open_files`                                 | 消费经过原生 Markdown 参数筛选的启动／单实例队列                                                                                            |
| `cache_recovery_image`、`write_recovery_snapshot`                               | 恢复 ID、图片键、图片类型和容量均校验；仅操作应用恢复目录                                                                                   |
| `list_recovery_snapshots`、`read_recovery_snapshot`、`delete_recovery_snapshot` | 仅访问合法恢复 ID；拒绝目录逃逸与重解析点；保留活动会话副本                                                                                 |

已移除 `read_file`、`write_file`、`file_mtime`、`create_directory`、`save_binary_file` 等旧入口及对应前端封装。内部恢复写入仍使用原子文件辅助函数，该函数不对 WebView 暴露。

设置适配器只使用 `load_settings` 返回的资源 ID 调用 `plugin:store|get/set/save`。能力列表不授予 Store 的通用 `load`、`get_store`、`reload`、`reset` 或清空操作，也不加载 opener 插件。Store 本身会忽略初始化读取错误，因此原生设置入口先读取并校验完整 JSON，再以该快照初始化 Store，并关闭隐式自动保存；前端写队列显式等待 `save`，失败后展示重试入口。

## 路径与单位

文稿响应中的 `path` 是原生校验的绝对目标。相对路径必须先交由原生解析；前端 `pathKey` 只统一 Windows 的分隔符、大小写、点路径、扩展路径和 UNC 前缀，不猜测工作目录。打开、另存为冲突、最近列表及图片缓存比较共用该规则。

窗口状态及显示器工作区统一使用物理像素，恢复时使用 Tauri 的 `PhysicalSize` / `PhysicalPosition`。Tauri 配置中的窗口最小尺寸仍由原生窗口配置约束。

容量和时延的来源是 [config/application.json](../config/application.json)。前端读取 `src/config/constants.ts`；Rust 构建脚本从同一 JSON 生成容量常量。JSON 契约中的固定上限有同步断言。

## 失败语义

文稿命令以 `FileError` 拒绝 Promise。调用者必须保留 dirty 状态，并展示已保留的恢复／备份路径，不能自动覆盖目标进行“回滚”。其他命令以字符串错误拒绝。关闭协调器对每次异步操作后的请求代次和内容版本重新核对；取消关闭不会取消已经发出的磁盘保存。

主题、大纲、源码偏好及快捷键的持久化失败会保留本次会话选择并提供重试；较晚完成的初始化读取不能覆盖用户的新选择。最近记录和窗口几何是尽力保存的元数据，其失败不会阻止已确认的文稿退出。
