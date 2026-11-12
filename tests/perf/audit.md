# MDPlus 性能审计

本轮唯一修复候选是 **③ 周期性 revision 检查**。本文记录测量前的代码状态，不预设最终修复方案，也不重新定义此前①②④的编号。下面的五个瓶颈按名称列出；其他优化尚未实施。

审计日期：2026-11-08。范围是当前工作区，包括已有未提交代码。文件位置均相对于仓库根目录；后续修复可能改变行号。

本文区分三类结论：

- **已确认调用**：代码能够证明的触发条件、执行路径、遍历范围和缓存边界。
- **待验证瓶颈**：这些调用可能导致卡顿，但还不能证明它们就是用户当前卡顿的主因。
- **未实测场景**：本文尚未引用该场景的正式基线、候选对照或真实桌面性能轨迹。基准的 setup smoke 不能替代这些证据。

## 1. 技术栈

桌面壳是 **Tauri 2 + Rust**，Windows 界面运行于 **WebView2**。前端是 **React 18 + TypeScript + Vite**，不是 Electron 或 Qt。Markdown 编辑器采用 **Milkdown / ProseMirror**，配置了 CommonMark、GFM、数学公式、代码高亮和 Mermaid 图表。

| 层次           | 依据                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 桌面与原生能力 | `src-tauri/Cargo.toml:29` 声明 Tauri 2；`:45` 起配置 Windows API 和 WebView2 依赖。`src-tauri/tauri.conf.json:5` 起连接前端开发服务和构建目录。   |
| 前端           | `package.json:27` 起声明 Milkdown、React 18、KaTeX、Mermaid、Prism；开发依赖包括 TypeScript 和 Vite。`src/main.tsx:7` 使用 React `createRoot()`。 |
| 编辑器         | `src/lib/editor.ts:108` 的 `createEditor()` 组合 Milkdown、ProseMirror 和各插件；`:21` 起导入 CommonMark/GFM 等模块。                             |

依赖版本应以当前锁文件为准；上述版本描述的是项目使用的技术系列，不是运行时性能测量。

## 2. Markdown、渲染、读取、搜索、高亮的位置

| 功能                  | 文件、函数或入口                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Markdown 解析与序列化 | `src/lib/editor.ts:108 createEditor()` 配置语法；`:415 setMarkdown()` 调用 `parserCtx(markdown)`；`:306` 的同步插件 `view.update()` 调用 `serializerCtx(doc)`。`src/lib/markdownSchemas.ts:24 cacheMarkdownParser()`、`:41 cachedDocSchema`、`:72 configureMarkdownSchemas()` 处理解析与序列化缓存。图片引用另走 `src/lib/imagePaths.ts:52 imageDestinations()` 的 micromark 解析。源码目录另走 `src/lib/sourceOutline.worker.ts:9 self.onmessage`。 |
| 预览与可视编辑        | `src/components/EditorTab.tsx:42 EditorTabInner()` 创建编辑器，`:123` 挂载 `<Milkdown />`。ProseMirror 维护可编辑 DOM。图片使用 `src/lib/imageView.ts:5 imageView()`；代码与 Mermaid 使用 `src/lib/mermaid.ts:27 mermaidView`；图表实际渲染在 `src/lib/diagramRender.ts:121 renderUncached()`。源码模式是 `src/components/SourceEditor.tsx:74 SourceEditor()` 中的受控 `<textarea>`。                                                                |
| 文件读取              | `src/hooks/useDocumentFiles.ts:90 openDocumentPath()` 协调打开；`src/lib/fileOps.ts:36 readDocument()`、`:40 documentRevision()`、`:53 readImageFile()` 发出 IPC。原生实现为 `src-tauri/src/safe_files.rs:309 read_document()`、`:331 document_revision()`、`:199 raw_snapshot()` 和 `src-tauri/src/lib.rs:320 read_image_file()`。                                                                                                                  |
| 搜索                  | `src/components/SearchBar.tsx:32 SearchBar()`；`src/lib/search.ts:32 createTextSearch()`、`:129 createDocumentSearch()`、`:265 searchPlugin.state.apply()`、`:338 runSearch()`。替换另在 `src/lib/replace.ts`。                                                                                                                                                                                                                                      |
| 语法高亮              | `src/lib/editor.ts:324` 注册 Milkdown Prism 插件；`src/lib/editorPerformance.ts:64 configurePrismTransactions()` 为无关事务添加快速路径。导出另在 `src/lib/export.ts:6` 导入 Prism，并在下一行加载 TypeScript grammar。公式使用 KaTeX，见 `src/lib/editor.ts:27` 和 `:323`。                                                                                                                                                                         |

