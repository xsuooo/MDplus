# 标签状态模型

改动保存、关闭、外部变更、恢复或图片之前先读这一页。它描述代码现状，行号会漂移，以标识符为准。术语见 [GLOSSARY.md](../GLOSSARY.md)。

## 七条规则

1. Milkdown 自带的 listener 防抖 200 ms，不能当保存来源。`lib/editor.ts` 在 `view.update` 里同步发布内容。
2. React 的 `tabs` 只用于显示，最多比 `tabsRef` 晚 `TAB_RENDER_MS`（120 ms）。保存、关闭、导出、切换模式之前先调用 `flushEditorUpdate`，再从 `tabsRef` 和 `tabMirror` 读。
3. 每个 `await` 之后重新核对代次（见下表），不相符就放弃本次操作。
4. 保存代次与关闭代次相互独立：取消关闭不能让已发出的保存失效。
5. `workspace.isAutoSavePaused(id)` 就是「该标签的自动保存已暂停」。手动保存不受它阻止。
6. 富文本文档和撤销历史里存图片 token（`mdplus-image:` 开头），只有序列化成 Markdown 时才换成磁盘相对路径。
7. 每个标签一个 `MilkdownProvider`，共用会互相覆盖内容。

## 正文的七份副本

| 副本                                 | 位置                | 何时更新                         |
| ------------------------------------ | ------------------- | -------------------------------- |
| ProseMirror 文档或源码 textarea 的值 | 编辑器实例          | 每次输入，唯一的事实来源         |
| `pendingEditorUpdates`               | `lib/editorUpdates` | 合并中的派生更新，flush 后清空   |
| `tabMirror.current[id].markdown`     | `useWorkspace`      | 每次编辑器发布更新               |
| `tabsRef.current[i].markdown`        | `useWorkspace`      | 与 `tabMirror` 同时写入          |
| React `tabs`                         | `useWorkspace`      | `scheduleTabRender` 延后 120 ms  |
| `Tab.initialContent`                 | `Tab`               | 创建编辑器时的初始文本           |
| `Tab.savedContent`                   | `Tab`               | 上次写盘成功或从磁盘重载时的文本 |

读当前正文用 `workspace.resolveContent(tab)`。

## 代次计数器

| 计数器                          | 递增处                                                                                             | 用途                                                   |
| ------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `contentVersions[id]`           | `useEditorView` 的 `handleEditorActivity`、`handleTabUpdate`、`handleSourceChange`；外部重载生效时 | 内容版本号。异步步骤前后比较，判断期间有没有新编辑     |
| `saveGenerations[id]`           | `removeTab`；另存为放弃采用新路径时                                                                | 使在途保存失效。也被恢复和图片粘贴当作「标签还在」令牌 |
| `modeGenerations[id]`           | `setSourceMode`                                                                                    | 使跨模式切换的图片拖放失效                             |
| `closeGeneration`               | `useDocumentClose` 每次发起或取消关闭                                                              | 使上一轮关闭确认失效                                   |
| `imagePreparations[id].version` | 记录发起准备时的 `contentVersions` 值                                                              | 判断准备结果是否仍对应当前内容                         |
| `ImageCache.generation`         | `lib/imageOps` 缓存内容变化时                                                                      | 图片缓存版本                                           |
| `Journal.generation`            | `lib/recovery` 每次安排或清除恢复副本                                                              | 使排队中的恢复写入失效                                 |

## 磁盘同步状态

一个标签的磁盘状态：四个 `Tab` 字段，加上 `workspace.diskSync[id]` 这一条记录（类型 `DiskSync`）。

| 位置                              | 含义                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| `Tab.diskRevision`                | 上次读写时的字节版本。外部变更以它判定，不看时间                                            |
| `Tab.diskMtime`                   | 上次已知的磁盘修改时间（不是「外部」时间）                                                  |
| `Tab.externalChanged`             | 后台标签有未处理的外部变更或读盘失败，标签栏显示提示                                        |
| `Tab.preserveLocal`               | 本地内容必须保留恢复副本，即使 `dirty` 为假                                                 |
| `diskSync[id].pausedMtime`        | 未定义表示自动保存在运行；数字是导致暂停的磁盘 mtime；`null` 表示已暂停但没有对应的磁盘时间 |
| `diskSync[id].detected`           | 已经向用户提示过的 `{ revision, mtime }`，避免同一变更重复提示                              |
| `diskSync[id].checking`           | 正在探测该标签的磁盘                                                                        |
| `diskSync[id].prompting`          | 正在显示该标签的重载提示                                                                    |
| `externalLastChecks`（hook 内部） | 后台标签上次探测时间                                                                        |

另有 `id in saveQueues.current` 表示保存在途。

### 转移

| 事件                                             | 结果                                                                                                  |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| 轮询发现磁盘版本变化                             | 记入 `diskSync[id].detected`，`preserveLocal: true`。当前标签弹重载提示，后台标签置 `externalChanged` |
| 用户选择重载并成功                               | 内容替换，`contentVersions` 加一，`resumeAutoSave(id)`，两个标志复位                                  |
| 用户拒绝重载，或重载期间内容变化，或图片准备失败 | `pauseAutoSave(id, 检测到的 mtime)`，保留本地内容                                                     |
| 探测或重载时读盘失败                             | `pauseAutoSave(id, null)`。当前标签弹错误，后台标签置 `externalChanged`。已是 `null` 时不重复提示     |
| 自动保存前发现磁盘版本不符                       | `pauseAutoSave(id, 磁盘 mtime)` 并提示一次，本次不写                                                  |
| 手动保存前发现磁盘版本不符                       | `pauseAutoSave` 后询问是否覆盖                                                                        |
| 确认或图片迁移期间磁盘再次变化                   | `pauseAutoSave(id, 最新 mtime)`，取消本次保存                                                         |
| 保存抛错                                         | `pauseAutoSave(id, null)`，`dirty: true`，安排恢复副本                                                |
| 保存或另存为成功                                 | `resumeAutoSave(id)`，`externalChanged` 与 `preserveLocal` 复位                                       |
| 关闭标签                                         | `removeTab` 从各个按 id 索引的容器里删除该 id，`saveGenerations` 加一                                 |

`pauseAutoSave(id, mtime)` 同时写 `diskSync[id].pausedMtime` 并置 `preserveLocal: true`。
