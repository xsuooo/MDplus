//! Content-safe document commands. The public payload contract is file_contract.json.
//!
//! Windows sharing protects each read snapshot, not the gap before ReplaceFileW.
//! Every replacement therefore captures the replaced object in a unique same-volume
//! backup and verifies it afterwards. A late conflict is reported with independent
//! local/previous copies, never "fixed" by overwriting a third party's next edit.
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tempfile::{Builder, TempDir};

use crate::{decode_text, image_mime, looks_binary, MAX_IMAGE_FILE_BYTES, MAX_TEXT_FILE_BYTES};

// Serializes this process only; arbitrary external editors do not participate.
static DOCUMENT_WRITES: Mutex<()> = Mutex::new(());

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileError {
    pub code: &'static str,
    pub message: String,
    pub path: String,
    pub recovery_path: Option<String>,
    pub backup_path: Option<String>,
    pub actual_revision: Option<String>,
    pub write_state: &'static str,
}

impl FileError {
    fn new(code: &'static str, path: &Path, message: impl Into<String>) -> Box<Self> {
        Box::new(Self {
            code,
            message: message.into(),
            path: display(path),
            recovery_path: None,
            backup_path: None,
            actual_revision: None,
            write_state: "unchanged",
        })
    }
    fn io(path: &Path, error: io::Error) -> Box<Self> {
        let code = if matches!(error.raw_os_error(), Some(32 | 33)) {
            "BUSY"
        } else {
            "IO_ERROR"
        };
        Self::new(code, path, format!("文件操作失败：{error}"))
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSnapshot {
    pub content: String,
    pub revision: String,
    pub mtime: u64,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionState {
    pub revision: Option<String>,
    pub mtime: Option<u64>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteReceipt {
    pub revision: String,
    pub mtime: u64,
    pub backup_path: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageReceipt {
    pub filename: String,
    pub relative_path: String,
    pub path: String,
}

fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
fn revision(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn valid_basename(name: &str) -> bool {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.encode_utf16().count() > 255
        || name.ends_with(['.', ' '])
        || name
            .chars()
            .any(|c| c.is_control() || ['/', '\\', ':', '*', '?', '"', '<', '>', '|'].contains(&c))
    {
        return false;
    }
    let stem = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_ascii_uppercase();
    if ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&stem.as_str()) {
        return false;
    }
    for prefix in ["COM", "LPT"] {
        if let Some(suffix) = stem.strip_prefix(prefix) {
            if ["1", "2", "3", "4", "5", "6", "7", "8", "9", "¹", "²", "³"].contains(&suffix) {
                return false;
            }
        }
    }
    true
}

fn is_link(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    metadata.file_type().is_symlink()
}

fn target_path(path: &Path) -> Result<PathBuf, Box<FileError>> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|name| valid_basename(name))
        .ok_or_else(|| FileError::new("INVALID_PATH", path, "文件名无效或属于系统保留名称"))?;
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()
            .map_err(|error| FileError::io(path, error))?
            .join(path)
    };
    let parent = absolute
        .parent()
        .ok_or_else(|| FileError::new("INVALID_PATH", path, "文件没有父目录"))?;
    let parent = fs::canonicalize(parent).map_err(|error| FileError::io(path, error))?;
    if !parent.is_dir() {
        return Err(FileError::new("INVALID_PATH", path, "父路径不是目录"));
    }
    let target = parent.join(name);
    match fs::symlink_metadata(&target) {
        Ok(metadata) if is_link(&metadata) || !metadata.is_file() => Err(FileError::new(
            "INVALID_PATH",
            path,
            "不支持目录、链接或重解析点作为文件目标",
        )),
        Ok(_) => Ok(target),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(target),
        Err(error) => Err(FileError::io(path, error)),
    }
}

struct RawSnapshot {
    // Keeping this handle alive denies in-place writers/deletion on Windows.
    _file: File,
    bytes: Vec<u8>,
    revision: String,
    mtime: u64,
}

fn raw_snapshot(path: &Path) -> Result<RawSnapshot, Box<FileError>> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;
        options.share_mode(FILE_SHARE_READ);
    }
    let mut file = options
        .open(path)
        .map_err(|error| FileError::io(path, error))?;
    let metadata = file
        .metadata()
        .map_err(|error| FileError::io(path, error))?;
    if !metadata.is_file() || is_link(&metadata) {
        return Err(FileError::new("INVALID_PATH", path, "不是常规文件"));
    }
    if metadata.len() > MAX_TEXT_FILE_BYTES {
        return Err(FileError::new("TOO_LARGE", path, "文稿超过 32 MiB 上限"));
    }
    #[cfg(test)]
    hooks::run(hooks::Checkpoint::ReadLocked, path);
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_TEXT_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| FileError::io(path, error))?;
    if bytes.len() as u64 > MAX_TEXT_FILE_BYTES {
        return Err(FileError::new("TOO_LARGE", path, "文稿超过 32 MiB 上限"));
    }
    let after = file
        .metadata()
        .map_err(|error| FileError::io(path, error))?;
    if after.len() != metadata.len() || after.modified().ok() != metadata.modified().ok() {
        return Err(FileError::new(
            "CONFLICT",
            path,
            "文件在读取期间改变，请重新读取",
        ));
    }
    let mtime = after
        .modified()
        .map_err(|error| FileError::io(path, error))?
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    Ok(RawSnapshot {
        _file: file,
        revision: revision(&bytes),
        bytes,
        mtime,
    })
}

