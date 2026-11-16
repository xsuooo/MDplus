//! Compact IPC image transport. Never deserialize image bytes as JSON numbers.
use base64::{engine::general_purpose::STANDARD, Engine};

use crate::config::MAX_IMAGE_FILE_BYTES;

pub(crate) const MAX_BASE64_IMAGE_CHARACTERS: u64 = MAX_IMAGE_FILE_BYTES.div_ceil(3) * 4;

#[derive(Debug)]
pub(crate) enum ImageDataError {
    TooLarge(u64),
    InvalidBase64,
}

impl std::fmt::Display for ImageDataError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooLarge(limit) => write!(f, "image exceeds the {limit} byte limit"),
            Self::InvalidBase64 => f.write_str("invalid base64 image data"),
        }
    }
}

pub(crate) fn decode_image(encoded: &str) -> Result<Vec<u8>, ImageDataError> {
    if encoded.len() as u64 > MAX_BASE64_IMAGE_CHARACTERS {
        return Err(ImageDataError::TooLarge(MAX_IMAGE_FILE_BYTES));
    }
    decode_limited(encoded, MAX_IMAGE_FILE_BYTES)
}

fn decode_limited(encoded: &str, limit: u64) -> Result<Vec<u8>, ImageDataError> {
    // The length gate runs before base64's output allocation. A JSON string
    // avoids the tens of millions of serde_json::Value/JS number array entries
    // incurred by Vec<u8> IPC. Only canonical padded STANDARD encoding is used.
    let max_encoded = limit.div_ceil(3) * 4;
    if encoded.len() as u64 > max_encoded {
        return Err(ImageDataError::TooLarge(limit));
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| ImageDataError::InvalidBase64)?;
    if bytes.len() as u64 > limit {
        return Err(ImageDataError::TooLarge(limit));
    }
    Ok(bytes)
}

pub(crate) fn encode_image(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

#[cfg(test)]
#[path = "image_data_tests.rs"]
mod tests;
