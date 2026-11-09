use super::*;
static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "MDPlus 恢复 测试 {} {} {}",
            std::process::id(),
            now_ms(),
            COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if self.0.starts_with(std::env::temp_dir())
            && self
                .0
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("MDPlus 恢复 测试 ")
        {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}
fn snapshot() -> Snapshot {
    Snapshot {
        id: "test-id".into(),
        title: "中文 草稿.md".into(),
        original_path: Some("D:\\中文 目录\\原文.md".into()),
        markdown: "中文 内容 ![](mdplus-image:picture)".into(),
        images: vec![RecoveryImage {
            placeholder: "mdplus-image:picture".into(),
            key: "picture.svg".into(),
            filename: "图片 一.svg".into(),
        }],
        updated_at: 0,
    }
}
const SVG: &[u8] = b"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"2\" height=\"2\"/>";

#[test]
fn caches_immutable_stash_bytes_without_base64_and_keeps_recovery_after_stash_release() {
    let root = Fixture::new();
    let stash_root = tempfile::tempdir().unwrap();
    let source = stash_root.path().join("source.svg");
    fs::write(&source, SVG).unwrap();
    let state = ImageStash::default();
    let receipt = state
        .insert_bytes(stash_root.path(), "source.svg", SVG)
        .unwrap();
    let receipt = serde_json::to_value(receipt).unwrap();
    let stash_key = receipt["key"].as_str().unwrap();
    let cleanup =
        cache_stashed_image(&root.0, &state, "test-id", "picture.svg", stash_key, &[]).unwrap();
    assert!(cleanup.cleanup_error.is_none());
    assert_eq!(fs::read(root.0.join("test-id/picture.svg")).unwrap(), SVG);
    save(&root.0, snapshot(), &[]).unwrap();
    let other = b"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"3\" height=\"3\"/>";
    let replacement = serde_json::to_value(
        state
            .insert_bytes(stash_root.path(), "other.svg", other)
            .unwrap(),
    )
    .unwrap();
    assert!(cache_stashed_image(
        &root.0,
        &state,
        "test-id",
        "picture.svg",
        replacement["key"].as_str().unwrap(),
        &[]
    )
    .is_err());
    state.discard_for_test(vec![stash_key.into()]).unwrap();
    assert!(state.read_bytes(stash_key).is_err());
    let restored = restore(&root.0, "test-id").unwrap();
    assert_eq!(
        crate::image_data::decode_image(&restored.images[0].data_base64).unwrap(),
        SVG
    );
    assert_eq!(fs::read(source).unwrap(), SVG);
}

#[test]
fn rejects_unknown_stash_keys_and_invalid_copy_metadata_before_writing_recovery() {
    let root = Fixture::new();
    let stash_root = tempfile::tempdir().unwrap();
    let state = ImageStash::default();
    let receipt = serde_json::to_value(
        state
            .insert_bytes(stash_root.path(), "source.svg", SVG)
            .unwrap(),
    )
    .unwrap();
    let stash_key = receipt["key"].as_str().unwrap();
    for (id, key, source, retained) in [
        (
            "test-id",
            "picture.svg",
            "00000000000000000000000000000000",
            vec![],
        ),
        ("../escape", "picture.svg", stash_key, vec![]),
        ("test-id", "../picture.svg", stash_key, vec![]),
        ("test-id", "picture.svg", "../source.svg", vec![]),
        (
            "test-id",
            "picture.svg",
            stash_key,
            vec!["../keep.svg".into()],
        ),
        ("test-id", "picture.jpg", stash_key, vec![]),
    ] {
        assert!(cache_stashed_image(&root.0, &state, id, key, source, &retained).is_err());
    }
    assert!(!root.0.join("test-id/picture.svg").exists());
    assert!(!root.0.join("test-id/picture.jpg").exists());
    assert_eq!(state.read_bytes(stash_key).unwrap(), SVG);
}

#[test]
fn reclaims_orphan_images_before_the_cache_capacity_check() {
    let root = Fixture::new();
    let dir = tab_dir(&root.0, "test-id", true).unwrap();
    for index in 0..5 {
        let file = fs::File::create(dir.join(format!("orphan-{index}.png"))).unwrap();
        file.set_len(MAX_IMAGE_FILE_BYTES).unwrap();
    }
    let cleanup = cache_image(&root.0, "test-id", "picture.svg", SVG, &[]).unwrap();
    assert_eq!(cleanup.removed_keys.len(), 5);
    assert!(cleanup.cleanup_error.is_none());
    let receipt = serde_json::to_value(&cleanup).unwrap();
    assert_eq!(receipt["removedKeys"].as_array().unwrap().len(), 5);
    assert!(receipt["cleanupError"].is_null());
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
    save(&root.0, snapshot(), &[]).unwrap();
    assert!(restore(&root.0, "test-id").is_ok());
}

