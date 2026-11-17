//! Images copied next to a document during save. A new file stays an "allocation" (an exclusive
//! handle that may still delete it) until the save commits or discards it.

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::safe_files::{
    display, is_link, optional_snapshot, revision, target_path, valid_basename, FileError,
    ImageReceipt,
};
use crate::{image_mime, MAX_IMAGE_FILE_BYTES};

struct OwnedAsset {
    file: File,
    path: PathBuf,
}

static IMAGE_ALLOCATIONS: std::sync::LazyLock<
    Mutex<std::collections::HashMap<String, OwnedAsset>>,
> = std::sync::LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

#[tauri::command]
pub fn save_image_asset(
    doc_path: String,
    filename: String,
    data_base64: String,
) -> Result<ImageReceipt, Box<FileError>> {
    let document = target_path(Path::new(&doc_path))?;
    if !valid_basename(&filename) {
        return Err(FileError::new("INVALID_PATH", &document, "图片文件名无效"));
    }
    let data = crate::image_data::decode_image(&data_base64).map_err(|error| {
        let code = match error {
            crate::image_data::ImageDataError::TooLarge(_) => "TOO_LARGE",
            crate::image_data::ImageDataError::InvalidBase64 => "INVALID_ENCODING",
        };
        FileError::new(code, &document, error.to_string())
    })?;
    image_mime(Path::new(&filename), &data)
        .map_err(|message| FileError::new("INVALID_ENCODING", &document, message))?;
    let mut allocations = IMAGE_ALLOCATIONS
        .lock()
        .map_err(|_| FileError::new("IO_ERROR", &document, "图片分配队列不可用"))?;
    if allocations.len() >= crate::config::MAX_IMAGE_STASH_ENTRIES {
        return Err(FileError::new(
            "TOO_LARGE",
            &document,
            "未完成的图片分配过多，请先完成或取消保存",
        ));
    }
    let directory = document.parent().unwrap().join("assets");
    match fs::create_dir(&directory) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(FileError::io(&directory, error)),
    }
    let metadata =
        fs::symlink_metadata(&directory).map_err(|error| FileError::io(&directory, error))?;
    if is_link(&metadata) || !metadata.is_dir() {
        return Err(FileError::new(
            "INVALID_PATH",
            &directory,
            "图片目录不能是文件、链接或重解析点",
        ));
    }
    let (stem, extension) = filename
        .rsplit_once('.')
        .ok_or_else(|| FileError::new("INVALID_PATH", &document, "图片缺少扩展名"))?;
    let expected_hash = revision(&data);
    for attempt in 0..1000 {
        let filename = if attempt == 0 {
            filename.clone()
        } else {
            format!("{stem}-{attempt}.{extension}")
        };
        let path = directory.join(&filename);
        // An uncommitted allocation belongs to a different migration. Sharing
        // its token or returning it as unowned would allow one rollback to break
        // another document, so allocate separately until it has been committed.
        if allocations.values().any(|asset| asset.path == path) {
            continue;
        }
        let mut file = match crate::owned_file::create_owned(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                // Reuse only a regular leaf, never a symlink/reparse point whose
                // bytes happen to match. Such references may fail on reopen or
                // escape the document directory; leave them alone and suffix.
                if optional_snapshot(&path, MAX_IMAGE_FILE_BYTES)
                    .is_ok_and(|raw| raw.is_some_and(|raw| raw.revision == expected_hash))
                {
                    return Ok(ImageReceipt {
                        relative_path: format!("./assets/{filename}"),
                        filename,
                        path: display(&path),
                        allocation_id: None,
                    });
                }
                continue;
            }
            Err(error) => return Err(FileError::io(&path, error)),
        };
        let result = file.write_all(&data).and_then(|_| file.sync_all());
        #[cfg(test)]
        let result = crate::safe_files::hooks::image_write_result(result);
        if let Err(error) = result {
            // The still-exclusive handle is proof of ownership. Delete only that
            // object; after closing it no cleanup is allowed by pathname.
            let cleanup = crate::owned_file::delete_on_close(&file);
            drop(file);
            #[cfg(test)]
            crate::safe_files::hooks::run(
                crate::safe_files::hooks::Checkpoint::ImageWriteFailed,
                &path,
            );
            let mut failure = FileError::io(&path, error);
            if let Err(cleanup) = cleanup {
                failure.write_state = "unknown";
                failure.message.push_str(&format!(
                    "\n图片可能不完整，未删除该路径：{}（{cleanup}）",
                    failure.path
                ));
            }
            return Err(failure);
        }
        let allocation_id = uuid::Uuid::new_v4().simple().to_string();
        allocations.insert(
            allocation_id.clone(),
            OwnedAsset {
                file,
                path: path.clone(),
            },
        );
        return Ok(ImageReceipt {
            relative_path: format!("./assets/{filename}"),
            filename,
            path: display(&path),
            allocation_id: Some(allocation_id),
        });
    }
    Err(FileError::new(
        "IO_ERROR",
        &directory,
        "图片同名文件过多，未覆盖任何已有图片",
    ))
}

fn finish_image_allocations(allocation_ids: Vec<String>, discard: bool) -> Result<(), String> {
    if allocation_ids.len() > crate::config::MAX_IMAGE_STASH_ENTRIES {
        return Err("too many image allocation ids".into());
    }
    let mut allocations = IMAGE_ALLOCATIONS
        .lock()
        .map_err(|_| "image allocation lock failed")?;
    let mut failures = Vec::new();
    for id in allocation_ids {
        // Unknown, duplicated or already-finalized tokens are harmless; clients
        // can retry completion but can never turn an arbitrary path into a token.
        if let Some(asset) = allocations.remove(&id) {
            if discard {
                let cleanup = || crate::owned_file::delete_on_close(&asset.file);
                #[cfg(test)]
                let result = crate::safe_files::hooks::image_discard_result(cleanup);
                #[cfg(not(test))]
                let result = cleanup();
                if let Err(error) = result {
                    failures.push(format!(
                        "图片清理未确认，请核对路径：{}（{error}）",
                        display(&asset.path)
                    ));
                }
            }
            drop(asset); // revoke the deletion right even if cleanup failed
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("\n"))
    }
}

#[tauri::command]
pub fn commit_image_assets(allocation_ids: Vec<String>) -> Result<(), String> {
    finish_image_allocations(allocation_ids, false)
}

#[tauri::command]
pub fn discard_image_assets(allocation_ids: Vec<String>) -> Result<(), String> {
    finish_image_allocations(allocation_ids, true)
}
