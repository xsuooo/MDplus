use crate::image_data::encode_image;
use crate::safe_files::{commit_image_assets, discard_image_assets, save_image_asset};
use std::fs;

fn create(root: &std::path::Path, bytes: &[u8]) -> crate::safe_files::ImageReceipt {
    save_image_asset(
        root.join("note.md").to_string_lossy().into_owned(),
        "picture.svg".into(),
        encode_image(bytes),
    )
    .unwrap()
}

#[test]
fn review_m4_abandoned_assets_are_owned_and_discarded_without_touching_existing_files() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("assets")).unwrap();
    fs::write(
        root.path().join("assets/picture.svg"),
        b"<svg><text>external</text></svg>",
    )
    .unwrap();
    let image = create(root.path(), b"<svg/>");
    assert_ne!(image.filename, "picture.svg");
    let id = image.allocation_id.unwrap();
    discard_image_assets(vec![id.clone()]).unwrap();
    assert!(!std::path::Path::new(&image.path).exists());
    assert_eq!(
        fs::read(root.path().join("assets/picture.svg")).unwrap(),
        b"<svg><text>external</text></svg>"
    );
    discard_image_assets(vec![id]).unwrap();
}

#[test]
fn review_m4_commit_and_exact_content_reuse_grant_no_further_deletion_rights() {
    let root = tempfile::tempdir().unwrap();
    let first = create(root.path(), b"<svg/>");
    let id = first.allocation_id.unwrap();
    commit_image_assets(vec![id.clone()]).unwrap();
    let reused = create(root.path(), b"<svg/>");
    assert_eq!(reused.path, first.path);
    assert!(reused.allocation_id.is_none());
    // A committed path is no longer protected by or deletable via that token.
    fs::write(&first.path, b"<svg><text>external edit</text></svg>").unwrap();
    discard_image_assets(vec![id]).unwrap();
    assert_eq!(
        fs::read(&first.path).unwrap(),
        b"<svg><text>external edit</text></svg>"
    );
    assert_eq!(fs::read_dir(root.path().join("assets")).unwrap().count(), 1);
}

#[cfg(any(windows, unix))]
#[cfg_attr(
    windows,
    ignore = "requires Windows symlink creation privilege; from src-tauri run: cargo test --lib review_p2_ -- --ignored --nocapture"
)]
#[test]
fn review_p2_identical_external_file_symlink_is_not_reused_as_a_portable_asset() {
    let root = tempfile::tempdir().unwrap();
    let document_dir = root.path().join("document");
    let assets = document_dir.join("assets");
    fs::create_dir_all(&assets).unwrap();
    let bytes = b"<svg><text>same bytes outside the document</text></svg>";
    let outside = root.path().join("outside.svg");
    fs::write(&outside, bytes).unwrap();
    let linked = assets.join("picture.svg");
    // This is a real file symlink, not a mock or a silently skipped privilege check.
    #[cfg(windows)]
    std::os::windows::fs::symlink_file(&outside, &linked).expect(
        "P2 regression requires a real file symlink; creation failed and coverage is NOT skipped",
    );
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, &linked).expect(
        "P2 regression requires a real file symlink; creation failed and coverage is NOT skipped",
    );
    assert!(fs::symlink_metadata(&linked)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(fs::read(&linked).unwrap(), bytes);

    let image = create(&document_dir, bytes);
    commit_image_assets(image.allocation_id.iter().cloned().collect()).unwrap();
    let document = document_dir.join("note.md").to_string_lossy().into_owned();
    crate::safe_files::write_document(
        document.clone(),
        format!("![]({})\n", image.relative_path),
        None,
    )
    .unwrap();
    let reopened = crate::read_image_file(document, image.relative_path.clone()).expect(
        "saved image must reopen inside the document boundary, not follow the external symlink",
    );
    assert_eq!(
        crate::image_data::decode_image(&reopened.data_base64).unwrap(),
        bytes
    );
    assert_eq!(image.filename, "picture-1.svg");
    assert!(
        image.allocation_id.is_some(),
        "fresh regular asset must carry its own allocation"
    );
    assert!(!crate::safe_files::is_link(
        &fs::symlink_metadata(&image.path).unwrap()
    ));
    assert!(fs::symlink_metadata(&linked)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(fs::read_link(&linked).unwrap(), outside);
    assert_eq!(fs::read(&outside).unwrap(), bytes);
}

#[cfg(windows)]
#[test]
fn review_m4_owned_handles_prevent_path_substitution_until_finalization() {
    let root = tempfile::tempdir().unwrap();
    let first = create(root.path(), b"<svg/>");
    let second = create(root.path(), b"<svg/>");
    assert_ne!(
        first.path, second.path,
        "uncommitted objects must not share a deletion lease"
    );
    assert!(fs::write(&first.path, b"external").is_err());
    assert!(fs::rename(&first.path, root.path().join("moved.svg")).is_err());
    let id = first.allocation_id.unwrap();
    commit_image_assets(vec![id.clone()]).unwrap();
    fs::rename(&first.path, root.path().join("moved.svg")).unwrap();
    fs::write(&first.path, b"replacement owned by someone else").unwrap();
    discard_image_assets(vec![id, second.allocation_id.unwrap()]).unwrap();
    assert_eq!(
        fs::read(&first.path).unwrap(),
        b"replacement owned by someone else"
    );
    assert!(!std::path::Path::new(&second.path).exists());
}

#[test]
fn review_m4_discard_failure_reports_path_but_releases_all_handles_and_authority() {
    let root = tempfile::tempdir().unwrap();
    let first = create(root.path(), b"<svg/>");
    let second = create(root.path(), b"<svg/>");
    let first_id = first.allocation_id.unwrap();
    crate::safe_files::hooks::fail_next_image_discard();
    let error =
        discard_image_assets(vec![first_id.clone(), second.allocation_id.unwrap()]).unwrap_err();
    assert!(error.contains(&first.path));
    assert!(std::path::Path::new(&first.path).exists());
    assert!(!std::path::Path::new(&second.path).exists());
    fs::write(&first.path, b"external edit after cleanup failure").unwrap();
    discard_image_assets(vec![first_id]).unwrap();
    assert_eq!(
        fs::read(&first.path).unwrap(),
        b"external edit after cleanup failure"
    );
}

#[test]
fn review_m8_asset_command_rejects_invalid_base64_without_creating_files() {
    let root = tempfile::tempdir().unwrap();
    assert!(save_image_asset(
        root.path().join("note.md").to_string_lossy().into_owned(),
        "image.svg".into(),
        "not base64".into()
    )
    .is_err());
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
}
