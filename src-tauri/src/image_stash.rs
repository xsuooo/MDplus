//! Process-local backing for undo/redo images, separate from crash recovery.
//! Keys address held handles, never caller paths. Windows files are delete-pending
//! for their whole lifetime, so process termination also releases their bytes.
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::Mutex;
use tauri::{Manager, State};
use tempfile::TempDir;

use crate::config::{MAX_IMAGE_FILE_BYTES, MAX_IMAGE_STASH_BYTES, MAX_IMAGE_STASH_ENTRIES};
use crate::{image_data, image_mime, owned_file, safe_files};

#[derive(Default)]
pub struct ImageStash(Mutex<Stash>);

struct StashedFile {
    file: File,
    length: u64,
    mime: &'static str,
}

#[derive(Default)]
struct Stash {
    // Drop handles before the TempDir tries to remove the now-empty directory.
    files: HashMap<String, StashedFile>,
    directory: Option<TempDir>,
    total_bytes: u64,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashReceipt {
    key: String,
    mime: &'static str,
    preview_url: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashedImage {
    mime: &'static str,
    data_base64: String,
}

impl ImageStash {
    /// Copy validated bytes into process-owned storage; callers never acquire
    /// deletion authority over the original file they selected or dropped.
    pub(crate) fn insert_bytes(
        &self,
        parent: &Path,
        filename: &str,
        bytes: &[u8],
    ) -> Result<StashReceipt, String> {
        self.0
            .lock()
            .map_err(|_| "session image lock failed")?
            .insert(parent, filename, bytes, MAX_IMAGE_STASH_BYTES)
    }

    pub(crate) fn read_bytes(&self, key: &str) -> Result<Vec<u8>, String> {
        if key.len() != 32
            || !key
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("invalid session image key".into());
        }
        self.0
            .lock()
            .map_err(|_| "session image lock failed")?
            .read_bytes(key)
            .map(|(_, bytes)| bytes)
    }

    #[cfg(test)]
    pub(crate) fn read_for_test(&self, key: &str) -> Result<StashedImage, String> {
        self.0.lock().unwrap().read(key)
    }

    #[cfg(test)]
    pub(crate) fn discard_for_test(&self, keys: Vec<String>) -> Result<(), String> {
        self.0.lock().unwrap().discard(keys)
    }
}

impl Stash {
    fn insert(
        &mut self,
        parent: &Path,
        filename: &str,
        data: &[u8],
        limit: u64,
    ) -> Result<StashReceipt, String> {
        if !safe_files::valid_basename(filename) {
            return Err("invalid image filename".into());
        }
        if data.len() as u64 > MAX_IMAGE_FILE_BYTES {
            return Err("image exceeds the configured size limit".into());
        }
        let mime = image_mime(Path::new(filename), data)?;
        let length = data.len() as u64;
        if length > limit.saturating_sub(self.total_bytes)
            || self.files.len() >= MAX_IMAGE_STASH_ENTRIES
        {
            return Err("session image stash is full; existing undo images were retained".into());
        }
        if self.directory.is_none() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            let metadata = fs::symlink_metadata(parent).map_err(|error| error.to_string())?;
            if !metadata.is_dir() || safe_files::is_link(&metadata) {
                return Err(
                    "session image stash directory must not be a link or reparse point".into(),
                );
            }
            self.directory = Some(
                tempfile::Builder::new()
                    .prefix("session-")
                    .tempdir_in(parent)
                    .map_err(|error| error.to_string())?,
            );
        }
        let key = uuid::Uuid::new_v4().simple().to_string();
        let path = self.directory.as_ref().unwrap().path().join(&key);
        let mut file = owned_file::create_owned(&path).map_err(|error| error.to_string())?;
        #[cfg(windows)]
        owned_file::delete_on_close(&file).map_err(|error| error.to_string())?;
        #[cfg(not(windows))]
        fs::remove_file(&path).map_err(|error| error.to_string())?;
        // Once marked, every error drops this handle and releases the private
        // file. The accounting/map changes only after complete durable bytes.
        file.write_all(data)
            .and_then(|_| file.sync_all())
            .map_err(|error| error.to_string())?;
        self.files
            .insert(key.clone(), StashedFile { file, length, mime });
        self.total_bytes += length;
        Ok(StashReceipt {
            preview_url: preview_url(&key),
            key,
            mime,
        })
    }

