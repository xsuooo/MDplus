//! Completion 1-3: native filesystem guarantees, using disposable directories only.
use crate::safe_files::{document_revision, read_document, save_image_asset, write_document};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Barrier};

struct TestDir(PathBuf);
impl TestDir {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "mdplus-safe-files-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn document(&self) -> String {
        self.0.join("note.md").to_string_lossy().into_owned()
    }
}
impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn assert_contract(name: &str, value: impl serde::Serialize) {
    let schema: serde_json::Value =
        serde_json::from_str(include_str!("file_contract.json")).unwrap();
    let value = serde_json::to_value(value).unwrap();
    let definition = &schema["$defs"][name];
    let properties = definition["properties"].as_object().unwrap();
    for field in definition["required"].as_array().unwrap() {
        assert!(
            value.get(field.as_str().unwrap()).is_some(),
            "missing required field {field}"
        );
    }
    for (key, field) in value.as_object().unwrap() {
        let rule = properties
            .get(key)
            .unwrap_or_else(|| panic!("undocumented field {key}"));
        if let Some(allowed) = rule.get("enum") {
            assert!(allowed.as_array().unwrap().contains(field));
        }
        if let Some(kind) = rule.get("type") {
            let kinds = kind
                .as_array()
                .cloned()
                .unwrap_or_else(|| vec![kind.clone()]);
            assert!(
                kinds.iter().any(|kind| match kind.as_str().unwrap() {
                    "string" => field.is_string(),
                    "integer" => field.is_u64(),
                    "null" => field.is_null(),
                    _ => panic!("unsupported contract check"),
                }),
                "wrong type for {key}: {field}"
            );
        }
    }
}

#[test]
fn completion_snapshot_and_revision_describe_the_same_raw_bytes() {
    let root = TestDir::new();
    let path = root.document();
    let (bytes, _, _) = encoding_rs::GBK.encode("中文原稿");
    fs::write(&path, &bytes).unwrap();
    let snapshot = read_document(path.clone()).unwrap();
    assert_eq!(snapshot.content, "中文原稿");
    let state = document_revision(path).unwrap();
    assert_eq!(state.revision.as_deref(), Some(snapshot.revision.as_str()));
    assert_eq!(state.mtime, Some(snapshot.mtime));
    assert_contract("DocumentSnapshot", snapshot);
    assert_contract("RevisionState", state);
}

#[test]
fn document_commands_return_one_absolute_identity_for_path_aliases() {
    // Keep cwd unchanged: other filesystem tests run concurrently.
    let root = tempfile::Builder::new()
        .prefix(".mdplus-identity-")
        .tempdir_in(std::env::current_dir().unwrap())
        .unwrap();
    let document = root.path().join("note.md");
    fs::create_dir(root.path().join("sub")).unwrap();
    fs::write(&document, "original").unwrap();
    let canonical = fs::canonicalize(&document).unwrap();
    let relative = PathBuf::from(root.path().file_name().unwrap()).join("note.md");
    for alias in [
        document.clone(),
        root.path().join(".").join("note.md"),
        root.path().join("sub").join("..").join("note.md"),
        relative,
        canonical.clone(),
    ] {
        let request = alias.to_string_lossy().into_owned();
        let snapshot = serde_json::to_value(read_document(request.clone()).unwrap()).unwrap();
        let state = serde_json::to_value(document_revision(request).unwrap()).unwrap();
        assert_eq!(snapshot["path"], canonical.to_string_lossy().as_ref());
        assert_eq!(state["path"], snapshot["path"]);
        assert_eq!(state["revision"], snapshot["revision"]);
    }
    let missing = root.path().join("sub").join("..").join("new.md");
    let state = document_revision(missing.to_string_lossy().into_owned()).unwrap();
    let state_json = serde_json::to_value(&state).unwrap();
    let receipt = write_document(
        missing.to_string_lossy().into_owned(),
        "new document".into(),
        state.revision,
    )
    .unwrap();
    let receipt_json = serde_json::to_value(receipt).unwrap();
    assert_eq!(state_json["path"], receipt_json["path"]);
    assert_eq!(
        receipt_json["path"],
        fs::canonicalize(root.path().join("new.md"))
            .unwrap()
            .to_string_lossy()
            .as_ref()
    );
}

#[test]
fn completion_missing_revision_is_not_a_permission_or_directory_error() {
    let root = TestDir::new();
    let missing = document_revision(root.document()).unwrap();
    assert!(missing.revision.is_none() && missing.mtime.is_none());
    assert_contract("RevisionState", missing);
    assert!(document_revision(root.0.to_string_lossy().into_owned()).is_err());
}

