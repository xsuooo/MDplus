# Item 3: complete baseline and candidate C comparison

Candidate C was rejected and rolled back. No production optimization remains. These are measured candidate results, not timings for the restored source.

- Commit: `8b9d98429ccf76f486d873b37cac8d79ea472202`.
- Baseline source SHA-256: `040ddbdf12c56a314ee554c58e1ed3be76b38b013a4a311513ec8355c27dbb7d`.
- Candidate C source SHA-256: `2a0d92485f6af969ec3fa3c322a27c9f7c93d2b52edfd2ab11d2903c947be5fc`.
- Candidate C run: `2026-11-08T03-06-54-206Z`.
- Measurement SHA-256: `c8cb6e6ff6a8afb1a68252110f4298668f92cd84c26764d29390f5e97c071e9f`.

All runs use the same machine, release settings, compiler versions, fixtures and measurement code. Samples are pooled across three repetitions using nearest-rank p50/p95. A negative percentage means a lower value. The fixed gate rejects any metric whose p50 or p95 increases by more than 5%, including metrics outside the changed code path.

Artifacts: [baseline](report.baseline.json), [current comparison](report.json), [candidate C](report.candidate-c.json), [candidate C patch, already reverted](candidate-c.patch), [decision log](perf-log.md).

## Candidate decisions

| Candidate                    | Change                                   | Dispatch improvement gate | Regression metrics | Decision                             |
| ---------------------------- | ---------------------------------------- | ------------------------- | -----------------: | ------------------------------------ |
| [A](report.candidate-a.json) | Async command with existing write mutex  | Pass                      |                  7 | Rejected; exact saved bytes restored |
| [B](report.candidate-b.json) | Fallible bounded-read buffer reservation | Pass                      |                 13 | Rejected; exact saved bytes restored |
| [C](report.candidate-c.json) | Combine async dispatch and reservation   | Pass                      |                  3 | Rejected; exact saved bytes restored |

## Native release metrics

| Metric                              | Unit | Baseline p50 / p95 | Candidate C p50 / p95 |  Change p50 / p95 | Gate           |
| ----------------------------------- | ---- | -----------------: | --------------------: | ----------------: | -------------- |
| `rust/read_document/table-1200`     | ms   |    0.5499 / 0.7418 |       0.3546 / 0.3791 | -35.52% / -48.89% | Pass           |
| `rust/raw_snapshot/table-1200`      | ms   |    0.2713 / 0.3708 |       0.1756 / 0.2163 | -35.27% / -41.67% | Pass           |
| `rust/document_revision/table-1200` | ms   |    0.5058 / 0.7751 |       0.3114 / 0.3556 | -38.43% / -54.12% | Pass           |
| `rust/ipc_dispatch/table-1200`      | ms   |    0.5151 / 0.7214 |       0.0048 / 0.0079 | -99.07% / -98.90% | Pass           |
| `rust/ipc_response/table-1200`      | ms   |    0.5124 / 0.7161 |       0.3327 / 0.4257 | -35.07% / -40.55% | Pass           |
| `rust/read_document/long-5000`      | ms   |    3.3130 / 4.3932 |       2.6213 / 2.8866 | -20.88% / -34.29% | Pass           |
| `rust/raw_snapshot/long-5000`       | ms   |    2.3150 / 2.6210 |       1.9087 / 2.1774 | -17.55% / -16.92% | Pass           |
| `rust/document_revision/long-5000`  | ms   |    2.4791 / 2.7836 |       2.3075 / 2.8088 |   -6.92% / +0.91% | Pass           |
| `rust/ipc_dispatch/long-5000`       | ms   |    2.4793 / 2.6440 |       0.0087 / 0.0133 | -99.65% / -99.50% | Pass           |
| `rust/ipc_response/long-5000`       | ms   |    2.4734 / 2.6394 |       2.1664 / 2.4848 |  -12.41% / -5.86% | Pass           |
| `rust/read_document/images-20`      | ms   |    0.1725 / 0.1923 |       0.1477 / 0.2221 | -14.38% / +15.50% | Regression >5% |
| `rust/raw_snapshot/images-20`       | ms   |    0.0619 / 0.0715 |       0.0379 / 0.0409 | -38.77% / -42.80% | Pass           |
| `rust/document_revision/images-20`  | ms   |    0.1918 / 0.2181 |       0.1537 / 0.1867 | -19.86% / -14.40% | Pass           |
| `rust/ipc_dispatch/images-20`       | ms   |    0.2019 / 0.2562 |       0.0041 / 0.0075 | -97.97% / -97.07% | Pass           |
| `rust/ipc_response/images-20`       | ms   |    0.2007 / 0.2537 |       0.1733 / 0.2471 |  -13.65% / -2.60% | Pass           |

