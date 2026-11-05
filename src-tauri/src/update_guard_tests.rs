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
