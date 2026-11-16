// MDPlus - Tauri backend commands
mod config;
#[cfg(test)]
mod image_asset_tests;
mod image_data;
mod image_import;
mod image_stash;
mod owned_file;
mod recovery;
mod safe_files;
#[cfg(test)]
mod safe_files_tests;
mod settings;
mod update_guard;

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

use config::{MAX_HTML_EXPORT_BYTES, MAX_IMAGE_FILE_BYTES, MAX_TEXT_FILE_BYTES};

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
/// 写回时统一为 UTF-8(见 safe_files::write_document),GBK 文件保存后转码为 UTF-8,内容不再丢失。
fn decode_text(bytes: &[u8]) -> Result<String, String> {
    if let Some(data) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return std::str::from_utf8(data)
            .map(str::to_owned)
            .map_err(|_| "UTF-8 BOM 文件包含无效字节，已拒绝有损解码".into());
    }
    if let Some(data) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        return decode_utf16(data, true);
    }
    if let Some(data) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        return decode_utf16(data, false);
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return Ok(text.to_owned());
    }
    let (decoded, _, had_errors) = encoding_rs::GBK.decode(bytes);
    if had_errors {
        return Err("文件包含无法按 UTF-8 或 GBK 解码的字节，已保留原文件".into());
    }
    Ok(decoded.into_owned())
}

/// BOM 确定编码后不回退；残缺字节和非法代理项必须显式失败。
fn decode_utf16(data: &[u8], little_endian: bool) -> Result<String, String> {
    let (chunks, remainder) = data.as_chunks::<2>();
    if !remainder.is_empty() {
        return Err("UTF-16 文件末尾存在残缺字节，已保留原文件".into());
    }
    let units: Vec<u16> = chunks
        .iter()
        .map(|chunk| {
            if little_endian {
                u16::from_le_bytes(*chunk)
            } else {
                u16::from_be_bytes(*chunk)
            }
        })
        .collect();
    String::from_utf16(&units).map_err(|_| "UTF-16 文件包含非法代理项，已保留原文件".into())
}

fn looks_binary(bytes: &[u8]) -> bool {
    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        return false;
    }
    bytes.iter().take(8192).any(|byte| *byte == 0)
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
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

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
                0, // ReplaceFileW does not support WRITE_THROUGH.
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

fn validate_html_export(path: &Path, byte_length: u64) -> Result<(), String> {
    if !path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("html"))
    {
        return Err("HTML export requires an .html target".into());
    }
    if byte_length > MAX_HTML_EXPORT_BYTES {
        return Err("HTML export exceeds the configured HTML-export limit".into());
    }
    Ok(())
}

/// HTML includes bundled fonts and base64 images; its independent budget must
/// apply to revision reads and backup verification as well as to input bytes.
#[tauri::command]
fn export_html(path: String, content: String) -> Result<(), String> {
    validate_html_export(Path::new(&path), content.len() as u64)?;
    let target = safe_files::revision_with_limit(path, MAX_HTML_EXPORT_BYTES)
        .map_err(|error| error.message)?;
    safe_files::write_text_with_limit(target.path, content, target.revision, MAX_HTML_EXPORT_BYTES)
        .map(|_| ())
        .map_err(|error| error.message)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageFile {
    path: String,
    mime: &'static str,
    data_base64: String,
}

fn document_image_path(doc_path: &Path, relative_path: &Path) -> Result<PathBuf, String> {
    if relative_path
        .components()
        .any(|component| matches!(component, Component::Prefix(_) | Component::RootDir))
    {
        return Err("image reference must be a relative path".to_owned());
    }
    let document = safe_files::target_path(doc_path).map_err(|error| error.message)?;
    if !document.is_file() {
        return Err("image references require an existing regular document".into());
    }
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
        return Err(format!(
            "image exceeds the {} byte limit",
            MAX_IMAGE_FILE_BYTES
        ));
    }
    let mut data = Vec::new();
    file.take(MAX_IMAGE_FILE_BYTES + 1)
        .read_to_end(&mut data)
        .map_err(|e| e.to_string())?;
    if data.len() as u64 > MAX_IMAGE_FILE_BYTES {
        return Err(format!(
            "image exceeds the {} byte limit",
            MAX_IMAGE_FILE_BYTES
        ));
    }
    Ok(ImageFile {
        mime: image_mime(&path, &data)?,
        path: path.to_string_lossy().into_owned(),
        data_base64: image_data::encode_image(&data),
    })
}

