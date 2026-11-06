// This list opts all application commands into Tauri's capability enforcement.
// Keep it aligned with generate_handler!, the main capability and file_contract.json.
pub const COMMANDS: &[&str] = &[
    "read_document",
    "document_revision",
    "write_document",
    "save_image_asset",
    "commit_image_assets",
    "discard_image_assets",
    "stash_image",
    "read_stashed_image",
    "discard_stashed_images",
    "export_html",
    "read_image_file",
    "load_settings",
    "save_settings",
    "take_startup_files",
    "take_pending_open_files",
    "cache_recovery_image",
    "write_recovery_snapshot",
    "list_recovery_snapshots",
    "read_recovery_snapshot",
    "delete_recovery_snapshot",
];
