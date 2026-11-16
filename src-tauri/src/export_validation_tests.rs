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
    // Exercise the exact command preflight without allocating a >512 MiB string.
    assert!(validate_html_export(&path, MAX_HTML_EXPORT_BYTES + 1).is_err());
    assert!(validate_html_export(&path, MAX_HTML_EXPORT_BYTES).is_ok());
    assert!(!path.exists());
    // An existing target over the export budget is also rejected before mutation.
    let file = File::create(&path).unwrap();
    file.set_len(MAX_HTML_EXPORT_BYTES + 1).unwrap();
    drop(file);
    assert!(export_html(path.to_string_lossy().into_owned(), "<html/>".into()).is_err());
    assert_eq!(fs::metadata(path).unwrap().len(), MAX_HTML_EXPORT_BYTES + 1);
}

#[test]
fn review_h2_default_font_sized_html_can_be_created_and_replaced() {
    // The bundled default fonts alone encode to 35,765,708 bytes. A real minimal
    // hello export is 35,891,148 bytes, already above the 32 MiB document budget.
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("default-fonts.html");
    let mut html = "<html><style>/*".to_owned();
    html.push_str(&"A".repeat(35_891_148 - html.len() - "*/</style>hello</html>".len()));
    html.push_str("*/</style>hello</html>");
    assert_eq!(html.len(), 35_891_148);
    assert!(html.len() as u64 > MAX_TEXT_FILE_BYTES);
    export_html(path.to_string_lossy().into_owned(), html.clone()).unwrap();
    assert_eq!(fs::read(&path).unwrap(), html.as_bytes());
    // Revision probing, previous-copy verification and read-back must use the
    // export budget too, not just the command's input preflight.
    export_html(path.to_string_lossy().into_owned(), html.clone()).unwrap();
    assert_eq!(fs::read(&path).unwrap(), html.as_bytes());
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
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
