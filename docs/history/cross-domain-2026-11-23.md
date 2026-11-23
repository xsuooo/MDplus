# 跨领域经典问题映射研究（2026-11-23）

检索日期：2026-11-23。正文核验与历史证据收束已完成；本研究本身未实施产品或运行产品测试。Lead 的实际采纳、修改与最终验收见[本轮复盘](retrospective-2026-11-23.md)，不把以下研究候选当成已执行结果。

## 范围与证据口径

问题：当前保存、恢复、图片、界面与文档返工，是否可以借鉴其他领域的经典问题模型？覆盖可靠性／事故复盘、并发／生命周期、人因／可用性、配置／契约验证四个领域。

项目身份：读取时分支 dev/0.2.7，HEAD 为 07ae81b73383e43c9ce751622da64085c51d726f。工作区包含未提交改动；下列“当前文件”指本次实际读取的工作区，不自动等同 HEAD 或已发布版本。历史提交通过 git show 核对。未 reset、restore、clean、提交、推送或操作用户数据；本任务仅新增本文件。

- **项目证据支持**：代码、测试定义或提交 diff 支持某个具体机制／变更；测试定义不等于本次运行通过，提交说明不单独证明历史根因。
- **外部原始主张**：官方规范、官方文档或作者自身工程经验。外部工程经验不等于本项目实证。
- **跨领域类比**：把外部机制映射到本地场景，须经项目验证；不推断开发者此前是否读过这些资料。
- 本次仅运行只读配置核对 node scripts/sync-config.mjs，退出码 0；未重新执行产品单测、浏览器或安装版测试。既有验证结果只作为文档记录引用，不改写成新验收。

## 主要结论（5 条）

1. **图片配额、会话登记或过期清理阻断核心任务，是“辅助故障扩大影响范围”的变体。** 3639829、a740432 与 07ae81b 的 diff 支持不同的局部隔离措施；有条件降级不是统一吞错。外部 SRE 支持策略类比，不证明本项目因果或收益量。[S1]
2. **异步完成后核对代次、落盘前核对字节版本，分别对应过期结果抑制与丢失更新防护。** 两者是不同保护层，不能拿取消关闭替代取消保存，也不能把 Windows 文件替换称为原子内容 CAS。[S2][S3]
3. **“失败”不等于“文件缺失”，“可恢复”不等于“已保存”，是失败分类与操作状态可观察性问题。** a1d6c6f／e7e1ce6 的 diff 支持误分类后移除记录或给错操作提示的修补；应做精准反馈与状态语义校准，不用更多常驻提示掩盖语义。是否易懂仍需真实用户／辅助技术验证。[S4][S5]
4. **跨层形状、编码单位和历史引用均有边界契约；Schema 不能取代业务语义、表示转换和时序测试。** 原始正文与 JSON 容量、UTF-8 字节与 UTF-16 码元、现行路径与历史路径必须分别校验。复用现有质量入口，避免第二份真相源。[S6][S8]
5. **闭环复盘应形成“事件—影响—机制证据—措施—验证”的学习记录，不把提交密度、返工或备份标题当作根因。** 现有文档已经区分失败重跑、模拟边界和原生待测；适合加小型事件登记，不适合引入重型事故平台。[S7]

## 指定线索的核实记录

