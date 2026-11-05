use super::*;

#[test]
fn export_ipc_rejects_non_html_targets_without_writing() {
    let root = tempfile::tempdir().unwrap();
    for name in [
        "notes.md",
        "script.js",
        "program.exe",
        "file.txt",
        "NUL.html",
    ] {
        let path = root.path().join(name);
        assert!(export_html(
            path.to_string_lossy().into_owned(),
            "<html>export</html>".into()
        )
        .is_err());
        assert!(!path.exists());
    }
}

#[test]
fn export_ipc_rejects_oversized_content_before_any_write() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("large.html");
    assert!(export_html(
        path.to_string_lossy().into_owned(),
        "x".repeat(MAX_TEXT_FILE_BYTES as usize + 1)
    )
    .is_err());
    assert!(!path.exists());
}

#[test]
fn export_ipc_writes_html_to_a_validated_regular_target() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("page.html");
    export_html(
        path.to_string_lossy().into_owned(),
        "<html>export</html>".into(),
    )
    .unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "<html>export</html>");
}
