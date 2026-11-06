//! Completion 1-3: native filesystem guarantees, using disposable directories only.
use crate::safe_files::{document_revision, read_document, write_document};

// Legacy filesystem regression callers work with bytes; the exposed command is
// base64-only. Finalize successful allocations so fixtures do not retain handles.
fn save_image_asset(
    doc_path: String,
    filename: String,
    data: Vec<u8>,
) -> Result<crate::safe_files::ImageReceipt, Box<crate::safe_files::FileError>> {
    let receipt = crate::safe_files::save_image_asset(
        doc_path,
        filename,
        crate::image_data::encode_image(&data),
    )?;
    crate::safe_files::commit_image_assets(receipt.allocation_id.iter().cloned().collect())
        .unwrap();
    Ok(receipt)
}
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
fn review_m6_nul_is_rejected_after_decoding_every_supported_encoding() {
    let root = TestDir::new();
    let path = root.document();
    let text = format!("{}中文\0tail", "a".repeat(8193));
    let mut encodings = vec![text.as_bytes().to_vec()];
    let (gbk, _, _) = encoding_rs::GBK.encode(&text);
    encodings.push(gbk.into_owned());
    for little_endian in [true, false] {
        let mut bytes = if little_endian {
            vec![0xFF, 0xFE]
        } else {
            vec![0xFE, 0xFF]
        };
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&if little_endian {
                unit.to_le_bytes()
            } else {
                unit.to_be_bytes()
            });
        }
        encodings.push(bytes);
    }
    for bytes in encodings {
        fs::write(&path, &bytes).unwrap();
        let error = read_document(path.clone()).unwrap_err();
        assert_eq!(error.code, "INVALID_ENCODING");
        assert_eq!(error.write_state, "unchanged");
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
}

#[test]
fn review_m6_nul_write_cannot_modify_or_create_a_document() {
    let root = TestDir::new();
    let path = root.document();
    let error = write_document(path.clone(), "new\0draft".into(), None).unwrap_err();
    assert_eq!(error.code, "INVALID_ENCODING");
    assert!(!PathBuf::from(&path).exists());
    fs::write(&path, "original").unwrap();
    let expected = read_document(path.clone()).unwrap().revision;
    let error = write_document(path.clone(), "new\0draft".into(), Some(expected)).unwrap_err();
    assert_eq!(error.code, "INVALID_ENCODING");
    assert_eq!(fs::read_to_string(path).unwrap(), "original");
    assert_eq!(fs::read_dir(&root.0).unwrap().count(), 1);
}

#[test]
fn review_m6_valid_utf16_documents_save_as_utf8_and_reopen_losslessly() {
    let root = TestDir::new();
    let path = root.document();
    let content = "中文 Ā emoji 😀\nend";
    for little_endian in [true, false] {
        let mut bytes = if little_endian {
            vec![0xFF, 0xFE]
        } else {
            vec![0xFE, 0xFF]
        };
        for unit in content.encode_utf16() {
            bytes.extend_from_slice(&if little_endian {
                unit.to_le_bytes()
            } else {
                unit.to_be_bytes()
            });
        }
        fs::write(&path, bytes).unwrap();
        let snapshot = read_document(path.clone()).unwrap();
        assert_eq!(snapshot.content, content);
        write_document(path.clone(), snapshot.content, Some(snapshot.revision)).unwrap();
        assert_eq!(fs::read(&path).unwrap(), content.as_bytes());
        assert_eq!(read_document(path.clone()).unwrap().content, content);
    }
}

#[test]
fn review_m6_decoded_text_must_fit_the_same_utf8_write_budget() {
    let root = TestDir::new();
    let path = root.document();
    let content = "中".repeat(crate::MAX_TEXT_FILE_BYTES as usize / 3 + 1);
    let mut bytes = vec![0xFF, 0xFE];
    for unit in content.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    assert!(bytes.len() as u64 <= crate::MAX_TEXT_FILE_BYTES);
    fs::write(&path, &bytes).unwrap();
    assert_eq!(read_document(path.clone()).unwrap_err().code, "TOO_LARGE");
    assert_eq!(fs::read(&path).unwrap(), bytes);
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

#[cfg(windows)]
#[test]
fn completion_image_write_failure_discards_only_the_still_owned_object() {
    use crate::safe_files::hooks::fail_next_image_write;
    let root = TestDir::new();
    // Inject an I/O error while the DELETE-capable exclusive handle is held.
    fail_next_image_write();
    let error = save_image_asset(
        root.document(),
        "same.svg".into(),
        b"<svg><text>local</text></svg>".to_vec(),
    )
    .unwrap_err();
    let path = PathBuf::from(&error.path);
    assert!(
        !path.exists(),
        "partial owned image should be removed by handle"
    );
    assert_eq!(error.code, "IO_ERROR");
    assert_eq!(error.write_state, "unchanged");
    assert!(error.recovery_path.is_none() && error.backup_path.is_none());
    assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 0);
    assert!(!PathBuf::from(root.document()).exists());
    assert_contract("FileError", error);
}

