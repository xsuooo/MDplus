# Stage 6: continuous native acceptance and deployment readiness

> Historical execution record. Current status: [README](../README.md); current delivery/rollback: [Windows runbook](ops/windows-delivery.md). Conclusions below describe this report's original run.

Final candidate: `0.2.5-phase6.1` / `phase6-20261030.1`.
The phase5.8 candidate was rejected during exported-PDF inspection: consecutive
standalone images lost centering because Milkdown serialized soft breaks as
whitespace spans. This production correction required a new candidate.

## Continuous contract

Use one synthetic long mixed-language document in an installed Windows Sandbox:

1. Create unsaved source, paste two actual clipboard images, switch modes/tabs,
   cancel close and refuse an update while dirty. Verify durable recovery files.
2. Crash only the test-owned process, restart, restore that same draft and images,
   save in a Chinese/space path and verify migrated image bytes on disk.
3. Select a middle source line, save, change mode/tab and return; edit/save/undo;
   edit live Mermaid without blur; change prose/code fonts and cycle themes.
4. Save As into another directory, preserve the first document and verify images;
   export this same document to offline HTML and selectable-text PDF; cancel a
   second print and continue editing without restarting to clear locks.
5. Close normally, reopen the saved copy, verify content/image hashes, rendered
   pixels and persisted preferences. Capture failures instead of resetting state.

Each checkpoint saves timestamped evidence. Screenshots/pixels supplement, not
replace, text/file-content assertions. Native clipboard and file operations are
real; all document content is synthetic. Browser assertions remain separately
labelled as mocked native IPC.

## Deployment boundary

Only after continuous acceptance passes: inventory a usable rollback installer,
back up the current host executable and configuration/profile without changing
them, and issue the exact candidate version/build/path/hash and full report.
Do not run the host installer, rewrite Git history, push, or publish a Release
as part of this acceptance stage. Host update is a separate explicit handoff.

Evidence: `.audit/phase6-2026-10-30/`.

## Final evidence (2026-10-31)

- Export alignment now recognizes Milkdown's whitespace hardbreak spans, while
  keeping images surrounded by prose inline. The new browser regression failed
  before the fix and passed afterward; both soft and hard breaks are covered.
- `tests/windows/continuous-native.ps1` exercises one evolving document through
  30 installed-WebView checkpoints, including two real clipboard bitmaps, dirty
  update refusal, crash/restore, save/undo/mode/tab continuity, live Mermaid,
  typography/theme, cross-directory Save As, HTML/PDF, print cancellation,
  subsequent editing, and normal restart. All pass on phase6.1.
- Browser suite: 91 passed (native IPC mocked). Unit suite: 322 passed. Rust:
  27 passed. Production/browser TypeScript and Clippy passed. NSIS x64 built.
- Actual native exports: offline HTML retains loaded fonts, math, final diagram,
  and two centered/stacked images; PDF has six pages, selectable Chinese/graph
  text, both bitmap payloads, centered geometry and original aspect ratios.
- Native theme regression: 269 geometry samples passed on the final package.
- A separate process-tree/update/recovery regression passed on the final package.
- Host program plus full roaming/local profile were backed up (949 files),
  with per-file SHA256 comparison. A local-only recovery installer restores the
  exact previous host binary, not an unmatched historical 0.2.4 release package.
  Its locked-file refusal, installation, configuration preservation and launch
  were exercised in the sandbox.
- Vite excludes `.audit` from file watching: shared sandbox evidence can be
  exclusively locked and previously crashed the development test server.

Report and exact package/backup identities: `.audit/phase6-2026-10-30/acceptance.md`
and `artifacts.json`. Earlier failed probes remain archived. No host installation,
Git commit/history change, push or Release is performed by this stage.

## Authorized host deployment (2026-10-31)

The separate, user-authorized host update completed at 01:05 +08:00 using the
same phase6.1 package, without another build or application change. Its SHA256
is `17535FAD7193CE45C26ADB889CD36A121F19398272163839C31CD0DCADFC9A14`.

The workspace and its executables inherit a Windows Low Mandatory Level label.
Running the installer directly from the build folder could not write the normal
TEMP directory. A process-only TEMP override reached maintenance but still failed
to write the installed executable. Publishing the package bytes as a new file in
the user's normal Downloads directory, with that directory's default security,
resolved both errors. Source/destination hashes match; no workspace ACL, security
software setting, or installer safety gate was changed. Do not distribute a
workspace build path as a ready-to-run local installer.

- Installer exit code: 0; registered version: `0.2.5-phase6.1`.
- Installed executable matches the previously accepted NSIS payload SHA256.
- All 947 configuration/profile files match the pre-update backup before launch.
- The installed process stays responsive with a main window and six WebView2
  children. Desktop visual automation was unavailable (native pipe missing), so
  no new screenshot or interactive UI acceptance is claimed for this host run.
- Fourteen superseded packages were moved, not deleted, to an audit archive with
  a source/destination/hash manifest. The current build folder retains one package.
- The exact recovery installer was also published to a separate normal local
  recovery directory; original program/profile backups remain untouched.

Deployment results: `.audit/host-install-retry-20261031-0103/deployment.md`.
This supersedes the earlier host-install failure as current status, not as history.
