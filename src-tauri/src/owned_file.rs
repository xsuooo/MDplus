//! A native-owned file is pinned by its handle until commit/discard. On Windows
//! its share mode denies writes and renames, and deletion acts on that handle,
//! never on a pathname that another process could have replaced.
use std::fs::{File, OpenOptions};
use std::io;
use std::path::Path;

pub(crate) fn create_owned(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE};
        use windows_sys::Win32::Storage::FileSystem::{DELETE, FILE_SHARE_READ};
        options
            .access_mode(GENERIC_READ | GENERIC_WRITE | DELETE)
            .share_mode(FILE_SHARE_READ);
    }
    options.open(path)
}

#[cfg(windows)]
pub(crate) fn delete_on_close(file: &File) -> io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FileDispositionInfo, SetFileInformationByHandle, FILE_DISPOSITION_INFO,
    };
    let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
    // SAFETY: file is a live handle created with DELETE access. The information
    // struct is live for the call. Windows pins identity and denies all external
    // mutation until this last owned handle closes.
    let success = unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileDispositionInfo,
            &disposition as *const FILE_DISPOSITION_INFO as *const _,
            std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    };
    if success == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
pub(crate) fn delete_on_close(_: &File) -> io::Result<()> {
    // A pathname identity check followed by unlink is not a safe deletion CAS.
    // Retain assets rather than risk deleting a replacement on another platform.
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "owned asset deletion currently requires Windows",
    ))
}
