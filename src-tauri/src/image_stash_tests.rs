use super::*;

#[test]
fn review_m8_session_stash_roundtrips_repeated_reads_and_releases_owned_bytes() {
    let root = tempfile::tempdir().unwrap();
    let mut stash = Stash::default();
    let a = stash
        .insert(root.path(), "one.svg", b"<svg/>", 1024)
        .unwrap();
    let b = stash
        .insert(root.path(), "two.svg", b"<svg><text>two</text></svg>", 1024)
        .unwrap();
    for key in [&a.key, &b.key, &a.key, &b.key] {
        let image = stash.read(key).unwrap();
        let bytes = image_data::decode_image(&image.data_base64).unwrap();
        assert_eq!(image.mime, "image/svg+xml");
        assert_eq!(
            bytes,
            if key == &a.key {
                b"<svg/>".as_slice()
            } else {
                b"<svg><text>two</text></svg>".as_slice()
            }
        );
    }
    assert!(stash.read("../foreign").is_err());
    stash
        .discard(vec![a.key.clone(), "../foreign".into()])
        .unwrap();
    assert!(stash.read(&a.key).is_err());
    assert!(stash.read(&b.key).is_ok());
    stash.discard(vec![a.key, b.key]).unwrap();
    assert_eq!(stash.total_bytes, 0);
    assert!(stash.files.is_empty());
    assert_eq!(
        fs::read_dir(stash.directory.as_ref().unwrap().path())
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn review_m8_stash_capacity_and_bad_input_fail_without_eviction_or_partial_accounting() {
    let root = tempfile::tempdir().unwrap();
    let mut stash = Stash::default();
    let a = stash.insert(root.path(), "one.svg", b"<svg/>", 6).unwrap();
    for (name, bytes) in [
        ("two.svg", b"<svg/>".as_slice()),
        ("bad.png", b"not png".as_slice()),
        ("../escape.svg", b"<svg/>".as_slice()),
    ] {
        assert!(stash.insert(root.path(), name, bytes, 6).is_err());
    }
    assert_eq!(stash.total_bytes, 6);
    assert_eq!(stash.files.len(), 1);
    assert_eq!(
        image_data::decode_image(&stash.read(&a.key).unwrap().data_base64).unwrap(),
        b"<svg/>"
    );
    stash.discard(vec![a.key]).unwrap();
    let next = stash.insert(root.path(), "two.svg", b"<svg/>", 6).unwrap();
    assert!(stash.read(&next.key).is_ok());
}

#[test]
fn review_m8_preview_protocol_only_serves_owned_keys_with_safe_headers() {
    let root = tempfile::tempdir().unwrap();
    let mut stash = Stash::default();
    let a = stash.insert(root.path(), "one.svg", b"<svg/>", 64).unwrap();
    let request = tauri::http::Request::builder()
        .uri(&a.preview_url)
        .body(Vec::new())
        .unwrap();
    for _ in 0..3 {
        let response = preview_from_stash(&mut stash, &request);
        assert_eq!(response.status(), 200);
        assert_eq!(response.body(), b"<svg/>");
        assert_eq!(response.headers()["Content-Type"], "image/svg+xml");
        assert_eq!(response.headers()["X-Content-Type-Options"], "nosniff");
        assert_eq!(response.headers()["Cache-Control"], "no-store");
        let csp = response.headers()["Content-Security-Policy"]
            .to_str()
            .unwrap();
        assert!(csp.contains("script-src 'none'") && csp.contains("sandbox"));
        let directives: Vec<_> = csp.split(';').map(str::trim).collect();
        assert_eq!(
            directives
                .iter()
                .copied()
                .find(|entry| entry.starts_with("font-src")),
            Some("font-src data:"),
            "embedded SVG fonts must render without enabling HTTP or wildcard font sources",
        );
        assert!(directives.contains(&"default-src 'none'"));
        assert!(directives.contains(&"script-src 'none'"));
        assert!(directives.contains(&"sandbox"));
        assert!(!response
            .headers()
            .contains_key("Access-Control-Allow-Origin"));
    }
    for path in [
        "/../secret.png",
        "/%2e%2e%2fsecret.png",
        "/00000000000000000000000000000000",
        "/C:/private",
    ] {
        let invalid = tauri::http::Request::builder()
            .uri(path)
            .body(Vec::new())
            .unwrap();
        assert_eq!(preview_from_stash(&mut stash, &invalid).status(), 404);
    }
    let invalid_method = tauri::http::Request::builder()
        .method("POST")
        .uri(&a.preview_url)
        .body(Vec::new())
        .unwrap();
    assert_eq!(
        preview_from_stash(&mut stash, &invalid_method).status(),
        405
    );
    stash.discard(vec![a.key]).unwrap();
    assert_eq!(preview_from_stash(&mut stash, &request).status(), 404);
}

#[cfg(windows)]
#[test]
fn stash_crash_writer_child() {
    let Some(root) = std::env::var_os("MDPLUS_TEST_STASH_CRASH_ROOT") else {
        return;
    };
    let root = std::path::PathBuf::from(root);
    let mut stash = Stash::default();
    stash.insert(&root, "one.svg", b"<svg/>", 64).unwrap();
    fs::write(
        root.join("session-path.txt"),
        stash
            .directory
            .as_ref()
            .unwrap()
            .path()
            .to_string_lossy()
            .as_bytes(),
    )
    .unwrap();
    std::process::exit(24);
}

#[cfg(windows)]
#[test]
fn review_m8_process_termination_closes_delete_pending_stash_images() {
    let root = tempfile::tempdir().unwrap();
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "image_stash::tests::stash_crash_writer_child",
            "--nocapture",
        ])
        .env("MDPLUS_TEST_STASH_CRASH_ROOT", root.path())
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(24));
    let session =
        std::path::PathBuf::from(fs::read_to_string(root.path().join("session-path.txt")).unwrap());
    assert!(session.starts_with(root.path()));
    assert_eq!(
        fs::read_dir(session).unwrap().count(),
        0,
        "terminated child retained image bytes"
    );
}

#[test]
fn review_m8_stash_lifetime_is_independent_of_recovery_directory_cleanup() {
    let root = tempfile::tempdir().unwrap();
    let mut stash = Stash::default();
    let a = stash
        .insert(&root.path().join("stash"), "one.svg", b"<svg/>", 64)
        .unwrap();
    let recovery = root.path().join("recovery-v1");
    fs::create_dir(&recovery).unwrap();
    fs::write(recovery.join("snapshot.json"), "{}").unwrap();
    fs::remove_dir_all(&recovery).unwrap();
    assert!(stash.read(&a.key).is_ok());
    let session = stash.directory.as_ref().unwrap().path().to_owned();
    drop(stash);
    assert!(!session.exists());
}
