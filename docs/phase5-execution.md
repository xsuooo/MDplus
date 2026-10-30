# Stage 5: theme and portable export consistency

> Historical execution record. Current status: [README](../README.md); current delivery/rollback: [Windows runbook](ops/windows-delivery.md). Conclusions below describe this report's original run.

Candidate: `0.2.5-phase5.8`\
Build identity: `phase5-20261030.8`

## Frozen scope

- Q7: quiet motion. Keep coordinated theme transitions, no save/status bounce or
  decorative scaling; slow diagrams cannot block document input indefinitely.
- Q9/Q14: light, readable HTML/PDF with the document's typography, images, math
  and diagrams. Single-file HTML embeds resources and licensed fonts for offline
  sharing, with an explicit size confirmation.
- Q11: export and theme changes must not rewrite Markdown, move selections or
  switch the live document's view/theme just to produce output.
- All earlier recovery and installer protections remain. No host installation,
  commit, push or Release before final continuous acceptance and rollback backup.

## Implementation

- `captureExport` freezes parsed Markdown and resolved image bytes synchronously.
  It does not read the current DOM after awaits or synchronize into the editor.
- `buildExport` produces independent static HTML, completes all diagrams before
  returning, validates image decoding and rejects missing/external resources
  rather than silently omitting them. Links are restricted to safe schemes.
- Shared `document.css` governs editor and export prose. Export uses 100% reading
  scale and a light palette; code wraps and wide table cells wrap for printing.
- Selected original font files, KaTeX WOFF2/CSS, and image data are embedded.
  Font licenses are retained in the HTML; MiSans's original license PDF is
  embedded, not replaced by an invented or abbreviated license.
- HTML export shows the actual approximate file size and returns cancellation
  distinctly from success. One app-owned busy guard prevents overlapping exports.
- PDF prints the same frozen document in a scriptless, isolated iframe. Generated
  CSS is installed through CSSOM so Tauri's inherited CSP style hashes do not
  break layout; host script/CSP permissions are not disabled. Wait for fonts and
  images, then retain the frame until afterprint, including cancellation.
- Diagram layout measures actual loaded body fonts in a temporary strict Mermaid
  renderer. Dynamic diagram styles are applied via CSSOM under packaged CSP.
  Flowcharts are measured again from their completed sanitized tree, avoiding
  WebView2's stale temporary-label bounds; titles and groups remain included.
  Visible previews use SVG image mode rather than giant HTML data-URL iframes:
  scripts, interactive links and external resource loading stay inert. Fonts are
  embedded inside the SVG image. Do not invoke Mermaid bindFunctions. Native
  checks include actual painted pixels, not merely iframe/container geometry.
- Diagram font selection is read after its NodeView attaches to its actual tab.
  Theme-only redraws retain the previous layout dimensions and crossfade after
  loading; only code/font changes may resize the document.
- Whole-window theme preparation stays bounded at 200ms. Late diagrams replace
  their old scene separately, respecting reduced motion. Save flash and modal
  scale/bounce are removed.

## Verification boundaries

Browser tests include immutable source, cancellation, broken-resource refusal,
offline resources, CSP-aware print layout, font embedding, injection handling,
theme geometry and prior editor/recovery behavior.

`tests/windows/export-native.ps1` drives the installed candidate's actual HTML
dialog and WebView2 print preview, with Chinese/space paths, PDF save/cancel,
file-content checks and original-file hashes. Printer output still belongs to
the system print dialog; opening it alone does not prove a PDF was written.
`tests/windows/theme-native.ps1` samples native diagram bounds through a complete
dark/system/light cycle. Geometry stability is not a claim about every display's
perceived animation smoothness.

Evidence and the stage report live in `.audit/phase5-2026-10-30/`.
Final continuous multi-feature acceptance and protected host deployment are a
separate gate, not implied by this stage's isolated tests.

## Stage evidence (2026-10-30)

- Final phase5.8: 322 unit tests, 90 browser regressions, 27 Rust tests,
  production/browser TypeScript, Clippy and NSIS build passed.
- Installed Windows Sandbox candidate: upgrade/lock safety, recovery, typography,
  editing continuity, media painted pixels and 240 theme geometry samples passed.
- Actual native HTML opened offline; actual native PDF has three pages with
  extractable Chinese/diagram labels. PDF save, repeated print/cancel and normal
  close passed. Neither HTML nor PDF changes the original Markdown file.
- Full report and immutable artifact hashes:
  `.audit/phase5-2026-10-30/acceptance.md` and `artifacts.json`.
- Host installed executable remains unchanged. No commit, push or Release.