## 3. 是否每次按键都全量解析、全量渲染

需要区分三个动作：**解析**把 Markdown 字符串变成文档树；**序列化**把文档树变回 Markdown；**DOM 更新**把文档变化显示到界面。

### 富文本模式

不是每次物理按键都重新解析全文 Markdown，也不是每次都重建全部 DOM。ProseMirror 使用事务修改文档并更新视图。移动光标或选择文字时，`src/lib/editor.ts:305` 的 `view.state.doc.eq(previous.doc)` 会跳过内容发布。

但只要文档内容发生实际变化，同步路径会执行：

1. `src/lib/editor.ts:306`：向 `serializerCtx` 传入完整 `doc`，生成当前 Markdown。
2. `src/lib/editor.ts:309`：提取目录；`:310`：`computeStats(markdown)` 扫描完整字符串。
3. `src/hooks/useEditorView.ts:412 handleTabUpdate()`：更新内容镜像，安排图片准备、保存、恢复保护和 React 提交。

序列化内部已经缓存部分未变化块，因此“向序列化器传入完整文档”不等于“每个节点都重新转换”。不过完整结果字符串和全文统计仍位于同步输入链路。表格内容变化时，GFM 仍计算整表列宽，见 `src/lib/markdownSchemas.ts:102`。

### 源码模式

`src/components/SourceEditor.tsx:267 handleChange()` 每次输入更新本地 draft，并调用父回调。`src/hooks/useEditorView.ts:574 handleSourceChange()` 在 `:581` 同步执行 `computeStats(text)`。这条输入路径不立即重新创建富文本 DOM。

源码返回富文本时，`src/hooks/useEditorView.ts:526 toggleSourceMode()` 根据变化调用 `syncEditor()`，最终由 `setMarkdown()` 解析完整 Markdown。源码目录打开时，另有延迟的 Worker 解析。图片准备、会话位置捕获等旁路也可能在输入停止后解析全文，不能只检查输入回调。

## 4. 已有防抖、节流、缓存和虚拟化情况