## Frontend Vitest metrics

| Metric                                    | Unit | Baseline p50 / p95 | Candidate C p50 / p95 |  Change p50 / p95 | Gate           |
| ----------------------------------------- | ---- | -----------------: | --------------------: | ----------------: | -------------- |
| `frontend/serializerCtx/table-1200`       | ms   |  11.9496 / 18.6657 |     11.4506 / 12.0479 |  -4.18% / -35.45% | Pass           |
| `frontend/computeStats/table-1200`        | ms   |    0.3243 / 0.7828 |       0.3195 / 0.4112 |  -1.48% / -47.47% | Pass           |
| `frontend/collectUnusedImages/table-1200` | ms   |    0.0915 / 0.1425 |       0.0839 / 0.1017 |  -8.31% / -28.63% | Pass           |
| `frontend/serializerCtx/long-5000`        | ms   |  21.1887 / 25.1420 |     20.9400 / 21.9713 |  -1.17% / -12.61% | Pass           |
| `frontend/computeStats/long-5000`         | ms   |    4.8344 / 5.4670 |       4.6888 / 4.8988 |  -3.01% / -10.39% | Pass           |
| `frontend/collectUnusedImages/long-5000`  | ms   |    2.4281 / 3.7397 |       2.0318 / 2.3625 | -16.32% / -36.83% | Pass           |
| `frontend/serializerCtx/images-20`        | ms   |    0.7780 / 1.3657 |       0.7016 / 0.9475 |  -9.82% / -30.62% | Pass           |
| `frontend/computeStats/images-20`         | ms   |    0.0124 / 0.0156 |       0.0129 / 0.0173 |  +4.03% / +10.90% | Regression >5% |
| `frontend/collectUnusedImages/images-20`  | ms   | 98.9605 / 116.3803 |    96.2995 / 109.4032 |   -2.69% / -6.00% | Pass           |

## Browser metrics

