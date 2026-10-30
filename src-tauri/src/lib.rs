// MDPlus - Tauri backend commands

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

const MAX_TEXT_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_IMAGE_FILE_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Default)]
struct StartupFiles(Mutex<Vec<String>>);

impl StartupFiles {
    fn new(files: Vec<String>) -> Self {
        Self(Mutex::new(files))
    }

    fn take(&self) -> Vec<String> {
        std::mem::take(&mut *self.0.lock().expect("startup files mutex poisoned"))
    }
}

#[derive(Default)]
struct PendingOpenFiles(Mutex<Vec<String>>);

impl PendingOpenFiles {
    fn push(&self, files: Vec<String>) {
        self.0
            .lock()
            .expect("pending open files mutex poisoned")
            .extend(files);
    }

    fn take(&self) -> Vec<String> {
        std::mem::take(&mut *self.0.lock().expect("pending open files mutex poisoned"))
    }
}

#[tauri::command]
fn take_startup_files(state: State<'_, StartupFiles>) -> Vec<String> {
    state.take()
}

#[tauri::command]
fn take_pending_open_files(state: State<'_, PendingOpenFiles>) -> Vec<String> {
    state.take()
}

/// 解码文件字节为文本:
/// 1. 剥离 UTF-8 BOM;
/// 2. 有效 UTF-8 直接使用;
/// 3. 带 BOM 的 UTF-16 LE/BE 按对应编码解码;
/// 4. 其余(常见 GBK/GB2312 编码的中文文件)按 GBK 解码,保留中文内容。
///
/// 写回时统一为 UTF-8(见 write_file),GBK 文件保存后转码为 UTF-8,内容不再丢失。
fn decode_text(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_owned();
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        if let Some(s) = decode_utf16(&bytes[2..], true) {
            return s;
        }
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        if let Some(s) = decode_utf16(&bytes[2..], false) {
            return s;
        }
    }
    let (decoded, _, _) = encoding_rs::GBK.decode(bytes);
    decoded.into_owned()
}

/// 按 UTF-16 解码(已去掉 BOM 的字节),little_endian 指定字节序。
fn decode_utf16(data: &[u8], little_endian: bool) -> Option<String> {
    let units: Vec<u16> = data
        .as_chunks::<2>()
        .0
        .iter()
        .map(|c| {
            if little_endian {
                u16::from_le_bytes(*c)
            } else {
                u16::from_be_bytes(*c)
            }
        })
        .collect();
    String::from_utf16(&units).ok()
}

fn looks_binary(bytes: &[u8]) -> bool {
    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        return false;
    }
    bytes.iter().take(8192).any(|byte| *byte == 0)
}

/// Read a file's text content from disk.
#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err("path is not a regular file".to_owned());
    }
    if metadata.len() > MAX_TEXT_FILE_BYTES {
        return Err("file is larger than the 32 MiB text-file limit".to_owned());
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    if looks_binary(&bytes) {
        return Err("binary files are not supported".to_owned());
    }
    Ok(decode_text(&bytes))
}

fn create_temp_file(target: &Path) -> io::Result<(File, PathBuf)> {
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("mdplus");
    let pid = std::process::id();

    for attempt in 0..100u32 {
        let candidate = parent.join(format!(".{name}.mdplus-{pid}-{attempt}.tmp"));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => return Ok((file, candidate)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }

    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "unable to allocate a unique temporary file",
    ))
}

#[cfg(windows)]
fn replace_file(temp: &Path, target: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{ReplaceFileW, REPLACEFILE_WRITE_THROUGH};

    if target.exists() {
        let target_w: Vec<u16> = target
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let temp_w: Vec<u16> = temp
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let result = unsafe {
            ReplaceFileW(
                target_w.as_ptr(),
                temp_w.as_ptr(),
                std::ptr::null(),
                REPLACEFILE_WRITE_THROUGH,
                std::ptr::null(),
                std::ptr::null(),
            )
        };
        if result == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    } else {
        fs::rename(temp, target)
    }
}

#[cfg(not(windows))]
fn replace_file(temp: &Path, target: &Path) -> io::Result<()> {
    fs::rename(temp, target)
}

