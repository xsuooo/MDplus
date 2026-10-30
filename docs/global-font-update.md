# Global font host update

> Historical execution record. Current status: [README](../README.md); current delivery/rollback: [Windows runbook](ops/windows-delivery.md). Conclusions below describe this report's original run.

Version: `0.2.5-phase6.2`
Build: `global-font-20261031.1`
Installed: 2026-10-31 01:48, Asia/Shanghai.

The UI/body and code font roles now apply across the application. Ordinary UI
text follows the selected body font; shortcut key labels follow the selected
code font. Preferences remain independent. Windows file/print dialogs keep the
system font. The preceding phase6.1 package did not include this correction.

## Verified for this candidate

- TypeScript checks, 322 unit tests, 94 browser cases, 27 Rust tests and Clippy.
- NSIS x64 build and extraction of the actual packaged executable.
- Sandbox upgrade from phase6.1, refusal while the old executable is exclusively
  locked, installed payload comparison, settings preservation, rollback to
  phase6.1, and re-upgrade to phase6.2.
- New host backup: 957 files, including the previous program/uninstaller, settings
  and complete WebView profile, with hashes checked before atomic completion.
- Host installer exit 0 and exact payload/version match. Before launch, all 955
  configuration/profile files remained unchanged.
- Installed application has a responsive main window and its WebView2 processes.

## Delivery and limitations

The current package lives in the normal user Downloads/MDPlus directory rather
than being launched from the low-integrity workspace. Older packages are kept in
the separate recovery/audit directories. No security setting or workspace ACL is
changed; no new runtime dependency is introduced.

The desktop automation native pipe is unavailable. This run therefore does not
claim native font-dialog screenshots, interactive WebView2 font verification, or
a rerun of the earlier full native document/export/theme workflow. Browser checks
exercise real CSS and font loading but simulate the native IPC boundary.

Complete report, manifests, logs, rollback paths and per-file hashes:
`.audit/global-font-update-20261031/acceptance.md` and `deployment-result.json`.
No commit, push, history rewrite or Release publication is performed.