| Metric                                 | Unit  |    Baseline p50 / p95 | Candidate C p50 / p95 | Change p50 / p95 | Gate           |
| -------------------------------------- | ----- | --------------------: | --------------------: | ---------------: | -------------- |
| `browser/inputToFrameMs/table-1200`    | ms    |     11.8000 / 14.7000 |     10.8000 / 12.7000 | -8.47% / -13.61% | Pass           |
| `browser/scrollFrameMs/table-1200`     | ms    |       5.0000 / 5.1000 |       5.0000 / 5.1000 |    0.00% / 0.00% | Pass           |
| `browser/initialOpenMs/table-1200`     | ms    | 1475.4000 / 1592.6000 | 1456.9000 / 1485.1000 |  -1.25% / -6.75% | Pass           |
| `browser/editorCreateMs/table-1200`    | ms    | 1179.4000 / 1193.6000 | 1160.6000 / 1165.5000 |  -1.59% / -2.35% | Pass           |
| `browser/longTaskCount/table-1200`     | count |                 1 / 1 |                 1 / 1 |    0.00% / 0.00% | Pass           |
| `browser/domNodes/table-1200`          | count |         14433 / 14433 |         14433 / 14433 |    0.00% / 0.00% | Pass           |
| `browser/retainedHeapBytes/table-1200` | bytes |   93732280 / 93821236 |   93714644 / 93796912 |  -0.02% / -0.03% | Pass           |
| `browser/longTaskTotalMs/table-1200`   | ms    | 1337.0000 / 1386.0000 | 1322.0000 / 1323.0000 |  -1.12% / -4.55% | Pass           |
| `browser/inputToFrameMs/long-5000`     | ms    |     28.4000 / 34.1000 |     27.4000 / 33.8000 |  -3.52% / -0.88% | Pass           |
| `browser/scrollFrameMs/long-5000`      | ms    |       5.0000 / 5.1000 |       5.0000 / 5.1000 |    0.00% / 0.00% | Pass           |
| `browser/initialOpenMs/long-5000`      | ms    |   989.6000 / 995.8000 |   932.0000 / 944.2000 |  -5.82% / -5.18% | Pass           |
| `browser/editorCreateMs/long-5000`     | ms    |   755.0000 / 767.9000 |   700.4000 / 710.5000 |  -7.23% / -7.47% | Pass           |
| `browser/longTaskCount/long-5000`      | count |                 1 / 1 |                 1 / 1 |    0.00% / 0.00% | Pass           |
| `browser/domNodes/long-5000`           | count |           2516 / 2516 |           2516 / 2516 |    0.00% / 0.00% | Pass           |
| `browser/retainedHeapBytes/long-5000`  | bytes |   93672296 / 93686672 |   93671124 / 93687216 |  -0.00% / +0.00% | Pass           |
| `browser/longTaskTotalMs/long-5000`    | ms    |   861.0000 / 865.0000 |   797.0000 / 807.0000 |  -7.43% / -6.71% | Pass           |
| `browser/inputToFrameMs/images-20`     | ms    |       4.0000 / 4.4000 |       4.3000 / 4.6000 |  +7.50% / +4.55% | Regression >5% |
| `browser/scrollFrameMs/images-20`      | ms    |       5.0000 / 5.1000 |       5.0000 / 5.1000 |    0.00% / 0.00% | Pass           |
| `browser/initialOpenMs/images-20`      | ms    |     70.2000 / 75.1000 |     69.1000 / 69.8000 |  -1.57% / -7.06% | Pass           |
| `browser/editorCreateMs/images-20`     | ms    |     49.8000 / 52.0000 |     46.5000 / 46.9000 |  -6.63% / -9.81% | Pass           |
| `browser/longTaskCount/images-20`      | count |                 1 / 1 |                 1 / 1 |    0.00% / 0.00% | Pass           |
| `browser/domNodes/images-20`           | count |             238 / 238 |             238 / 238 |    0.00% / 0.00% | Pass           |
| `browser/retainedHeapBytes/images-20`  | bytes |   82188824 / 82200168 |   82185856 / 82194856 |  -0.00% / -0.01% | Pass           |
| `browser/longTaskTotalMs/images-20`    | ms    |     57.0000 / 60.0000 |     53.0000 / 54.0000 | -7.02% / -10.00% | Pass           |

## Interpretation and limits

`ipc_dispatch` measures synchronous occupancy of the real generated Tauri command handler. `ipc_response` measures completion at its response callback. Async dispatch moves work to the runtime; dispatch reduction alone does not show less I/O or hashing. The direct long-document revision p95 did not improve in candidate C.

The browser runs the real Milkdown editor with mocked Tauri IPC. It therefore does not measure native polling during editing, the complete App background effects, or a WebView2 event loop. Native timing uses warm filesystem cache and sequential requests; it does not establish cold disk, multiple-tab saturation or hardware IME performance.

Raw samples remain in the JSON files and their recorded evidence directories. The current production fingerprint equals the baseline after rollback. No second benchmark was run on restored bytes, and no restored-source timings are claimed.