#[test]
fn completion_create_only_does_not_replace_an_existing_document() {
    let root = TestDir::new();
    let path = root.document();
    fs::write(&path, "external").unwrap();
    let error = write_document(path.clone(), "local".into(), None).unwrap_err();
    assert_eq!(error.code, "CONFLICT");
    assert_eq!(error.write_state, "unchanged");
    assert_eq!(fs::read_to_string(&path).unwrap(), "external");
    assert_eq!(
        fs::read_to_string(error.recovery_path.as_ref().unwrap()).unwrap(),
        "local"
    );
    assert_contract("FileError", error);
}

#[test]
fn completion_stale_content_conflicts_even_when_mtime_was_preserved() {
    let root = TestDir::new();
    let path = root.document();
    fs::write(&path, "first").unwrap();
    let modified = fs::metadata(&path).unwrap().modified().unwrap();
    let snapshot = read_document(path.clone()).unwrap();
    fs::write(&path, "other").unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(modified))
        .unwrap();
    let error = write_document(path.clone(), "local".into(), Some(snapshot.revision)).unwrap_err();
    assert_eq!(error.code, "CONFLICT");
    assert_eq!(fs::read_to_string(path).unwrap(), "other");
    assert_eq!(
        fs::read_to_string(error.recovery_path.unwrap()).unwrap(),
        "local"
    );
}

#[test]
fn completion_expected_revision_does_not_recreate_a_deleted_file() {
    let root = TestDir::new();
    let path = root.document();
    fs::write(&path, "original").unwrap();
    let snapshot = read_document(path.clone()).unwrap();
    fs::remove_file(&path).unwrap();
    let error = write_document(path.clone(), "local".into(), Some(snapshot.revision)).unwrap_err();
    assert_eq!(error.code, "CONFLICT");
    assert!(!PathBuf::from(path).exists());
}

#[test]
fn completion_verified_write_receipt_matches_committed_bytes_and_metadata() {
    let root = TestDir::new();
    let path = root.document();
    let created = write_document(path.clone(), "first".into(), None).unwrap();
    let receipt = write_document(path.clone(), "第二版".into(), Some(created.revision)).unwrap();
    let snapshot = read_document(path).unwrap();
    assert_eq!(snapshot.content, "第二版");
    assert_eq!(receipt.revision, snapshot.revision);
    assert_eq!(receipt.mtime, snapshot.mtime);
    assert_contract("WriteReceipt", receipt);
    assert_eq!(
        fs::read_dir(&root.0).unwrap().count(),
        1,
        "successful transaction leaked temporary copies"
    );
}

#[test]
fn completion_two_writers_cannot_both_commit_the_same_expected_revision() {
    let root = TestDir::new();
    let path = root.document();
    fs::write(&path, "original").unwrap();
    let expected = read_document(path.clone()).unwrap().revision;
    let barrier = Arc::new(Barrier::new(2));
    let workers: Vec<_> = ["writer-one", "writer-two"]
        .into_iter()
        .map(|content| {
            let barrier = barrier.clone();
            let path = path.clone();
            let revision = expected.clone();
            std::thread::spawn(move || {
                barrier.wait();
                write_document(path, content.into(), Some(revision))
            })
        })
        .collect();
    let results: Vec<_> = workers
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Err(error) if error.code == "CONFLICT"))
            .count(),
        1
    );
}

#[test]
fn completion_invalid_encoding_has_a_typed_error_and_no_write() {
    let root = TestDir::new();
    let path = root.document();
    fs::write(&path, [0xFF, 0xFE, 0x61]).unwrap();
    let error = read_document(path.clone()).unwrap_err();
    assert_eq!(error.code, "INVALID_ENCODING");
    assert_eq!(error.write_state, "unchanged");
    assert_eq!(fs::read(path).unwrap(), [0xFF, 0xFE, 0x61]);
    assert_contract("FileError", error);
}

