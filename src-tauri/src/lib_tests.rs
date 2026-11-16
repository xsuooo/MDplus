use super::*;

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "mdplus-image-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn image_paths_are_limited_to_the_document_directory() {
    let root = TestDirectory::new();
    let docs = root.0.join("docs");
    fs::create_dir_all(docs.join("img")).unwrap();
    let document = docs.join("note.md");
    fs::write(&document, "document").unwrap();
    fs::write(docs.join("img/picture.png"), b"image").unwrap();
    fs::write(root.0.join("secret.png"), b"secret").unwrap();

    assert!(document_image_path(&document, Path::new("img/picture.png")).is_ok());
    assert!(document_image_path(&document, Path::new("../secret.png")).is_err());
    assert!(document_image_path(&document, &root.0.join("secret.png")).is_err());
    assert!(document_image_path(&document, Path::new("img/missing.png")).is_err());
}

#[cfg(windows)]
#[test]
fn windows_absolute_and_drive_relative_image_paths_are_rejected() {
    let root = TestDirectory::new();
    let document = root.0.join("note.md");
    fs::write(&document, "document").unwrap();
    for reference in [
        r"C:\private\secret.png",
        r"C:private\secret.png",
        r"\private\secret.png",
        r"\\server\share\secret.png",
        r"\\?\C:\private\secret.png",
    ] {
        assert!(document_image_path(&document, Path::new(reference)).is_err());
    }
}

#[test]
fn directory_links_cannot_escape_the_document_directory() {
    let root = TestDirectory::new();
    let docs = root.0.join("docs");
    let outside = root.0.join("outside");
    fs::create_dir(&docs).unwrap();
    fs::create_dir(&outside).unwrap();
    let document = docs.join("note.md");
    fs::write(&document, "document").unwrap();
    fs::write(outside.join("secret.png"), b"secret").unwrap();
    let link = docs.join("linked");
    #[cfg(windows)]
    {
        let output = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .output()
            .unwrap();
        assert!(output.status.success());
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, &link).unwrap();

    assert!(document_image_path(&document, Path::new("linked/secret.png")).is_err());
    #[cfg(windows)]
    fs::remove_dir(&link).unwrap();
    #[cfg(unix)]
    fs::remove_file(&link).unwrap();
}

#[test]
fn image_content_must_match_a_supported_extension() {
    let png = [
        0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R',
    ];
    assert_eq!(image_mime(Path::new("image.png"), &png), Ok("image/png"));
    assert!(image_mime(Path::new("secret.png"), b"PRIVATE_KEY=secret").is_err());
    assert!(image_mime(Path::new("secret.txt"), &png).is_err());
    assert!(image_mime(Path::new("image.jpg"), &png).is_err());
    assert!(image_mime(Path::new("image.svg"), b"not an image").is_err());
    assert!(image_mime(Path::new("image.svg"), b"<html/>").is_err());
    assert!(image_mime(Path::new("image.svg"), b"<svg><g>").is_err());
    assert!(image_mime(Path::new("image.svg"), b"<!DOCTYPE svg><svg/>").is_err());
    assert_eq!(
        image_mime(
            Path::new("image.svg"),
            br#"<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>"#
        ),
        Ok("image/svg+xml")
    );
}

#[test]
fn image_command_rejects_disguised_non_images() {
    let root = TestDirectory::new();
    let document = root.0.join("note.md");
    fs::write(&document, "document").unwrap();
    fs::write(root.0.join("secret.png"), "PRIVATE_KEY=secret").unwrap();
    assert!(read_image_file(
        document.to_string_lossy().into_owned(),
        "secret.png".to_owned()
    )
    .is_err());
}

#[test]
fn startup_files_are_consumed_only_once() {
    let startup_files = StartupFiles::new(vec!["README.md".to_string()]);

    assert_eq!(startup_files.take(), vec!["README.md"]);
    assert!(startup_files.take().is_empty());
}

