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
| `import_dropped_image`                                                          | 接受拖入或选择的绝对 PNG/JPG/JPEG 常规文件路径；检查格式、容量并实际解码，将原始字节复制到本进程图片 stash，返回元数据，不修改来源文件   |
| `stash_image`、`read_stashed_image`、`discard_stashed_images`                   | 独立的本进程图片历史缓存；随机 key 只索引持有的文件句柄，与恢复快照目录和清理生命周期完全隔离                                            |
| `export_html`                                                                   | 只接受 `.html` 常规文件目标；独立 512 MiB 输出预算覆盖字体和 Base64 图片，修订探测、原子提交、备份校验都使用同一预算                     |
| `load_settings`、`save_settings`                                                | 无路径参数；固定应用数据目录的设置文件。损坏 JSON、非普通文件、重解析点或超过 1 MiB 的文件拒绝读取并保留；保存以已加载 revision 原子提交 |
| `take_startup_files`、`take_pending_open_files`                                 | 消费经过原生 Markdown 参数筛选的启动／单实例队列；相对路径先绑定发送进程 cwd，再筛选常规文件，绝不修改全局 cwd                           |
| `cache_recovery_image`、`write_recovery_snapshot`                               | 恢复 ID、图片键、图片类型和容量均校验；请求包含在途 `retainedKeys`，返回附件回收回执；仅操作应用恢复目录                                 |
| `list_recovery_snapshots`、`read_recovery_snapshot`、`delete_recovery_snapshot` | 仅访问合法恢复 ID；拒绝目录逃逸与重解析点；不删除独立 session stash 中仍可 Undo 的图片                                                   |

已移除 `read_file`、`write_file`、`file_mtime`、`create_directory`、`save_binary_file` 等旧入口。内部恢复写入辅助函数不暴露给 WebView。

## 文稿、HTML 与编码

普通文稿读取和保存仍限 32 MiB；HTML 的较大预算不是绕过文稿容量限制的开关。公共调用者不能传入或扩大原生写入预算。HTML 和设置复用同一安全 writer：同目录 staging、完整写入和同步、create-only/CAS、替换前副本捕获、提交后内容核验。不确定结果绝不通过覆盖目标自动回滚。

文稿无损支持 UTF-8、带 BOM 的 UTF-16 LE/BE 及可无损解码的 GBK，写回统一 UTF-8。原始字节初筛之外，**完整解码后和写入前均拒绝 NUL**，并核对解码后的 UTF-8 长度；不会偷偷删除字符。损坏输入不写入、转码或重置原文件。

## 设置持久化

`load_settings()` 返回 `{ values, revision }`，文件不存在时为 `{ values: {}, revision: null }`。`save_settings({ values, expectedRevision })` 只在完整 JSON 原子提交并核验后返回 `{ revision }`，外部修改产生冲突，不能盲覆盖。

[设置适配器](../src/services/settingsStore.ts)继续提供 `get/set/save`：get/set 隔离对象引用，set 在发布内存候选前检查 JSON 可序列化性与容量；save 串行提交其调用时的快照，仅在成功时推进 revision。读取失败允许重新加载，写入失败保留待保存值供重试。原生不再注册或依赖 Store 插件，能力列表也不含 `store:*`；因此不存在插件退出时无条件 `fs::write` 截断设置的旁路，也没有新增的退出隐式保存。

## 图片传输、预览与历史缓存

需要传输图片字节的 IPC 数据字段都是 **`dataBase64: string`**，使用带 padding 的标准 Base64；不再接受或返回高容量 `number[]`。64 MiB 单图的编码上限为 89,478,488 个 ASCII 字符。原生先检查编码长度，再解码并检查字节数、扩展名和内容类型。

`import_dropped_image({ path })` 返回 `{ key, mime, previewUrl, filename, byteLength, digest }`。该入口原生读取 PNG/JPG/JPEG 并实际解码，拒绝相对路径、目录、重解析点、设备路径、损坏图片及超过 64 MiB 的文件。来源字节直接进入独立 stash，前端只接收元数据和 SHA-256；因此拖入不会把大图往返编码成 Base64。`read_image_file` 继续保留文稿目录内读取的限制。

导入解码串行执行。分配预算来自共享容量配置：PNG 先扣除一份压缩源，JPEG 扣除两份，预算不足时在解码前拒绝；其余预算交给图片库的 `max_alloc`。库内部的分配限制为尽力执行，不能据此断言整个进程的峰值内存被硬性限制。暂存和迁移清理只释放本进程持有的副本，不删除拖入的原图片。

`stash_image({ filename, dataBase64 })` 返回 `{ key, mime, previewUrl }`；`read_stashed_image({ key })` 返回 `{ mime, dataBase64 }`；`discard_stashed_images({ keys })` 只关闭本进程登记的句柄。缓存总磁盘预算为 1 GiB，最多 4096 项；达到上限会明确失败，不驱逐既有 Undo 数据。只有成功 stash 后前端才可释放唯一内存副本。

