use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

use crate::{
    image_mime, image_stash::ImageStash, write_file_atomic, MAX_IMAGE_FILE_BYTES,
    MAX_TEXT_FILE_BYTES,
};

use crate::config::{
    MAX_IMAGE_STASH_ENTRIES, MAX_RECOVERY_IMAGES as MAX_IMAGES, MAX_SNAPSHOT_IMAGE_BYTES,
    RECOVERY_RETENTION_MS as RETENTION_MS,
};
static IO_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryImage {
    pub placeholder: String,
    pub filename: String,
    pub key: String,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub id: String,
    pub title: String,
    pub original_path: Option<String>,
    pub markdown: String,
    pub images: Vec<RecoveryImage>,
    #[serde(default)]
    pub updated_at: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    id: String,
    title: String,
    original_path: Option<String>,
    updated_at: u64,
    damaged: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoredImage {
    #[serde(flatten)]
    image: RecoveryImage,
    data_base64: String,
    mime: String,
}

#[derive(serde::Serialize)]
pub struct Restored {
    snapshot: Snapshot,
    images: Vec<RestoredImage>,
}

#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cleanup {
    removed_keys: Vec<String>,
    cleanup_error: Option<String>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn identifier(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 100
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("invalid recovery identifier".into());
    }
    Ok(())
}

fn regular_path(path: &Path, directory: bool) -> Result<(), String> {
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return Err("recovery reparse points are not allowed".into());
        }
    }
    if meta.file_type().is_symlink()
        || meta.is_dir() != directory
        || (!directory && !meta.is_file())
    {
        return Err("invalid recovery file type".into());
    }
    Ok(())
}

fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("recovery-v1");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    regular_path(&root, true)?;
    fs::canonicalize(root).map_err(|e| e.to_string())
}

fn tab_dir(root: &Path, id: &str, create: bool) -> Result<PathBuf, String> {
    identifier(id)?;
    regular_path(root, true)?;
    let dir = root.join(id);
    if create && !dir.exists() {
        fs::create_dir(&dir).map_err(|e| e.to_string())?;
    }
    regular_path(&dir, true)?;
    Ok(dir)
}

fn image_path(dir: &Path, key: &str) -> Result<PathBuf, String> {
    let (id, extension) = key.rsplit_once('.').ok_or("invalid recovery image key")?;
    identifier(id)?;
    if !["png", "jpg", "jpeg", "gif", "webp", "svg"].contains(&extension) {
        return Err("invalid recovery image extension".into());
    }
    Ok(dir.join(key))
}

fn read_limited(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    use std::io::Read;
    regular_path(path, false)?;
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() > limit {
        return Err("recovery file exceeds size limit".into());
    }
    let mut data = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut data)
        .map_err(|e| e.to_string())?;
    if data.len() as u64 > limit {
        return Err("recovery file exceeds size limit".into());
    }
    Ok(data)
}

fn validate(snapshot: &Snapshot) -> Result<(), String> {
    identifier(&snapshot.id)?;
    if snapshot.title.len() > 1024
        || snapshot
            .original_path
            .as_ref()
            .is_some_and(|p| p.len() > 32768)
        || snapshot.markdown.len() as u64 > MAX_TEXT_FILE_BYTES
        || snapshot.images.len() > MAX_IMAGES
    {
        return Err("recovery snapshot exceeds limits".into());
    }
    let mut keys = HashSet::new();
    for image in &snapshot.images {
        let id = image
            .placeholder
            .strip_prefix("mdplus-image:")
            .ok_or("invalid image token")?;
        identifier(id)?;
        image_path(Path::new(""), &image.key)?;
        if !image.key.starts_with(&format!("{id}."))
            || !keys.insert(&image.key)
            || image.filename.is_empty()
            || image.filename.len() > 255
            || image.filename.contains(['/', '\\', ':'])
            || image.filename == "."
            || image.filename == ".."
        {
            return Err("invalid recovery image metadata".into());
        }
    }
    Ok(())
}

fn validate_retained_keys(keys: &[String]) -> Result<HashSet<String>, String> {
    if keys.len() > MAX_IMAGE_STASH_ENTRIES {
        return Err("too many retained recovery images".into());
    }
    for key in keys {
        image_path(Path::new(""), key)?;
    }
    Ok(keys.iter().cloned().collect())
}

fn prune_images(dir: &Path, id: &str, mut retained: HashSet<String>) -> Cleanup {
    let mut cleanup = Cleanup::default();
    let operation = (|| -> Result<(), String> {
        if dir.join("snapshot.json").exists() {
            let snapshot = read_snapshot(dir, id)?;
            validate_attachments(dir, &snapshot.images)?;
            retained.extend(snapshot.images.into_iter().map(|image| image.key));
        }
        for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let key = entry.file_name().to_string_lossy().into_owned();
            if retained.contains(&key) || image_path(dir, &key).is_err() {
                continue;
            }
            regular_path(&entry.path(), false)?;
            // shortcut: bound each cleanup receipt, retry on the next write for larger legacy caches.
            if cleanup.removed_keys.len() == MAX_IMAGE_STASH_ENTRIES {
                return Err("recovery cleanup batch limit reached; retry on the next write".into());
            }
            fs::remove_file(entry.path()).map_err(|e| e.to_string())?;
            cleanup.removed_keys.push(key);
        }
        Ok(())
    })();
    cleanup.cleanup_error = operation.err();
    cleanup
}