| 机制                    | 已有实现与限制                                                                                                                                                                                                                                                                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| React 提交节流与 memo   | `src/hooks/useEditorView.ts:400 scheduleTabRender()` 使用 120ms 节流。`EditorTab`、`SourceEditor`、`SearchBar`、`OutlinePanel` 等已有 `memo`。节流不覆盖此前的同步序列化和统计。`src/App.tsx:442` 给目录传递新的内联回调，可能使其浅比较失效。                                                                                                              |
| 延迟与后台派生工作      | `config/application.json:3` 起配置图片准备 150ms、恢复写入 1000ms、自动保存 1500ms、外部检查 2000ms。`src/hooks/useSessionPersistence.ts:32` 定义位置保存 500ms。源码目录在 `src/hooks/useEditorView.ts:86` 的 effect 中等待 150ms 后创建 Worker，仅在源码模式且目录打开时执行；完成或失效后终止 Worker。                                                   |
| Markdown 与文档节点缓存 | `cacheMarkdownParser()` 只保留最近一个全文字符串的原始 AST，命中仍需 `structuredClone`，以防 remark 插件污染缓存。`cachedDocSchema` 缓存顶层段落、标题和表格；`configureMarkdownSchemas()` 另缓存段落文本、表格、行和单元格结果。带图片等情况有保守失效规则。节点索引使用 `src/lib/documentNodes.ts` 的 `createNodeIndex()`。                               |
| 搜索、图片与历史边界    | 搜索使用不变 textblock 的 WeakMap 缓存；高亮最多 1000 项，每 1024 个匹配记检查点。图片引用缓存最多 4 项、合计 4,194,304 字符，较大的单篇不进入该缓存。源码撤销最多 200 条，400ms 内连续输入合并。依据：`src/lib/search.ts:22`、`:84`、`src/lib/imagePaths.ts:38`、`:154`、`src/components/SourceEditor.tsx:224`、`config/application.json:10` 和 `:24` 起。 |
| 虚拟滚动与后台标签      | 未发现正文按可视范围挂载的虚拟滚动。`src/App.tsx:496` 为全部标签保留编辑器，`:529` 也保留源码编辑区。`src/styles/global.css:737` 对后台编辑器使用 `content-visibility: hidden`，当前标签恢复可见；它不会虚拟化当前文稿的大表，也不会释放后台编辑器状态。目录 `src/components/OutlinePanel.tsx:105` 仍全量 `items.map()`。                                   |

这些都是审计快照已有的机制，不代表本轮新增优化。搜索的“高亮窗口”也不是正文虚拟滚动。

会话恢复默认开启，见 `src/hooks/useSessionPersistence.ts:38` 和 `src/lib/store.ts:230`。原生环境监听 `.editor-area` 内的 scroll、select、selectionchange、input、keyup、pointerup（`src/hooks/useSessionPersistence.ts:411`）；事件目标必须是该区域内的 HTMLElement，因此目标为 document 的 selectionchange 会被过滤。源码模式的输入和滚动也会重置 500ms 定时器。实际捕获还受启动完成、恢复开关、读取错误和关闭状态限制（`:140`）。

`captureLiveSession()` 遍历全部标签，但 `sessionDocument()` 在 `:120` 跳过没有路径的标签。`captureTabPlace()` 为非活跃页复用已有位置，活跃页重新捕获（`src/hooks/useDocumentSession.ts:111`）。富文本位置解析使用该编辑器的 remark 上下文，可命中 `cacheMarkdownParser()`，但命中仍需克隆 AST 并执行 `runSync`；图片引用使用独立的 micromark 解析及内容缓存，两者不共享结果。因此，输入时的序列化和统计、150ms 后的图片准备、500ms 后的位置保存需要分别观察；不能把其中一个缓存命中当作全部旁路都已免除全文工作。

## 5. 大文件打开和滚动的主要可疑环节

**打开阶段存在多个顺序门槛。**`openDocumentPath()` 先读取正文（`src/hooks/useDocumentFiles.ts:114`），然后准备图片（`:143`），再核对磁盘 revision（`:146`），之后才添加标签（`:166`）。revision 核对是数据一致性保护，不能为了提速直接删除。

测量前，`read_document()` 通过 `raw_snapshot()` 完整读入、校验并计算 SHA-256。`document_revision()` 也进入完整快照路径，不只是读 mtime。原生图片读取还包含格式校验和 base64 编码。前端的图片准备另外有全局串行 I/O 队列、图片引用解析与可达性回收。打开完成后，初次 Milkdown 解析、完整正文 DOM、高亮和初始序列化也会产生 CPU 与内存成本。

**滚动阶段需要分开看持续滚动和暂停后的工作。**当前文档没有正文虚拟化，大表、长段落、图片和公式可能增加 Layout/Paint 成本。源码滚动保存位置时，还会在约 500ms 空闲后创建全文离屏测量 DOM。纯滚动不应被描述为“每帧重新解析 Markdown”；真正的重复解析或布局应由调用栈确认。

