# Stage 1: durable recovery and safe installer updates

> Historical execution record. Current status: [README](../README.md); current delivery/rollback: [Windows runbook](ops/windows-delivery.md). Conclusions below describe this report's original run.

Candidate version: `0.2.5-phase1.1`\
Build identity: `phase1-20261030.1`

## Frozen scope

1. Protect unsaved Markdown and pasted images with local recovery snapshots.
2. Diagnose installer write failures, request graceful shutdown of the exact
   installed process and wait for its WebView2 descendants.
3. Preserve all earlier editor fixes. No host installation until the complete
   plan passes native end-to-end acceptance and rollback artifacts are ready.

## Storage contract

- Recovery lives under the application's local data directory, `recovery-v1`.
  It contains plaintext document/image data; it is not encrypted or uploaded.
- Image bytes are flushed to a temporary file and atomically renamed before
  any snapshot can reference them. Manifest updates also use write-then-rename.
- A per-document queue orders image writes, snapshot writes and deletion.
- Typing is checkpointed after one second of inactivity. Status distinguishes
  recovery protection from saving the actual Markdown file.
- Recovery opens a new unsaved copy, never silently overwrites an original path.
- Successful saves and explicit discards remove the recovery copy. Failed writes
  leave the last complete manifest intact. Expired inactive cache directories
  are cleaned after seven days; reparse points are not traversed.

## Installer contract

- Do not kill processes based only on `mdplus.exe` or `msedgewebview2.exe` names.
- Identify the exact installation executable, retain process handles, request
  normal window close, and wait for captured WebView2 descendants.
- Cancel/timeout/access denial means installation aborts, not forced termination.
- Check that the target can be opened exclusively before copying. After copying,
  compare installed executable bytes with the packaged binary; a skipped file
  cannot be reported as a successful installation.
- Do not uninstall/recreate user configuration during a same-version update.

## Required evidence

Unit tests, real filesystem tests under Chinese/space paths, React/Milkdown
recovery flows, and isolated Windows installation/process-lock probes are kept
separate. The historical NSIS write error is not attributed to a process lock
without a reproduced lock or matching native diagnostic.

This is a stage candidate, not final release approval. Subsequent stages cover
editing continuity, typography, image/chart interaction, export and the full
continuous acceptance flow.

## Stage evidence (2026-10-30)

- TypeScript and 308 unit tests passed; Rust's 27 tests and Clippy passed.
- 46 browser regressions passed, including recovery and edits during shutdown.
- In an isolated Windows 11 x64 Sandbox, real NSIS upgrade, external-lock refusal,
  graceful main/WebView2 exit, unsaved-update refusal, actual clipboard image
  recovery after process termination, and explicit-discard cleanup passed.
- Local evidence and the complete Chinese report:
  `.audit/phase1-2026-10-30/acceptance.md`.
- The host installation was not changed. The historical host write error has not
  been uniquely reproduced; MSI/cross-installer migration and final acceptance
  remain outside this stage. The custom NSIS template is based on Tauri CLI
  v2.11.4 under the adjacent MIT license; retain its in-place update behavior
  when upgrading the bundler.