| 线索               | 已核实的项目证据                                                                                                                                                                                                                                                                                  | 可以支持／不能支持                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 图片暂存满仍需保全 | 提交 363982968d944be5e694da31256f97cb62a74f7e 描述并修改图片暂存、恢复、保存与测试；原逻辑在该提交 src/lib/imageOps.ts，现拆为 src/lib/images/。当前 src/lib/images/stash.ts:105-125 只对 STASH_FULL 且提供 file backing 时降级；src/lib/images/references.ts:72-76 的 refresh 不提供此 backing。 | 支持配额错误被独立分类、非刷新准备可无预览保全；不能据此给出事故次数、丢失字节数或修复收益。                                                       |
| 模块拆分后循环调整 | 提交 7b19275e63137658de54b8b4f2f22fbadb92c496 的父版本 src/lib/images/stash.ts:6 导入 references；该提交 diff 显示 references 原本导入 stash，随后把路径 helper 移到 stash。                                                                                                                      | 支持静态导入循环曾存在并被打断；无运行栈或执行证据，不能写成曾导致崩溃，也不证明“模块越小越好／越坏”。只把职责拆分后的依赖方向复核列为低成本候选。 |
| 文档位置返工       | 879362096b67195da25bfcb48f140499e40a2715 将带日期记录移入 docs/history；4a0cbe667ebff82a0304b5c79e86929f2e460322 修正三处归档链接；b80fbb650e2dfa0d4c6d496b1d2938e4c09ea70c 补旧模块位置和归档行号基线。docs/history/README.md:3-13 明示归档时态及 pre-simplify-20261118 基线。                   | 支持迁移后修补定位信息；没有用户决策记录或耗时统计，不推断需求反复、沟通失败或谁造成返工。属于引用契约与时间版本问题的类比。                       |
| 备份 UI／恢复修复  | 提交 07ae81b73383e43c9ce751622da64085c51d726f 的 src-tauri/src/recovery.rs diff 增加 JSON 扩张预算、统一文件名校验及过期清理失败的 cleanup_error；同时包含 UI 与核验记录。                                                                                                                        | 支持这些改动被提交保留；“before reinstall”仅为标题，不证明实际重装、工具来源、人员意图或事故根因。                                                 |

这些线索不合并成一个总根因。lead 后续历史审计提出四组可重复机制；下表又以实际提交 diff／当前测试定义复核，而非把转述当成新的项目实证。

### 历史审计补充：四组机制，不是唯一总根因

| 机制                  | 本次独立复核的项目证据                                                                                                                                                                                                                                                                                                                                          | 映射与边界                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 失败不能当 missing    | a1d6c6ffca9a5279a95e64fe49ef13847d6c3443 的 src/hooks/useDocumentFiles.ts:204-233 diff 仅在 documentRevision 返回 revision=null 时移除最近记录；探测失败保留。e7e1ce65a45b19916384b3f11b02e407a3c596f0 的 src/hooks/useExternalChanges.ts:85-108 diff 把已读取正文后的图片准备失败独立处理，并暂停自动保存、保留本地内容。                                      | C3 的状态语义问题，也关联 C1 的失败分类；不能据此宣称所有一般错误都已准确区分，或把 unknown 当 absent。  |
| 辅助故障 blast radius | a74043243aba3b8e183b960e8c95023f7e246277 的 src/hooks/useDocumentClose.ts:113-125 diff 在文稿已保护且再次核对关闭条件后，捕获会话写入失败再继续关闭；3639829 为受限图片降级；07ae81b 为清理失败保留 cleanup_error 后继续列出健康草稿。                                                                                                                          | C1 的局部故障隔离；三个前置条件各不相同，不可归并成“失败也总要继续”。                                    |
| 跨表示边界            | src-tauri/src/safe_files.rs:95-103 按 encode_utf16().count() 限制文件名；src-tauri/src/recovery.rs:19,168,296 分别约束编码预算、正文原始字节和 JSON 成品。src-tauri/src/recovery_tests.rs:471-496 定义100个“图”文件名往返；src-tauri/src/recovery_tests.rs:500-515 定义最大正文的控制字符 JSON 转义往返与超限拒绝。                                             | C4 的单位／表示转换契约。测试定义支持边界覆盖，未在本次运行；JSON 可扩张不等于所有内容固定扩张六倍。[S8] |
| 拆分边界与历史指针    | b211de89190ed3324e17b1995fb2bc9325ffaa5c 从四个 src/lib/images/ 模块收回11处 export；3cebc237bae3a9ba6aec684fffec36d19956f3ef 将 src-tauri/src/safe_files.rs:352-356 的 SaveCopies::new 改回私有。b4ab6b047bd4d4e51fbec7d2d4b1be6271b27745 重命名当前工作区 hook；5fcd78f7d4a65668db5320d4509ff0df07def9a5 把 tests/perf/audit.md:71 的历史引用恢复为当时路径。 | C4／C5 的契约及时间版本；拆分后同时核对导入方向、公开面和历史引用，不把静态循环写成实测 runtime fault。  |

