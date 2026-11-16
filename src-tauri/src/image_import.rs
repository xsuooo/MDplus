//! Explicit local-image drop boundary. Document-relative image reads retain
//! their separate, narrower contract. Only owned stash copies can be discarded.
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use image::{ImageFormat, ImageReader, Limits};
use sha2::{Digest, Sha256};
use tauri::Manager;

use crate::config::{MAX_IMAGE_FILE_BYTES, MAX_IMAGE_MEMORY_BYTES};
use crate::image_stash::{ImageStash, StashReceipt};
use crate::{image_mime, safe_files};

// Even direct simultaneous IPC calls cannot multiply decoding buffers.
static IMAGE_IMPORT_IO: Mutex<()> = Mutex::new(());

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DroppedImageReceipt {
    #[serde(flatten)]
    stash: StashReceipt,
    filename: String,
    byte_length: u64,
    digest: String,
}

fn dropped_image_path(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("拖入图片需要绝对文件路径".into());
    }
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png" | "jpg" | "jpeg") => {}
        _ => return Err("拖入图片仅支持 PNG 和 JPG 文件".into()),
    }
    safe_files::target_path(path).map_err(|error| error.message)
}

fn validate_dropped_image(path: &Path, bytes: &[u8]) -> Result<(), String> {
    validate_dropped_image_with_budget(path, bytes, MAX_IMAGE_MEMORY_BYTES)
}

fn validate_dropped_image_with_budget(
    path: &Path,
    bytes: &[u8],
    memory_budget: u64,
) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() as u64 > MAX_IMAGE_FILE_BYTES {
        return Err("图片为空或超过 64 MiB 限制".into());
    }
    let format = match image_mime(path, bytes)? {
        "image/png" => ImageFormat::Png,
        "image/jpeg" => ImageFormat::Jpeg,
        _ => return Err("拖入图片仅支持 PNG 和 JPG 文件".into()),
    };
    // Magic bytes alone also accept truncated or corrupt files. Decode once
    // before making an editor reference visible. The pinned source is copied
    // unchanged into the stash, rather than re-encoding a lossy JPEG.
    // image's JPEG decoder also owns a second compressed input buffer. Reserve
    // both source copies before setting its decoded allocation budget. max_alloc
    // is the decoder's best-effort allocation limit, not a process RSS guarantee.
    let source_copies = if format == ImageFormat::Jpeg { 2 } else { 1 };
    let source_bytes = (bytes.len() as u64).saturating_mul(source_copies);
    if source_bytes >= memory_budget {
        return Err("图片解码分配预算不足".into());
    }
    let mut limits = Limits::default();
    limits.max_alloc = Some(memory_budget - source_bytes);
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(limits);
    reader
        .decode()
        .map(|_| ())
        .map_err(|error| format!("图片无法解码或超过解码分配预算：{error}"))
}

fn import_into_stash(
    state: &ImageStash,
    parent: &Path,
    path: &Path,
) -> Result<DroppedImageReceipt, String> {
    let _io = IMAGE_IMPORT_IO.lock().map_err(|_| "图片导入锁不可用")?;
    let path = dropped_image_path(path)?;
    let snapshot = safe_files::optional_snapshot(&path, MAX_IMAGE_FILE_BYTES)
        .map_err(|error| error.message)?
        .ok_or("拖入的图片已不存在")?;
    validate_dropped_image(&path, &snapshot.bytes)?;
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("图片文件名无效")?
        .to_owned();
    let stash = state.insert_bytes(parent, &filename, &snapshot.bytes)?;
    Ok(DroppedImageReceipt {
        stash,
        filename,
        byte_length: snapshot.bytes.len() as u64,
        digest: format!("{:x}", Sha256::digest(&snapshot.bytes)),
    })
}

/// The only arbitrary local path accepted for image imports: a user drop's
/// absolute PNG/JPEG file is validated and copied to the owned session stash.
#[tauri::command]
pub async fn import_dropped_image(
    app: tauri::AppHandle,
    path: String,
) -> Result<DroppedImageReceipt, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let parent = app
            .path()
            .app_local_data_dir()
            .map_err(|error| error.to_string())?
            .join("session-image-stash-v1");
        let state = app.state::<ImageStash>();
        import_into_stash(&state, &parent, Path::new(&path))
    })
    .await
    .map_err(|error| format!("图片导入任务失败：{error}"))?
}

#[cfg(test)]
#[path = "image_import_tests.rs"]
mod tests;
