use super::*;

#[test]
fn review_m8_base64_uses_exact_limits_before_and_after_decoding() {
    assert_eq!(MAX_BASE64_IMAGE_CHARACTERS, 89_478_488);
    assert_eq!(decode_limited("YWJjZA==", 4).unwrap(), b"abcd");
    // Same encoded character count, but padding changes the decoded size.
    assert!(decode_limited("YWJjZGU=", 4).is_err());
    assert!(decode_limited("YWJjZGVmZw==", 4).is_err());
    for invalid in ["YQ", "YQ=", "Y Q==", "YQ==\n", "!!!!", "YQ__", "YR=="] {
        assert!(decode_image(invalid).is_err(), "{invalid}");
    }
}

#[test]
fn review_m8_serialized_images_are_one_compact_string_not_number_arrays() {
    let bytes: Vec<u8> = (0..=255).cycle().take(1024 * 1024).collect();
    let encoded = encode_image(&bytes);
    assert_eq!(decode_image(&encoded).unwrap(), bytes);
    let json = serde_json::to_string(&serde_json::json!({"dataBase64": encoded})).unwrap();
    assert!(json.len() < bytes.len() * 3 / 2);
    assert!(!json.contains('['));
}
