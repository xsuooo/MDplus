# Stage 4: image and diagram interaction

> Historical execution record. Current status: [README](../README.md); current delivery/rollback: [Windows runbook](ops/windows-delivery.md). Conclusions below describe this report's original run.

Candidate: `0.2.5-phase4.2`\
Build identity: `phase4-20261030.2`

## Frozen behavior

- Q6: center standalone images/diagrams within the reading column, preserve
  aspect ratio, shrink wide media, never stretch small media or crop long media.
  Inline images remain inline.
- Q13: single click selects the node. Explicit controls open a viewer or the
  diagram source editor. Selection supports normal rich copy, deletion and undo.
- Viewing/zooming must not rewrite Markdown, add undo entries, or move the
  document selection/viewport on return.
- Preserve all prior recovery, installer, continuity and typography behavior.
  Do not install on the host, commit, push or release.

## Implementation

- Image NodeViews keep original document URLs and resolved preview bytes apart.
  The presentation wrapper exposes a viewer control only while selected/focused;
  failed images expose a readable error and disable the viewer until loaded.
- Mermaid NodeViews separate selection, source editing and viewing. Live source
  input updates the document synchronously so keyboard saves and recovery do not
  read stale code. Preview rendering never replaces an active source textarea.
- Mermaid initialization/rendering is serialized because library configuration
  is global. Replacement previews remain hidden until loaded, retaining the
  previously visible diagram throughout a refresh.
- Read the generated SVG viewBox inside the returned sandbox document and size
  its iframe with the same aspect ratio. Narrow diagrams keep intrinsic size;
  wide ones shrink without an oversized fixed-height frame.
- Generated markup stays in an opaque, scriptless iframe. The viewer retains
  the same restrictions; a local CSP blocks external resources inside diagrams.
  Untrusted SVG is never inserted directly into the application document.
- One app-owned native dialog provides fit/original size, 10–400% explicit zoom,
  scrolling and pointer panning, focus restoration and Escape. App close requests
  dismiss it before showing the existing unsaved-document confirmation.
- HTML cloning removes editing controls and image wrappers. Print CSS suppresses
  controls. Full offline HTML/PDF resource embedding remains in stage 5.

## Typography boundary

Diagram labels deliberately retain the proportional system UI font stack used
by Mermaid's isolated layout document. They do not silently claim to use the
selected bundled prose font: simply naming an app-local font inside an opaque
iframe does not load it or make Mermaid measure it correctly. A shared,
license-compliant font embedding/layout path remains for the export stage.

## Evidence

Browser tests use real React/Milkdown, geometry, node selection, clipboard
serialization, history and the viewer; native IPC is simulated where applicable.
`tests/windows/media-native.ps1` uses an actually installed Windows Sandbox
candidate, real mouse/keyboard, clipboard and Unicode/space-path files.

Audit logs, package hashes, failure attempts and the stage report live under
`.audit/phase4-2026-10-30/`. Final release/host-update approval is not implied by a
stage pass; the complete continuous acceptance flow is still required.

## Stage result (2026-10-30)

- Final candidate phase4.2: 321 unit tests, 78 browser regressions, both TypeScript
  checks, 27 Rust tests and Clippy passed.
- Fresh Windows Sandbox final-package checks passed: installation/locks/config,
  typography, media interaction/live diagram Ctrl+S, editing continuity, graceful
  process-tree shutdown, unsaved-update refusal and clipboard-image crash recovery.
- Real browser pointer panning and light/dark/small-window/native screenshots
  were inspected. Probe failures and environment limitations remain in the report.
- Final report: `.audit/phase4-2026-10-30/acceptance.md`; package/hash inventory:
  `artifacts.json` in the same directory.
- No host install, commit, push or Release. Stage 5 (theme/export), final continuous
  acceptance and protected host deployment remain outstanding.