本轮修订收束：lead 已明确拟做现有层级内的 copy／state 语义与精准反馈，并复用质量入口增加有条件失败矩阵及迁移检查。本研究只提出与这些选择相容的验证候选，不另造全局错误框架；没有将“拟做”写成“已完成”。

## 映射与适用边界

### C1：可靠性——核心保全与有条件降级

**原始主张与出处**：[S1] 的 Handling Overload 讨论计算／请求过载时提供 degraded responses，极端过载仍可能只能返回错误。它不是建议对所有错误继续运行，更不是建议牺牲用户数据完整性。

**项目证据**：docs/product-core.md:9-17 将安全保全纳入主任务；docs/product-core.md:91-98 要求新编辑不能误报已保存、失败保留内容。src/lib/images/stash.ts:105-125 的关键规则为“if (!file || !isStashFull(error)) throw error”；src/lib/images/stash.ts:137-150 重新读取并核对长度和 SHA-256，不匹配仍拒绝。测试定义分别覆盖暂存满下手动保存、自动保存、另存为和草稿保护（tests/imageStashFullSave.test.tsx:119,141,161,183），以及变更字节／其他错误／刷新仍拒绝（tests/imageStashFull.test.ts:200,272,294,314）。

**适用条件**：可牺牲的是预览，不是图片字节；有合法原文件、有限容量的明确错误分类，且使用时仍校验。刷新、打开、恢复等需要新的正确内容时，不任意沿用旧图。

**限制与证据类型**：项目机制有代码和测试定义支持；把它称为故障隔离／降级是类比。SRE 的吞吐场景不同于桌面存储配额，不能照搬限流参数、SLO 或收益数据；该策略也不证明本机磁盘全满时仍能写盘。

**采纳建议**：保留已有窄降级分支；会话登记、清理、预览等辅助步骤，分别写清继续主流程的前置条件及失败状态。后续增加资源能力时先问“此失败是否必须阻断正文保全”。不新增全局错误框架、统一吞错或自动驱逐用户图片。

### C2：并发／生命周期——过期结果与丢失更新是两层问题

**原始主张与出处**：[S3] 在 Fetching data with Effects 中用 cleanup 设置 ignore，防止响应乱序后提交旧结果；[S2] §13.1.1 用 If-Match 阻止并行主体意外覆盖同一资源，并要求在执行方法前评估条件。

**项目证据**：docs/state-model.md:13,19-20,43-49 分别记录活得比标签久的 tabEpoch、每个 await 后核对代次、独立保存／关闭代次、内容版本与缓存版本。docs/development-quality.md:31-33 要求同步镜像读状态并先补延迟／失败／取消／并发回归。src-tauri/src/safe_files.rs:487-491 对比 actual 与 expected_revision，不符返回 CONFLICT；src-tauri/src/safe_files.rs:541-555 还核对提交字节和捕获的前版本，不符返回 RECOVERY_REQUIRED 并保留副本。

**适用条件**：本地 UI 身份／内容在 await 期间可变化时，提交结果前检查对应代次；外部程序可改文件时，用内容版本而不是仅用 mtime 判断覆盖资格。不同生命周期需要各自失效规则。

**重要限制与证据类型**：RFC 的 HTTP 条件请求是外部协议示范，不是本项目采用 HTTP 或满足 RFC 的证据。src-tauri/src/safe_files.rs:497 明确写出“此间隙不能由 ReplaceFileW 变成 content-CAS”；外部写入可落在检查与替换之间，现策略是捕获、后验核对与保副本，不是绝对无竞态。React cleanup 抑制结果提交也不等于物理取消已发出的 IPC 或撤销已落盘内容。

