# MDPlus performance loop: audit item ③

Scope: measure and address periodic document revision checks only. Items ①, ②,
and ④ require a later user confirmation. Existing worktree changes and real user
documents are outside the rollback scope.

## Fixed measurement protocol

- Git HEAD: `8b9d98429ccf76f486d873b37cac8d79ea472202`. Reports also hash production
  inputs, benchmark inputs, fixtures, compiler versions, and the release profile.
- Fixtures: 1200 table data rows, 5000 physical text lines, and 20 distinct generated
  PNG images with relative Markdown references. The generator is deterministic.
- Native: actual file I/O and actual Tauri command dispatch in a MockRuntime,
  release profile, three repetitions, five warmups and 30 measured calls per group.
- Frontend: Vitest bench with three processes, ten warmups and 50 measured calls
  per group. Edits and fixture preparation are outside the timed regions.
- Browser: existing agent-browser HeadlessChrome, Vite dev server, native IPC mocked, 1200 × 800
  viewport, fixed fonts, one warmup and three measured runs per fixture. Each run
  uses 20 trusted CDP keyboard input events and measures the next animation frame.
- Quantiles: nearest rank across all measured calls, with each repetition retained.
  No best-run selection. Retained heap uses CDP after an explicit garbage collection.
- Acceptance is fixed before the baseline: all three native IPC dispatch p50/p95
  values must improve at least 10%; no reported regression metric p50/p95 may worsen
  more than 5%. A zero baseline changing to nonzero is a regression.

The Rust test runtime replaces window transport, not command execution or file
I/O. It measures synchronous dispatch occupancy, not real WebView2 frame latency.
The browser fixture measures real editor input and layout but does not exercise
native file polling. Native total response latency remains a regression metric.

## Setup

- Added only measurement code, a test-only Tauri feature, and an npm entry point.
  The production `document_revision` command remains synchronous for the baseline.
- Rust release test compilation passed. Frontend setup smoke passed all nine
  benchmark correctness checks; smoke timings are not baseline evidence.
- Vitest 4.1.12 omits raw samples from its built-in JSON output. A small reporter
  preserves its actual in-memory samples without replacing benchmark execution.
- Rollbacks restore this task's pre-change bytes or reverse its exact patch.
  They must not run `git checkout` on a file containing earlier worktree changes.
- The first native launch failed before test execution with Windows
  `STATUS_ENTRYPOINT_NOT_FOUND` (`0xc0000139`). The test executable imported
  `TaskDialogIndirect` but had no Common Controls v6 manifest. Embedding the
  manifest in the generated test binary made `--list` pass. The runner now supplies
  the equivalent test-only linker flags through `CARGO_ENCODED_RUSTFLAGS`; baseline
  and candidates use the same flags. No production build script changed, and the
  failed launch is not measurement evidence.
- Native setup then passed, but libtest printed the metric marker after its test
  name on the same line. The aggregator initially rejected that standard prefix.
  The parser now accepts it, with an assert-based check. This incomplete setup run
  did not produce a baseline; its raw log remains in `.runs/`.
- Ego browser setup completed 20 trusted keyboard inputs, but its page evaluation
  timed out during the scrolling phase. `Browser.getVersion` was also unavailable
  on its task CDP connection. Native window activation did not provide reliable
  geometry, so unattended measurement uses the project's existing `agent-browser`
  HeadlessChrome approach instead. No Playwright dependency was added. None of the
  incomplete Ego runs count as a baseline. A fresh isolated browser session and
  explicit viewport keep later measurements independent of desktop visibility.
- The runner limits Vite's dependency scan to the performance entry page. This
  avoids scanning old audit and native build HTML during test startup. Production
  Vite configuration is unchanged.

## Baseline and candidate 1

- The first complete `npm run perf` produced `report.baseline.json` and
  `report.json`. All three repetitions and browser correctness assertions passed.
  Measurement inputs are now frozen at SHA-256
  `c8cb6e6ff6a8afb1a68252110f4298668f92cd84c26764d29390f5e97c071e9f`.