fn write_file_atomic(path: &Path, content: &[u8]) -> io::Result<()> {
    let (mut temp_file, temp_path) = create_temp_file(path)?;
    let result = (|| {
        temp_file.write_all(content)?;
        temp_file.sync_all()?;
        drop(temp_file);
        replace_file(&temp_path, path)
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

/// Write text content to a file on disk (always UTF-8).
/// 先写临时文件再原子替换,避免写入中断导致原文件损坏。
#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    write_file_atomic(Path::new(&path), content.as_bytes()).map_err(|e| e.to_string())
}

/// Return a file's last-modified time in milliseconds since UNIX_EPOCH.
#[tauri::command]
fn file_mtime(path: String) -> Result<u64, String> {
    let mtime = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .map_err(|e| e.to_string())?;
    let millis = mtime
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(millis)
}

/// Save binary data (e.g., images) to a file.
#[tauri::command]
fn save_binary_file(path: String, data: Vec<u8>) -> Result<(), String> {
    write_file_atomic(Path::new(&path), &data).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
struct ImageFile {
    path: String,
    mime: &'static str,
    data: Vec<u8>,
}

fn document_image_path(doc_path: &Path, relative_path: &Path) -> Result<PathBuf, String> {
    if relative_path
        .components()
        .any(|component| matches!(component, Component::Prefix(_) | Component::RootDir))
    {
        return Err("image reference must be a relative path".to_owned());
    }
    let document = fs::canonicalize(doc_path).map_err(|e| e.to_string())?;
    let directory = document
        .parent()
        .ok_or("document has no parent directory")?;
    let image = fs::canonicalize(directory.join(relative_path)).map_err(|e| e.to_string())?;
    // Canonicalization also resolves symlinks and Windows junctions before the boundary check.
    if !image.starts_with(directory) {
        return Err("image reference is outside the document directory".to_owned());
    }
    Ok(image)
}

fn is_svg(bytes: &[u8]) -> bool {
    use quick_xml::events::Event;

    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };
    let mut reader = quick_xml::Reader::from_str(text);
    let mut root_seen = false;
    let mut depth = 0usize;
    loop {
        match reader.read_event() {
            Ok(Event::Start(tag)) => {
                if depth == 0 && (root_seen || tag.name().as_ref() != b"svg") {
                    return false;
                }
                root_seen = true;
                depth += 1;
            }
            Ok(Event::Empty(tag)) if depth == 0 => {
                if root_seen || tag.name().as_ref() != b"svg" {
                    return false;
                }
                root_seen = true;
            }
            Ok(Event::End(_)) => {
                let Some(next_depth) = depth.checked_sub(1) else {
                    return false;
                };
                depth = next_depth;
            }
            Ok(Event::DocType(_)) | Err(_) => return false,
            Ok(Event::Text(text)) if depth == 0 => {
                if text.iter().any(|byte| !byte.is_ascii_whitespace()) {
                    return false;
                }
            }
            Ok(Event::CData(_) | Event::GeneralRef(_)) if depth == 0 => return false,
            Ok(Event::Eof) => return root_seen && depth == 0,
            Ok(_) => {}
        }
    }
}

fn image_mime(path: &Path, bytes: &[u8]) -> Result<&'static str, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let expected = match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" if is_svg(bytes) => return Ok("image/svg+xml"),
        _ => return Err("unsupported or invalid image file".to_owned()),
    };
    match infer::get(bytes) {
        Some(kind) if kind.mime_type() == expected => Ok(expected),
        _ => Err("image content does not match its extension".to_owned()),
    }
}

/// Only read supported images inside the directory of the user-opened document.
#[tauri::command]
fn read_image_file(doc_path: String, relative_path: String) -> Result<ImageFile, String> {
    let path = document_image_path(Path::new(&doc_path), Path::new(&relative_path))?;
    let file = File::open(&path).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err("path is not a regular file".to_owned());
    }
    if metadata.len() > MAX_IMAGE_FILE_BYTES {
        return Err("image is larger than the 64 MiB image-file limit".to_owned());
    }
    let mut data = Vec::new();
    file.take(MAX_IMAGE_FILE_BYTES + 1)
        .read_to_end(&mut data)
        .map_err(|e| e.to_string())?;
    if data.len() as u64 > MAX_IMAGE_FILE_BYTES {
        return Err("image is larger than the 64 MiB image-file limit".to_owned());
    }
    Ok(ImageFile {
        mime: image_mime(&path, &data)?,
        path: path.to_string_lossy().into_owned(),
        data,
    })
}