fn cache_image(
    root: &Path,
    id: &str,
    key: &str,
    data: &[u8],
    retained_keys: &[String],
) -> Result<Cleanup, String> {
    if data.len() as u64 > MAX_IMAGE_FILE_BYTES {
        return Err("recovery image exceeds size limit".into());
    }
    let dir = tab_dir(root, id, true)?;
    let path = image_path(&dir, key)?;
    image_mime(&path, data)?;
    let mut retained = validate_retained_keys(retained_keys)?;
    retained.insert(key.into());
    let cleanup = prune_images(&dir, id, retained);
    let mut total = data.len() as u64;
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.path() != path {
            regular_path(&entry.path(), false)?;
            total += entry.metadata().map_err(|e| e.to_string())?.len();
        }
    }
    // Keep the last complete snapshot while a disjoint replacement attachment set is staged.
    if total > 2 * MAX_SNAPSHOT_IMAGE_BYTES + MAX_TEXT_FILE_BYTES + 1024 * 1024 {
        return Err("recovery cache exceeds per-document limit".into());
    }
    if path.exists() {
        regular_path(&path, false)?;
        if read_limited(&path, MAX_IMAGE_FILE_BYTES)? == data {
            return Ok(cleanup);
        }
        return Err("recovery image keys are immutable".into());
    }
    write_file_atomic(&path, data).map_err(|e| e.to_string())?;
    Ok(cleanup)
}

fn validate_attachments(dir: &Path, images: &[RecoveryImage]) -> Result<(), String> {
    let mut size = 0;
    for image in images {
        let path = image_path(dir, &image.key)?;
        regular_path(&path, false)?;
        let length = fs::metadata(&path).map_err(|e| e.to_string())?.len();
        if length > MAX_IMAGE_FILE_BYTES {
            return Err("recovery image exceeds size limit".into());
        }
        size += length;
    }
    if size > MAX_SNAPSHOT_IMAGE_BYTES {
        return Err("recovery attachments exceed 256 MiB".into());
    }
    Ok(())
}

fn save(root: &Path, mut snapshot: Snapshot, retained_keys: &[String]) -> Result<Cleanup, String> {
    validate(&snapshot)?;
    let retained = validate_retained_keys(retained_keys)?;
    let dir = tab_dir(root, &snapshot.id, true)?;
    validate_attachments(&dir, &snapshot.images)?;
    snapshot.updated_at = now_ms();
    let path = dir.join("snapshot.json");
    if path.exists() {
        regular_path(&path, false)?;
    }
    let data = serde_json::to_vec(&snapshot).map_err(|e| e.to_string())?;
    if data.len() as u64 > MAX_TEXT_FILE_BYTES + 1024 * 1024 {
        return Err("encoded recovery snapshot exceeds size limit".into());
    }
    // Images are durable before the manifest replaces the previous complete snapshot.
    write_file_atomic(&path, &data).map_err(|e| e.to_string())?;
    // Cleanup is auxiliary: its failure cannot undo a fully published snapshot.
    Ok(prune_images(&dir, &snapshot.id, retained))
}

fn read_snapshot(dir: &Path, id: &str) -> Result<Snapshot, String> {
    let data = read_limited(
        &dir.join("snapshot.json"),
        MAX_TEXT_FILE_BYTES + 1024 * 1024,
    )?;
    let snapshot: Snapshot =
        serde_json::from_slice(&data).map_err(|_| "invalid recovery snapshot")?;
    validate(&snapshot)?;
    if snapshot.id != id {
        return Err("recovery snapshot identity mismatch".into());
    }
    Ok(snapshot)
}

fn restore(root: &Path, id: &str) -> Result<Restored, String> {
    let dir = tab_dir(root, id, false)?;
    let snapshot = read_snapshot(&dir, id)?;
    let mut images = Vec::new();
    let mut total = 0;
    for image in &snapshot.images {
        let path = image_path(&dir, &image.key)?;
        let data = read_limited(&path, MAX_IMAGE_FILE_BYTES)?;
        total += data.len() as u64;
        if total > MAX_SNAPSHOT_IMAGE_BYTES {
            return Err("recovery attachments exceed 256 MiB".into());
        }
        let mime = image_mime(&path, &data)?.to_owned();
        images.push(RestoredImage {
            image: image.clone(),
            data_base64: crate::image_data::encode_image(&data),
            mime,
        });
    }
    Ok(Restored { snapshot, images })
}