- Root cause: `useExternalChanges()` at `src/hooks/useExternalChanges.ts:205`
  calls `documentRevision()` every 2000ms for eligible saved tabs. The generated
  synchronous Tauri handler executes `document_revision()` at
  `src-tauri/src/safe_files.rs:331`, then `revision_with_limit()`,
  `optional_snapshot()`, and `raw_snapshot()`. It reads and hashes all document
  bytes before releasing its calling thread.
- Candidate 1 marks only `document_revision` as `#[tauri::command(async)]`.
  It shares the existing write mutex so new background read handles cannot cause
  this process's Windows replacement operations to fail with sharing errors.
  Request/response fields, full-byte revisions, poll interval and all path/size
  checks remain unchanged. Total I/O is not reduced by this candidate.
- The IPC contract parser accepts the supported async annotation. A deterministic
  channel-based test pauses a real revision read, verifies the write lock is held,
  then verifies the queued save and both revisions. No sleep-based race assertion.
- Before-change bytes and hashes are saved under `.rollback/before-item-3/`.
  Candidate acceptance is pending the unchanged `npm run perf` gate.

### Candidate 1 result: rejected and rolled back

- Run `2026-11-08T02-59-06-879Z`, full data in `report.candidate-a.json`, exact
  attempted patch in `candidate-a.patch`.
- Native IPC dispatch p50/p95 improved: table 99.05%/98.82%, long document
  99.61%/99.37%, image document 97.28%/96.53%.
- It failed the unchanged regression gate. Long-document IPC response p95 rose
  from 2.6394 to 2.8645 ms (+8.53%). Image-document response p50/p95 rose from
  0.2007/0.2537 to 0.2255/0.3739 ms (+12.36%/+47.38%). Five additional regression
  metrics are listed in that report, including browser input p95.
- Async dispatch removes caller occupancy but adds scheduling and does not reduce
  full-read/hash work. Unchanged browser code also varied; these measurements do
  not prove native scheduling caused those browser changes. They still fail the
  requested gate and are not discarded as noise.
- Restored exact before-candidate bytes for `safe_files.rs` and
  `ipcContract.test.ts`, including removal of the candidate-specific test.
  Earlier user changes remain intact. No HEAD checkout was used.

## Candidate 2: preserve synchronous dispatch, reduce bounded-read overhead

- Root evidence: `raw_snapshot()` wraps `&mut File` in `take(limit + 1)` before
  `read_to_end`. Rust 1.99.1's `Take<T>` inherits the default reader, bypassing
  `File::read_to_end`'s size-based reservation. Starting from an empty Vec triggers
  a 32-byte probe and subsequent buffer growth. This is verified in local rustdoc
  sources, not inferred from a fabricated syscall trace.
- Added a fallible `try_reserve_exact(metadata.len())` before the bounded read.
  The existing metadata size guard, read limit, post-read metadata check, Windows
  handle restrictions and full SHA-256 calculation all remain. Allocation failure
  remains a returned I/O error; no infallible large allocation was introduced.
- This changes one shared reader so periodic revisions and document opening use
  the same fix. No async scheduling, timers or caches remain from candidate 1.
- Performance acceptance remains pending the frozen `npm run perf` gate.

### Candidate 2 result: rejected and rolled back

- Run `2026-11-08T03-03-07-700Z`, full data in `report.candidate-b.json`, patch in
  `candidate-b.patch`.
- All three dispatch p50/p95 passed the improvement gate: table
  0.5151/0.7214 to 0.3092/0.3628 ms; long document 2.4793/2.6440 to
  2.0594/2.1690 ms; image document 0.2019/0.2562 to 0.1431/0.2042 ms.
- The full gate still rejected it. The direct image-document revision p95 rose
  18.34%; twelve frontend/browser regression metrics also exceeded 5%. Their
  complete before/after quantiles are retained in the report, not omitted because
  this Rust-only change cannot affect their mocked code path.
- Restored exact `safe_files.rs` pre-candidate bytes. Neither preallocation nor
  the earlier async change was retained at this stage.

## Candidate 3: reduce read overhead and move revision dispatch off the host

- Combines the validated fallible reservation from candidate 2 with candidate 1's
  async command annotation and existing write mutex. Candidate 2 showed actual
  single-call savings, providing a reason to test whether they offset the async
  response overhead observed in candidate 1.