**采纳建议**：在已有状态表增量记录每个异步边界使用的令牌和提交条件，不再造通用“取消全部”开关。现有 safe_files 原生测试已有 BeforeCommit／AfterCommit 注入及 RECOVERY_REQUIRED 断言（src-tauri/src/safe_files_tests.rs:581-617），后续变更在这些窗口验证；本次未执行这些测试。

### C3：人因／可用性——看见状态与防止高代价误操作

**原始主张与出处**：[S4] SC 4.1.3 要求状态消息可由角色／属性确定并无需转移焦点即可被辅助技术呈现；其 Intent 明确避免不必要打断。[S5] SC 3.3.4 对修改／删除用户可控数据等行为提出 reversible、checked、confirmed 至少一种保护，不要求对每次轻微操作都弹确认。

**项目证据**：docs/history/ui-ux-2026-11-19.md:18-23,27-31 记录非常驻的启动失败处理、未保存／可恢复／备份失败区分、删除风险说明及焦点边界。src/components/StatusBar.tsx:94-116 已为保存与恢复状态分别使用 role=status，恢复提示明确“未加密；不等于正式保存”。docs/product-core.md:97-98 定义恢复为新文稿、关闭的三个明确动作。

**适用条件**：后台保存／恢复状态不应抢走写作焦点；不可轻易撤销的丢弃或永久删除需明确保护。提示可见性、处理入口、键盘路径与实际状态必须一致。

**限制与证据类型**：SC 4.1.3 是直接适用的 Web 内容状态消息指导；SC 3.3.4 是网页用户数据场景，对桌面本地删除是设计类比，不据此宣称 WCAG 全项合规。role 属性和清楚文案不等于真实读屏可用，也不证明用户已理解两种保全状态。docs/history/ui-ux-2026-11-19.md:51,71 与 docs/ops/p0-verification-2026-11-20.md:29,61 明示模拟 IPC、真实 IME／安装版等未验收边界。

**采纳建议**：优先验证现有三种状态与处理入口，不增添常驻横幅或为无害操作增加确认。以真实辅助技术与任务走查补充代码断言；未得到用户证据前不改产品信息层级。

### C4：配置／契约——形状约束、跨层同步与语义测试分开

**原始主张与出处**：[S6] Object → Additional Properties：额外属性默认允许，additionalProperties=false 才拒绝；Object → Required Properties：properties 中定义的字段默认并非必填。故“有 Schema”本身不足以证明约束完整。[S8] RFC 8259 §7／§8.3 区分原始字符串和转义表示：控制字符必须转义，BMP 的六字符序列与非 BMP 的十二字符代理对表示不能混用字节预算。[S9] RFC 8081 §4.4.6 直接登记 `font/woff2`，WOFF2 签名必须为 `0x774F4632`（`wOF2`）；WOFF 1／2 的媒体类型和 @font-face format 不同。文件长度、媒体元数据与实际字节表示是不同契约字段。

**项目证据**：src-tauri/src/file_contract.json:176-177,323-328、tests/ipcContract.test.ts:11-31,58-62,95-115 与 package.json:13-14,21-22 支持结构／同步入口。11-23 原生导出两份 MiSans 的真实 wOF2 字节被标 text/html，其他 WOFF2 为 legacy 类型；src/lib/fontResources.ts 原样保留 Blob 类型，tests/fontPackaging.test.ts 未查 MIME。tests/fontResources.test.ts 的真实 FileReader／Blob 4 红 → 字体／包装／导出 18 项绿；实际原生 HTML SHA e21b7d11c1a77b075e9901497265444e21adfd9367bdf4872b0fce47cef6a9f3，Root 独立确认 5/5 font/woff2、7/7 资源 bytes/SHA 不变、正文与未保存状态保持。`.audit/closure-2026-11-23-lead/native-font-mime-independent-review.json` 与 `.audit/closure-2026-11-23-lead/font-mime-red-command.json` 可回验。