#[test]
fn completion_concurrent_images_keep_distinct_names_and_correct_bytes() {
    let root = TestDir::new();
    let document = root.document();
    let barrier = Arc::new(Barrier::new(8));
    let workers: Vec<_> = (0..8)
        .map(|index| {
            let barrier = barrier.clone();
            let document = document.clone();
            std::thread::spawn(move || {
                let bytes =
                    format!("<svg xmlns=\"http://www.w3.org/2000/svg\"><text>{index}</text></svg>")
                        .into_bytes();
                barrier.wait();
                let image = save_image_asset(document, "same.svg".into(), bytes.clone()).unwrap();
                (image, bytes)
            })
        })
        .collect();
    let results: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect();
    let names: std::collections::HashSet<_> =
        results.iter().map(|(image, _)| &image.filename).collect();
    assert_eq!(names.len(), 8);
    for (image, bytes) in results {
        assert_eq!(fs::read(&image.path).unwrap(), bytes);
        assert_eq!(image.relative_path, format!("./assets/{}", image.filename));
        assert_contract("ImageReceipt", image);
    }
    assert!(
        !PathBuf::from(document).exists(),
        "asset creation unexpectedly created the document"
    );
}

#[test]
fn completion_image_write_failure_keeps_file_and_reports_uncertain_path() {
    use crate::safe_files::hooks::fail_next_image_write;
    let root = TestDir::new();
    let bytes = b"<svg><text>local</text></svg>";
    // Inject a terminal I/O error after real writes, not a host disk-full condition.
    fail_next_image_write();
    let error = save_image_asset(root.document(), "same.svg".into(), bytes.to_vec()).unwrap_err();
    let path = PathBuf::from(&error.path);
    assert!(
        path.is_file(),
        "failed image must be retained for manual review"
    );
    assert_eq!(fs::read(&path).unwrap(), bytes);
    assert_eq!(error.code, "IO_ERROR");
    assert_eq!(error.write_state, "unknown");
    assert!(error.message.contains(&error.path));
    assert!(error.message.contains("未删除"));
    assert!(error.recovery_path.is_none() && error.backup_path.is_none());
    assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
    assert!(!PathBuf::from(root.document()).exists());
    assert_contract("FileError", error);
}

#[test]
fn completion_image_write_failure_never_deletes_a_later_external_file() {
    use crate::safe_files::hooks::{at, fail_next_image_write, Checkpoint};
    let root = TestDir::new();
    let bytes = b"<svg><text>local</text></svg>";
    let external = b"<svg><text>external</text></svg>";
    fail_next_image_write();
    at(Checkpoint::ImageWriteFailed, move |path| {
        // This is the real Windows rename/write interval after the exclusive handle closes.
        fs::rename(path, path.with_file_name("failed-attempt.svg")).unwrap();
        fs::write(path, external).unwrap();
    });
    let error = save_image_asset(root.document(), "same.svg".into(), bytes.to_vec()).unwrap_err();
    let path = PathBuf::from(&error.path);
    assert_eq!(
        fs::read(&path).expect("failure cleanup must not delete a later external image"),
        external
    );
    assert_eq!(
        fs::read(path.with_file_name("failed-attempt.svg")).unwrap(),
        bytes
    );
    assert!(
        !path.with_file_name("same-1.svg").exists(),
        "I/O errors must not retry"
    );
    assert_eq!(error.code, "IO_ERROR");
    assert_eq!(error.write_state, "unknown");
    assert!(error.message.contains(&error.path));
    assert_contract("FileError", error);
}

#[test]
fn completion_image_rejects_unsafe_names_and_non_images() {
    let root = TestDir::new();
    for filename in [
        "../escape.svg",
        "C:escape.svg",
        "NUL.svg",
        "image.svg.",
        "dir/image.svg",
        "dir\\image.svg",
    ] {
        let error =
            save_image_asset(root.document(), filename.into(), b"<svg/>".to_vec()).unwrap_err();
        assert_eq!(error.code, "INVALID_PATH", "{filename}");
    }
    assert!(save_image_asset(root.document(), "image.png".into(), b"not a png".to_vec()).is_err());
    assert_eq!(fs::read_dir(&root.0).unwrap().count(), 0);
}

#[cfg(windows)]
#[test]
fn completion_read_handle_blocks_in_place_writers_until_snapshot_is_complete() {
    use crate::safe_files::hooks::{at, Checkpoint};
    let root = TestDir::new();
    let path = root.document();
    fs::write(&path, "original").unwrap();
    at(Checkpoint::ReadLocked, |target| {
        assert!(fs::write(target, "must not interleave").is_err());
    });
    let snapshot = read_document(path.clone()).unwrap();
    assert_eq!(snapshot.content, "original");
    assert_eq!(fs::read_to_string(path).unwrap(), "original");
}