fn delete(root: &Path, id: &str) -> Result<(), String> {
    identifier(id)?;
    if !root.join(id).exists() {
        return Ok(());
    }
    let dir = tab_dir(root, id, false)?;
    let files: Vec<_> = fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .map(|entry| entry.map(|e| e.path()))
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    // Never traverse a junction/symlink, or recursively remove an unexpected directory.
    for path in &files {
        regular_path(path, false)?;
    }
    // Remove the manifest first: an interrupted cleanup cannot offer an incomplete restore.
    let manifest = dir.join("snapshot.json");
    if manifest.exists() {
        fs::remove_file(&manifest).map_err(|e| e.to_string())?;
    }
    for path in files {
        if path != manifest {
            fs::remove_file(path).map_err(|e| e.to_string())?;
        }
    }
    fs::remove_dir(dir).map_err(|e| e.to_string())
}

fn list(root: &Path, active_ids: &[String], now: u64) -> Result<Vec<Entry>, String> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let id = entry.file_name().to_string_lossy().into_owned();
        if identifier(&id).is_err() || active_ids.contains(&id) {
            continue;
        }
        let dir = tab_dir(root, &id, false)?;
        let newest = fs::read_dir(&dir)
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .filter_map(|e| e.metadata().ok())
            .filter_map(|m| m.modified().ok())
            .chain(fs::metadata(&dir).ok().and_then(|m| m.modified().ok()))
            .max()
            .unwrap_or(UNIX_EPOCH)
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        if now.saturating_sub(newest) > RETENTION_MS {
            delete(root, &id)?;
            continue;
        }
        if !dir.join("snapshot.json").exists() {
            entries.push(Entry {
                id,
                title: "Incomplete image cache".into(),
                original_path: None,
                updated_at: newest,
                damaged: true,
            });
            continue;
        }
        match read_snapshot(&dir, &id) {
            Ok(snapshot) if validate_attachments(&dir, &snapshot.images).is_ok() => {
                entries.push(Entry {
                    id,
                    title: snapshot.title,
                    original_path: snapshot.original_path,
                    updated_at: snapshot.updated_at,
                    damaged: false,
                })
            }
            _ => entries.push(Entry {
                id,
                title: "Damaged recovery snapshot".into(),
                original_path: None,
                updated_at: newest,
                damaged: true,
            }),
        }
    }
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.updated_at));
    Ok(entries)
}

fn cache_stashed_image(
    root: &Path,
    state: &ImageStash,
    id: &str,
    key: &str,
    stash_key: &str,
    retained_keys: &[String],
) -> Result<Cleanup, String> {
    identifier(id)?;
    image_path(Path::new(""), key)?;
    validate_retained_keys(retained_keys)?;
    let _lock = IO_LOCK.lock().map_err(|_| "recovery storage lock failed")?;
    // Read under the recovery lock so simultaneous IPC cannot multiply image buffers.
    let data = state.read_bytes(stash_key)?;
    cache_image(root, id, key, &data, retained_keys)
}

#[tauri::command]
pub async fn cache_recovery_image(
    app: tauri::AppHandle,
    id: String,
    key: String,
    stash_key: String,
    retained_keys: Vec<String>,
) -> Result<Cleanup, String> {
    tauri::async_runtime::spawn_blocking(move || {
        cache_stashed_image(
            &root(&app)?,
            &app.state::<ImageStash>(),
            &id,
            &key,
            &stash_key,
            &retained_keys,
        )
    })
    .await
    .map_err(|error| format!("恢复图片缓存任务失败：{error}"))?
}

#[tauri::command]
pub async fn write_recovery_snapshot(
    app: tauri::AppHandle,
    snapshot: Snapshot,
    retained_keys: Vec<String>,
) -> Result<Cleanup, String> {
    let _lock = IO_LOCK.lock().map_err(|_| "recovery storage lock failed")?;
    save(&root(&app)?, snapshot, &retained_keys)
}

#[tauri::command]
pub async fn list_recovery_snapshots(
    app: tauri::AppHandle,
    active_ids: Vec<String>,
) -> Result<Vec<Entry>, String> {
    let _lock = IO_LOCK.lock().map_err(|_| "recovery storage lock failed")?;
    list(&root(&app)?, &active_ids, now_ms())
}

#[tauri::command]
pub async fn read_recovery_snapshot(app: tauri::AppHandle, id: String) -> Result<Restored, String> {
    let _lock = IO_LOCK.lock().map_err(|_| "recovery storage lock failed")?;
    restore(&root(&app)?, &id)
}

#[tauri::command]
pub async fn delete_recovery_snapshot(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let _lock = IO_LOCK.lock().map_err(|_| "recovery storage lock failed")?;
    delete(&root(&app)?, &id)
}

#[cfg(test)]
#[path = "recovery_tests.rs"]
mod tests;