**适用条件**：共享配置、IPC 或离线资源变更跨越前端、Rust、权限、fixture 与宿主桥时，对齐所有消费者、编码单位和资源类型／字节内容。旧数据兼容须有界；对已确认 wOF2 字节只归一化媒体类型，不靠上游标签猜内容，也不扩为全文件安全扫描器。

**限制与证据类型**：JSON Schema 官方说明支持结构关键词解释；项目测试定义支持已有一致性保护，未证明所有入站／回执都在运行时执行完整 Schema 校验。形状合法也不能证明“不静默覆盖”“图片已持久化”或“关闭期间新编辑保留”；仍须 C1／C2 的语义与时序断言。跨字段端口同步更非 JSON Schema 默认能力。

**实际采纳**：复用已有 fixture／check 入口补形状、编码／单位、时序与资源 MIME 反例；tests/fontResources.test.ts 验证 fetched 和 inline 的误标签字体、完整字节，以及 PNG／许可 PDF／文本不变。仅修正已确认的 WOFF2 类型，不截字库、不删字重、不新增配置或验证依赖。迁移另核导入方向、公开面和历史提交定位。RFC 8081 对字体类型是直接标准支持，JSON Schema 对形状是规范说明，不能据此声称浏览器／读屏／性能全面验收。

### C5：事故复盘——证据链与可检验的行动项

**原始主张与出处**：[S7] Postmortem Culture 定义复盘包含事件、影响、缓解动作、原因和防复发行动；Google’s Postmortem Philosophy 要求找 contributing causes 而不指责个人，并明确复盘有时间成本、需要触发标准。

**项目证据**：docs/ops/p0-verification-2026-11-20.md:33-37 把 EPERM、断言执行前的 0xc0000142、动画观察时序分别记录，并保留首轮失败；docs/ops/p0-verification-2026-11-20.md:29,55,61 不把模拟浏览器、源码摘要或候选包当安装版验收。docs/history/ui-ux-2026-11-19.md:39-49 也区分历史大范围回归、本轮较小回归和忽略项。

**适用条件**：可见数据保全失败、错误地宣称验收通过、同机制重复失败、人工回滚／恢复等，值得轻量复盘。普通文案改动或单次可解释的环境限制无需自动升级为事故。

**限制与证据类型**：Google 自身实践是可靠性经验来源；把它用于个人桌面项目是类比，不证明项目组织文化、谁的信息不完整或“真正唯一根因”。没有当时日志／决策证据时，应写“未知”，而不是用提交标题填空。

**采纳建议**：单份小记录只写触发事件、影响是否已证实、机制证据、措施负责人／验证入口；已有档案固定时间版本，现行说明另行维护。模块拆分检查导入方向、迁移后检查链接，作为该事件的低成本行动项，不新增通用流程平台。

## 采纳候选：触发、成本与验证

下表保留研究时形成的候选，成本为相对工作量判断，不是工时统计或收益预测。Lead 已采纳 A 的条件式 E1／E2／N 矩阵、C 的组件状态与文案反例、D 的既有跨表示回归及 E 的单份复盘与定向 ESLint 回边检查。B 复用已有代次／幂等回归，未新增令牌状态表或通用取消框架；真实产品与辅助技术验收以本轮复盘的实际覆盖为准。