#[cfg(windows)]
#[test]
fn completion_replacement_race_retains_external_backup_and_independent_local_draft() {
    use crate::safe_files::hooks::{at, Checkpoint};
    let root = TestDir::new();
    let path = root.document();
    fs::write(&path, "original").unwrap();
    let expected = read_document(path.clone()).unwrap().revision;
    at(Checkpoint::BeforeCommit, |target| {
        fs::write(target, "external during replacement").unwrap();
    });
    let error = write_document(path.clone(), "local draft".into(), Some(expected)).unwrap_err();
    assert_eq!(error.code, "RECOVERY_REQUIRED");
    assert_eq!(error.write_state, "committed");
    assert_eq!(
        fs::read_to_string(error.backup_path.as_ref().unwrap()).unwrap(),
        "external during replacement"
    );
    assert_eq!(
        fs::read_to_string(error.recovery_path.as_ref().unwrap()).unwrap(),
        "local draft"
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), "local draft");
    fs::write(&path, "another edit after the error").unwrap();
    assert_eq!(
        fs::read_to_string(error.recovery_path.as_ref().unwrap()).unwrap(),
        "local draft",
        "recovery draft must not share the target inode"
    );
    assert_contract("FileError", error);
}

#[cfg(windows)]
#[test]
fn completion_post_commit_writer_is_not_overwritten_by_an_automatic_rollback() {
    use crate::safe_files::hooks::{at, Checkpoint};
    let root = TestDir::new();
    let path = root.document();
    fs::write(&path, "original").unwrap();
    let expected = read_document(path.clone()).unwrap().revision;
    at(Checkpoint::AfterCommit, |target| {
        fs::write(target, "new external edit").unwrap();
    });
    let error = write_document(path.clone(), "local draft".into(), Some(expected)).unwrap_err();
    assert_eq!(error.code, "RECOVERY_REQUIRED");
    assert_eq!(fs::read_to_string(path).unwrap(), "new external edit");
    assert_eq!(
        fs::read_to_string(error.recovery_path.unwrap()).unwrap(),
        "local draft"
    );
    assert_eq!(
        fs::read_to_string(error.backup_path.unwrap()).unwrap(),
        "original"
    );
}

#[test]
fn completion_create_race_never_clobbers_a_new_external_file() {
    use crate::safe_files::hooks::{at, Checkpoint};
    let root = TestDir::new();
    let path = root.document();
    at(Checkpoint::BeforeCommit, |target| {
        fs::write(target, "external create").unwrap();
    });
    let error = write_document(path.clone(), "local draft".into(), None).unwrap_err();
    assert_eq!(error.code, "CONFLICT");
    assert_eq!(error.write_state, "unchanged");
    assert_eq!(fs::read_to_string(path).unwrap(), "external create");
    assert_eq!(
        fs::read_to_string(error.recovery_path.unwrap()).unwrap(),
        "local draft"
    );
}

#[test]
fn completion_asset_io_error_is_not_treated_as_a_free_filename() {
    let root = TestDir::new();
    fs::write(root.0.join("assets"), "do not replace").unwrap();
    assert!(save_image_asset(root.document(), "image.svg".into(), b"<svg/>".to_vec()).is_err());
    assert_eq!(
        fs::read_to_string(root.0.join("assets")).unwrap(),
        "do not replace"
    );
}

#[cfg(windows)]
#[test]
fn completion_replace_sharing_failure_retains_draft_and_original_without_rollback() {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};
    let root = TestDir::new();
    let path = root.document();
    fs::write(&path, "original").unwrap();
    let expected = read_document(path.clone()).unwrap().revision;
    // This reader allows reads/writes but intentionally denies deletion/rename.
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .open(&path)
        .unwrap();
    let error = write_document(path.clone(), "local draft".into(), Some(expected)).unwrap_err();
    assert_eq!(error.code, "RECOVERY_REQUIRED");
    assert_eq!(error.write_state, "unknown");
    drop(held);
    assert_eq!(fs::read_to_string(path).unwrap(), "original");
    assert_eq!(
        fs::read_to_string(error.recovery_path.unwrap()).unwrap(),
        "local draft"
    );
}

#[cfg(windows)]
#[test]
fn completion_partial_path_failure_preserves_available_previous_and_local_copies() {
    use crate::safe_files::hooks::{at, Checkpoint};
    let root = TestDir::new();
    let path = root.document();
    fs::write(&path, "original").unwrap();
    let expected = read_document(path.clone()).unwrap().revision;
    at(Checkpoint::BeforeCommit, |target| {
        let transaction = fs::read_dir(target.parent().unwrap())
            .unwrap()
            .map(|item| item.unwrap().path())
            .find(|item| {
                item.is_dir()
                    && item
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .starts_with(".mdplus-save-")
            })
            .unwrap();
        // Inject the filesystem shape of a partial replacement; do not claim
        // this forces Windows itself to return a specific 117x error code.
        fs::rename(target, transaction.join("previous.md")).unwrap();
    });
    let error = write_document(path.clone(), "local draft".into(), Some(expected)).unwrap_err();
    assert_eq!(error.code, "RECOVERY_REQUIRED");
    assert_eq!(error.write_state, "unknown");
    assert!(
        !PathBuf::from(path).exists(),
        "must not recreate the target without review"
    );
    assert_eq!(
        fs::read_to_string(error.backup_path.unwrap()).unwrap(),
        "original"
    );
    assert_eq!(
        fs::read_to_string(error.recovery_path.unwrap()).unwrap(),
        "local draft"
    );
}

