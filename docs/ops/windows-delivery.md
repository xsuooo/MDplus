# Windows delivery and rollback

Current version, build identifier and delivery status live in [README](../../README.md).
This is the only current operating procedure. Older stage and release runbooks
are historical evidence, not authority to publish or delete anything.

## Boundaries

- Delivery is not installation. Neither script pushes, tags or publishes.
- Run as the current Windows user, not another elevated account. The installer
  script supports upgrades of the registered per-user NSIS installation only.
- Save documents and close MDPlus yourself before an upgrade. Scripts never
  sweep/kill MDPlus or WebView2 processes; ambiguous occupancy fails closed.
- Back up the complete install directory, Roaming and Local app profiles and
  the exact rollback installer. Snapshots contain private data: keep them local.
- Only local drive paths are supported, including Chinese characters and spaces.
  Drive roots, overlapping targets, junctions and symlinks are refused.
- Failures retain diagnostics and `.partial` files/directories. A partial is
  never an approved package or complete backup. Do not rerun over it.

Prerequisites: Node/Rust/WebView2 as in README; 7-Zip on PATH (or `-SevenZip` with
its EXE path); PowerShell 7 recommended. The scripts use PowerShell 5.1-compatible
syntax; local 5.1 execution was blocked by signing policy, not bypassed. CI has
both shell checks. Do not disable security settings to run an unsigned script.

## 1. Validate and build OR reuse an already accepted package

From the repository root:

```powershell
.\scripts\windows\test-delivery.ps1
.\scripts\windows\deliver.ps1 -Build -OutputRoot "$env:USERPROFILE\Downloads\MDPlus-Delivery"
```

`-Build` checks all six version declarations (npm manifests/locks, Cargo
manifest/lock and Tauri), runs frontend checks, then builds **NSIS only** into a
new isolated target directory. `TEMP`, `TMP`, and `CARGO_TARGET_DIR` are set only
in the build process environment and restored in `finally`. Existing artifacts
are not used to hide a build failure. Rust and native acceptance remain separate
gates; successful delivery is not a claim that all acceptance passed.

To export an existing locally trusted package instead, pass `-PackagePath` and
`-ExpectedPackageSha256` from its verified acceptance manifest. Never obtain the
expected hash from an untrusted package and treat that as independent approval.
This mode does not rebuild, and its source HEAD/build label does not prove the
historical binary was built from today's tree. It records `mode = Existing`.

Both modes:

1. Create a fresh partial directory outside the repository.
2. Create destination files as bytes, flush, verify SHA256, then rename. Source
   ACLs are not copied. Inspect the new file's mandatory label using read-only
   `icacls /save`; refuse Low/Untrusted integrity. Never change workspace ACLs,
   antivirus settings or machine/user TEMP.
3. Extract `mdplus.exe` **from the exported NSIS package** with 7-Zip, verify its
   PE ProductVersion, and record payload/package SHA256 and sizes.
4. Validate an existing `current` directory. Unknown files, malformed manifests,
   bad hashes or an identical candidate stop without replacing it.
5. Journal a promotion and rename the previous `current` into a unique archive,
   then rename the completed candidate to `current`. On synchronous failure,
   restore the previous current directory. A power interruption between the two
   directory renames can leave `current` absent; both versions and the promotion
   journal remain recoverable. This is not a multi-directory atomic transaction.

Layout:

```text
MDPlus-Delivery/
  current/                  one setup EXE, manifest.json, SHA256SUMS, README.txt
  archive/<version>-<id>/    previous complete current directory, never deleted
  promotion-<id>.json        archive/candidate recovery locations
  <id>.partial/             retained only after a failed/incomplete attempt
```

Build/extract logs and results go to a new ignored `.audit/delivery-*` directory
unless `-EvidenceDirectory` specifies another new location. Existing evidence is
never overwritten. No automatic retention/deletion policy is applied to backups.
Only script-owned `current` directories can be archived automatically; the older
flat Downloads/MDPlus delivery is left untouched by this closeout.

## 2. Acceptance before installation

