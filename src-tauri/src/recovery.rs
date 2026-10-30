use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

use crate::{image_mime, write_file_atomic, MAX_IMAGE_FILE_BYTES, MAX_TEXT_FILE_BYTES};

const RETENTION_MS: u64 = 7 * 24 * 60 * 60 * 1000;
const MAX_IMAGES: usize = 128;
const MAX_SNAPSHOT_IMAGE_BYTES: u64 = 256 * 1024 * 1024;
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
pub struct RestoredImage {
    #[serde(flatten)]
    image: RecoveryImage,
    data: Vec<u8>,
    mime: String,
}

#[derive(serde::Serialize)]
pub struct Restored {
    snapshot: Snapshot,
    images: Vec<RestoredImage>,
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

fn cache_image(root: &Path, id: &str, key: &str, data: &[u8]) -> Result<(), String> {
    if data.len() as u64 > MAX_IMAGE_FILE_BYTES {
        return Err("recovery image exceeds size limit".into());
    }
    let dir = tab_dir(root, id, true)?;
    let path = image_path(&dir, key)?;
    image_mime(&path, data)?;
    let mut total = data.len() as u64;
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.path() != path {
            regular_path(&entry.path(), false)?;
            total += entry.metadata().map_err(|e| e.to_string())?.len();
        }
    }
    if total > MAX_SNAPSHOT_IMAGE_BYTES + MAX_TEXT_FILE_BYTES + 1024 * 1024 {
        return Err("recovery cache exceeds per-document limit".into());
    }
    if path.exists() {
        regular_path(&path, false)?;
        if read_limited(&path, MAX_IMAGE_FILE_BYTES)? == data {
            return Ok(());
        }
        return Err("recovery image keys are immutable".into());
    }
    write_file_atomic(&path, data).map_err(|e| e.to_string())
}

