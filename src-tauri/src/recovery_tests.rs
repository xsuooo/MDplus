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
fn unicode_paths_round_trip_and_cleanup() {
    let root = Fixture::new();
    cache_image(&root.0, "test-id", "picture.svg", SVG).unwrap();
    save(&root.0, snapshot()).unwrap();
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
    cache_image(&root.0, "test-id", "picture.svg", SVG).unwrap();
    save(&root.0, snapshot()).unwrap();
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
    save(&root.0, next).unwrap();
    assert_eq!(
        restore(&root.0, "test-id").unwrap().snapshot.markdown,
        "新内容"
    );
}
#[test]
fn refuses_snapshot_with_missing_attachment_without_losing_old_manifest() {
    let root = Fixture::new();
    cache_image(&root.0, "test-id", "picture.svg", SVG).unwrap();
    save(&root.0, snapshot()).unwrap();
    let mut next = snapshot();
    next.images[0].key = "missing.png".into();
    next.images[0].placeholder = "mdplus-image:missing".into();
    assert!(save(&root.0, next).is_err());
    assert!(restore(&root.0, "test-id").is_ok());
}
#[test]
fn cached_image_identity_cannot_be_overwritten() {
    let root = Fixture::new();
    cache_image(&root.0, "test-id", "picture.svg", SVG).unwrap();
    save(&root.0, snapshot()).unwrap();
    assert!(cache_image(&root.0, "test-id", "picture.svg", b"<svg/>").is_err());
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
    assert!(cache_image(&root.0, "../escape", "picture.svg", SVG).is_err());
    assert!(cache_image(&root.0, "test-id", "../outside.svg", SVG).is_err());
    cache_image(&root.0, "test-id", "picture.svg", SVG).unwrap();
    fs::create_dir(root.0.join("test-id/foreign")).unwrap();
    assert!(delete(&root.0, "test-id").is_err());
    assert!(root.0.join("test-id/picture.svg").exists());
}
#[test]
fn expires_only_inactive_recovery_directories_after_seven_days() {
    let root = Fixture::new();
    cache_image(&root.0, "test-id", "picture.svg", SVG).unwrap();
    save(&root.0, snapshot()).unwrap();
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
    cache_image(&root.0, "test-id", "picture.svg", SVG).unwrap();
    save(&root.0, snapshot()).unwrap();
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
    cache_image(&root.0, "test-id", "picture.svg", SVG).unwrap();
    save(&root.0, snapshot()).unwrap();
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(root.0.join("test-id/snapshot.json"))
        .unwrap();
    let mut next = snapshot();
    next.markdown = "replacement".into();
    assert!(save(&root.0, next).is_err());
    drop(lock);
    assert_eq!(
        restore(&root.0, "test-id").unwrap().snapshot.markdown,
        snapshot().markdown
    );
}