#[test]
fn retains_in_flight_batch_images_then_reclaims_only_recovery_duplicates() {
    let root = Fixture::new();
    cache_image(&root.0, "test-id", "picture.svg", SVG, &[]).unwrap();
    save(&root.0, snapshot(), &[]).unwrap();
    let retained = vec!["batch-a.svg".into(), "batch-b.svg".into()];
    cache_image(&root.0, "test-id", "batch-a.svg", SVG, &retained).unwrap();
    cache_image(&root.0, "test-id", "batch-b.svg", SVG, &retained).unwrap();
    let source = root.0.join("user-source.svg");
    let stash = root.0.join("history-stash");
    fs::write(&source, SVG).unwrap();
    fs::create_dir(&stash).unwrap();
    fs::write(stash.join("picture.svg"), SVG).unwrap();
    let dir = root.0.join("test-id");
    fs::write(dir.join("unknown.txt"), b"preserve me").unwrap();
    fs::create_dir(dir.join("unknown-directory")).unwrap();
    let mut next = snapshot();
    next.markdown = "no images".into();
    next.images.clear();
    let cleanup = save(&root.0, next.clone(), &retained).unwrap();
    assert_eq!(cleanup.removed_keys, vec!["picture.svg"]);
    assert!(dir.join("batch-a.svg").is_file());
    assert!(dir.join("batch-b.svg").is_file());
    assert_eq!(save(&root.0, next, &[]).unwrap().removed_keys.len(), 2);
    assert!(dir.join("unknown.txt").is_file());
    assert!(dir.join("unknown-directory").is_dir());
    assert_eq!(fs::read(source).unwrap(), SVG);
    assert_eq!(fs::read(stash.join("picture.svg")).unwrap(), SVG);
    assert!(restore(&root.0, "test-id").is_ok());
}

#[test]
fn cleanup_failure_does_not_revoke_a_complete_new_snapshot() {
    let root = Fixture::new();
    cache_image(&root.0, "test-id", "picture.svg", SVG, &[]).unwrap();
    save(&root.0, snapshot(), &[]).unwrap();
    fs::create_dir(root.0.join("test-id/foreign.svg")).unwrap();
    let mut next = snapshot();
    next.markdown = "complete replacement".into();
    let cleanup = save(&root.0, next, &[]).unwrap();
    assert!(cleanup.cleanup_error.is_some());
    assert!(root.0.join("test-id/foreign.svg").is_dir());
    assert_eq!(
        restore(&root.0, "test-id").unwrap().snapshot.markdown,
        "complete replacement"
    );
}

#[test]
fn damaged_manifest_and_invalid_retained_keys_are_not_deletion_evidence() {
    let root = Fixture::new();
    let dir = tab_dir(&root.0, "test-id", true).unwrap();
    fs::write(dir.join("snapshot.json"), b"damaged").unwrap();
    fs::write(dir.join("old.svg"), SVG).unwrap();
    let cleanup = cache_image(&root.0, "test-id", "picture.svg", SVG, &[]).unwrap();
    assert!(cleanup.cleanup_error.is_some());
    assert!(dir.join("old.svg").is_file());
    assert_eq!(fs::read(dir.join("snapshot.json")).unwrap(), b"damaged");
    assert!(cache_image(&root.0, "test-id", "new.svg", SVG, &["../old.svg".into()]).is_err());
    assert!(save(&root.0, snapshot(), &["../old.svg".into()]).is_err());
    assert!(dir.join("old.svg").is_file());
    assert!(!dir.join("new.svg").exists());
}

