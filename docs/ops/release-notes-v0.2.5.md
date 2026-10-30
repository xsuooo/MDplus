# MDPlus v0.2.5

Release date: 2026-10-31 (Asia/Shanghai).
Branch: `release`. Tag: `v0.2.5`. Build: `release-20261031.1`.

## Changes

- Durable recovery snapshots for drafts and pasted images, using write-then-rename
  and explicit failures instead of silently losing content.
- Preserve source images during save/Save As and keep references, undo history,
  selections and reading positions aligned across editing modes and tabs.
- Independent global body/UI and source/code fonts. Menus, dialogs and buttons
  follow body/UI; shortcut key labels follow code. All fonts are bundled for
  offline use with their licenses; Windows system dialogs keep system fonts.
- Center standalone images, separate selection from media viewing, and stabilize
  Mermaid preview geometry during theme changes while preserving live drafts.
- Smoother theme transitions and reduced-motion support; frozen, self-contained
  light HTML/PDF exports do not alter the editor theme.
- Guarded NSIS upgrades with process/file-lock checks and payload verification;
  atomic backup and independently verified delivery tooling.

This promotes the accepted phase6.2 implementation. Only release version/build
metadata and release documentation change; the withdrawn v0.2.4 tag is not reused.

## Assets and installation

- `MDPlus_0.2.5_x64-setup.exe`: Windows x64 NSIS installer.
- `MDPlus_0.2.5_x64-setup.exe.sha256`: SHA256 for the exact uploaded installer.
- `MDPlus_0.2.5_build-manifest.json`: public, path-free source/payload provenance.

Download to a normal local directory and verify the hash before executing. Save
documents and close MDPlus before upgrading. Existing NSIS settings are retained;
the installer refuses direct migration from an MSI installation. No MSI or ARM64
package is offered. WebView2 is required.

The package is unsigned: the project has no configured code-signing certificate.
Respect organizational/Windows security policy; do not disable security controls
to install it. The larger package includes full offline Chinese font resources.

## Release verification

Re-run against `0.2.5 / release-20261031.1` on 2026-10-31:

| Gate | Result |
| --- | --- |
| npm/Cargo/Tauri version consistency | All six values match |
| Windows delivery script tests (PowerShell 7) | 18/18 passed |
| Application TypeScript and unit tests | 322/322 passed, 26 files |
| Browser fixture TypeScript | Passed |
| Browser regression | 94/94 passed; native IPC mocked |
| Rust formatting, tests and Clippy with warnings denied | Passed; 27/27 tests |
| npm dependency audit | 0 reported vulnerabilities |
| Fresh optimized Windows x64 NSIS build | Passed; actual packaged executable is 0.2.5 |
| Native sandbox install/upgrade checks | 10/10 passed |
| Native sandbox rollback/re-upgrade checks | 13/13 passed |

The native checks use Windows 11 Sandbox (build 26100) and Chinese/space-containing
installation and temporary paths. They cover v0.2.3 to v0.2.5 upgrade, exclusive
file-lock refusal without changing the old executable/settings, exact installed
payload hashes, registered versions, and v0.2.5 to v0.2.3 to v0.2.5 rollback.
Settings and a synthetic profile marker survive both directions; this is not a
claim that an older version understands newer recovery data or WebView profiles.

Package size: 49,371,440 bytes. Installer SHA256:

```text
A239F1C9D01463D37DEEA7D846DDCE50D518251C6C138BB3E6DF202CCD795F1E
```

The build is produced before the final documentation commit. Its 105 tracked
build inputs are hashed and checked unchanged against that commit; the public
manifest distinguishes the build base from the final source commit. Publication
is also gated on the exact release commit's Linux frontend and Windows Rust/
PowerShell CI jobs, and downloaded Release assets must match the local hashes.
See [CI runs](https://github.com/xsuooo/MDplus/actions/workflows/ci.yml?query=branch%3Arelease)
and the attached public build manifest for final source/artifact identities.

## Known boundaries

- Browser regression uses real React/Milkdown/CSS/fonts but mocks native IPC.
- Previous phase6.2 host upgrade and phase6.1 continuous native document/process
  tests remain historical evidence. The new sandbox checks do not re-run live
  WebView2 shutdown, unsaved-document dialogs or continuous native editing.
- Native font-dialog interaction, true restart persistence and Windows 10,
  ARM64, MSI migration and all input-method combinations are not assumed tested.
- Exported standalone files can be large because fonts and media are embedded.
- This release does not automatically replace the developer's installed phase6.2
  application or overwrite its profiles, drafts or recovery snapshots.

## Rollback

Keep a fresh backup of current documents, installation and both application
profiles before a downgrade. Use a previously verified NSIS package; do not
automatically replace newer profiles with an old snapshot, which can lose drafts.
The last public stable version is [v0.2.3](https://github.com/xsuooo/MDplus/releases/tag/v0.2.3).
That version does not provide the new recovery/typography behavior; it cannot be
assumed to understand newer recovery data. Preserve those directories separately.

Maintainer rollback is non-forceful: withdraw only this run's failed Release/tag
after verifying ownership/hash; keep v0.2.3 intact, retain the pre-release Git bundle
and return the local workspace to its original `agent/bootstrap` baseline. Never
rewrite a branch that acquired someone else's commits. See the local release audit
for recorded ref hashes and exact guarded commands.

Full changes: [v0.2.3...v0.2.5](https://github.com/xsuooo/MDplus/compare/v0.2.3...v0.2.5).
Current operating procedure: [Windows delivery and rollback](https://github.com/xsuooo/MDplus/blob/v0.2.5/docs/ops/windows-delivery.md).