fn markdown_files_from_args<I, F>(args: I, cwd: &Path, path_is_file: F) -> Vec<String>
where
    I: IntoIterator<Item = String>,
    F: Fn(&str) -> bool,
{
    args.into_iter()
        .skip(1)
        .filter_map(|arg| {
            let lower = arg.to_lowercase();
            if !(lower.ends_with(".md") || lower.ends_with(".markdown")) {
                return None;
            }
            let path = Path::new(&arg);
            let resolved = if path.is_absolute() {
                path.to_owned()
            } else {
                // A second process can have a different cwd from the primary
                // instance. Never resolve its relative files against our cwd or
                // call set_current_dir, which would race other document work.
                if !cwd.is_absolute() {
                    return None;
                }
                #[cfg(windows)]
                {
                    let mut components = path.components();
                    if let Some(Component::Prefix(prefix)) = components.next() {
                        use std::path::Prefix;
                        let Prefix::Disk(drive) = prefix.kind() else {
                            return None;
                        };
                        let sender_drive = match cwd.components().next() {
                            Some(Component::Prefix(p)) => match p.kind() {
                                Prefix::Disk(d) | Prefix::VerbatimDisk(d) => d,
                                _ => return None,
                            },
                            _ => return None,
                        };
                        if !drive.eq_ignore_ascii_case(&sender_drive) {
                            return None;
                        }
                        let resolved = cwd
                            .join(components.as_path())
                            .to_string_lossy()
                            .into_owned();
                        return path_is_file(&resolved).then_some(resolved);
                    }
                }
                cwd.join(path)
            };
            if !resolved.is_absolute() {
                return None;
            }
            let resolved = resolved.to_string_lossy().into_owned();
            path_is_file(&resolved).then_some(resolved)
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
    if let Some(code) = update_guard::run_if_requested() {
        std::process::exit(code);
    }
    // Parse arguments before creating the webview so the hidden-window startup path has
    // the file list available before React mounts.
    let args: Vec<String> = std::env::args().collect();
    let startup_cwd = std::env::current_dir().unwrap_or_default();
    let startup_files =
        markdown_files_from_args(args, &startup_cwd, |path| Path::new(path).is_file());

    tauri::Builder::default()
        .manage(StartupFiles::new(startup_files))
        .manage(PendingOpenFiles::default())
        .manage(image_stash::ImageStash::default())
        .register_uri_scheme_protocol("mdplus-image-stash", |context, request| {
            image_stash::preview(context.app_handle(), request)
        })
        .plugin(tauri_plugin_dialog::init())
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
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            // Resolve against the sending process before filtering or queueing.
            let md_files =
                markdown_files_from_args(args, Path::new(&cwd), |path| Path::new(path).is_file());
            let has_files = !md_files.is_empty();
            if has_files {
                app.state::<PendingOpenFiles>().push(md_files);
            }

            if let Some(window) = app.get_webview_window("main") {
                // 初次显现由前端在恢复位置与布局后完成,第二实例不抢先显示隐藏窗口。
                if window.is_visible().unwrap_or(false) {
                    if window.is_minimized().unwrap_or(false) {
                        let _ = window.unminimize();
                    }
                    let _ = window.set_focus();
                }

                // 如果有文件，传递给前端
                if has_files {
                    let _ = window.emit("open-files", ());
                }
            }
        }))
        .invoke_handler(tauri::generate_handler![
            safe_files::read_document,
            safe_files::document_revision,
            safe_files::write_document,
            safe_files::save_image_asset,
            safe_files::commit_image_assets,
            safe_files::discard_image_assets,
            image_stash::stash_image,
            image_import::import_dropped_image,
            image_stash::read_stashed_image,
            image_stash::discard_stashed_images,
            read_image_file,
            export_html,
            settings::load_settings,
            settings::save_settings,
            take_startup_files,
            take_pending_open_files,
            recovery::cache_recovery_image,
            recovery::write_recovery_snapshot,
            recovery::list_recovery_snapshots,
            recovery::read_recovery_snapshot,
            recovery::delete_recovery_snapshot
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "export_validation_tests.rs"]
mod export_validation_tests;