#[test]
fn permits_disjoint_valid_attachment_sets_during_snapshot_replacement() {
    let root = Fixture::new();
    let mut data = SVG.to_vec();
    data.resize(40 * 1024 * 1024, b' ');
    let keys = |prefix: &str| {
        (0..4)
            .map(|index| format!("{prefix}-{index}.svg"))
            .collect::<Vec<_>>()
    };
    let old_keys = keys("old");
    let new_keys = keys("new");
    let mut old = snapshot();
    old.images = old_keys
        .iter()
        .map(|key| RecoveryImage {
            placeholder: format!("mdplus-image:{}", key.trim_end_matches(".svg")),
            filename: key.clone(),
            key: key.clone(),
        })
        .collect();
    old.markdown = old
        .images
        .iter()
        .map(|image| format!("![]({})", image.placeholder))
        .collect::<Vec<_>>()
        .join("\n");
    for key in &old_keys {
        cache_image(&root.0, "test-id", key, &data, &old_keys).unwrap();
    }
    save(&root.0, old.clone(), &[]).unwrap();
    for key in &new_keys {
        cache_image(&root.0, "test-id", key, &data, &new_keys).unwrap();
    }
    assert_eq!(
        read_snapshot(&root.0.join("test-id"), "test-id")
            .unwrap()
            .markdown,
        old.markdown
    );
    assert_eq!(
        read_limited(
            &root.0.join("test-id").join(&old_keys[0]),
            MAX_IMAGE_FILE_BYTES
        )
        .unwrap(),
        data
    );
    let mut next = old;
    next.images = new_keys
        .iter()
        .map(|key| RecoveryImage {
            placeholder: format!("mdplus-image:{}", key.trim_end_matches(".svg")),
            filename: key.clone(),
            key: key.clone(),
        })
        .collect();
    next.markdown = next
        .images
        .iter()
        .map(|image| format!("![]({})", image.placeholder))
        .collect::<Vec<_>>()
        .join("\n");
    let cleanup = save(&root.0, next, &[]).unwrap();
    assert_eq!(cleanup.removed_keys.len(), 4);
    for key in old_keys {
        assert!(!root.0.join("test-id").join(key).exists());
    }
    for key in new_keys {
        assert_eq!(
            fs::metadata(root.0.join("test-id").join(key))
                .unwrap()
                .len(),
            data.len() as u64
        );
    }
}
#[test]
fn unicode_paths_round_trip_and_cleanup() {
    let root = Fixture::new();
    cache_image(&root.0, "test-id", "picture.svg", SVG, &[]).unwrap();
    save(&root.0, snapshot(), &[]).unwrap();
    let result = restore(&root.0, "test-id").unwrap();
    assert_eq!(result.snapshot.markdown, snapshot().markdown);
    assert_eq!(
        crate::image_data::decode_image(&result.images[0].data_base64).unwrap(),
        SVG
    );
    assert_eq!(list(&root.0, &[], now_ms()).unwrap().len(), 1);
    assert!(list(&root.0, &["test-id".into()], now_ms())
        .unwrap()
        .is_empty());
    delete(&root.0, "test-id").unwrap();
    assert!(fs::read_dir(&root.0).unwrap().next().is_none());
}
#[test]
fn interrupted_temporary_manifest_does_not_replace_last_good_snapshot() {
    let root = Fixture::new();
    cache_image(&root.0, "test-id", "picture.svg", SVG, &[]).unwrap();
    save(&root.0, snapshot(), &[]).unwrap();
    fs::write(
        root.0.join("test-id/.snapshot.json.mdplus-crash.tmp"),
        b"{\"markdown\":",
    )
    .unwrap();
    assert_eq!(
        restore(&root.0, "test-id").unwrap().snapshot.markdown,
        snapshot().markdown
    );
    let mut next = snapshot();
    next.markdown = "新内容".into();
    save(&root.0, next, &[]).unwrap();
    assert_eq!(
        restore(&root.0, "test-id").unwrap().snapshot.markdown,
        "新内容"
    );
}
#[test]
fn refuses_snapshot_with_missing_attachment_without_losing_old_manifest() {
    let root = Fixture::new();
    cache_image(&root.0, "test-id", "picture.svg", SVG, &[]).unwrap();
    save(&root.0, snapshot(), &[]).unwrap();
    let mut next = snapshot();
    next.images[0].key = "missing.png".into();
    next.images[0].placeholder = "mdplus-image:missing".into();
    assert!(save(&root.0, next, &[]).is_err());
    assert!(restore(&root.0, "test-id").is_ok());
}
#[test]
fn cached_image_identity_cannot_be_overwritten() {
    let root = Fixture::new();
    cache_image(&root.0, "test-id", "picture.svg", SVG, &[]).unwrap();
    save(&root.0, snapshot(), &[]).unwrap();
    assert!(cache_image(&root.0, "test-id", "picture.svg", b"<svg/>", &[]).is_err());
    assert_eq!(
        crate::image_data::decode_image(
            &restore(&root.0, "test-id").unwrap().images[0].data_base64
        )
        .unwrap(),
        SVG
    );
}
#[test]
fn traversal_and_unexpected_directories_are_never_deleted() {
    let root = Fixture::new();
    assert!(cache_image(&root.0, "../escape", "picture.svg", SVG, &[]).is_err());
    assert!(cache_image(&root.0, "test-id", "../outside.svg", SVG, &[]).is_err());
    cache_image(&root.0, "test-id", "picture.svg", SVG, &[]).unwrap();
    fs::create_dir(root.0.join("test-id/foreign")).unwrap();
    assert!(delete(&root.0, "test-id").is_err());
    assert!(root.0.join("test-id/picture.svg").exists());
}
#[test]
fn expires_only_inactive_recovery_directories_after_seven_days() {
    let root = Fixture::new();
    cache_image(&root.0, "test-id", "picture.svg", SVG, &[]).unwrap();
    save(&root.0, snapshot(), &[]).unwrap();
    assert!(list(
        &root.0,
        &["test-id".into()],
        now_ms() + RETENTION_MS + 10000
    )
    .unwrap()
    .is_empty());
    assert!(root.0.join("test-id").exists());
    assert!(list(&root.0, &[], now_ms() + RETENTION_MS + 10000)
        .unwrap()
        .is_empty());
    assert!(!root.0.join("test-id").exists());
}
#[test]
fn damaged_manifest_is_reported_not_silently_removed() {
    let root = Fixture::new();
    let dir = tab_dir(&root.0, "test-id", true).unwrap();
    fs::write(dir.join("snapshot.json"), b"broken").unwrap();
    assert!(list(&root.0, &[], now_ms()).unwrap()[0].damaged);
    assert!(restore(&root.0, "test-id").is_err());
}
#[test]
fn missing_attachment_is_reported_damaged_without_removing_the_manifest() {
    let root = Fixture::new();
    cache_image(&root.0, "test-id", "picture.svg", SVG, &[]).unwrap();
    save(&root.0, snapshot(), &[]).unwrap();
    let manifest = root.0.join("test-id/snapshot.json");
    let previous = fs::read(&manifest).unwrap();
    fs::remove_file(root.0.join("test-id/picture.svg")).unwrap();
    let mut healthy = snapshot();
    healthy.id = "healthy-id".into();
    healthy.markdown = "intact draft".into();
    healthy.images.clear();
    save(&root.0, healthy, &[]).unwrap();

    let entries = list(&root.0, &[], now_ms()).unwrap();
    assert_eq!(entries.len(), 2);
    assert!(
        entries
            .iter()
            .find(|entry| entry.id == "test-id")
            .unwrap()
            .damaged
    );
    assert!(
        !entries
            .iter()
            .find(|entry| entry.id == "healthy-id")
            .unwrap()
            .damaged
    );
    assert!(restore(&root.0, "test-id").is_err());
    assert_eq!(
        restore(&root.0, "healthy-id").unwrap().snapshot.markdown,
        "intact draft"
    );
    assert_eq!(fs::read(manifest).unwrap(), previous);
}
#[test]
fn oversized_attachment_is_reported_damaged_and_left_untouched() {
    let root = Fixture::new();
    cache_image(&root.0, "test-id", "picture.svg", SVG, &[]).unwrap();
    save(&root.0, snapshot(), &[]).unwrap();
    let image = root.0.join("test-id/picture.svg");
    let file = fs::File::create(&image).unwrap();
    file.set_len(MAX_IMAGE_FILE_BYTES + 1).unwrap();
    drop(file);

    assert!(list(&root.0, &[], now_ms()).unwrap()[0].damaged);
    assert_eq!(fs::metadata(image).unwrap().len(), MAX_IMAGE_FILE_BYTES + 1);
    assert!(root.0.join("test-id/snapshot.json").is_file());
}
#[test]
fn crash_writer_child() {
    use std::io::Write;
    let Some(target) = std::env::var_os("MDPLUS_TEST_CRASH_TARGET") else {
        return;
    };
    let (mut file, _) = crate::create_temp_file(Path::new(&target)).unwrap();
    file.write_all(b"{\"markdown\":\"half").unwrap();
    file.sync_all().unwrap();
    std::process::exit(23);
}
#[test]
fn process_exit_during_write_keeps_last_complete_manifest() {
    let root = Fixture::new();
    cache_image(&root.0, "test-id", "picture.svg", SVG, &[]).unwrap();
    save(&root.0, snapshot(), &[]).unwrap();
    let result = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "recovery::tests::crash_writer_child",
            "--nocapture",
        ])
        .env(
            "MDPLUS_TEST_CRASH_TARGET",
            root.0.join("test-id/snapshot.json"),
        )
        .status()
        .unwrap();
    assert_eq!(result.code(), Some(23));
    assert_eq!(
        restore(&root.0, "test-id").unwrap().snapshot.markdown,
        snapshot().markdown
    );
}
#[test]
#[cfg(windows)]
fn locked_manifest_does_not_destroy_previous_snapshot() {
    use std::os::windows::fs::OpenOptionsExt;
    let root = Fixture::new();
    cache_image(&root.0, "test-id", "picture.svg", SVG, &[]).unwrap();
    save(&root.0, snapshot(), &[]).unwrap();
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(root.0.join("test-id/snapshot.json"))
        .unwrap();
    let mut next = snapshot();
    next.markdown = "replacement".into();
    assert!(save(&root.0, next, &[]).is_err());
    drop(lock);
    assert_eq!(
        restore(&root.0, "test-id").unwrap().snapshot.markdown,
        snapshot().markdown
    );
}
