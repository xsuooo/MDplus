//! Release-only native read timings against the fixed performance fixtures.
use super::{document_revision, raw_snapshot, read_document, FileError, MAX_TEXT_FILE_BYTES};
use serde::Serialize;
use sha2::Digest;
use std::fs;
use std::hint::black_box;
use std::path::Path;
use std::sync::mpsc::sync_channel;
use std::time::{Duration, Instant, UNIX_EPOCH};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponse};
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime, INVOKE_KEY};
use tauri::webview::InvokeRequest;

const REPETITIONS: usize = 3;
const SAMPLES_PER_REPETITION: usize = 30;
const WARMUP_PER_REPETITION: usize = 5;

#[derive(Serialize)]
struct Metric {
    name: String,
    unit: &'static str,
    samples: Vec<Vec<f64>>,
}

fn measure<Input, Output>(
    name: String,
    prepare: impl Fn() -> Input,
    operation: impl Fn(Input) -> Result<Output, Box<FileError>>,
    verify: impl Fn(&Output),
) -> Metric {
    let mut repetitions = Vec::with_capacity(REPETITIONS);
    for _ in 0..REPETITIONS {
        for _ in 0..WARMUP_PER_REPETITION {
            let result = operation(prepare()).expect("native warmup failed");
            verify(black_box(&result));
        }
        let mut samples = Vec::with_capacity(SAMPLES_PER_REPETITION);
        for _ in 0..SAMPLES_PER_REPETITION {
            let input = black_box(prepare());
            let started = Instant::now();
            let result = operation(input);
            let elapsed_ms = started.elapsed().as_secs_f64() * 1_000.0;
            let result = black_box(result).expect("native sample failed");
            verify(&result);
            assert!(elapsed_ms.is_finite() && elapsed_ms >= 0.0);
            samples.push(elapsed_ms);
        }
        repetitions.push(samples);
    }
    Metric {
        name,
        unit: "ms",
        samples: repetitions,
    }
}

