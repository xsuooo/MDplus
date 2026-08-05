// MDPlus - Tauri backend commands

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

const MAX_TEXT_FILE_BYTES: u64 = 32 * 1024 * 1024;

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
        .chunks_exact(2)
        .map(|c| {
            if little_endian {
                u16::from_le_bytes([c[0], c[1]])
            } else {
                u16::from_be_bytes([c[0], c[1]])
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .setup(|app| {
            // 从命令行参数中提取要打开的文件路径
            let args: Vec<String> = std::env::args().collect();
            // 跳过第一个参数（程序路径），查找 .md 或 .markdown 文件
            let md_files: Vec<String> = args
                .iter()
                .skip(1)
                .filter(|arg| {
                    let lower = arg.to_lowercase();
                    (lower.ends_with(".md") || lower.ends_with(".markdown"))
                        && std::path::Path::new(arg).exists()
                })
                .map(|s| s.to_string())
                .collect();

            if !md_files.is_empty() {
                // 将文件路径发送到前端
                let window = app.get_webview_window("main").unwrap();
                let files_json = serde_json::to_string(&md_files).unwrap();
                let _ = window.eval(&format!("window.__TAURI_STARTUP_FILES__ = {}", files_json));
            }
            Ok(())
        })
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                let _ = webview.window().show();
            }
        })
        .invoke_handler(tauri::generate_handler![read_file, write_file, file_mtime])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

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
