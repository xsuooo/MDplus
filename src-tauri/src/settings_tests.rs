use super::*;
use std::fs::File;

#[test]
fn review_m3_no_plugin_store_can_truncate_settings_on_save_or_exit() {
    let startup = include_str!("lib.rs");
    assert!(
        !startup.contains("tauri_plugin_store::"),
        "plugin-store Exit saves unconditionally using fs::write"
    );
    assert!(!include_str!("../Cargo.toml").contains("tauri-plugin-store ="));
}

#[test]
fn failed_read_preserves_the_original_file_and_allows_retry() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("settings.json");
    fs::write(&path, "{broken settings").unwrap();
    assert!(read_settings(&path).is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "{broken settings");
    fs::write(&path, r#"{"theme-mode":"dark"}"#).unwrap();
    assert_eq!(read_settings(&path).unwrap().values["theme-mode"], "dark");
}

#[test]
fn missing_settings_use_defaults_but_directories_and_invalid_shapes_fail() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("settings.json");
    assert!(read_settings(&path).unwrap().values.is_empty());
    assert!(read_settings(root.path()).is_err());
    for invalid in ["[]", "null", "42", ""] {
        fs::write(&path, invalid).unwrap();
        assert!(read_settings(&path).is_err());
    }
}

fn values(theme: &str) -> Values {
    HashMap::from([("theme-mode".into(), serde_json::json!(theme))])
}

#[test]
fn review_m3_settings_roundtrip_preserves_keys_and_returns_the_committed_revision() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("settings.json");
    let initial = read_settings(&path).unwrap();
    assert!(initial.revision.is_none());
    let first = persist_settings(&path, values("dark"), initial.revision).unwrap();
    let loaded = read_settings(&path).unwrap();
    assert_eq!(loaded.revision, Some(first.revision));
    assert_eq!(loaded.values["theme-mode"], "dark");
    let mut updated = loaded.values;
    updated.insert(
        "unknown-future-key".into(),
        serde_json::json!({"preserved": true}),
    );
    let second = persist_settings(&path, updated, loaded.revision).unwrap();
    let loaded = read_settings(&path).unwrap();
    assert_eq!(loaded.revision, Some(second.revision));
    assert_eq!(loaded.values["unknown-future-key"]["preserved"], true);
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
}

#[test]
fn review_m3_stale_or_missing_revision_cannot_replace_external_or_damaged_settings() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("settings.json");
    fs::write(&path, r#"{"theme-mode":"light"}"#).unwrap();
    let loaded = read_settings(&path).unwrap();
    fs::write(&path, r#"{"theme-mode":"external"}"#).unwrap();
    assert!(persist_settings(&path, values("local"), loaded.revision).is_err());
    assert_eq!(
        read_settings(&path).unwrap().values["theme-mode"],
        "external"
    );
    fs::write(&path, "{damaged original").unwrap();
    assert!(read_settings(&path).is_err());
    assert!(persist_settings(&path, values("local"), None).is_err());
    assert_eq!(fs::read_to_string(path).unwrap(), "{damaged original");
}

#[cfg(windows)]
#[test]
fn review_m3_interrupted_replacement_keeps_complete_old_settings_and_allows_retry() {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("settings.json");
    let original = r#"{"theme-mode":"light","outline-open":true}"#;
    fs::write(&path, original).unwrap();
    let expected = read_settings(&path).unwrap().revision;
    // Reads and in-place writes would be allowed, but atomic replacement is not.
    // The old plugin fs::write path would truncate here; our writer must fail.
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .open(&path)
        .unwrap();
    let error = persist_settings(&path, values("dark"), expected.clone()).unwrap_err();
    assert!(error.contains("本地副本"));
    assert_eq!(fs::read_to_string(&path).unwrap(), original);
    drop(held);
    let receipt = persist_settings(&path, values("dark"), expected).unwrap();
    let loaded = read_settings(&path).unwrap();
    assert_eq!(loaded.revision, Some(receipt.revision));
    assert_eq!(loaded.values["theme-mode"], "dark");
}

#[test]
fn review_m3_oversized_save_cannot_change_previous_settings() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("settings.json");
    fs::write(&path, r#"{"theme-mode":"light"}"#).unwrap();
    let expected = read_settings(&path).unwrap().revision;
    assert!(persist_settings(
        &path,
        values(&"x".repeat(MAX_SETTINGS_FILE_BYTES as usize)),
        expected
    )
    .is_err());
    assert_eq!(read_settings(&path).unwrap().values["theme-mode"], "light");
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
}

#[test]
fn settings_crash_writer_child() {
    let Some(path) = std::env::var_os("MDPLUS_TEST_SETTINGS_CRASH_TARGET") else {
        return;
    };
    let path = PathBuf::from(path);
    let expected = read_settings(&path).unwrap().revision;
    crate::safe_files::hooks::at(crate::safe_files::hooks::Checkpoint::BeforeCommit, |_| {
        std::process::exit(25);
    });
    let _ = persist_settings(&path, values("never fully committed"), expected);
    panic!("crash checkpoint was not reached");
}

#[test]
fn review_m3_process_exit_before_atomic_commit_keeps_complete_old_settings() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("settings.json");
    let original = r#"{"theme-mode":"light","outline-open":true}"#;
    fs::write(&path, original).unwrap();
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "settings::tests::settings_crash_writer_child",
            "--nocapture",
        ])
        .env("MDPLUS_TEST_SETTINGS_CRASH_TARGET", &path)
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(25));
    assert_eq!(fs::read_to_string(&path).unwrap(), original);
    let expected = read_settings(&path).unwrap().revision;
    persist_settings(&path, values("retry succeeds"), expected).unwrap();
    assert_eq!(
        read_settings(&path).unwrap().values["theme-mode"],
        "retry succeeds"
    );
}

#[test]
fn oversized_settings_are_not_loaded_or_rewritten() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("settings.json");
    let file = File::create(&path).unwrap();
    file.set_len(MAX_SETTINGS_FILE_BYTES + 1).unwrap();
    assert!(read_settings(&path).is_err());
    assert_eq!(
        fs::metadata(&path).unwrap().len(),
        MAX_SETTINGS_FILE_BYTES + 1
    );
}