上述顺序、完整读取和 DOM 保留方式已由代码确认；哪一段占主导、是否造成用户可感知卡顿，仍需真实桌面轨迹和正式基线判断。

## 6. 启动重依赖

`src/main.tsx:3` 同步导入 `App`；`src/App.tsx:3` 同步导入 `EditorTab`，后者同步导入 `createEditor`。因此，即使首屏只显示欢迎界面，编辑器模块的同步依赖链仍需要加载。创建具体文稿编辑器则发生在标签挂载时，两者应分开测量。

| 加载方式           | 依赖与证据                                                                                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 同步编辑器依赖     | Milkdown、ProseMirror、CommonMark/GFM、history、math、KaTeX、Prism、Nord。见 `src/lib/editor.ts:21` 起的 import。                                                                                                                    |
| 同步导出依赖       | `src/App.tsx:20` 导入 `useDocumentExport`；该 hook 在 `src/hooks/useDocumentExport.ts:5` 导入导出模块。`src/lib/export.ts:3` 起同步引入 DOMSerializer、KaTeX、Prism、TypeScript grammar 以及若干 CSS/raw 资源。                      |
| 同步样式与资源地址 | `src/main.tsx:5` 引入 KaTeX CSS；`src/styles/global.css:1` 引入字体声明。`src/lib/fontResources.ts:2` 起的 `?url` import 是字体资源地址，不代表启动读取全部字体字节。`embeddedFonts()` 在 `:52` 起按当前字体选择后才读取并编码资源。 |
| 按需加载           | Mermaid 本体在 `src/lib/diagramRender.ts:147 renderUncached()` 中 `await import('mermaid')`。源码目录 Worker 也按条件创建。不能把它们写成无条件启动加载。                                                                            |

`vite.config.ts:58` 的 `react/editor` manual chunks 只是同步依赖分组，不是编辑器懒加载。本文没有把打包体积当作启动耗时，也没有提供未经测量的启动毫秒数。

`src/main.tsx:8` 使用 React StrictMode；开发模式的额外检查不能直接当作生产版本的重复初始化证据。

## 7. 五个优先验证的性能瓶颈

优先级是静态审计排序，不是已经测得的耗时排名。只有周期性 revision 检查属于本轮③修复候选，其余项目只验证和记录。