fn optional_snapshot(path: &Path) -> Result<Option<RawSnapshot>, Box<FileError>> {
    // Preserve the actual NotFound kind, rather than interpreting an error string.
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(FileError::io(path, error)),
        Ok(metadata) if is_link(&metadata) || !metadata.is_file() => {
            return Err(FileError::new("INVALID_PATH", path, "不是常规文件"))
        }
        Ok(_) => {}
    }
    // If it disappears between metadata and opening, fail closed; the caller retries.
    raw_snapshot(path).map(Some)
}

#[tauri::command]
pub fn read_document(path: String) -> Result<DocumentSnapshot, Box<FileError>> {
    let path = target_path(Path::new(&path))?;
    let raw = raw_snapshot(&path)?;
    if looks_binary(&raw.bytes) {
        return Err(FileError::new(
            "INVALID_ENCODING",
            &path,
            "不支持二进制文稿",
        ));
    }
    let content = decode_text(&raw.bytes)
        .map_err(|message| FileError::new("INVALID_ENCODING", &path, message))?;
    Ok(DocumentSnapshot {
        content,
        revision: raw.revision,
        mtime: raw.mtime,
    })
}

#[tauri::command]
pub fn document_revision(path: String) -> Result<RevisionState, Box<FileError>> {
    let path = target_path(Path::new(&path))?;
    let raw = optional_snapshot(&path)?;
    Ok(RevisionState {
        revision: raw.as_ref().map(|value| value.revision.clone()),
        mtime: raw.map(|value| value.mtime),
    })
}

struct SaveCopies {
    directory: TempDir,
    local: PathBuf,
    staging: PathBuf,
    previous: PathBuf,
}
impl SaveCopies {
    fn new(target: &Path, bytes: &[u8]) -> Result<Self, Box<FileError>> {
        let directory = Builder::new()
            .prefix(".mdplus-save-")
            .tempdir_in(target.parent().unwrap())
            .map_err(|error| FileError::io(target, error))?;
        let local = directory.path().join("local.md");
        write_new(&local, bytes).map_err(|error| FileError::io(target, error))?;
        let intent =
            serde_json::to_vec(&serde_json::json!({ "target": display(target), "format": 1 }))
                .map_err(|error| FileError::new("IO_ERROR", target, error.to_string()))?;
        write_new(&directory.path().join("intent.json"), &intent)
            .map_err(|error| FileError::io(target, error))?;
        Ok(Self {
            staging: directory.path().join("staging.tmp"),
            previous: directory.path().join("previous.md"),
            local,
            directory,
        })
    }
    fn retain(self, mut error: Box<FileError>) -> Box<FileError> {
        error.recovery_path = self.local.is_file().then(|| display(&self.local));
        error.backup_path = self.previous.is_file().then(|| display(&self.previous));
        let _retained_directory = self.directory.keep();
        if let Some(path) = &error.recovery_path {
            error.message.push_str(&format!("\n本地副本：{path}"));
        }
        if let Some(path) = &error.backup_path {
            error.message.push_str(&format!("\n替换前副本：{path}"));
        }
        error
    }
}

