# Stable baseline closeout

Date: 2026-10-31 (Asia/Shanghai).
Current state: [README](../README.md).
Operating procedure: [Windows delivery and rollback](ops/windows-delivery.md).

## Frozen scope

Preserve stages 1-6 and the global-font correction as one current source baseline.
Do not recreate historical phase commits, amend/rewrite history, push, tag or
publish a Release. Only delivery tooling, documentation and their checks change
during this closeout. No runtime edit, version bump or host reinstall is required.
The installed version remains `0.2.5-phase6.2` / `global-font-20261031.1`.
The accepted runtime/test/font baseline is saved locally as commit `eb0e2fe`
(`fix: complete content-safe editor and global typography`).

The user reports no current issue. This is useful experience feedback, not proof
that every native acceptance checkpoint was executed.

## Current validation

| Check | Evidence and boundary |
| --- | --- |
| Frontend TypeScript + unit tests | 26 files, 322 tests passed in this closeout |
| Frontend production build + browser TypeScript | Both passed; no new native application package built |
| Complete browser regression | 94 cases passed, including all 9 typography cases; real CSS/fonts, mocked native IPC; persistence case remounts React, not Windows |
| Rust formatting, tests and Clippy | Formatting and Clippy passed; 27 tests passed with process-local writable TEMP/TMP |
| Delivery-script regression | 18 checks passed on PowerShell 7: versions, atomic copy/backup, Chinese/space paths, locks, hash rejection, junction rejection, archive preservation and explicit-install refusal |
| Real package export | Existing accepted package exported as fresh bytes outside the workspace; actual NSIS payload re-extracted; package, payload and PE version matched |
| Mandatory integrity | Normal exported package accepted; actual low-integrity workspace file rejected; no ACL/security settings changed |
| Native automation availability | Initialize and fresh-session retry both failed: native pipe not found, Windows error 2 |

Initial Rust execution against normal TEMP failed 15 filesystem tests with
PermissionDenied because the workspace-built test EXE inherits Low integrity.
The successful rerun used an ignored workspace-local temporary directory, only
for that child process. No production code was changed to make the tests pass.

The first synthetic script run exposed PowerShell's inability to deserialize
npm's empty root-package JSON key; this was fixed in the in-memory parser.
Local Windows PowerShell 5.1 execution was refused by signing policy. No policy
was changed; PowerShell 7 is the locally verified runner and both shells are
included in CI (remote CI has not run because this work is not pushed).

The first browser-runner attempt inherited a daemon-held output pipe and was
interrupted; its private browser/server were closed. The runner now uses bounded
CLI process handles with separate output files. Only complete `results.json`
outcomes count, not an opened page or runner startup message.

Local raw evidence is under `.audit/stable-closeout-20261031/`. It is ignored and
not committed: it may contain usernames, full paths, ACLs and host-specific logs.
Synthetic package-export copies live in a clearly named `NOT-FOR-INSTALL-*`
verification directory, outside the current user delivery directory.

Final evidence entries: `check.log`, `frontend-build.log`,
`browser-typecheck.log`, `browser-all-3/results.json`,
`rust-tests-local-temp.log`, `clippy.log`, `script-tests-final-2/results.json`,
`real-package-export/result.json` and `baseline-verification.json`.
The baseline check confirms all initial runtime/test/font source bytes stayed
unchanged throughout this closeout (only historical documentation gained links).
Staged whitespace checks additionally found four trailing spaces in upstream OFL
notice text. Only those spaces were removed; license wording and all font binary
bytes remain unchanged. The final staged whitespace check passes.

The installed EXE and normal Downloads package were rehashed without launching
or modifying them. They still match the accepted phase6.2 artifacts:

```text
package SHA256: 2145B4BEA9D91F145C9FF0E117A1C7CAC8C80CA9DCE6BFEFDFFE09734A534A86
payload SHA256: 7C1266EC31BD8927524E30031E99ED4DF035416A6FFF4B51024200EE8B6C4F53
```

## Historical evidence retained, not rerun or relabeled

- Phase6.2: 322 unit tests, 94 browser cases (mocked native IPC), 27 Rust tests;
  successful NSIS build, actual packaged EXE extraction; sandbox upgrade with 10
  checks, rollback/re-upgrade with 13 checks.
- Phase6.2 host: installer exit 0, exact installed payload/version, 957 backed-up
  files and 955 unchanged configuration/profile files before first launch.
- Phase6.1: continuous native same-document workflow with 30 checkpoints,
  269 theme geometry samples and native HTML/PDF inspection. These remain
  phase6.1 evidence, not new phase6.2 native results.

See [stage 6](phase6-execution.md), [global font update](global-font-update.md)
and their local evidence indexes. Historical reports retain their original
conclusions, including their then-current uncommitted/unpublished status.

## Remaining limitations and shortest manual font check

No new host installation or rollback was executed to test the new wrapper.
`-Build` orchestration was not used to create another runtime package in this
closeout; the existing accepted NSIS package was used for real export/extraction.
The new scripts therefore have synthetic filesystem/process-refusal evidence
and real export evidence, not a newly claimed end-to-end native install run.

The native pipe is unavailable. True installed-app font-dialog interaction,
selection continuity and restart persistence are **not automatically verified**
in this closeout. This is a disclosed, non-blocking baseline-closeout limitation,
not permission to claim native acceptance or publish a new release.

Manual check in the already installed app (use only a disposable document):

1. Create/save mixed Chinese/English prose plus a fenced code block. Record its
   SHA256 with `Get-FileHash -LiteralPath $testDocument`.
2. Note the original two typography selections. Change only the body/UI font to
   WenKai: menus, dialogs, buttons and prose should change; code should not.
3. Change only the source/code font to Cascadia/MiSans: source, fenced code and
   shortcut key labels should change; ordinary UI/prose should not.
4. Save, close normally and reopen the app/document. Both choices should remain
   independent. Confirm the document SHA256 is unchanged. Restore the original
   font choices when done; do not use a real unsaved working document for this.

Windows native file/print dialogs intentionally retain the system font.

## Delivery and rollback status

The accepted package in Downloads/MDPlus and installed EXE are left in place.
No old installer, rollback data, draft or profile is deleted. Future deliveries
use a single `current` directory and separate `archive`; the explicit install
script requires approval for the exact package, a new complete backup, idle/lock
checks, exact rollback payload matching, and post-install verification.

Only source, tests, bundled font assets/licenses, reusable tooling and sanitized
documentation belong in the local baseline commits. Build outputs, recovery
snapshots, private receipts/profiles and local logs do not.

## Self-check

| Axis | Score | Evidence / next improvement |
| --- | --- | --- |
| Accuracy | 4/5 | Executed tests and binary hashes are recorded; true native font/restart verification remains manual |
| Completeness | 4/5 | Frozen tooling, source baseline and docs are covered; new install wrapper is not falsely counted as host-tested |
| Clarity | 4/5 | README has one current entry; historical stage reports necessarily retain older outcomes |
| Actionability | 4/5 | Reusable commands, stop conditions and four manual checks are provided; unsigned 5.1 execution still depends on local policy |
| Conciseness | 4/5 | Detailed evidence is separated from README; the safety runbook is longer than a simple build guide |

Overall: 4.0/5. Next opportunities are native font/restart verification when the
desktop helper works, and an isolated execution of the new install wrapper at
the next explicitly approved update. Neither justifies changing this user's
currently accepted installation now. This assessment favors truthful boundaries
over marking every item green merely because the user reports normal operation.
