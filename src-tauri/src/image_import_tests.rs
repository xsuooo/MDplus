use super::*;
use std::fs::{self, File};

fn encoded(format: ImageFormat) -> Vec<u8> {
    let pixels = image::RgbImage::from_pixel(2, 2, image::Rgb([20, 90, 160]));
    let mut output = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(pixels)
        .write_to(&mut output, format)
        .unwrap();
    output.into_inner()
}

#[test]
fn image_drop_copies_real_png_jpeg_bytes_and_discards_only_the_owned_copy() {
    let root = tempfile::tempdir().unwrap();
    let parent = root.path().join("stash");
    let state = ImageStash::default();
    for (filename, format, mime) in [
        ("图片 1.PNG", ImageFormat::Png, "image/png"),
        ("photo 2.jpg", ImageFormat::Jpeg, "image/jpeg"),
        ("photo 3.jpeg", ImageFormat::Jpeg, "image/jpeg"),
    ] {
        let bytes = encoded(format);
        let source = root.path().join(filename);
        fs::write(&source, &bytes).unwrap();
        let receipt = import_into_stash(&state, &parent, &source).unwrap();
        let value = serde_json::to_value(&receipt).unwrap();
        assert_eq!(value["filename"], filename);
        assert_eq!(value["mime"], mime);
        assert_eq!(value["byteLength"], bytes.len());
        assert_eq!(value["digest"], format!("{:x}", Sha256::digest(&bytes)));
        assert!(value.get("dataBase64").is_none());
        let key = value["key"].as_str().unwrap();
        // An external edit after import cannot rewrite undo's immutable copy.
        fs::write(&source, b"external replacement").unwrap();
        let stashed = serde_json::to_value(state.read_for_test(key).unwrap()).unwrap();
        let stashed_bytes =
            crate::image_data::decode_image(stashed["dataBase64"].as_str().unwrap()).unwrap();
        assert_eq!(stashed_bytes, bytes);
        state.discard_for_test(vec![key.into()]).unwrap();
        assert!(state.read_for_test(key).is_err());
        assert_eq!(fs::read(&source).unwrap(), b"external replacement");
    }
}

#[test]
fn image_drop_rejects_invalid_paths_types_sizes_and_corrupt_bytes_without_a_stash() {
    let root = tempfile::tempdir().unwrap();
    let parent = root.path().join("stash");
    let state = ImageStash::default();
    let png = encoded(ImageFormat::Png);
    for (filename, bytes) in [
        ("bad.png", b"not an image".as_slice()),
        ("empty.png", b"".as_slice()),
        ("mismatch.jpg", png.as_slice()),
        ("truncated.png", &png[..png.len() / 2]),
        ("unsupported.svg", b"<svg/>".as_slice()),
    ] {
        let source = root.path().join(filename);
        fs::write(&source, bytes).unwrap();
        assert!(import_into_stash(&state, &parent, &source).is_err());
        assert_eq!(fs::read(&source).unwrap(), bytes);
    }
    let oversized = root.path().join("large.png");
    File::create(&oversized)
        .unwrap()
        .set_len(MAX_IMAGE_FILE_BYTES + 1)
        .unwrap();
    assert!(import_into_stash(&state, &parent, &oversized).is_err());
    let directory = root.path().join("directory.png");
    fs::create_dir(&directory).unwrap();
    assert!(import_into_stash(&state, &parent, &directory).is_err());
    assert!(import_into_stash(&state, &parent, &root.path().join("missing.png")).is_err());
    assert!(dropped_image_path(Path::new("relative.png")).is_err());
    #[cfg(windows)]
    assert!(dropped_image_path(Path::new(r"\\.\NUL.png")).is_err());
    assert!(!parent.exists(), "invalid inputs allocated a session stash");
}

#[test]
fn image_drop_checks_decoder_memory_before_publishing_a_reference() {
    let png = encoded(ImageFormat::Png);
    let jpeg = encoded(ImageFormat::Jpeg);
    for (name, bytes) in [("one.png", png), ("two.jpg", jpeg)] {
        assert!(validate_dropped_image(Path::new(name), &bytes).is_ok());
        assert!(validate_dropped_image_with_budget(
            Path::new(name),
            &bytes,
            bytes.len() as u64 + 1,
        )
        .is_err());
    }
}

#[test]
fn image_drop_jpeg_reserves_both_compressed_copies_before_decoded_allocation() {
    let bytes = encoded(ImageFormat::Jpeg);
    let source_bytes = bytes.len() as u64;
    assert_eq!(
        validate_dropped_image_with_budget(Path::new("two.jpg"), &bytes, source_bytes * 2)
            .unwrap_err(),
        "图片解码分配预算不足",
    );
    // One extra byte cannot hold the 2x2 RGB output, even though the image is valid.
    assert!(
        validate_dropped_image_with_budget(Path::new("two.jpg"), &bytes, source_bytes * 2 + 1,)
            .is_err()
    );
    assert!(validate_dropped_image_with_budget(
        Path::new("two.jpg"),
        &bytes,
        source_bytes * 2 + 128,
    )
    .is_ok());
}

#[cfg(unix)]
#[test]
fn image_drop_rejects_a_leaf_symlink_and_preserves_its_source() {
    let root = tempfile::tempdir().unwrap();
    let bytes = encoded(ImageFormat::Png);
    let source = root.path().join("original.png");
    let link = root.path().join("link.png");
    fs::write(&source, &bytes).unwrap();
    std::os::unix::fs::symlink(&source, &link).unwrap();
    assert!(import_into_stash(&ImageStash::default(), &root.path().join("stash"), &link).is_err());
    assert_eq!(fs::read(&source).unwrap(), bytes);
}