fn write_new(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

#[cfg(windows)]
fn replace_capturing_previous(staging: &Path, target: &Path, previous: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;
    let wide = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<u16>>()
    };
    let target = wide(target);
    let staging = wide(staging);
    let previous = wide(previous);
    // SAFETY: all three buffers are live, NUL-terminated, same-volume paths. No
    // staging handle is open. WRITE_THROUGH is explicitly unsupported by this API.
    let result = unsafe {
        ReplaceFileW(
            target.as_ptr(),
            staging.as_ptr(),
            previous.as_ptr(),
            0,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
#[cfg(not(windows))]
fn replace_capturing_previous(_: &Path, _: &Path, _: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "verified replacements currently require Windows",
    ))
}

#[cfg(windows)]
fn publish_new(staging: &Path, target: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;
    let wide = |path: &Path| {
        path.as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<u16>>()
    };
    let staging = wide(staging);
    let target = wide(target);
    // SAFETY: same-volume live NUL-terminated paths. Omitting REPLACE_EXISTING
    // is essential: a file created after our absence check must be left alone.
    let result = unsafe { MoveFileExW(staging.as_ptr(), target.as_ptr(), 0) };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
#[cfg(not(windows))]
fn publish_new(staging: &Path, target: &Path) -> io::Result<()> {
    fs::hard_link(staging, target)?;
    fs::remove_file(staging)
}

#[tauri::command]
pub fn write_document(
    path: String,
    content: String,
    expected_revision: Option<String>,
) -> Result<WriteReceipt, Box<FileError>> {
    let target = target_path(Path::new(&path))?;
    if content.len() as u64 > MAX_TEXT_FILE_BYTES {
        return Err(FileError::new("TOO_LARGE", &target, "文稿超过 32 MiB 上限"));
    }
    let _lock = DOCUMENT_WRITES
        .lock()
        .map_err(|_| FileError::new("IO_ERROR", &target, "保存队列不可用，请保留草稿并重启"))?;
    let copies = SaveCopies::new(&target, content.as_bytes())?;
    let current = match optional_snapshot(&target) {
        Ok(current) => current,
        Err(error) => return Err(copies.retain(error)),
    };
    let actual = current.as_ref().map(|raw| raw.revision.clone());
    if actual != expected_revision {
        let mut error = FileError::new("CONFLICT", &target, "磁盘版本已改变，本次未覆盖磁盘文件");
        error.actual_revision = actual;
        return Err(copies.retain(error));
    }
    if let Err(error) = write_new(&copies.staging, content.as_bytes()) {
        return Err(copies.retain(FileError::io(&target, error)));
    }
    // Release the read-sharing guard only after both local copies are durable.
    // This gap cannot be made a content-CAS by ReplaceFileW; verify the captured backup.
    drop(current);
    #[cfg(test)]
    hooks::run(hooks::Checkpoint::BeforeCommit, &target);
    if expected_revision.is_some() {
        if let Err(error) = replace_capturing_previous(&copies.staging, &target, &copies.previous) {
            let mut error = FileError::new(
                "RECOVERY_REQUIRED",
                &target,
                format!("Windows 替换未完成，路径状态需要核对：{error}"),
            );
            error.write_state = "unknown";
            return Err(copies.retain(error));
        }
    } else {
        // Publish the complete, closed staging file without REPLACE_EXISTING.
        if let Err(error) = publish_new(&copies.staging, &target) {
            let mut failure = if error.kind() == io::ErrorKind::AlreadyExists {
                FileError::new("CONFLICT", &target, "目标文件已被创建，本次未覆盖")
            } else {
                FileError::io(&target, error)
            };
            failure.actual_revision = optional_snapshot(&target)
                .ok()
                .flatten()
                .map(|raw| raw.revision);
            return Err(copies.retain(failure));
        }
    }
    #[cfg(test)]
    hooks::run(hooks::Checkpoint::AfterCommit, &target);
    let committed = match raw_snapshot(&target) {
        Ok(raw) => raw,
        Err(cause) => {
            let mut error = FileError::new(
                "RECOVERY_REQUIRED",
                &target,
                format!("文件已替换，但无法核验写入结果：{}", cause.message),
            );
            error.write_state = "committed";
            return Err(copies.retain(error));
        }
    };
    let expected_local = revision(content.as_bytes());
    let backup_matches = match expected_revision {
        Some(ref expected) => {
            raw_snapshot(&copies.previous).is_ok_and(|raw| raw.revision == *expected)
        }
        None => true,
    };
    if committed.revision != expected_local || !backup_matches {
        let mut error = FileError::new(
            "RECOVERY_REQUIRED",
            &target,
            "替换期间检测到外部修改；已保留副本，请手动核对，未自动回滚",
        );
        error.actual_revision = Some(committed.revision.clone());
        error.write_state = "committed";
        return Err(copies.retain(error));
    }
    let receipt = WriteReceipt {
        revision: committed.revision.clone(),
        mtime: committed.mtime,
        backup_path: None,
    };
    // The target remains read-locked until this function returns; mtime belongs
    // to the verified bytes. Successful saves need not accumulate private drafts.
    let previous = copies.previous.clone();
    if copies.directory.close().is_err() && previous.is_file() {
        return Ok(WriteReceipt {
            backup_path: Some(display(&previous)),
            ..receipt
        });
    }
    Ok(receipt)
}

#[tauri::command]
pub fn save_image_asset(
    doc_path: String,
    filename: String,
    data: Vec<u8>,
) -> Result<ImageReceipt, Box<FileError>> {
    let document = target_path(Path::new(&doc_path))?;
    if !valid_basename(&filename) {
        return Err(FileError::new("INVALID_PATH", &document, "图片文件名无效"));
    }
    if data.len() as u64 > MAX_IMAGE_FILE_BYTES {
        return Err(FileError::new(
            "TOO_LARGE",
            &document,
            "图片超过 64 MiB 上限",
        ));
    }
    image_mime(Path::new(&filename), &data)
        .map_err(|message| FileError::new("INVALID_ENCODING", &document, message))?;
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
    for attempt in 0..1000 {
        let filename = if attempt == 0 {
            filename.clone()
        } else {
            format!("{stem}-{attempt}.{extension}")
        };
        let path = directory.join(&filename);
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(0);
        }
        let mut file = match options.open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(FileError::io(&path, error)),
        };
        let result = file.write_all(&data).and_then(|_| file.sync_all());
        #[cfg(test)]
        let result = hooks::image_write_result(result);
        drop(file);
        if let Err(error) = result {
            #[cfg(test)]
            hooks::run(hooks::Checkpoint::ImageWriteFailed, &path);
            // The closed path may now name another writer's file; never delete it by name.
            let mut failure = FileError::io(&path, error);
            failure.write_state = "unknown";
            failure.message.push_str(&format!(
                "\n图片可能不完整，未删除该路径，请手动核对：{}",
                failure.path
            ));
            return Err(failure);
        }
        return Ok(ImageReceipt {
            relative_path: format!("./assets/{filename}"),
            filename,
            path: display(&path),
        });
    }
    Err(FileError::new(
        "IO_ERROR",
        &directory,
        "图片同名文件过多，未覆盖任何已有图片",
    ))
}

