/*
 * Persistance minimale des réglages de l'injecteur (juste le chemin du repo
 * low-cord pour l'instant) — un fichier JSON dans le dossier de config Tauri de
 * l'app, pas de plugin externe pour un si petit besoin.
 */

use serde::{Deserialize, Serialize};
use std::fs;
use tauri::{AppHandle, Manager};

#[derive(Debug, Default, Serialize, Deserialize, Clone)]
pub struct InjectorSettings {
    pub repo_path: Option<String>,
}

fn settings_file(app: &AppHandle) -> std::path::PathBuf {
    let dir = app.path().app_config_dir().expect("dossier de config introuvable");
    let _ = fs::create_dir_all(&dir);
    dir.join("injector-settings.json")
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> InjectorSettings {
    let path = settings_file(&app);
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings: InjectorSettings) -> Result<(), String> {
    let path = settings_file(&app);
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}