| 候选                           | 触发场景                                                   | 成本／取舍                                                     | 验证法与完成条件                                                                                                                                                            |
| ------------------------------ | ---------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A 有条件辅助失败矩阵           | 新附件／预览依赖，会话登记／清理再阻断主流程               | 低至中：复用现有夹具，逐场景列前置条件；禁止统一吞错           | 容量满／一般错误／字节变更／refresh 分别注入；仅合法窄降级保全正文；会话失败继续关闭须先证明文稿已保护且关闭代次仍有效，清理失败仍列健康草稿并给出失败状态。                |
| B 异步操作令牌／提交条件检查表 | 保存、关闭、导出或图片流程新添 await／切换身份             | 低：补表与现有延迟测试；不必重构成通用框架                     | 延迟后编辑／关标签／取消关闭／切模式，旧操作不能更新新状态；BeforeCommit／AfterCommit 外改时保副本并准确返回冲突／恢复要求。不能把物理写入宣称已撤销。                      |
| C 精准反馈与状态语义＋任务走查 | 修改失败文案、缺失判断、备份／正式保存状态                 | 文案和状态断言低成本；真实用户／辅助技术走查中成本，隔离安装版 | 覆盖 missing／locked／unknown、正文已读但图片准备失败，禁止误报删除、误移最近记录或诱导覆盖；在既有层级让用户辨别“已保存／可恢复／备份失败”，核对读屏、焦点与保留两份路径。 |
| D 契约与跨表示边界反例         | 改命令、字段、错误码、容量、文件名、资源类型或端口         | 低至中：现有断言／原生边界用例；不增依赖                       | 缺／多字段、权限漂移应失败；中文名称、最坏 JSON 转义正确往返；WOFF2 字节必须匹配 font/woff2，非字体与许可字节保持；结构成功不替代业务保全、真实 IPC 或宿主导出。            |
| E 轻量事件表及迁移检查         | 保全失效、假阳性验收、重复失败；搬文档／拆模块另做局部检查 | 低：沿用 docs/history 与源码 diff，不给所有任务加事故流程      | 行动项追到日志／提交／file:line 和重现入口；相对链接可解析，历史路径绑定原提交；拆分后导入方向与公开面有依据，消费者一致。没有根因证据就登记未知，不补故事。                |

## 一手来源登记

均于 2026-11-23 实际读取官方正文，关键原文按页面去 HTML 标签并合并空白后核对。网页节名比搜索结果标题更可靠；英文短引只固定关键主张，不代替全文。来源性质：规范／指导／自述经验，而非本项目试验。

| 编号 | 官方 URL、节名                                                                                                  | 关键原文／原始主张                                                                                                                               | 正文访问与限制                                                                                |
| ---- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| S1   | https://sre.google/sre-book/handling-overload/ — Handling Overload（开头的 degraded responses 讨论）            | “serve degraded results when necessary, and handle resource errors transparently when all else fails.” 这是服务过载策略，不是数据保全实证。      | HTTP 200，71,758 字符；官方 SRE 自述经验。                                                    |
| S2   | https://www.rfc-editor.org/rfc/rfc9110.txt — §13.1.1 If-Match（亦见 §8.8 Validators）                           | “prevent accidental overwrites when multiple user agents might be acting in parallel on the same resource” 条件不满足时不得执行请求方法。        | HTTP 200，502,907 字符；HTTP 标准语义。适用本地文件仅为机制类比。                             |
| S3   | https://react.dev/reference/react/useEffect — Fetching data with Effects                                        | “network responses may arrive in a different order than you sent them.” 示例 cleanup 置 ignore=true 并在提交前检查。                             | HTTP 200，601,699 字符；React 官方 API 指导，不包含本项目 IPC 可取消性保证。                  |
| S4   | https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html — SC 4.1.3／Intent                             | “make users aware of important changes in content that are not given focus” 状态可通过角色／属性呈现，不应不必要打断。                           | HTTP 200，60,332 字符；W3C Understanding 为解释性指导，不能替代完整规范／辅助技术测试。       |
| S5   | https://www.w3.org/WAI/WCAG22/Understanding/error-prevention-legal-financial-data.html — SC 3.3.4／Intent       | “at least one of the following is true: Reversible” 后续列 Checked、Confirmed；适用于法律／金融、用户可控数据修改删除等规定场景。                | HTTP 200，48,118 字符；桌面本地删除为设计类比，不宣称合规已验收。                             |
| S6   | https://json-schema.org/understanding-json-schema/reference/object — Additional Properties／Required Properties | “Setting the additionalProperties schema to false means no additional properties will be allowed.” properties 定义字段默认非必填，需 required。  | HTTP 200，710,158 字符；官方关键词解释，未核对项目运行时完整 Schema 执行器。                  |
| S7   | https://sre.google/sre-book/postmortem-culture/ — Google’s Postmortem Philosophy                                | “focus on identifying the contributing causes of the incident without indicting any individual or team” 有触发门槛和成本，不是对项目人员的归因。 | HTTP 200，55,072 字符；Google 工程经验，不代表本项目已发生生产事故。                          |
| S8   | https://www.rfc-editor.org/rfc/rfc8259.txt — §7 Strings／§8.3 String Comparison                                 | “represented as a six-character sequence” 与十二字符 UTF-16 代理对表示；控制字符必须转义。                                                       | HTTP 200；JSON 表示规范，不保证具体序列化器尺寸或 Windows 命名单位。                          |
| S9   | https://www.rfc-editor.org/rfc/rfc8081.txt — §4.4.6 WOFF 2.0（2017-02）                                         | “Type name: font”“Subtype name: woff2”；签名 MUST 为 `0x774F4632`（wOF2），WOFF 1／2 的类型不同。                                                | Root 于 2026-11-23 实际读官方正文，HTTP 200；支持字体类型／签名归一，不证明消费者渲染或性能。 |