#[cfg(windows)]
#[test]
fn completion_image_write_failure_never_deletes_a_later_external_file() {
    use crate::safe_files::hooks::{at, fail_next_image_write, Checkpoint};
    let root = TestDir::new();
    let external = b"<svg><text>external</text></svg>";
    fail_next_image_write();
    at(Checkpoint::ImageWriteFailed, move |path| {
        // Identity-safe cleanup already finished before closing the owned handle.
        // Anything created now must never be deleted by that operation.
        assert!(!path.exists());
        fs::write(path, external).unwrap();
    });
    let error =
        save_image_asset(root.document(), "same.svg".into(), b"<svg/>".to_vec()).unwrap_err();
    let path = PathBuf::from(&error.path);
    assert_eq!(fs::read(&path).unwrap(), external);
    assert!(
        !path.with_file_name("same-1.svg").exists(),
        "I/O errors must not retry"
    );
    assert_eq!(error.code, "IO_ERROR");
    assert_eq!(error.write_state, "unchanged");
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
#[ignore = "requires Windows symlink creation privilege; from src-tauri run: cargo test --lib review_p2_ -- --ignored --nocapture"]
#[test]
fn review_p2_read_and_revision_reject_leaf_symlinks_inserted_after_path_checks() {
    use crate::safe_files::hooks::{at, Checkpoint};
    for revision_only in [false, true] {
        let root = TestDir::new();
        let path = root.document();
        fs::write(&path, "original").unwrap();
        let original = fs::canonicalize(&path).unwrap();
        let outside = root.0.join("outside.md");
        fs::write(&outside, "must not read through the substituted link").unwrap();
        let prepared_link = root.0.join("prepared-link.md");
        std::os::windows::fs::symlink_file(&outside, &prepared_link).expect(
            "real Windows file symlink creation failed; leaf-race regression is NOT skipped",
        );
        at(Checkpoint::BeforeReadOpen, move |target| {
            assert_eq!(fs::canonicalize(target).unwrap(), original);
            assert!(fs::symlink_metadata(&prepared_link)
                .unwrap()
                .file_type()
                .is_symlink());
            fs::rename(target, target.with_file_name("original-moved.md")).unwrap();
            fs::rename(&prepared_link, target).unwrap();
        });
        let error = if revision_only {
            document_revision(path.clone()).err()
        } else {
            read_document(path.clone()).err()
        }
        .expect("snapshot followed a leaf symlink installed after preflight");
        assert_eq!(error.code, "INVALID_PATH");
        assert_eq!(error.write_state, "unchanged");
        assert!(fs::symlink_metadata(&path)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::read(root.0.join("original-moved.md")).unwrap(),
            b"original"
        );
        assert_eq!(
            fs::read(&outside).unwrap(),
            b"must not read through the substituted link"
        );
    }
}

#[cfg(windows)]
#[ignore = "requires Windows symlink creation privilege; from src-tauri run: cargo test --lib review_p2_ -- --ignored --nocapture"]
#[test]
fn review_p2_conditional_write_rejects_substituted_leaf_and_retains_local_draft() {
    use crate::safe_files::hooks::{at, Checkpoint};
    let root = TestDir::new();
    let path = root.document();
    fs::write(&path, "original").unwrap();
    let expected = read_document(path.clone()).unwrap().revision;
    let original = fs::canonicalize(&path).unwrap();
    let outside = root.0.join("outside.md");
    fs::write(&outside, "original").unwrap();
    // Acquire the real-link fixture before entering DOCUMENT_WRITES so a missing
    // OS privilege fails this test without poisoning unrelated write tests.
    let prepared_link = root.0.join("prepared-link.md");
    std::os::windows::fs::symlink_file(&outside, &prepared_link).expect(
        "real Windows file symlink creation failed; conditional-write coverage is NOT skipped",
    );
    at(Checkpoint::BeforeReadOpen, move |target| {
        assert_eq!(fs::canonicalize(target).unwrap(), original);
        assert!(fs::symlink_metadata(&prepared_link)
            .unwrap()
            .file_type()
            .is_symlink());
        fs::rename(target, target.with_file_name("original-moved.md")).unwrap();
        fs::rename(&prepared_link, target).unwrap();
    });
    let error = write_document(path.clone(), "local draft".into(), Some(expected))
        .expect_err("conditional write accepted the substituted leaf");
    assert_eq!(error.code, "INVALID_PATH");
    assert_eq!(error.write_state, "unchanged");
    assert_eq!(
        fs::read(error.recovery_path.unwrap()).unwrap(),
        b"local draft"
    );
    assert!(fs::symlink_metadata(&path)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(fs::read(&outside).unwrap(), b"original");
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