/// Create a directory (and parent directories if needed).
#[tauri::command]
fn create_directory(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

fn markdown_files_from_args<I, F>(args: I, path_exists: F) -> Vec<String>
where
    I: IntoIterator<Item = String>,
    F: Fn(&str) -> bool,
{
    args.into_iter()
        .skip(1)
        .filter_map(|arg| {
            let lower = arg.to_lowercase();
            let is_markdown = lower.ends_with(".md") || lower.ends_with(".markdown");
            (is_markdown && path_exists(&arg)).then_some(arg)
        })
        .collect()
}

/// 禁用浏览器查找、刷新、打印、开发工具加速键,保留文本编辑快捷键。
/// 不设置 AcceleratorKeyPressed.Handled:它会连同页面键盘事件一起吞掉。
#[cfg(windows)]
fn configure_browser_accelerator_keys(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows_core::Interface;

    window.with_webview(|webview| {
        let controller = webview.controller();
        // 读回一次实际状态,失败时至少能在日志里看出来,不至于静默失效
        let outcome = unsafe {
            (|| -> windows_core::Result<bool> {
                let core = controller.CoreWebView2()?;
                let settings = core.Settings()?;
                let settings3: ICoreWebView2Settings3 = settings.cast()?;
                settings3.SetAreBrowserAcceleratorKeysEnabled(false)?;
                let mut enabled = windows_core::BOOL(0);
                settings3.AreBrowserAcceleratorKeysEnabled(&mut enabled)?;
                Ok(enabled.as_bool())
            })()
        };
        match outcome {
            Ok(true) => eprintln!("[mdplus] WebView2 浏览器加速键仍为开启,功能键可能被宿主拦截"),
            Ok(false) => eprintln!("[mdplus] WebView2 browser accelerator keys enabled=false"),
            Err(err) => eprintln!("[mdplus] 关闭 WebView2 浏览器加速键失败: {err}"),
        }
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Parse arguments before creating the webview so the hidden-window startup path has
    // the file list available before React mounts.
    let args: Vec<String> = std::env::args().collect();
    let startup_files = markdown_files_from_args(args, |path| Path::new(path).exists());

    tauri::Builder::default()
        .manage(StartupFiles::new(startup_files))
        .manage(PendingOpenFiles::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .setup(|app| {
            // 窗口在 setup 之前已由 tauri.conf.json 创建,这里把 WebView2 的宿主层
            // 加速键关掉,前端才能收到 F11 这类裸功能键(详见函数注释)。
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                if let Err(err) = configure_browser_accelerator_keys(&window) {
                    eprintln!("[mdplus] 配置 WebView2 加速键失败: {err}");
                }
            }
            Ok(())
        })
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // 当尝试启动第二个实例时，将参数发送给第一个实例
            let md_files = markdown_files_from_args(args, |path| Path::new(path).exists());

            if let Some(window) = app.get_webview_window("main") {
                // 确保窗口可见并获得焦点
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();

                // 如果有文件，传递给前端
                if !md_files.is_empty() {
                    app.state::<PendingOpenFiles>().push(md_files);
                    let _ = window.emit("open-files", ());
                }
            }
        }))
        .on_page_load(|webview, payload| {
            // 页面一开始加载就显示窗口,避免用户双击后长时间看不到任何反馈。
            // 窗口配置了 backgroundColor(#f6f5f1),配合前端的 startup-placeholder,
            // 在内容渲染完成前不会闪白或闪欢迎页。
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                let window = webview.window();
                let _ = window.show();
                let _ = window.set_focus();
            }
        })
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            file_mtime,
            save_binary_file,
            read_image_file,
            create_directory,
            take_startup_files,
            take_pending_open_files
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "mdplus-image-test-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn image_paths_are_limited_to_the_document_directory() {
        let root = TestDirectory::new();
        let docs = root.0.join("docs");
        fs::create_dir_all(docs.join("img")).unwrap();
        let document = docs.join("note.md");
        fs::write(&document, "document").unwrap();
        fs::write(docs.join("img/picture.png"), b"image").unwrap();
        fs::write(root.0.join("secret.png"), b"secret").unwrap();

        assert!(document_image_path(&document, Path::new("img/picture.png")).is_ok());
        assert!(document_image_path(&document, Path::new("../secret.png")).is_err());
        assert!(document_image_path(&document, &root.0.join("secret.png")).is_err());
        assert!(document_image_path(&document, Path::new("img/missing.png")).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn windows_absolute_and_drive_relative_image_paths_are_rejected() {
        let root = TestDirectory::new();
        let document = root.0.join("note.md");
        fs::write(&document, "document").unwrap();
        for reference in [
            r"C:\private\secret.png",
            r"C:private\secret.png",
            r"\private\secret.png",
            r"\\server\share\secret.png",
            r"\\?\C:\private\secret.png",
        ] {
            assert!(document_image_path(&document, Path::new(reference)).is_err());
        }
    }

    #[test]
    fn directory_links_cannot_escape_the_document_directory() {
        let root = TestDirectory::new();
        let docs = root.0.join("docs");
        let outside = root.0.join("outside");
        fs::create_dir(&docs).unwrap();
        fs::create_dir(&outside).unwrap();
        let document = docs.join("note.md");
        fs::write(&document, "document").unwrap();
        fs::write(outside.join("secret.png"), b"secret").unwrap();
        let link = docs.join("linked");
        #[cfg(windows)]
        {
            let output = std::process::Command::new("cmd")
                .args(["/c", "mklink", "/J"])
                .arg(&link)
                .arg(&outside)
                .output()
                .unwrap();
            assert!(output.status.success());
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &link).unwrap();

        assert!(document_image_path(&document, Path::new("linked/secret.png")).is_err());
        #[cfg(windows)]
        fs::remove_dir(&link).unwrap();
        #[cfg(unix)]
        fs::remove_file(&link).unwrap();
    }

    #[test]
    fn image_content_must_match_a_supported_extension() {
        let png = [
            0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R',
        ];
        assert_eq!(image_mime(Path::new("image.png"), &png), Ok("image/png"));
        assert!(image_mime(Path::new("secret.png"), b"PRIVATE_KEY=secret").is_err());
        assert!(image_mime(Path::new("secret.txt"), &png).is_err());
        assert!(image_mime(Path::new("image.jpg"), &png).is_err());
        assert!(image_mime(Path::new("image.svg"), b"not an image").is_err());
        assert!(image_mime(Path::new("image.svg"), b"<html/>").is_err());
        assert!(image_mime(Path::new("image.svg"), b"<svg><g>").is_err());
        assert!(image_mime(Path::new("image.svg"), b"<!DOCTYPE svg><svg/>").is_err());
        assert_eq!(
            image_mime(
                Path::new("image.svg"),
                br#"<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>"#
            ),
            Ok("image/svg+xml")
        );
    }

    #[test]
    fn image_command_rejects_disguised_non_images() {
        let root = TestDirectory::new();
        let document = root.0.join("note.md");
        fs::write(&document, "document").unwrap();
        fs::write(root.0.join("secret.png"), "PRIVATE_KEY=secret").unwrap();
        assert!(read_image_file(
            document.to_string_lossy().into_owned(),
            "secret.png".to_owned()
        )
        .is_err());
    }

    #[test]
    fn startup_files_are_consumed_only_once() {
        let startup_files = StartupFiles::new(vec!["README.md".to_string()]);

        assert_eq!(startup_files.take(), vec!["README.md"]);
        assert!(startup_files.take().is_empty());
    }

    #[test]
    fn pending_open_files_survive_before_frontend_listener_is_ready() {
        let pending = PendingOpenFiles::default();
        pending.push(vec!["first.md".to_string()]);
        pending.push(vec!["second.md".to_string()]);

        assert_eq!(pending.take(), vec!["first.md", "second.md"]);
        assert!(pending.take().is_empty());
    }

    #[test]
    fn startup_file_arguments_are_detected_before_webview_creation() {
        let files = markdown_files_from_args(
            vec![
                "mdplus.exe".to_string(),
                "README.md".to_string(),
                "notes.txt".to_string(),
                "missing.md".to_string(),
            ],
            |path| path == "README.md",
        );

        assert_eq!(files, vec!["README.md"]);
    }

    #[test]
    fn utf8_passthrough_unchanged() {
        assert_eq!(decode_text("你好 MDPlus".as_bytes()), "你好 MDPlus");
    }

    #[test]
    fn utf8_bom_is_stripped() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice("中文".as_bytes());
        assert_eq!(decode_text(&bytes), "中文");
    }

    #[test]
    fn gbk_roundtrip_preserves_chinese() {
        // GBK 编码的中文文件不再被 from_utf8_lossy 打成 U+FFFD
        let (gbk, _, _) = encoding_rs::GBK.encode("中文测试内容 123");
        let text = decode_text(&gbk);
        assert_eq!(text, "中文测试内容 123");
        assert!(!text.contains('\u{FFFD}'));
    }

    #[test]
    fn utf16le_bom_is_decoded() {
        let mut bytes = vec![0xFF, 0xFE];
        for u in "你好 UTF-16".encode_utf16() {
            bytes.extend_from_slice(&u.to_le_bytes());
        }
        assert_eq!(decode_text(&bytes), "你好 UTF-16");
    }

    #[test]
    fn utf16be_bom_is_decoded() {
        let mut bytes = vec![0xFE, 0xFF];
        for u in "你好 UTF-16".encode_utf16() {
            bytes.extend_from_slice(&u.to_be_bytes());
        }
        assert_eq!(decode_text(&bytes), "你好 UTF-16");
    }

    #[test]
    fn binary_payload_is_detected_but_utf16_is_allowed() {
        assert!(looks_binary(b"text\0payload"));
        assert!(!looks_binary(&[0xFF, 0xFE, 0x00, 0x4E]));
    }

    #[test]
    fn atomic_write_replaces_existing_file() {
        let path = std::env::temp_dir().join(format!(
            "mdplus-atomic-write-{}-{}.md",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::write(&path, "旧内容").unwrap();
        write_file_atomic(&path, "新内容".as_bytes()).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "新内容");
        let _ = fs::remove_file(path);
    }
}
