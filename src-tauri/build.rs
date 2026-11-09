fn main() {
    println!("cargo:rerun-if-changed=../config/application.json");
    println!("cargo:rerun-if-changed=src/ipc_commands.rs");
    let config: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string("../config/application.json").expect("missing application config"),
    )
    .expect("invalid application config");
    let mut constants = String::new();
    for (name, key, kind) in [
        ("MAX_TEXT_FILE_BYTES", "textFileBytes", "u64"),
        ("MAX_HTML_EXPORT_BYTES", "htmlExportBytes", "u64"),
        ("MAX_IMAGE_FILE_BYTES", "imageFileBytes", "u64"),
        ("MAX_IMAGE_MEMORY_BYTES", "imageMemoryBytes", "u64"),
        ("MAX_IMAGE_STASH_BYTES", "imageStashBytes", "u64"),
        ("MAX_IMAGE_STASH_ENTRIES", "imageStashEntries", "usize"),
        ("MAX_SETTINGS_FILE_BYTES", "settingsFileBytes", "u64"),
        ("MAX_SNAPSHOT_IMAGE_BYTES", "snapshotImageBytes", "u64"),
        ("MAX_RECOVERY_IMAGES", "recoveryImages", "usize"),
        ("RECOVERY_RETENTION_MS", "recoveryRetentionMs", "u64"),
    ] {
        let value = config["limits"][key]
            .as_u64()
            .expect("limit must be an unsigned integer");
        assert!(value > 0, "limit must be positive");
        constants.push_str(&format!("pub const {name}: {kind} = {value};\n"));
    }
    std::fs::write(
        std::path::Path::new(&std::env::var("OUT_DIR").expect("missing build output"))
            .join("application_config.rs"),
        constants,
    )
    .expect("failed to generate application limits");
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(ipc_commands::COMMANDS)),
    )
    .expect("failed to build the application command allowlist");
}

#[path = "src/ipc_commands.rs"]
mod ipc_commands;