fn save(root: &Path, mut snapshot: Snapshot) -> Result<(), String> {
    validate(&snapshot)?;
    let dir = tab_dir(root, &snapshot.id, true)?;
    let mut size = 0;
    for image in &snapshot.images {
        let path = image_path(&dir, &image.key)?;
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
    write_file_atomic(&path, &data).map_err(|e| e.to_string())
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
            data,
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
            Ok(snapshot) => entries.push(Entry {
                id,
                title: snapshot.title,
                original_path: snapshot.original_path,
                updated_at: snapshot.updated_at,
                damaged: false,
            }),
            Err(_) => entries.push(Entry {
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

#[tauri::command]
pub async fn cache_recovery_image(
    app: tauri::AppHandle,
    id: String,
    key: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let _lock = IO_LOCK.lock().map_err(|_| "recovery storage lock failed")?;
    cache_image(&root(&app)?, &id, &key, &data)
}

#[tauri::command]
pub async fn write_recovery_snapshot(
    app: tauri::AppHandle,
    snapshot: Snapshot,
) -> Result<(), String> {
    let _lock = IO_LOCK.lock().map_err(|_| "recovery storage lock failed")?;
    save(&root(&app)?, snapshot)
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
mod tests {
    use super::*;
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "MDPlus 恢复 测试 {} {} {}",
                std::process::id(),
                now_ms(),
                COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            if self.0.starts_with(std::env::temp_dir())
                && self
                    .0
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("MDPlus 恢复 测试 ")
            {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
    }
    fn snapshot() -> Snapshot {
        Snapshot {
            id: "test-id".into(),
            title: "中文 草稿.md".into(),
            original_path: Some("D:\\中文 目录\\原文.md".into()),
            markdown: "中文 内容 ![](mdplus-image:picture)".into(),
            images: vec![RecoveryImage {
                placeholder: "mdplus-image:picture".into(),
                key: "picture.svg".into(),
                filename: "图片 一.svg".into(),
            }],
            updated_at: 0,
        }
    }
    const SVG: &[u8] = b"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"2\" height=\"2\"/>";
    #[test]
    fn unicode_paths_round_trip_and_cleanup() {
        let root = Fixture::new();
        cache_image(&root.0, "test-id", "picture.svg", SVG).unwrap();
        save(&root.0, snapshot()).unwrap();
        let result = restore(&root.0, "test-id").unwrap();
        assert_eq!(result.snapshot.markdown, snapshot().markdown);
        assert_eq!(result.images[0].data, SVG);
        assert_eq!(list(&root.0, &[], now_ms()).unwrap().len(), 1);
        assert!(list(&root.0, &["test-id".into()], now_ms())
            .unwrap()
            .is_empty());
        delete(&root.0, "test-id").unwrap();
        assert!(fs::read_dir(&root.0).unwrap().next().is_none());
    }
    #[test]
    fn interrupted_temporary_manifest_does_not_replace_last_good_snapshot() {
        let root = Fixture::new();
        cache_image(&root.0, "test-id", "picture.svg", SVG).unwrap();
        save(&root.0, snapshot()).unwrap();
        fs::write(
            root.0.join("test-id/.snapshot.json.mdplus-crash.tmp"),
            b"{\"markdown\":",
        )
        .unwrap();
        assert_eq!(
            restore(&root.0, "test-id").unwrap().snapshot.markdown,
            snapshot().markdown
        );
        let mut next = snapshot();
        next.markdown = "新内容".into();
        save(&root.0, next).unwrap();
        assert_eq!(
            restore(&root.0, "test-id").unwrap().snapshot.markdown,
            "新内容"
        );
    }
    #[test]
    fn refuses_snapshot_with_missing_attachment_without_losing_old_manifest() {
        let root = Fixture::new();
        cache_image(&root.0, "test-id", "picture.svg", SVG).unwrap();
        save(&root.0, snapshot()).unwrap();
        let mut next = snapshot();
        next.images[0].key = "missing.png".into();
        next.images[0].placeholder = "mdplus-image:missing".into();
        assert!(save(&root.0, next).is_err());
        assert!(restore(&root.0, "test-id").is_ok());
    }
    #[test]
    fn cached_image_identity_cannot_be_overwritten() {
        let root = Fixture::new();
        cache_image(&root.0, "test-id", "picture.svg", SVG).unwrap();
        save(&root.0, snapshot()).unwrap();
        assert!(cache_image(&root.0, "test-id", "picture.svg", b"<svg/>").is_err());
        assert_eq!(restore(&root.0, "test-id").unwrap().images[0].data, SVG);
    }
    #[test]
    fn traversal_and_unexpected_directories_are_never_deleted() {
        let root = Fixture::new();
        assert!(cache_image(&root.0, "../escape", "picture.svg", SVG).is_err());
        assert!(cache_image(&root.0, "test-id", "../outside.svg", SVG).is_err());
        cache_image(&root.0, "test-id", "picture.svg", SVG).unwrap();
        fs::create_dir(root.0.join("test-id/foreign")).unwrap();
        assert!(delete(&root.0, "test-id").is_err());
        assert!(root.0.join("test-id/picture.svg").exists());
    }
    #[test]
    fn expires_only_inactive_recovery_directories_after_seven_days() {
        let root = Fixture::new();
        cache_image(&root.0, "test-id", "picture.svg", SVG).unwrap();
        save(&root.0, snapshot()).unwrap();
        assert!(list(
            &root.0,
            &["test-id".into()],
            now_ms() + RETENTION_MS + 10000
        )
        .unwrap()
        .is_empty());
        assert!(root.0.join("test-id").exists());
        assert!(list(&root.0, &[], now_ms() + RETENTION_MS + 10000)
            .unwrap()
            .is_empty());
        assert!(!root.0.join("test-id").exists());
    }
    #[test]
    fn damaged_manifest_is_reported_not_silently_removed() {
        let root = Fixture::new();
        let dir = tab_dir(&root.0, "test-id", true).unwrap();
        fs::write(dir.join("snapshot.json"), b"broken").unwrap();
        assert!(list(&root.0, &[], now_ms()).unwrap()[0].damaged);
        assert!(restore(&root.0, "test-id").is_err());
    }
    #[test]
    fn crash_writer_child() {
        use std::io::Write;
        let Some(target) = std::env::var_os("MDPLUS_TEST_CRASH_TARGET") else {
            return;
        };
        let (mut file, _) = crate::create_temp_file(Path::new(&target)).unwrap();
        file.write_all(b"{\"markdown\":\"half").unwrap();
        file.sync_all().unwrap();
        std::process::exit(23);
    }
    #[test]
    fn process_exit_during_write_keeps_last_complete_manifest() {
        let root = Fixture::new();
        cache_image(&root.0, "test-id", "picture.svg", SVG).unwrap();
        save(&root.0, snapshot()).unwrap();
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "recovery::tests::crash_writer_child",
                "--nocapture",
            ])
            .env(
                "MDPLUS_TEST_CRASH_TARGET",
                root.0.join("test-id/snapshot.json"),
            )
            .status()
            .unwrap();
        assert_eq!(result.code(), Some(23));
        assert_eq!(
            restore(&root.0, "test-id").unwrap().snapshot.markdown,
            snapshot().markdown
        );
    }
    #[test]
    #[cfg(windows)]
    fn locked_manifest_does_not_destroy_previous_snapshot() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = Fixture::new();
        cache_image(&root.0, "test-id", "picture.svg", SVG).unwrap();
        save(&root.0, snapshot()).unwrap();
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(root.0.join("test-id/snapshot.json"))
            .unwrap();
        let mut next = snapshot();
        next.markdown = "replacement".into();
        assert!(save(&root.0, next).is_err());
        drop(lock);
        assert_eq!(
            restore(&root.0, "test-id").unwrap().snapshot.markdown,
            snapshot().markdown
        );
    }
}