| 卡顿场景                                               | 可疑代码位置（文件:行 + 函数）                                                                                                                                                                                                                                                                      | 根因判断                                                                                                                                                                                                                                                                                                                                  | 验证方法                                                                                                                                                                                                                                | 修复优先级                                                                        |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 多个已保存文稿打开后，约每两秒出现周期性卡顿           | `src/hooks/useExternalChanges.ts:205 useExternalChanges()` 的轮询 effect；`src/lib/fileOps.ts:40 documentRevision()`；`src-tauri/src/safe_files.rs:331 document_revision()`、`:335 revision_with_limit()`、`:199 raw_snapshot()`、`:91 revision()`                                                  | **已确认**：符合条件的标签每 2000ms 请求字节 revision，完整读取并哈希文件。测量前 command 是同步函数。已有 dirty、保存队列、在途检查和弹窗排除条件，并非每轮无条件读取所有标签。**待验证**：原生调度阻塞和磁盘/CPU 开销是否构成主要卡顿；前端 `await` 不能单独证明原生工作已经移到后台线程。                                              | 打开三份固定 fixture，保持已保存且无编辑，记录至少三个轮询周期。比较单标签与三标签；分别记录 revision 调用耗时、原生主循环或真实 WebView 心跳间隔和文件读取活动。只有这些指标才能区分“总耗时下降”和“界面不再被阻塞”。                   | **P1，本轮唯一修复候选③**。先建立基线，再确定方案；保留冲突检测和字节一致性语义。 |
| 富文本大表格内部输入变慢；源码长文逐字输入变慢         | `src/lib/editor.ts:298 createEditor()` 中的同步插件 `view.update()`；`:306 serializerCtx(doc)`；`src/lib/markdownSchemas.ts:97 configureMarkdownSchemas()` 的 table handler；`src/lib/stats.ts:12 computeStats()`；`src/hooks/useEditorView.ts:574 handleSourceChange()`                            | **已确认**：内容事务同步生成 Markdown 并扫描全文统计；已有块/行/单元格缓存，但表格修改仍需计算整表列宽。120ms React 节流不覆盖这些工作。**待验证**：序列化、统计和 DOM 更新各自的占比。不是每键重新解析整篇 Markdown，也不是每键重建全部 DOM。                                                                                            | 使用 `table-1200.md`，在表格前、表格中部和表格后各输入固定字符；用 `long-5000.md` 测源码输入。分开看 `frontend/serializerCtx/*`、`frontend/computeStats/*` 和浏览器输入到下一帧 p50/p95。                                               | **P1，暂不实施优化**。                                                            |
| 含图片文稿编辑一段时间后更慢，停输入后出现长任务       | `src/hooks/useRecovery.ts:41 prepareCurrentImages()`；`src/lib/imageOps.ts:561 prepareImageReferences()`、`:114 collectUnusedImages()`；`src/components/SourceEditor.tsx:127` 注册的可达性 root；`src/lib/imagePaths.ts:52 imageDestinations()`；`src/lib/editor.ts:586 getEditorImageReferences()` | **已确认**：图片准备前执行全局可达性回收；源码 root 扫描当前文本和 undo/redo 历史。包含 `![` 且缓存未命中时执行完整 micromark GFM/math 解析。4 项缓存会被多个历史版本挤出；超过 4,194,304 字符的单篇不缓存。富文本 root 缓存失效时还在隔离 state 上回放历史。无 `![` 的文稿走快速路径。**待验证**：该路径在真实编辑历史中的 CPU/GC 占比。 | 使用 `images-20.md`，固定当前文本加 20 个独立源码历史版本；用另两份无图 fixture 对照。记录 `frontend/collectUnusedImages/*`，并在真实编辑场景观察停输入后 2 秒内的 collection、imageDestinations 和 GC。基准不能用空缓存或未注册 root。 | **P1，暂不实施优化**。                                                            |
| 源码滚动暂停约半秒后卡顿；富文本编辑后半秒出现额外工作 | `src/hooks/useSessionPersistence.ts:163 scheduleSessionWrite()`、`:130 captureLiveSession()`；`src/lib/editorPosition.ts:345 captureSourceSessionPlace()`、`:158 positionedBlocks()`；`src/lib/sourcePosition.ts:24 measureSourceLayout()`；`src/lib/sessionPosition.ts:91 textAnchor()`            | **已确认**：500ms 防抖后捕获有路径标签的位置。源码滚动到非顶部时创建全文离屏 DOM，再读取 Range/布局；富文本定位缓存失效时 parse/clone/runSync 并遍历。起止与滚动锚还扫描文本前缀。非活跃页已有位置可复用；不变富文本文档可以命中定位缓存。**待验证**：暂停后的布局或解析是否造成可感知卡顿。                                              | 打开有路径的 `long-5000.md`，源码滚到中后部再停止约 0.5 秒；与顶部和会话恢复关闭状态对照。查看 `measureSourceLayout` 下的 Layout；富文本修改后检查 `positionedBlocks`。此项需要 native 会话环境，普通函数基准不能覆盖全链路。           | **P1，暂不实施优化**。                                                            |
| 搜索框输入变慢，或搜索开启时正文输入变慢               | `src/components/SearchBar.tsx:54 SearchBar()` 的 sourceMatches memo、`:106` 搜索 effect；`src/lib/search.ts:32 createTextSearch()`、`:129 createDocumentSearch()`、`:265 searchPlugin.state.apply()`、`:301` 文档变化分支                                                                           | **已确认**：关键词变化没有防抖；源码文本变化重新扫描整字符串。富文本重走 textblocks，但不变块索引可复用。1000 项高亮限制约束 decoration 数量，不限制计数扫描。源码匹配导航还使用全文离屏布局。**待验证**：特定词频、文稿结构下的输入延迟。                                                                                                | 在 `long-5000.md` 和 `table-1200.md` 中比较搜索关闭、搜索高频词、搜索零匹配词。固定输入次数，记录搜索函数 self/total time 与输入下一帧 p50/p95。源码“下一个匹配”另外检查 Layout。                                                       | **P2；若卡顿仅在搜索时出现则升为 P1。暂不实施优化**。                             |

