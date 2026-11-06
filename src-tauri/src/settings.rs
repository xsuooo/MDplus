//! Fixed-path settings snapshots. No plugin resources, autosave or exit-time writes.
//! A save receipt is returned only after the same atomic/CAS checks as documents.
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

use crate::config::MAX_SETTINGS_FILE_BYTES;
use crate::safe_files;

type Values = HashMap<String, serde_json::Value>;

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSnapshot {
    values: Values,
    revision: Option<String>,
}

#[derive(Debug, serde::Serialize)]
pub struct SettingsReceipt {
    revision: String,
}

fn read_settings(path: &Path) -> Result<SettingsSnapshot, String> {
    // This includes strict regular-file/reparse checks, bounded reading and a
    // Windows sharing guard. Hash exactly the bytes parsed, never a later read.
    let Some(raw) = safe_files::optional_snapshot(path, MAX_SETTINGS_FILE_BYTES)
        .map_err(|error| error.message)?
    else {
        return Ok(SettingsSnapshot {
            values: Values::new(),
            revision: None,
        });
    };
    let values = serde_json::from_slice(&raw.bytes)
        .map_err(|error| format!("settings could not be read; original file retained: {error}"))?;
    Ok(SettingsSnapshot {
        values,
        revision: Some(raw.revision),
    })
}

fn persist_settings(
    path: &Path,
    values: Values,
    expected_revision: Option<String>,
) -> Result<SettingsReceipt, String> {
    let content = serde_json::to_string(&values).map_err(|error| error.to_string())?;
    if content.len() as u64 > MAX_SETTINGS_FILE_BYTES {
        return Err("settings exceed the configured size limit; original file retained".into());
    }
    // Creating the application directory is deferred until an explicit save.
    // Failed loads (including malformed JSON) never create or replace a file.
    let parent = path.parent().ok_or("settings path has no parent")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let receipt = safe_files::write_text_with_limit(
        path.to_string_lossy().into_owned(),
        content,
        expected_revision,
        MAX_SETTINGS_FILE_BYTES,
    )
    .map_err(|error| error.message)?;
    Ok(SettingsReceipt {
        revision: receipt.revision,
    })
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("mdplus-settings.json"))
}

#[tauri::command]
pub fn load_settings(app: tauri::AppHandle) -> Result<SettingsSnapshot, String> {
    read_settings(&settings_path(&app)?)
}

#[tauri::command]
pub fn save_settings(
    app: tauri::AppHandle,
    values: Values,
    expected_revision: Option<String>,
) -> Result<SettingsReceipt, String> {
    persist_settings(&settings_path(&app)?, values, expected_revision)
}

#[cfg(test)]
#[path = "settings_tests.rs"]
mod tests;
