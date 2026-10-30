//! Installer-only process coordination. Never terminate by process name.
use std::path::Path;

pub fn run_if_requested() -> Option<i32> {
    let args: Vec<_> = std::env::args_os().collect();
    let mode = args.get(1)?.to_str()?;
    if mode != "--prepare-update" && mode != "--verify-install" {
        return None;
    }
    let result = (|| {
        let target = args
            .get(2)
            .map(Path::new)
            .ok_or("missing installation path")?;
        if args.len() != 3
            || !target.is_absolute()
            || !target
                .file_name()
                .is_some_and(|name| name.eq_ignore_ascii_case("mdplus.exe"))
        {
            return Err("invalid installation executable path".into());
        }
        if mode == "--verify-install" {
            verify(target)
        } else {
            prepare(target)
        }
    })();
    match result {
        Ok(()) => Some(0),
        Err(error) => {
            eprintln!("MDPlus update aborted: {error}");
            Some(2)
        }
    }
}

fn verify(target: &Path) -> Result<(), String> {
    use std::io::Read;
    let mut source = std::fs::File::open(std::env::current_exe().map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let mut installed = std::fs::File::open(target).map_err(|e| e.to_string())?;
    if source.metadata().map_err(|e| e.to_string())?.len()
        != installed.metadata().map_err(|e| e.to_string())?.len()
    {
        return Err("installed executable is missing or does not match the package".into());
    }
    let mut a = [0; 65536];
    let mut b = [0; 65536];
    loop {
        let length = source.read(&mut a).map_err(|e| e.to_string())?;
        if length == 0 {
            break;
        }
        installed
            .read_exact(&mut b[..length])
            .map_err(|e| e.to_string())?;
        if a[..length] != b[..length] {
            return Err("installed executable does not match the package".into());
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn prepare(_: &Path) -> Result<(), String> {
    Err("installer maintenance requires Windows".into())
}

#[cfg(windows)]
fn prepare(target: &Path) -> Result<(), String> {
    windows::prepare(target)
}

#[cfg(windows)]
mod windows {
    use std::collections::HashSet;
    use std::fs::OpenOptions;
    use std::os::windows::fs::OpenOptionsExt;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};
    use windows_sys::core::BOOL;
    use windows_sys::Win32::Foundation::{
        CloseHandle, HANDLE, HWND, INVALID_HANDLE_VALUE, LPARAM, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, WaitForSingleObject,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindowThreadProcessId, PostMessageW, WM_CLOSE,
    };

    struct OwnedHandle(HANDLE);
    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    struct Process {
        id: u32,
        parent: u32,
        name: String,
    }
    struct Tracked {
        id: u32,
        handle: OwnedHandle,
    }

    fn processes() -> Result<Vec<Process>, String> {
        let handle = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if handle == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let handle = OwnedHandle(handle);
        let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut items = Vec::new();
        let mut ok = unsafe { Process32FirstW(handle.0, &mut entry) };
        while ok != 0 {
            let length = entry
                .szExeFile
                .iter()
                .position(|c| *c == 0)
                .unwrap_or(entry.szExeFile.len());
            items.push(Process {
                id: entry.th32ProcessID,
                parent: entry.th32ParentProcessID,
                name: String::from_utf16_lossy(&entry.szExeFile[..length]),
            });
            ok = unsafe { Process32NextW(handle.0, &mut entry) };
        }
        Ok(items)
    }

    fn open(id: u32) -> Option<Tracked> {
        let handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                id,
            )
        };
        (!handle.is_null()).then_some(Tracked {
            id,
            handle: OwnedHandle(handle),
        })
    }

    fn image(process: &Tracked) -> Result<PathBuf, String> {
        let mut path = vec![0u16; 32768];
        let mut length = path.len() as u32;
        if unsafe {
            QueryFullProcessImageNameW(process.handle.0, 0, path.as_mut_ptr(), &mut length)
        } == 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(PathBuf::from(String::from_utf16_lossy(
            &path[..length as usize],
        )))
    }

    fn normalized(path: &Path) -> String {
        path.to_string_lossy()
            .replace('/', "\\")
            .trim_start_matches(r"\\?\")
            .to_lowercase()
    }

    unsafe extern "system" fn close_window(window: HWND, data: LPARAM) -> BOOL {
        let targets = &*(data as *const HashSet<u32>);
        let mut id = 0;
        GetWindowThreadProcessId(window, &mut id);
        let mut class = [0u16; 128];
        let length = GetClassNameW(window, class.as_mut_ptr(), class.len() as i32);
        // WebView2 creates auxiliary top-level windows in the same process. Closing
        // those first can tear down IPC before the editor handles its close request.
        if targets.contains(&id)
            && length > 0
            && String::from_utf16_lossy(&class[..length as usize]) == "Tauri Window"
        {
            PostMessageW(window, WM_CLOSE, 0, 0);
        }
        1
    }

    fn exited(process: &Tracked) -> bool {
        unsafe { WaitForSingleObject(process.handle.0, 0) == WAIT_OBJECT_0 }
    }

    pub(super) fn prepare(target: &Path) -> Result<(), String> {
        let target = if target.exists() {
            std::fs::canonicalize(target).map_err(|e| e.to_string())?
        } else {
            std::fs::canonicalize(target.parent().ok_or("missing installation directory")?)
                .map_err(|e| e.to_string())?
                .join("mdplus.exe")
        };
        let all = processes()?;
        let self_id = unsafe { GetCurrentProcessId() };
        let mut main = Vec::new();
        for process in &all {
            if process.id == self_id || !process.name.eq_ignore_ascii_case("mdplus.exe") {
                continue;
            }
            let Some(handle) = open(process.id) else {
                continue;
            };
            if normalized(&image(&handle)?) == normalized(&target) {
                main.push(handle);
            }
        }
        let mut ids: HashSet<u32> = main.iter().map(|p| p.id).collect();
        let main_ids = ids.clone();
        let mut children = Vec::new();
        loop {
            let mut added = false;
            for process in &all {
                if ids.contains(&process.id)
                    || !ids.contains(&process.parent)
                    || !process.name.eq_ignore_ascii_case("msedgewebview2.exe")
                {
                    continue;
                }
                if let Some(handle) = open(process.id) {
                    if !image(&handle)?
                        .file_name()
                        .is_some_and(|n| n.eq_ignore_ascii_case("msedgewebview2.exe"))
                    {
                        continue;
                    }
                    children.push(handle);
                    ids.insert(process.id);
                    added = true;
                }
            }
            if !added {
                break;
            }
        }
        // WM_CLOSE enters the application's normal unsaved-document confirmation path.
        unsafe {
            EnumWindows(Some(close_window), &main_ids as *const _ as LPARAM);
        }
        let deadline = Instant::now() + Duration::from_secs(30);
        while main.iter().any(|p| !exited(p)) {
            if Instant::now() >= deadline {
                return Err("old application is still open; save or discard changes and close it, then retry".into());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while children.iter().any(|p| !exited(p)) {
            if Instant::now() >= deadline {
                return Err(
                    "old application's WebView2 children are still running; update was not applied"
                        .into(),
                );
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        // File access, not a process name, is the final gate; AV/other locks also fail safely.
        if target.exists() {
            OpenOptions::new()
                .read(true)
                .write(true)
                .share_mode(0)
                .open(target)
                .map_err(|e| format!("installation executable is locked or not writable: {e}"))?;
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn unicode_installation_paths_are_normalized_without_losing_characters() {
            assert_eq!(
                normalized(Path::new(r"\\?\D:\中文 空格\MDPlus.exe")),
                normalized(Path::new("d:/中文 空格/mdplus.exe"))
            );
        }
        #[test]
        fn exclusive_probe_detects_an_external_file_lock() {
            let dir =
                std::env::temp_dir().join(format!("MDPlus 安装 锁测试-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let file = dir.join("mdplus.exe");
            std::fs::write(&file, b"fixture").unwrap();
            let lock = OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(&file)
                .unwrap();
            assert!(prepare(&file).is_err());
            drop(lock);
            assert!(prepare(&file).is_ok());
            std::fs::remove_file(file).unwrap();
            std::fs::remove_dir(dir).unwrap();
        }
    }
}
