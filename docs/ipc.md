# IPC 契约与安全边界

[file_contract.json](../src-tauri/src/file_contract.json) 是应用命令的统一 JSON 契约。请求字段使用 camelCase。新增或删除命令时，同步修改契约、[命令目录](../src-tauri/src/ipc_commands.rs)、[原生 handler](../src-tauri/src/lib.rs)、[主窗口能力](../src-tauri/capabilities/default.json)及前端适配器。

`tauri-build::AppManifest` 将目录中的命令纳入 Tauri 权限检查；仅本地主窗口 `main` 获准使用，不配置远程来源或窗口通配符。[契约测试](../tests/ipcContract.test.ts)核对这些声明、原生参数及容量配置；Rust 测试核对真实序列化响应。请求类型、路径、容量及内容版本由原生校验，前端检查不能替代原生边界。

| 命令                                                                            | 用途与边界                                                                                                                               |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `read_document`、`document_revision`                                            | 返回绑定字节版本的快照或版本，以及校验后的绝对路径；拒绝设备命名空间、控制字符、非法文件名、目录、链接和过大文件                         |
| `write_document`                                                                | 必须提交当前版本；`expectedRevision: null` 只创建不存在的目标；冲突或替换不确定时保留独立本地稿件及可取得的替换前副本                    |
| `save_image_asset`                                                              | 校验 basename、图片类型和 64 MiB 上限；只在文稿旁的 `assets` 中排他创建，或复用完整的相同内容；返回 `allocationId`                       |
| `commit_image_assets`、`discard_image_assets`                                   | 仅接受本进程分配的随机 token，不接受文件路径；完成或放弃本轮图片迁移，详见下文                                                           |
| `read_image_file`                                                               | 文稿必须是常规文件；图片只能在规范化后的文稿目录以内，并校验扩展名、内容类型及容量                                                       |
| `stash_image`、`read_stashed_image`、`discard_stashed_images`                   | 独立的本进程图片历史缓存；随机 key 只索引持有的文件句柄，与恢复快照目录和清理生命周期完全隔离                                            |
| `export_html`                                                                   | 只接受 `.html` 常规文件目标；独立 512 MiB 输出预算覆盖字体和 Base64 图片，修订探测、原子提交、备份校验都使用同一预算                     |
| `load_settings`、`save_settings`                                                | 无路径参数；固定应用数据目录的设置文件。损坏 JSON、非普通文件、重解析点或超过 1 MiB 的文件拒绝读取并保留；保存以已加载 revision 原子提交 |
| `take_startup_files`、`take_pending_open_files`                                 | 消费经过原生 Markdown 参数筛选的启动／单实例队列；相对路径先绑定发送进程 cwd，再筛选常规文件，绝不修改全局 cwd                           |
| `cache_recovery_image`、`write_recovery_snapshot`                               | 恢复 ID、图片键、图片类型和容量均校验；仅操作应用恢复目录                                                                                |
| `list_recovery_snapshots`、`read_recovery_snapshot`、`delete_recovery_snapshot` | 仅访问合法恢复 ID；拒绝目录逃逸与重解析点；不删除独立 session stash 中仍可 Undo 的图片                                                   |

已移除 `read_file`、`write_file`、`file_mtime`、`create_directory`、`save_binary_file` 等旧入口。内部恢复写入辅助函数不暴露给 WebView。

## 文稿、HTML 与编码

普通文稿读取和保存仍限 32 MiB；HTML 的较大预算不是绕过文稿容量限制的开关。公共调用者不能传入或扩大原生写入预算。HTML 和设置复用同一安全 writer：同目录 staging、完整写入和同步、create-only/CAS、替换前副本捕获、提交后内容核验。不确定结果绝不通过覆盖目标自动回滚。

文稿无损支持 UTF-8、带 BOM 的 UTF-16 LE/BE 及可无损解码的 GBK，写回统一 UTF-8。原始字节初筛之外，**完整解码后和写入前均拒绝 NUL**，并核对解码后的 UTF-8 长度；不会偷偷删除字符。损坏输入不写入、转码或重置原文件。

## 设置持久化

`load_settings()` 返回 `{ values, revision }`，文件不存在时为 `{ values: {}, revision: null }`。`save_settings({ values, expectedRevision })` 只在完整 JSON 原子提交并核验后返回 `{ revision }`，外部修改产生冲突，不能盲覆盖。