启动与当前文稿完整 DOM 也属于重要观察项，已在第 5、6 节单独说明。没有因表格只列五项而认定它们不存在。

## 8. 最小验证方案与固定夹具

三份夹具由 `tests/perf/generate.mjs` 确定性生成，不使用用户文稿：

| 夹具                                | 固定内容                                | 主要用途                                       |
| ----------------------------------- | --------------------------------------- | ---------------------------------------------- |
| `tests/perf/fixtures/table-1200.md` | 1200 行数据、5 列表格，包含表格前后标记 | 表格内外序列化、输入、首次 DOM 建立与滚动。    |
| `tests/perf/fixtures/long-5000.md`  | 5000 物理行，包含长段落和固定输入标记   | 全文统计、长文输入、滚动、会话位置捕获与搜索。 |
| `tests/perf/fixtures/images-20.md`  | 20 个本地合成 PNG 引用及正文            | 图片打开链路、可达性回收、含图解析与历史增长。 |

执行协议：

1. 使用统一入口 `npm run perf`，保存夹具校验信息和正式结果；不要在计时区并行构建或运行其他基准。
2. 使用相同软件版本、窗口尺寸、字体、缩放、标签数量和输入位置。区分首次打开与重复打开，不把文件缓存状态差异当作修复收益。
3. 每个场景重复三次，保留全部原始样本，汇总 p50/p95，不只挑最快一次。前端函数基准每次固定 10 次预热、50 次正式采样，准备编辑器、修改事务和历史均放在计时外。
4. 对照表中指定的场景观察 CPU 调用栈、长任务、Layout/Paint、帧间隔和内存；原生检查另记录线程/事件循环响应。60Hz 下 16.7ms 是帧预算参考，超过 50ms 的主线程任务可用于定位长任务，不是本文测得的结果。
5. 仅围绕③选择一个最小候选改动，再以相同协议复测。其他路径的基准用于发现回归，不把它们的改善列为本轮已完成优化。

`tests/perf/frontend.bench.ts` 使用真实 `serializerCtx`、`computeStats()`、`collectUnusedImages()`。图片项创建真实缓存并注册当前文稿及 20 份历史；只 mock 原生图片 IPC。它运行在 Node/jsdom，**不能代表真实桌面线程阻塞、排版、滚动帧率或硬件输入法延迟**。

当前 Vitest 的内置 `--outputJson` 会清空原始 `samples`。`tests/perf/vitest.config.ts` 另外输出 `MDPLUS_PERF_FRONTEND=` 单行 JSON，原始样本位于 `metrics[].samples`，供统一 runner 聚合。正式结果应与本文的静态判断分开阅读。

## 9. 文件修改与结论边界

最初审计阶段没有实施生产代码优化。后续新增的固定夹具和性能基准属于测量前置；本文由后续授权生成。

本文所列原生读取与 revision command 仍按**测量前的同步实现**描述。最终是否调整调度、读取策略或其他实现，必须由正式测量和数据一致性要求决定，本文不预先声称某种方案已经生效。

除③这个唯一修复候选外，序列化、统计、图片回收、会话位置、搜索、启动依赖和正文虚拟化均未在本轮实施优化。本文为静态审计，实测结果见同目录的 `report.json`；本文未填入未经确认的性能数值。