    fn read_bytes(&mut self, key: &str) -> Result<(&'static str, Vec<u8>), String> {
        let image = self.files.get_mut(key).ok_or("unknown session image key")?;
        // One mutex covers seek + read; cloned handles can share an OS cursor.
        image
            .file
            .seek(SeekFrom::Start(0))
            .map_err(|error| error.to_string())?;
        let mut data = Vec::with_capacity(image.length as usize);
        (&mut image.file)
            .take(MAX_IMAGE_FILE_BYTES + 1)
            .read_to_end(&mut data)
            .map_err(|error| error.to_string())?;
        if data.len() as u64 != image.length {
            return Err("session image size changed; image was not restored".into());
        }
        Ok((image.mime, data))
    }

    fn read(&mut self, key: &str) -> Result<StashedImage, String> {
        let (mime, data) = self.read_bytes(key)?;
        Ok(StashedImage {
            mime,
            data_base64: image_data::encode_image(&data),
        })
    }

    fn discard(&mut self, keys: Vec<String>) -> Result<(), String> {
        if keys.len() > MAX_IMAGE_STASH_ENTRIES {
            return Err("too many session image keys".into());
        }
        for key in keys {
            if let Some(image) = self.files.remove(&key) {
                self.total_bytes -= image.length;
                drop(image); // closes the delete-pending handle, not an untrusted path
            }
        }
        Ok(())
    }
}

fn preview_url(key: &str) -> String {
    #[cfg(any(windows, target_os = "android"))]
    {
        format!("http://mdplus-image-stash.localhost/{key}")
    }
    #[cfg(not(any(windows, target_os = "android")))]
    {
        format!("mdplus-image-stash://localhost/{key}")
    }
}

fn image_response(status: u16, mime: &str, bytes: Vec<u8>) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder().status(status)
        .header("Content-Type", mime)
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store")
        // SVG is useful as an image but must not execute scripts or load external
        // resources if this preview URL is navigated to as a document.
        .header("Content-Security-Policy", "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; sandbox")
        .body(bytes).expect("fixed image headers must be valid")
}

fn preview_from_stash(
    stash: &mut Stash,
    request: &tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    if request.method() != tauri::http::Method::GET {
        return image_response(405, "text/plain", b"method not allowed".to_vec());
    }
    let key = request.uri().path().strip_prefix('/').unwrap_or("");
    if key.len() != 32
        || !key
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || request.uri().query().is_some()
    {
        return image_response(404, "text/plain", b"not found".to_vec());
    }
    match stash.read_bytes(key) {
        Ok((mime, bytes)) => image_response(200, mime, bytes),
        Err(_) => image_response(404, "text/plain", b"not found".to_vec()),
    }
}

pub(crate) fn preview(
    app: &tauri::AppHandle,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let state = app.state::<ImageStash>();
    // Synchronous protocol handling and the same mutex as IPC reads serialize
    // disk buffers. Each response is bounded by the unchanged 64 MiB limit.
    let Ok(mut stash) = state.0.lock() else {
        return image_response(503, "text/plain", b"image stash unavailable".to_vec());
    };
    preview_from_stash(&mut stash, &request)
}

#[tauri::command]
pub fn stash_image(
    app: tauri::AppHandle,
    state: State<'_, ImageStash>,
    filename: String,
    data_base64: String,
) -> Result<StashReceipt, String> {
    let data = image_data::decode_image(&data_base64).map_err(|error| error.to_string())?;
    let parent = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?
        .join("session-image-stash-v1");
    state.insert_bytes(&parent, &filename, &data)
}

#[tauri::command]
pub fn read_stashed_image(
    state: State<'_, ImageStash>,
    key: String,
) -> Result<StashedImage, String> {
    state
        .0
        .lock()
        .map_err(|_| "session image lock failed")?
        .read(&key)
}

#[tauri::command]
pub fn discard_stashed_images(
    state: State<'_, ImageStash>,
    keys: Vec<String>,
) -> Result<(), String> {
    state
        .0
        .lock()
        .map_err(|_| "session image lock failed")?
        .discard(keys)
}

#[cfg(test)]
#[path = "image_stash_tests.rs"]
mod tests;
