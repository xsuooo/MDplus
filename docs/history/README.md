# 归档文档

本目录是带日期的工作记录和审计报告，按当时的状态保存，不再更新。现行说明见 [开发与质量检查](../development-quality.md) 和 [标签状态模型](../state-model.md)。

## 行号以标签 `pre-simplify-20261118` 为准

文中的源码行号（链接里的 `#L…` 和正文里的 `文件:行号`）写于各文档的日期，之后没有维护。标签 `pre-simplify-20261118`（提交 `87d4692`）之后的简化重构移动、拆分了大量代码，这些行号与当前代码对不上。要看文档所指的代码，取标签处的文件：

```bash
git show pre-simplify-20261118:src/hooks/useDocumentFiles.ts
```

文档早于标签，个别行号在标签处已有偏差：`AUDIT-2026-11-09.md` 的 101 个行号链接里，有 1 个的范围在标签处就超出了文件末尾（`src/lib/store.ts#L219-L249`，该文件在标签处只有 226 行）。

## 改过名的文件

链接里的文件路径已改为当前位置，保证能点开。下列文件在标签处用的是旧路径：

| 当前路径                            | 标签处的路径                                                            |
| ----------------------------------- | ----------------------------------------------------------------------- |
| `src/hooks/useWorkspace.ts`         | `src/hooks/useDocumentSession.ts`                                       |
| `src/lib/position/` 下的四个文件    | `src/lib/` 下的同名文件                                                 |
| `src/lib/paths.ts`                  | `src/lib/pathIdentity.ts` 与 `src/lib/pathDisplay.ts`                   |
| `src/services/windowPersistence.ts` | `src/services/windowState.ts`                                           |
| 本目录下的文档                      | `docs/` 下的同名文件；`AUDIT-2026-11-09.md` 原为仓库根目录的 `AUDIT.md` |

另有一些文件路径没变，但部分内容已移到新文件：`src/lib/imageOps.ts`、`src/hooks/useEditorView.ts`、`src/hooks/useDocumentFiles.ts`、`src/hooks/useRecovery.ts`、`src-tauri/src/safe_files.rs`、`src-tauri/src/lib.rs`。去向见 [模块职责表](../development-quality.md)。