fn measure_ipc(
    webview: &tauri::Webview<MockRuntime>,
    name: &str,
    path: &str,
    expected: &serde_json::Value,
) -> [Metric; 2] {
    let sample = || {
        let request = InvokeRequest {
            cmd: "document_revision".to_owned(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "http://tauri.localhost".parse().unwrap(),
            body: InvokeBody::Json(serde_json::json!({ "path": path })),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_owned(),
        };
        let webview = webview.clone();
        let (sender, receiver) = sync_channel(1);
        let started = Instant::now();
        webview.on_message(
            request,
            Box::new(move |_webview, _command, response, _callback, _error| {
                let response_ms = started.elapsed().as_secs_f64() * 1_000.0;
                sender
                    .send((response_ms, response))
                    .expect("native IPC benchmark receiver disappeared");
            }),
        );
        let dispatch_ms = started.elapsed().as_secs_f64() * 1_000.0;
        let (response_ms, response) = receiver
            .recv_timeout(Duration::from_secs(30))
            .expect("native IPC benchmark response timed out");
        let response = match black_box(response) {
            InvokeResponse::Ok(body) => body.deserialize::<serde_json::Value>().unwrap(),
            InvokeResponse::Err(error) => panic!("native IPC command failed: {}", error.0),
        };
        assert_eq!(&response, expected);
        assert!(dispatch_ms.is_finite() && dispatch_ms >= 0.0);
        assert!(response_ms.is_finite() && response_ms >= 0.0);
        (dispatch_ms, response_ms)
    };
    let mut dispatch = Metric {
        name: format!("rust/ipc_dispatch/{name}"),
        unit: "ms",
        samples: Vec::with_capacity(REPETITIONS),
    };
    let mut response = Metric {
        name: format!("rust/ipc_response/{name}"),
        unit: "ms",
        samples: Vec::with_capacity(REPETITIONS),
    };
    for _ in 0..REPETITIONS {
        for _ in 0..WARMUP_PER_REPETITION {
            black_box(sample());
        }
        let mut dispatch_samples = Vec::with_capacity(SAMPLES_PER_REPETITION);
        let mut response_samples = Vec::with_capacity(SAMPLES_PER_REPETITION);
        for _ in 0..SAMPLES_PER_REPETITION {
            let (dispatch_ms, response_ms) = sample();
            dispatch_samples.push(dispatch_ms);
            response_samples.push(response_ms);
        }
        dispatch.samples.push(dispatch_samples);
        response.samples.push(response_samples);
    }
    [dispatch, response]
}

#[test]
#[ignore = "fixed performance baseline; run with --release --ignored --nocapture --test-threads=1"]
fn perf_native() {
    if cfg!(debug_assertions) {
        panic!("native performance measurements require cargo test --release");
    }
    let fixture_root =
        fs::canonicalize(Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/perf/fixtures"))
            .expect("generate tests/perf/fixtures before running this benchmark");
    let app = mock_builder()
        .invoke_handler(tauri::generate_handler![super::document_revision])
        .build(mock_context(noop_assets()))
        .expect("could not build native IPC benchmark runtime");
    let window = tauri::WebviewWindowBuilder::new(&app, "perf", Default::default())
        .build()
        .expect("could not build native IPC benchmark window");
    let mut metrics = Vec::new();
    let mut fixtures = Vec::new();
    for name in ["table-1200", "long-5000", "images-20"] {
        let path = fs::canonicalize(fixture_root.join(format!("{name}.md")))
            .expect("fixed performance fixture is missing");
        assert!(path.starts_with(&fixture_root), "fixture escaped its root");
        let path_string = path.to_str().expect("fixture path is not UTF-8").to_owned();
        let bytes = fs::read(&path).expect("could not read performance fixture");
        let text = std::str::from_utf8(&bytes).expect("performance fixtures must use UTF-8");
        let revision = format!("sha256:{:x}", sha2::Sha256::digest(&bytes));
        let mtime = fs::metadata(&path)
            .unwrap()
            .modified()
            .unwrap()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        fixtures.push(serde_json::json!({
            "name": name,
            "bytes": bytes.len(),
            "revision": revision,
        }));
        metrics.push(measure(
            format!("rust/read_document/{name}"),
            || path_string.clone(),
            read_document,
            |result| {
                assert_eq!(result.path, path_string);
                assert_eq!(result.content, text);
                assert_eq!(result.revision, revision);
                assert_eq!(result.mtime, mtime);
            },
        ));
        metrics.push(measure(
            format!("rust/raw_snapshot/{name}"),
            || path.as_path(),
            |path| raw_snapshot(path, MAX_TEXT_FILE_BYTES),
            |result| {
                assert_eq!(result.bytes, bytes);
                assert_eq!(result.revision, revision);
                assert_eq!(result.mtime, mtime);
            },
        ));
        metrics.push(measure(
            format!("rust/document_revision/{name}"),
            || path_string.clone(),
            document_revision,
            |result| {
                assert_eq!(result.path, path_string);
                assert_eq!(result.revision.as_deref(), Some(revision.as_str()));
                assert_eq!(result.mtime, Some(mtime));
            },
        ));
        metrics.extend(measure_ipc(
            window.as_ref(),
            name,
            &path_string,
            &serde_json::json!({ "path": path_string, "revision": revision, "mtime": mtime }),
        ));
    }
    println!(
        "MDPLUS_PERF_NATIVE={}",
        serde_json::json!({
            "repetitions": REPETITIONS,
            "samplesPerRepetition": SAMPLES_PER_REPETITION,
            "warmupPerRepetition": WARMUP_PER_REPETITION,
            "profile": "release",
            "fixtures": fixtures,
            "metrics": metrics,
            "scope": [
                "Real native filesystem calls against fixed read-only fixtures.",
                "Warm page cache; five untimed warmups precede each group of 30 samples.",
                "Direct-call input preparation, result assertions and destruction are outside the timed region.",
                "IPC metrics execute the real generated document_revision handler and real filesystem I/O.",
                "MockRuntime replaces the window and OS transport, not the command wrapper or filesystem.",
                "ipc_dispatch measures on_message synchronous occupancy; ipc_response ends at its response callback.",
                "Requests are sequential; native WebView2 frame time, runtime saturation, Markdown parsing and image reads are not measured."
            ],
        })
    );
}