### 获取方法与访问失败记录

初始 research 的七个页面为 snippet-only／low，官方域名解析为 198.18.* 被“SSRF blocked”拒绝，未据摘要采纳；随后 PowerShell 读取明确公开 HTTPS 原文，七篇及补充 S8 均 HTTP 200。Root 本轮真实原生导出发现 MIME 反例后，以 Node fetch 直接读取 S9 官方正文和 §4.4.6，也为 HTTP 200。最终九个来源均有正文支持；访问路径失败不是网站不可用的结论。

可复核方式：读取 S1-S9 URL，按表中节名／短引定位；RFC 9110 搜索 If-Match，RFC 8259 搜索 six-character sequence，RFC 8081 定位 §4.4.6。网页变化时重标检索日期；访问字符数不是长期摘要。未把镜像、搜索重复或工具文档算作额外独立跨领域来源。

## 项目证据复核入口与待决定项

历史记录可只读复核：

```powershell
git show 3639829 -- src/lib/imageOps.ts src-tauri/src/image_stash.rs tests/imageStashFull.test.ts
git show 7b19275^:src/lib/images/stash.ts
git show 7b19275 -- src/lib/images/stash.ts src/lib/images/references.ts
git show 8793620 --stat
git show 4a0cbe6 b80fbb6 --stat
git show 07ae81b -- src-tauri/src/recovery.rs
git show a1d6c6f -- src/hooks/useDocumentFiles.ts tests/sessionRestore.test.tsx
git show e7e1ce6 -- src/hooks/useExternalChanges.ts tests/documentProtection.test.tsx
git show a740432 -- src/hooks/useDocumentClose.ts tests/sessionRestore.test.tsx
git show b211de8 3cebc23 -- src/lib/images src-tauri/src/safe_files.rs
git show b4ab6b0 5fcd78f -- tests/perf/audit.md
node scripts/sync-config.mjs
```

Lead 已采纳 A-E 中有证据的有条件失败矩阵、状态／文案、现有幂等提交、定向迁移 lint 和跨表示／资源类型反例，未增通用取消表、全仓扫描或事故平台。源码与原生候选按本轮范围验收；PDF／IME／真实用户或辅助技术／VM 安装是单列的未覆盖发布边界，不把未运行称通过。产品定位、账户和云同步等范围仍不扩展（docs/product-core.md:3,82）。

交付差异：本文含五条主要结论、四领域映射、九个已读官方来源，以及五个有触发／成本／验证出口的采纳项；本文研究不等于产品实证，实际 diff、红绿测试与原生回验记录由 Lead 的复盘与 .audit 证据单独承载。
