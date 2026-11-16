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

/// `code` and `writeState` let the frontend retry only a rejection that wrote nothing.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsError {
    code: &'static str,
    message: String,
    write_state: &'static str,
}

impl From<String> for SettingsError {
    fn from(message: String) -> Self {
        Self {
            code: "IO_ERROR",
            message,
            write_state: "unchanged",
        }
    }
}

impl From<&str> for SettingsError {
    fn from(message: &str) -> Self {
        message.to_string().into()
    }
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
) -> Result<SettingsReceipt, SettingsError> {
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
    .map_err(|error| {
        let error = *error;
        // The caller still holds these values and retries against the changed file,
        // so a retained copy per rejected save would only pile up beside the settings.
        // The writer reports copies under the canonical parent directory.
        let stale = error.code == "CONFLICT" && error.write_state == "unchanged";
        let removed = stale
            && error
                .recovery_path
                .as_deref()
                .and_then(|copy| Path::new(copy).parent())
                .is_some_and(|directory| {
                    fs::canonicalize(parent).ok().as_deref() == directory.parent()
                        && directory
                            .file_name()
                            .is_some_and(|name| name.to_string_lossy().starts_with(".mdplus-save-"))
                        && fs::remove_dir_all(directory).is_ok()
                });
        SettingsError {
            code: error.code,
            write_state: error.write_state,
            // A copy that could not be removed stays named in the message.
            message: if removed {
                "settings changed on disk; the file was not overwritten".into()
            } else {
                error.message
            },
        }
    })?;
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
) -> Result<SettingsReceipt, SettingsError> {
    persist_settings(&settings_path(&app)?, values, expected_revision)
}

#[cfg(test)]
#[path = "settings_tests.rs"]
mod tests;