#[test]
fn pending_open_files_survive_before_frontend_listener_is_ready() {
    let pending = PendingOpenFiles::default();
    pending.push(vec!["first.md".to_string()]);
    pending.push(vec!["second.md".to_string()]);

    assert_eq!(pending.take(), vec!["first.md", "second.md"]);
    assert!(pending.take().is_empty());
}

#[test]
fn review_m7_single_instance_does_not_discard_sender_cwd() {
    assert!(!include_str!("lib.rs").contains("|app, args, _cwd|"));
}

#[test]
fn startup_file_arguments_are_detected_before_webview_creation() {
    let files = markdown_files_from_args(
        vec![
            "mdplus.exe".to_string(),
            "README.md".to_string(),
            "notes.txt".to_string(),
            "missing.md".to_string(),
        ],
        &std::env::current_dir().unwrap(),
        |path| {
            Path::new(path)
                .file_name()
                .is_some_and(|name| name == "README.md")
        },
    );

    assert_eq!(
        files,
        vec![std::env::current_dir()
            .unwrap()
            .join("README.md")
            .to_string_lossy()]
    );
}

#[test]
fn review_m7_arguments_use_sender_cwd_and_are_queued_as_absolute_regular_files() {
    let root = TestDirectory::new();
    let primary = root.0.join("primary");
    let sender = root.0.join("sender");
    fs::create_dir(&primary).unwrap();
    fs::create_dir(&sender).unwrap();
    fs::write(primary.join("same.md"), "wrong primary").unwrap();
    fs::write(sender.join("same.md"), "correct sender").unwrap();
    fs::write(sender.join("中文.MARKDOWN"), "correct unicode").unwrap();
    fs::create_dir(sender.join("directory.md")).unwrap();
    let absolute = primary.join("same.md").to_string_lossy().into_owned();
    let cwd_before = std::env::current_dir().unwrap();
    let files = markdown_files_from_args(
        vec![
            "mdplus.exe".into(),
            "same.md".into(),
            "中文.MARKDOWN".into(),
            "missing.md".into(),
            "directory.md".into(),
            "notes.txt".into(),
            absolute.clone(),
        ],
        &sender,
        |path| Path::new(path).is_file(),
    );
    assert_eq!(
        files,
        vec![
            sender.join("same.md").to_string_lossy().into_owned(),
            sender.join("中文.MARKDOWN").to_string_lossy().into_owned(),
            absolute
        ]
    );
    assert!(files.iter().all(|path| Path::new(path).is_absolute()));
    assert_eq!(fs::read_to_string(&files[0]).unwrap(), "correct sender");
    assert_eq!(std::env::current_dir().unwrap(), cwd_before);
    let pending = PendingOpenFiles::default();
    pending.push(files.clone());
    assert_eq!(pending.take(), files);
}

#[test]
fn review_m7_invalid_sender_cwd_never_falls_back_to_primary_cwd() {
    let root = TestDirectory::new();
    let absolute = root.0.join("note.md").to_string_lossy().into_owned();
    let files = markdown_files_from_args(
        vec!["app".into(), "relative.md".into(), absolute.clone()],
        Path::new("not-an-absolute-cwd"),
        |_| true,
    );
    assert_eq!(files, vec![absolute]);
}

#[cfg(windows)]
#[test]
fn review_m7_drive_relative_arguments_are_bound_only_to_sender_drive() {
    let files = markdown_files_from_args(
        vec![
            "app".into(),
            r"D:note.md".into(),
            r"C:other.md".into(),
            r"\root.md".into(),
        ],
        Path::new(r"D:\sender"),
        |_| true,
    );
    assert_eq!(files, vec![r"D:\sender\note.md", r"D:\root.md"]);
}

#[test]
fn utf8_passthrough_unchanged() {
    assert_eq!(
        decode_text("你好 MDPlus".as_bytes()).unwrap(),
        "你好 MDPlus"
    );
}

#[test]
fn utf8_bom_is_stripped() {
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice("中文".as_bytes());
    assert_eq!(decode_text(&bytes).unwrap(), "中文");
}