#[cfg(windows)]
#[test]
fn completion_busy_revision_is_an_error_not_an_absent_file() {
    use std::os::windows::fs::OpenOptionsExt;
    let root = TestDir::new();
    let path = root.document();
    fs::write(&path, "original").unwrap();
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&path)
        .unwrap();
    let error = document_revision(path).unwrap_err();
    assert_eq!(error.code, "BUSY");
    assert_eq!(error.write_state, "unchanged");
    drop(held);
}

#[test]
fn completion_size_limits_reject_before_replacing_documents_or_creating_assets() {
    let root = TestDir::new();
    let path = root.document();
    let file = fs::File::create(&path).unwrap();
    file.set_len(crate::MAX_TEXT_FILE_BYTES + 1).unwrap();
    drop(file);
    assert_eq!(read_document(path.clone()).unwrap_err().code, "TOO_LARGE");
    let error = write_document(
        path.clone(),
        "x".repeat(crate::MAX_TEXT_FILE_BYTES as usize + 1),
        None,
    )
    .unwrap_err();
    assert_eq!(error.code, "TOO_LARGE");
    assert_eq!(
        fs::metadata(path).unwrap().len(),
        crate::MAX_TEXT_FILE_BYTES + 1
    );
    let error = save_image_asset(
        root.document(),
        "image.png".into(),
        vec![0; crate::MAX_IMAGE_FILE_BYTES as usize + 1],
    )
    .unwrap_err();
    assert_eq!(error.code, "TOO_LARGE");
    assert!(!root.0.join("assets").exists());
}

#[test]
fn completion_empty_document_is_valid_and_revision_changes_after_a_real_edit() {
    let root = TestDir::new();
    let path = root.document();
    let empty = write_document(path.clone(), "".into(), None).unwrap();
    assert_eq!(read_document(path.clone()).unwrap().content, "");
    let next = write_document(path, "a".into(), Some(empty.revision.clone())).unwrap();
    assert_ne!(empty.revision, next.revision);
}

#[cfg(windows)]
#[test]
fn completion_valid_windows_long_basename_can_still_be_read() {
    let root = TestDir::new();
    let path = root.0.join(format!("{}.md", "x".repeat(245)));
    fs::write(&path, "valid long filename").unwrap();
    assert_eq!(
        read_document(path.to_string_lossy().into_owned())
            .unwrap()
            .content,
        "valid long filename"
    );
}

#[test]
fn completion_declared_commands_are_registered_in_the_real_handler() {
    let schema: serde_json::Value =
        serde_json::from_str(include_str!("file_contract.json")).unwrap();
    let source = include_str!("lib.rs");
    let handler: Vec<_> = source
        .split("tauri::generate_handler![")
        .nth(1)
        .unwrap()
        .split(']')
        .next()
        .unwrap()
        .split(',')
        .map(|item| item.trim().rsplit("::").next().unwrap())
        .filter(|item| !item.is_empty())
        .collect();
    assert_eq!(
        handler.len(),
        schema["x-commands"].as_object().unwrap().len()
    );
    for command in schema["x-commands"].as_object().unwrap().keys() {
        assert!(
            handler.contains(&command.as_str()),
            "missing IPC registration: {command}"
        );
    }
}

#[test]
fn document_commands_reject_empty_control_and_oversized_paths() {
    for path in [String::new(), "bad\0name.md".into(), "x".repeat(32768)] {
        assert_eq!(document_revision(path).unwrap_err().code, "INVALID_PATH");
    }
}

#[cfg(windows)]
#[test]
fn document_commands_reject_device_namespaces_before_accessing_them() {
    for path in [
        r"\\.\pipe\mdplus-never-open",
        r"\\?\GLOBALROOT\Device\HarddiskVolume1\note.md",
    ] {
        assert_eq!(
            document_revision(path.into()).unwrap_err().code,
            "INVALID_PATH"
        );
    }
}
