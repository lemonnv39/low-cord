/*
 * Export/import des préréglages de plugins low-cord — lit/écrit directement le
 * `settings.json` qu'low-cord (fork Vencord) maintient lui-même dans son propre
 * dossier de données, sans jamais toucher Discord en direct : seule la clé
 * "plugins" (état activé + réglages par plugin, format Vencord standard)
 * est exportée/importée, le reste de la configuration (thèmes, cloud sync,
 * langue...) n'est jamais touché.
 *
 * Bug corrigé (rapporté après un vrai test avec un ami) : si low-cord tournait
 * encore pendant l'import, il réécrivait settings.json avec son état EN
 * MÉMOIRE juste après notre écriture, annulant silencieusement l'import —
 * d'où l'impression que "ça n'a pas marché". On tue maintenant toutes les
 * branches connues avant d'écrire, comme patch_discord le fait déjà pour
 * app.asar, et on les relance ensuite pour que le changement soit visible
 * immédiatement.
 */

use crate::patcher;
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

/// Pack de plugins par défaut, fourni par l'utilisateur à partir de son
/// propre compte — appliqué automatiquement à la toute première install
/// de low-cord sur une machine (voir apply_default_plugins_if_fresh dans
/// patcher.rs), pour qu'un nouvel ami n'ait pas besoin de refaire tout le
/// tri de plugins à la main. Volontairement expurgé des données propres à
/// l'utilisateur d'origine (permissions partagées avec un compte précis,
/// chemins de dossier codés en dur) avant d'être embarqué ici.
const DEFAULT_PLUGINS_JSON: &str = include_str!("default_plugins.json");

fn settings_json_path() -> Result<PathBuf, String> {
    let appdata = std::env::var("APPDATA").map_err(|_| "Variable APPDATA introuvable.".to_string())?;
    Ok(PathBuf::from(appdata).join("low-cord").join("settings").join("settings.json"))
}

/// Utilisé pour décider si une install est "toute fraîche" pour cette
/// machine — voir patcher::patch_discord.
pub fn settings_json_exists() -> bool {
    settings_json_path().map(|p| p.exists()).unwrap_or(false)
}

fn require_existing_settings_path() -> Result<PathBuf, String> {
    let path = settings_json_path()?;
    if !path.exists() {
        return Err(format!(
            "Fichier de settings low-cord introuvable ({}). Lance low-cord au moins une fois avant d'exporter tes plugins.",
            path.display()
        ));
    }
    Ok(path)
}

fn read_settings() -> Result<Value, String> {
    let path = require_existing_settings_path()?;
    let raw = fs::read_to_string(&path).map_err(|e| format!("Lecture de settings.json impossible : {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("settings.json invalide : {e}"))
}

fn write_settings(value: &Value) -> Result<(), String> {
    let path = require_existing_settings_path()?;
    let pretty = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    fs::write(&path, pretty).map_err(|e| format!("Écriture de settings.json impossible : {e}"))
}

fn set_plugins_key(plugins: Value) -> Result<(), String> {
    // Ferme low-cord AVANT de lire/écrire : sinon le process encore en mémoire
    // resauvegarde son propre état par-dessus notre écriture dès qu'il perd
    // le focus ou se ferme normalement, et le changement semble n'avoir
    // jamais eu lieu (voir le commentaire d'en-tête du fichier).
    let killed = patcher::kill_all_known_processes();

    let mut settings = read_settings()?;
    let Some(obj) = settings.as_object_mut() else {
        return Err("settings.json a un format inattendu.".to_string());
    };
    obj.insert("plugins".to_string(), plugins);
    write_settings(&settings)?;

    patcher::relaunch_branches(&killed);
    Ok(())
}

/// Exporte uniquement la clé "plugins" (état + réglages de chaque plugin)
/// vers le fichier choisi par l'utilisateur — jamais le reste de la config.
/// Ne modifie rien, donc pas besoin de fermer low-cord pour l'export.
#[tauri::command]
pub fn export_plugin_presets(dest_path: String) -> Result<(), String> {
    let settings = read_settings()?;
    let plugins = settings.get("plugins").cloned().unwrap_or(Value::Object(Default::default()));

    let preset = serde_json::json!({
        "lowcordPluginPreset": true,
        "version": 1,
        "plugins": plugins,
    });

    let pretty = serde_json::to_string_pretty(&preset).map_err(|e| e.to_string())?;
    fs::write(&dest_path, pretty).map_err(|e| format!("Écriture du fichier impossible : {e}"))
}

/// Importe une clé "plugins" depuis un fichier exporté par cette même
/// fonction — remplace la config de plugins actuelle, ne touche à rien
/// d'autre dans settings.json (thèmes, langue, cloud...). Ferme puis relance
/// low-cord (voir set_plugins_key) pour que le changement soit réellement pris
/// en compte.
#[tauri::command]
pub fn import_plugin_presets(src_path: String) -> Result<(), String> {
    let raw = fs::read_to_string(&src_path).map_err(|e| format!("Lecture du fichier impossible : {e}"))?;
    let preset: Value = serde_json::from_str(&raw).map_err(|e| format!("Fichier invalide (pas du JSON) : {e}"))?;

    let plugins = preset
        .get("plugins")
        .cloned()
        .ok_or_else(|| "Ce fichier ne contient pas de préréglage de plugins low-cord valide.".to_string())?;

    set_plugins_key(plugins)
}

/// Applique le pack de plugins par défaut embarqué — appelé automatiquement
/// juste après la toute première install de low-cord sur une machine (voir
/// patcher::patch_discord), jamais sur une install qui a déjà son propre
/// settings.json (on ne touche jamais aux choix d'un utilisateur existant).
/// Pack vide (`{}`) = rien à appliquer : on ne ferme/relance alors PAS Discord
/// juste après l'install (inutile, et risque de l'erreur « Object has been destroyed »).
pub fn has_default_plugins() -> bool {
    serde_json::from_str::<Value>(DEFAULT_PLUGINS_JSON)
        .ok()
        .and_then(|v| v.as_object().map(|o| !o.is_empty()))
        .unwrap_or(false)
}

pub fn apply_default_plugins() -> Result<(), String> {
    let plugins: Value = serde_json::from_str(DEFAULT_PLUGINS_JSON)
        .map_err(|e| format!("default_plugins.json embarqué invalide : {e}"))?;
    set_plugins_key(plugins)
}