#[test]
fn gbk_roundtrip_preserves_chinese() {
    // GBK 编码的中文文件不再被 from_utf8_lossy 打成 U+FFFD
    let (gbk, _, _) = encoding_rs::GBK.encode("中文测试内容 123");
    let text = decode_text(&gbk).unwrap();
    assert_eq!(text, "中文测试内容 123");
    assert!(!text.contains('\u{FFFD}'));
}

#[test]
fn utf16le_bom_is_decoded() {
    let mut bytes = vec![0xFF, 0xFE];
    for u in "你好 UTF-16".encode_utf16() {
        bytes.extend_from_slice(&u.to_le_bytes());
    }
    assert_eq!(decode_text(&bytes).unwrap(), "你好 UTF-16");
}

#[test]
fn utf16be_bom_is_decoded() {
    let mut bytes = vec![0xFE, 0xFF];
    for u in "你好 UTF-16".encode_utf16() {
        bytes.extend_from_slice(&u.to_be_bytes());
    }
    assert_eq!(decode_text(&bytes).unwrap(), "你好 UTF-16");
}

#[test]
fn binary_payload_is_detected_but_utf16_is_allowed() {
    assert!(looks_binary(b"text\0payload"));
    assert!(!looks_binary(&[0xFF, 0xFE, 0x00, 0x4E]));
}

#[test]
fn completion_decode_rejects_odd_utf16le_without_changing_source() {
    let root = TestDirectory::new();
    let path = root.0.join("odd-le.md");
    let bytes = [0xFF, 0xFE, b'a', 0, b'b'];
    fs::write(&path, bytes).unwrap();
    assert!(safe_files::read_document(path.to_string_lossy().into_owned()).is_err());
    assert_eq!(fs::read(path).unwrap(), bytes);
}

#[test]
fn completion_decode_rejects_odd_utf16be_without_changing_source() {
    let root = TestDirectory::new();
    let path = root.0.join("odd-be.md");
    let bytes = [0xFE, 0xFF, 0, b'a', 0];
    fs::write(&path, bytes).unwrap();
    assert!(safe_files::read_document(path.to_string_lossy().into_owned()).is_err());
    assert_eq!(fs::read(path).unwrap(), bytes);
}

#[test]
fn completion_decode_rejects_invalid_utf16_surrogates_without_gbk_fallback() {
    let root = TestDirectory::new();
    for (index, bytes) in [vec![0xFF, 0xFE, 0x00, 0xD8], vec![0xFE, 0xFF, 0xDC, 0x00]]
        .into_iter()
        .enumerate()
    {
        let path = root.0.join(format!("surrogate-{index}.md"));
        fs::write(&path, &bytes).unwrap();
        assert!(safe_files::read_document(path.to_string_lossy().into_owned()).is_err());
        assert_eq!(fs::read(path).unwrap(), bytes);
    }
}

#[test]
fn completion_decode_rejects_gbk_replacement_characters() {
    let root = TestDirectory::new();
    let path = root.0.join("invalid-gbk.md");
    fs::write(&path, [0x81]).unwrap();
    assert!(safe_files::read_document(path.to_string_lossy().into_owned()).is_err());
    assert_eq!(fs::read(path).unwrap(), [0x81]);
}

#[test]
fn completion_decode_honors_utf8_bom_instead_of_falling_back_to_gbk() {
    let root = TestDirectory::new();
    let path = root.0.join("invalid-utf8.md");
    let bytes = [0xEF, 0xBB, 0xBF, 0xC4, 0xE3];
    fs::write(&path, bytes).unwrap();
    assert!(safe_files::read_document(path.to_string_lossy().into_owned()).is_err());
    assert_eq!(fs::read(path).unwrap(), bytes);
}

#[test]
fn atomic_write_replaces_existing_file() {
    let path = std::env::temp_dir().join(format!(
        "mdplus-atomic-write-{}-{}.md",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::write(&path, "旧内容").unwrap();
    write_file_atomic(&path, "新内容".as_bytes()).unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), "新内容");
    let _ = fs::remove_file(path);
}
