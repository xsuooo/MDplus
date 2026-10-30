# Stage 3: unified typography

> Historical execution record. Current status: [README](../README.md); current delivery/rollback: [Windows runbook](ops/windows-delivery.md). Conclusions below describe this report's original run.

Candidate: `0.2.5-phase3.1`\
Build identity: `phase3-20261030.1`

## Frozen decisions

- Preserve the existing toolbar, tabs, outline, editor and status bar.
- Reading text and code have independent font roles and persisted choices.
- Default prose: MiSans, proportional Latin and Chinese.
- Default source/code: JetBrains Mono + Sarasa Gothic SC. Existing pair choices
  remain code preferences; they no longer override the prose font.
- Prose baseline: 16px / 1.75, effective reading width at most 720px before the
  existing editor zoom multiplier. The column shrinks with the outline/window.
- Source baseline: 16px / 1.6; fenced code: 14px / 1.6; inline code: 0.9em.
- Heading scale: 28 / 23 / 20 / 18 / 16 / 15px at 100%. Strong/emphasis uses
  actual MiSans/Sarasa Semibold or LXGW WenKai Medium, not synthetic bold.

## Implementation

- `editorFont.ts`: independent body/code preference validation and persistence.
- `TypographyPanel.tsx`: non-modal status-bar panel with two labeled selectors,
  mixed-language and code previews, outside-click and Escape dismissal.
- Consolidate duplicate source/container styles. Tokens govern reading width,
  gutter, font sizes, line heights and real emphasis weight.
- Break long prose URLs while keeping long code and wide tables scrollable.
- Bundle licensed emphasis faces alongside regular faces. MiSans official WOFF2
  stays unmodified; Sarasa/WenKai format conversion does not subset glyphs.
  Fonts are app-local, offline, not installed into Windows.
- Stage-2 selection/scroll preservation applies independently to both font roles.
  A failed font load still settles restoration using the available fallback.

## Boundaries

Diagram labels retain the existing sandbox font handling for the media stage;
HTML/PDF embedding and export typography remain in the later export stage.
Italic can still be synthesized. The WenKai emphasis is its actual Medium face,
not a claimed Semibold. Mixing code/CJK faces does not promise a strict 2:1 grid.

All nine bundled editor faces total 44,903,972 bytes, about 22.7 MB more than the
previous six-face set. Only selected fonts/weights are loaded; the default body
regular face is preloaded to reduce the first-paint fallback interval.

No host installation, commit, push or release is part of this stage.

## Stage result (2026-10-30)

- Production/browser TypeScript checks, 318 unit tests, 66 browser cases,
  27 Rust tests, and Clippy with `-D warnings` passed.
- NSIS x64 build passed. Installed candidate verified in a fresh Windows sandbox:
  locked-file refusal, old-version upgrade, configuration preservation, native
  typography persistence/selection, prior editing continuity, process shutdown,
  unsaved-update refusal, and actual clipboard-image crash recovery.
- Native probes now use WebView2's actual UIA patterns and select nonempty visual
  lines independently of font wrapping. Fixture writes follow the no-instance
  check, so a failed retry does not rewrite an open test document.
- Full report: `.audit/phase3-2026-10-30/acceptance.md`.
  Version, hashes, package path and host protection: `artifacts.json` and
  `host-verification.json` in the same audit directory.
- Font footprint and synthesized-italic limits are recorded in the report.
  The two design-scan advisories concern the semantic quote border and an
  existing modal easing, not an unreported clean scan.
- Host installation is unchanged. Images/diagrams are the next stage; theme,
  export and final continuous acceptance remain before any host update.

## Global UI follow-up (2026-10-31)

The installed phase6.1 build exposed a gap: the body/code roles changed document
content but not application chrome. The shortcut dialog still inherited the
system sans stack, and shortcut chips explicitly used the fallback mono stack.

The source fix moves the selected font roles to the document root before paint.
Body text, menus, dialogs, buttons, search/select controls, media actions, the
drag overlay and the error fallback inherit the body choice. Shortcut chips use
the code choice; recording prompts use the body choice. The two persisted font
preferences remain independent. The panel now calls the first choice the UI/body
font and explains that Windows file/print dialogs are outside this scope.

Verification: 322 unit tests and 94 browser cases pass, including new global-UI,
shortcut-font and error-fallback regressions and dialog persistence assertions.
Production/browser typechecks and the frontend build pass. Narrow and desktop
browser screenshots confirm WenKai UI text alongside Fira Code shortcut chips.
Native test control labels are updated, but native suites were not rerun.

Evidence: `.audit/global-font-20261031/report.md`. This follow-up does not build a
new NSIS package or replace the running phase6.1 host installation. The source
fix must be packaged and installed in a separately protected update before it
appears in that installed application.