Run frontend/Rust gates and the applicable native checks. Record exact candidate
hash, version, build, success/failure, and **all untested or degraded items** in a
local Markdown report. Never label browser IPC mocks as native acceptance.

The checked-in browser runner uses a private session and a loopback Vite server:

```powershell
.\scripts\windows\test-browser.ps1 -Browser 'D:\Program Files\npm-global\node_modules\agent-browser\bin\agent-browser-win32-x64.exe'
# Add -Cases all for the full browser suite.
```

Replace `-Browser` with your installed native EXE path. It is not a dependency
silently installed by these scripts. Results contain the requested cases and
actual outcomes; zero/incomplete cases fail. CLI calls have a 45-second timeout;
cleanup closes only that session and stops only the runner's server process.

After reviewing the report, create a **local** JSON approval receipt containing:

```json
{
  "status": "approved",
  "packageSha256": "<64 hex digits from the verified candidate>",
  "report": "<absolute path to the local Markdown report>",
  "reportSha256": "<SHA256 of that exact report>"
}
```

This is an explicit operator decision, not a test result generated by the build.
The install script requires matching hashes and backs up both receipt and report.

## 3. Explicit installation (not executed during this closeout)

First locate the registered installation, a new normal local backup path, and
the independently verified previous installer and hash. Then invoke:

```powershell
.\scripts\windows\install.ps1 `
  -DeliveryDirectory $currentDirectory `
  -InstallDirectory $registeredInstallDirectory `
  -BackupDirectory $newBackupDirectory `
  -RollbackPackage $verifiedPreviousPackage `
  -RollbackSha256 $verifiedPreviousSha256 `
  -AcceptanceReport $localApprovalReceipt `
  -Install
```

Without `-Install`, it stops before touching any path. With it, the script checks
the registered install path, refuses active MDPlus/update/profile processes,
probes EXE file locks, hashes/copies every source file and empty directory,
rechecks the source trees (including missing roots), flushes the manifest and
atomically completes the backup directory. It never modifies an old snapshot.

Before launching NSIS it verifies normal package integrity, the unchanged source
trees, the candidate hash, and the backup rollback package. It extracts the
rollback payload and requires an exact hash match to the current installed EXE.
NSIS runs with `/S /UPDATE` and `/D` last. There is no automatic retry, forced kill
or rollback. The existing installer guard remains responsible for final native
process/handle races; the script does not claim an atomic OS-wide process lock.

After exit 0, installed hash and PE/registered versions must match the candidate,
and both profiles must be byte-identical **before first launch**. The app is not
automatically started. Results go to `install-result.json` in the new backup.
Timeout/error means stop, preserve the backup, inspect the process and results;
do not keep launching new installers or automatically restore stale profiles.

## 4. Rollback

1. Preserve current work first. Save/close MDPlus and keep a fresh backup of the
   current installation/profiles before any downgrade.
2. Select the complete previous delivery archive or verified rollback package,
   not a `.partial` file. Check it against the recorded SHA256.
3. If the package is in a low-integrity workspace, export fresh bytes to a normal
   directory and verify before running. Do not move ACL-bearing build files or
   alter security settings to make them execute.
4. Use the approved earlier installer to replace the application only. Do not
   uninstall/remove the user's settings. Manually verify version, launch and
   document/image behavior before considering rollback complete.
5. Old profile restoration is a separate, explicit recovery decision: replacing
   it can lose newer drafts, settings or images. Keep both generations; do not
   merge or overwrite profiles automatically.

For a previous archive produced by this runbook, `install.ps1` also supports an
approved downgrade: use that archive as `-DeliveryDirectory`, approve its exact
hash, and supply the **currently installed** version's installer as
`-RollbackPackage`. This preserves the ability to return to the version being
downgraded. Legacy flat-package archives without a matching manifest require the
manual procedure; do not fabricate a receipt or infer a payload hash.

The closeout does not execute a rollback or remove any previous recovery data.
For the current user's already completed phase6.2 deployment, exact private
backup/archive paths are indexed in
`.audit/global-font-update-20261031/deployment-result.json` and `package-archive.json`.