- Restored the same IPC contract and deterministic read/write regression test.
  No measurement code, sample count, threshold, fixture or cache changed.
- This is the last distinct minimal candidate for this pass. Repeatedly running
  the same candidate until unrelated frontend noise happens to pass would select
  a lucky result. If the unchanged gate rejects this candidate, it will be rolled
  back and the remaining uncertainty reported rather than weakening the gate.

### Candidate 3 result: rejected and rolled back

- Run `2026-11-08T03-06-54-206Z`, full data in `report.candidate-c.json` and
  `report.json`, exact attempted patch in `candidate-c.patch`.
- Native IPC dispatch p50/p95 improved for all three fixtures: table
  0.5151/0.7214 to 0.0048/0.0079 ms; long document 2.4793/2.6440 to
  0.0087/0.0133 ms; image document 0.2019/0.2562 to 0.0041/0.0075 ms.
- These are synchronous command-dispatch occupancy measurements, not a 99%
  reduction in total work. Direct long-document `document_revision` p50/p95 was
  2.4791/2.7836 before and 2.3075/2.8088 ms after: its p95 did not improve.
  Full IPC response p50/p95 was 2.4734/2.6394 before and 2.1664/2.4848 ms after.
- Exactly three reported metrics failed the unchanged regression gate:
  `rust/read_document/images-20` p95 0.1923 to 0.2221 ms (+15.50%);
  `frontend/computeStats/images-20` p95 0.0156 to 0.0173 ms (+10.90%);
  `browser/inputToFrameMs/images-20` p50 4.0 to 4.3 ms (+7.50%). All three
  repetitions and all 48 metrics remain in the reports, including the unchanged
  frontend path's variation. No threshold or noise allowance was added.
- Restored `safe_files.rs` and `ipcContract.test.ts` from the verified
  `.rollback/before-item-3/manifest.json` backups. All production input bytes now
  hash to the baseline SHA-256
  `040ddbdf12c56a314ee554c58e1ed3be76b38b013a4a311513ec8355c27dbb7d`.
  `safe_files_tests.rs` also still matches its saved hash. No existing worktree
  changes were removed, and no HEAD checkout was used.

## Final state of this pass

- All three optimization candidates were rejected and rolled back. Only the
  measurement fixtures, scripts, reports, documentation and test wiring remain.
  `report.json.current` intentionally records the rejected candidate 3, not an
  unperformed benchmark after rollback. `comparison.md` shows all 48 before/after
  metric rows. The rollback was verified by byte hashes, not by invented timings.
  An independent read-only check recomputed all quantiles, per-repetition
  quantiles, percentages and gates across the baseline and three candidate
  reports: each contains 48 metrics, three repetitions and 3150 raw samples.
- The measurement entry point remains `npm run perf`. Baseline, fixture,
  environment and measurement hashes are fixed; candidate source hashes differ
  and are recorded. No commits, new npm dependencies, poll-interval changes,
  measurement-only production caches or user-document edits were made.
- After rollback, browser TypeScript checks, scoped ESLint, scoped Prettier and
  `cargo fmt --check` passed. The IPC/file/save Vitest group passed all 68 tests.
  The release `safe_files_tests::` group passed 31 tests; its two existing
  symlink-privilege tests remained explicitly ignored. Test temporary files were
  confined to `tests/perf/.runs/correctness-after-rollback`.
- Unmeasured: real WebView2 frame latency during native polling, hardware IME,
  cold disk cache, multiple-tab polling saturation, and maximum-size documents.
  The browser runs a real Milkdown editor with mocked native IPC; it does not
  reproduce the whole native application's background effects. Native IPC uses
  the real generated command handler with MockRuntime transport. These limits
  prevent claiming that this pass fixed the reported desktop lag.
  Browser open time, DOM size and retained heap have only three samples per
  fixture; their nearest-rank p95 is the largest of those three samples. A gate
  regression is not proof that the candidate caused a small timing difference.
- Stop before item ①, as requested. Continuing that item requires the user's
  confirmation of these results, not another unrecorded candidate-3 retry.