Windows stash 文件在发布 key 前就设置 delete-pending，读取始终通过保留句柄并在互斥锁内 seek/read；释放 key 或进程终止会关闭句柄并释放图片字节。会话目录和恢复快照不共用，因此正常保存清理 recovery 不会破坏 Undo。

`previewUrl` 是进程内只读 `mdplus-image-stash` 资源地址；Windows 使用 `http://mdplus-image-stash.localhost/<key>`。协议只接受随机 key，不解释路径、目录跳转或外部 URL；只允许 GET，读取与 IPC 共用串行锁和单图上限。响应包含校验后的 MIME、`nosniff`、`no-store` 及禁止脚本/外链的沙箱 CSP，不开放通用 CORS。主 CSP 仅在 `img-src` 精确放行这些源，不扩大脚本或网络权限。**独立 HTML 导出必须内嵌图片数据，不能保留临时 previewUrl。**

## 图片迁移与失败语义

新图片的 `allocationId` 是随机的本进程所有权 token；复用既有相同图片时为 `null`，不授予删除权。尚未完成的图片不与另一轮迁移共用删除 token。

Windows 原生在 `create_new` 时取得 DELETE 权限并保留只共享读取的句柄；外部不能在 token 有效时改写或替换该对象。`discard_image_assets` 通过 **该句柄**删除本次对象，不按客户端路径 unlink。`commit_image_assets` 关闭句柄并永久撤销删除权；重复、未知、已完成 token 均不能删除其他文件。discard 失败也释放句柄/删除权并返回明确路径供核对，不不断泄漏锁。

前端只在正文确定 `writeState: unchanged`（包括尚未发出写请求）时 discard。请求已经发出但结果不明、取消时写入仍可能继续，或者结果为 `unknown`/`committed`，必须 commit 并保守保留资产。不能把异常字符串误当作“正文未写入”。图片清理失败应展示，不能掩盖主保存错误。

文稿命令以 `FileError` 拒绝 Promise。调用者必须保留 dirty 状态，展示已保留的恢复／备份路径，不自动覆盖目标“回滚”。其他命令以字符串错误拒绝。关闭协调器核对异步操作后的请求代次和内容版本；取消关闭不会撤销已经发出的磁盘保存。

## 恢复附件回收

`cache_recovery_image({ id, key, stashKey, retainedKeys })` 和 `write_recovery_snapshot({ snapshot, retainedKeys })` 都返回 `{ removedKeys: string[], cleanupError: string | null }`。`stashKey` 只索引本进程持有的图片句柄，不接受路径或 Base64；原生在线程池内将已校验的原始字节复制到恢复目录，继续校验恢复图片类型、键和容量。前端沿用串行图片 I/O 队列，并在缓存完成前保留独立租约，因此关闭标签或取消插入不会释放在途副本，也不会同时积累多个大图工作缓冲。

`retainedKeys` 最多 4096 项，只允许合法恢复图片键；不接受路径。前端提交当前冻结快照、待写快照和在途图片的键，并根据 `removedKeys` 失效已缓存标记。快照文件格式不变，既有恢复副本仍可读取。

缓存容量检查前回收孤儿，快照完整原子发布后回收旧副本。删除依据必须是已校验且附件完整的当前 manifest，同时保留在途键；损坏 manifest 不作为删除依据。只删除合法键对应的常规文件，不遍历链接、重解析点或未知目录，不处理独立 session stash。每次回收最多 4096 项，更多旧缓存留待后续写入继续。

完整快照仍限 128 张图片、附件总计 256 MiB。原子替换期间允许两套附件及 manifest 暂存，总缓存预算为 `2 × 256 MiB + 32 MiB + 1 MiB`；这不会扩大最终快照或单图 64 MiB 限制。

`cleanupError` 是辅助回收错误，已成功发布的快照继续有效；前端记录错误并保守清空缓存标记，下次写入重新确认图片。主缓存或快照提交失败仍拒绝 Promise 并进入恢复错误状态，不能把辅助失败误报成已发布快照丢失。命令与持久化 snapshot 格式保持原有入口，请求和响应形状须前后端一起更新。

## 路径与单位

文稿响应中的 `path` 是原生校验的绝对目标。相对路径交由原生解析；前端 `pathKey` 只统一 Windows 分隔符、大小写、点路径、扩展路径和 UNC 前缀，不猜测工作目录。发送方跨盘 `C:relative.md` 缺少对应盘工作目录时拒绝，绝不使用主进程的隐式盘 cwd 猜测。

窗口及显示器工作区统一使用物理像素。容量与时延的唯一配置来源是 [application.json](../config/application.json)；前端读取[常量适配器](../src/config/constants.ts)，Rust 构建脚本生成原生常量，JSON 契约用测试同步上限。
