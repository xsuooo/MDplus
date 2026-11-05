use super::*;

#[test]
fn failed_read_preserves_the_original_file_and_allows_retry() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("settings.json");
    fs::write(&path, "{broken settings").unwrap();
    assert!(read_settings(&path).is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "{broken settings");
    fs::write(&path, r#"{"theme-mode":"dark"}"#).unwrap();
    assert_eq!(read_settings(&path).unwrap()["theme-mode"], "dark");
}

#[test]
fn missing_settings_use_defaults_but_directories_and_invalid_shapes_fail() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("settings.json");
    assert!(read_settings(&path).unwrap().is_empty());
    assert!(read_settings(root.path()).is_err());
    for invalid in ["[]", "null", "42", ""] {
        fs::write(&path, invalid).unwrap();
        assert!(read_settings(&path).is_err());
    }
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