#[cfg(test)]
pub(crate) mod hooks {
    use std::cell::{Cell, RefCell};
    use std::path::Path;
    #[derive(Clone, Copy, PartialEq)]
    pub enum Checkpoint {
        ReadLocked,
        BeforeCommit,
        AfterCommit,
        ImageWriteFailed,
    }
    type Hook = (Checkpoint, Box<dyn FnOnce(&Path)>);
    thread_local! { static HOOK: RefCell<Option<Hook>> = const { RefCell::new(None) }; }
    thread_local! { static IMAGE_WRITE_FAILURE: Cell<bool> = const { Cell::new(false) }; }
    pub fn fail_next_image_write() {
        IMAGE_WRITE_FAILURE.with(|flag| flag.set(true));
    }
    pub(super) fn image_write_result(result: std::io::Result<()>) -> std::io::Result<()> {
        if IMAGE_WRITE_FAILURE.with(|flag| flag.replace(false)) {
            result.and(Err(std::io::Error::other("injected image write failure")))
        } else {
            result
        }
    }
    pub fn at(point: Checkpoint, hook: impl FnOnce(&Path) + 'static) {
        HOOK.with(|slot| *slot.borrow_mut() = Some((point, Box::new(hook))));
    }
    pub(super) fn run(point: Checkpoint, path: &Path) {
        let hook = HOOK.with(|slot| {
            if slot
                .borrow()
                .as_ref()
                .is_some_and(|(expected, _)| *expected == point)
            {
                slot.borrow_mut().take()
            } else {
                None
            }
        });
        if let Some((_, hook)) = hook {
            hook(path);
        }
    }
}