[设置适配器](../src/services/settingsStore.ts)继续提供 `get/set/save`：get/set 隔离对象引用，set 在发布内存候选前检查 JSON 可序列化性与容量；save 串行提交其调用时的快照，仅在成功时推进 revision。读取失败允许重新加载，写入失败保留待保存值供重试。原生不再注册或依赖 Store 插件，能力列表也不含 `store:*`；因此不存在插件退出时无条件 `fs::write` 截断设置的旁路，也没有新增的退出隐式保存。

## 图片传输、预览与历史缓存

所有图片 IPC 数据字段都是 **`dataBase64: string`**，使用带 padding 的标准 Base64；不再接受或返回高容量 `number[]`。64 MiB 单图的编码上限为 89,478,488 个 ASCII 字符。原生先检查编码长度，再解码并检查字节数、扩展名和内容类型。

`stash_image({ filename, dataBase64 })` 返回 `{ key, mime, previewUrl }`；`read_stashed_image({ key })` 返回 `{ mime, dataBase64 }`；`discard_stashed_images({ keys })` 只关闭本进程登记的句柄。缓存总磁盘预算为 1 GiB，最多 4096 项；达到上限会明确失败，不驱逐既有 Undo 数据。只有成功 stash 后前端才可释放唯一内存副本。

Windows stash 文件在发布 key 前就设置 delete-pending，读取始终通过保留句柄并在互斥锁内 seek/read；释放 key 或进程终止会关闭句柄并释放图片字节。会话目录和恢复快照不共用，因此正常保存清理 recovery 不会破坏 Undo。

`previewUrl` 是进程内只读 `mdplus-image-stash` 资源地址；Windows 使用 `http://mdplus-image-stash.localhost/<key>`。协议只接受随机 key，不解释路径、目录跳转或外部 URL；只允许 GET，读取与 IPC 共用串行锁和单图上限。响应包含校验后的 MIME、`nosniff`、`no-store` 及禁止脚本/外链的沙箱 CSP，不开放通用 CORS。主 CSP 仅在 `img-src` 精确放行这些源，不扩大脚本或网络权限。**独立 HTML 导出必须内嵌图片数据，不能保留临时 previewUrl。**

## 图片迁移与失败语义

新图片的 `allocationId` 是随机的本进程所有权 token；复用既有相同图片时为 `null`，不授予删除权。尚未完成的图片不与另一轮迁移共用删除 token。

Windows 原生在 `create_new` 时取得 DELETE 权限并保留只共享读取的句柄；外部不能在 token 有效时改写或替换该对象。`discard_image_assets` 通过 **该句柄**删除本次对象，不按客户端路径 unlink。`commit_image_assets` 关闭句柄并永久撤销删除权；重复、未知、已完成 token 均不能删除其他文件。discard 失败也释放句柄/删除权并返回明确路径供核对，不不断泄漏锁。

前端只在正文确定 `writeState: unchanged`（包括尚未发出写请求）时 discard。请求已经发出但结果不明、取消时写入仍可能继续，或者结果为 `unknown`/`committed`，必须 commit 并保守保留资产。不能把异常字符串误当作“正文未写入”。图片清理失败应展示，不能掩盖主保存错误。

文稿命令以 `FileError` 拒绝 Promise。调用者必须保留 dirty 状态，展示已保留的恢复／备份路径，不自动覆盖目标“回滚”。其他命令以字符串错误拒绝。关闭协调器核对异步操作后的请求代次和内容版本；取消关闭不会撤销已经发出的磁盘保存。

## 路径与单位

文稿响应中的 `path` 是原生校验的绝对目标。相对路径交由原生解析；前端 `pathKey` 只统一 Windows 分隔符、大小写、点路径、扩展路径和 UNC 前缀，不猜测工作目录。发送方跨盘 `C:relative.md` 缺少对应盘工作目录时拒绝，绝不使用主进程的隐式盘 cwd 猜测。

窗口及显示器工作区统一使用物理像素。容量与时延的唯一配置来源是 [application.json](../config/application.json)；前端读取[常量适配器](../src/config/constants.ts)，Rust 构建脚本生成原生常量，JSON 契约用测试同步上限。
