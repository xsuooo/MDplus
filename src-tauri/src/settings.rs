//! Only the application's fixed settings file may become a frontend Store resource.
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Read;
use std::path::Path;
use std::sync::Mutex;
use tauri::{Manager, ResourceId, State};
use tauri_plugin_store::StoreExt;

use crate::config::MAX_SETTINGS_FILE_BYTES;

#[derive(Default)]
pub struct SettingsResource(Mutex<Option<ResourceId>>);

fn read_settings(path: &Path) -> Result<HashMap<String, serde_json::Value>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(error) => return Err(error.to_string()),
    };
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("settings reparse points are not allowed".into());
        }
    }
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_SETTINGS_FILE_BYTES
    {
        return Err("settings must be a regular file within the configured size limit".into());
    }
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|error| error.to_string())?
        .take(MAX_SETTINGS_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_SETTINGS_FILE_BYTES {
        return Err("settings exceed the configured size limit".into());
    }
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("settings could not be read; original file retained: {error}"))
}

#[tauri::command]
pub fn load_settings(
    app: tauri::AppHandle,
    state: State<'_, SettingsResource>,
) -> Result<ResourceId, String> {
    let mut resource = state
        .0
        .lock()
        .map_err(|_| "settings resource lock failed")?;
    if let Some(id) = *resource {
        return Ok(id);
    }
    let path = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("mdplus-settings.json");
    let values = read_settings(&path)?;
    // StoreBuilder silently ignores file read errors. Seed only our validated snapshot,
    // and disable its implicit saves: the frontend explicitly waits for save receipts.
    let store = app
        .store_builder(path)
        .defaults(values)
        .create_new()
        .disable_auto_save()
        .build()
        .map_err(|error| error.to_string())?;
    let id = app.resources_table().add_arc(store);
    *resource = Some(id);
    Ok(id)
}

#[cfg(test)]
#[path = "settings_tests.rs"]
mod tests;
