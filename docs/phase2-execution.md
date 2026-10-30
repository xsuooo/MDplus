# Stage 2: editing continuity

> Historical execution record. Current status: [README](../README.md); current delivery/rollback: [Windows runbook](ops/windows-delivery.md). Conclusions below describe this report's original run.

Candidate: `0.2.5-phase2.1`\
Build identity: `phase2-20261030.1`

## Scope and invariants

- Save/auto-save do not move the document selection or scroll position.
- A background save never focuses its hidden editor over the active tab.
- Image migration updates image attributes without creating a body-edit undo step.
- When a migrated URL wraps onto additional source lines, retain the visible text
  anchor rather than blindly preserving a scroll offset that would shift the text.
- Each open tab keeps its source/rendered mode, selection and scroll position.
- Source views stay mounted while hidden, retaining their draft and undo/redo
  history. Closing a tab still removes its view and recovery state.
- Mode switching matches positioned Markdown textblocks to rendered blocks.
  Headings, paragraphs, nested lists, quotes, table cells, code and inline math
  are covered. An unchanged round trip restores the exact original selection and
  scroll offsets; newly mapped views use the same block, not document percentages.
- Font changes preserve the current selection and scroll offset after the selected
  font loads. New user input or scrolling cancels a pending position restoration.

## Implementation

- `src/lib/editor.ts`: skip identical documents, normalize generated heading IDs,
  patch image attributes or the minimal changed range, map selection and suppress
  synthetic sync notifications. No unconditional `focus()` or move-to-start.
- `src/lib/editorPosition.ts`: per-mode snapshots, Markdown/ProseMirror block
  matching, real wrapped-text measurement and bidirectional mode transfer.
- `SourceEditor`: explicit visibility, actual DOM selection capture before an
  external draft change, and image-URL rebasing of source selection/history.
- `App`: per-tab presentation state; synchronize the relevant tab instead of
  replacing every editor on each mode switch. Keep raw source Markdown as the
  authoritative save/recovery content.

## Evidence and delivery boundary

Detailed logs, package hashes and the stage report are under
`.audit/phase2-2026-10-30/`. Browser regressions use real React/Milkdown with native
IPC simulated; native continuity is checked separately against an actually
installed Windows Sandbox candidate.

No host update is authorized by this stage alone. Stage 1 recovery/installer
protections remain enabled; final typography, media/export and full continuous
acceptance still follow in the frozen plan.

## Stage results (2026-10-30)

- 314 unit tests, 60 browser regressions, browser/production TypeScript checks,
  27 Rust tests and Clippy passed.
- Windows Sandbox installed-candidate checks passed: save/mode/tab selection and
  viewport continuity, undo after save, graceful close, installer lock handling,
  configuration preservation and stage-1 crash recovery with actual clipboard images.
- Host installation remained unchanged. Full report:
  `.audit/phase2-2026-10-30/acceptance.md`; package/payload hashes: `artifacts.json`.
