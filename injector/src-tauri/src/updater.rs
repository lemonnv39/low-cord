/*
 * Self-update PORTABLE de l'injecteur — sans
 * NSIS/tauri-plugin-updater (l'app est un .exe portable unique).
 *
 * On lit la dernière GitHub Release de `lemonnv39/low-cord`, on compare
 * son tag à la version courante (CARGO_PKG_VERSION) ; si elle est plus récente
 * on télécharge l'asset `low-cord-injector.exe` et on REMPLACE l'exe en cours
 * d'exécution (self_replace gère le renommage impossible-à-supprimer de
 * Windows), puis on relance l'app sur le nouveau binaire.
 *
 * NB : distinct de dist_fetch.rs, qui met à jour le CONTENU de low-cord
 * (patcher.js & co) depuis low-cord. Ici c'est l'injecteur lui-même.
 */

use std::time::Duration;

use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::config::{RELEASES_API, RELEASE_TAG_PREFIX, USER_AGENT};
// Noms d'asset préférés, essayés dans l'ordre ; à défaut on prend le premier
// asset .exe de la release. Robuste à un renommage du binaire (self_replace
// remplace l'exe courant quel que soit son nom local).
const PREFERRED_ASSETS: &[&str] = &["low-cord-injector.exe"];

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    body: Option<String>,
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
}

#[derive(Clone, Serialize)]
pub struct UpdateInfo {
    version: String,
    notes: Option<String>,
    url: String,
}

fn http_client() -> Result<reqwest::Client, String> {
    // Timeouts explicites : sans eux, un réseau qui stalle figerait la
    // vérification/le téléchargement à l'infini (reqwest n'a aucun timeout par
    // défaut). Le timeout global est généreux car on télécharge l'exe complet
    // (~10 Mo) — mieux vaut échouer proprement après un délai que geler.
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())
}

/// `injector-v1.2.3` (tag du monorepo) / `v1.2.3` / `1.2.3` -> `1.2.3`
fn normalize_tag(tag: &str) -> &str {
    let tag = tag.trim();
    tag.strip_prefix(RELEASE_TAG_PREFIX).unwrap_or(tag).trim_start_matches(['v', 'V'])
}

async fn fetch_latest_release() -> Result<Release, String> {
    let resp = http_client()?
        .get(RELEASES_API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Échec de la vérification de mise à jour : {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Échec de la vérification de mise à jour : HTTP {}", resp.status()));
    }
    resp.json::<Release>().await.map_err(|e| format!("Réponse illisible : {e}"))
}

/// Renvoie l'info de MAJ si la dernière Release est plus récente que la version
/// courante ET expose l'asset `low-cord-injector.exe`, sinon None.
async fn available_update() -> Result<Option<UpdateInfo>, String> {
    let rel = fetch_latest_release().await?;
    let current = Version::parse(env!("CARGO_PKG_VERSION")).map_err(|e| e.to_string())?;
    let latest = Version::parse(normalize_tag(&rel.tag_name))
        .map_err(|e| format!("Tag de release illisible « {} » : {e}", rel.tag_name))?;
    if latest <= current {
        return Ok(None);
    }
    let asset = PREFERRED_ASSETS
        .iter()
        .find_map(|name| rel.assets.iter().find(|a| a.name.eq_ignore_ascii_case(name)))
        .or_else(|| rel.assets.iter().find(|a| a.name.to_ascii_lowercase().ends_with(".exe")))
        .ok_or_else(|| format!("Aucun .exe dans la release {}", rel.tag_name))?;
    Ok(Some(UpdateInfo {
        version: normalize_tag(&rel.tag_name).to_string(),
        notes: rel.body,
        url: asset.browser_download_url.clone(),
    }))
}

/// Check silencieux au lancement : émet `injector-update-available` si une MAJ
/// existe. N'installe/ne télécharge rien tout seul — c'est le frontend qui,
/// sur clic, appelle `install_injector_update`.
pub fn spawn_silent_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        match available_update().await {
            Ok(Some(info)) => {
                let _ = app.emit("injector-update-available", info);
            }
            Ok(None) => {}
            Err(e) => eprintln!("[updater] check silencieux échoué : {e}"),
        }
    });
}

/// Re-vérifie à la demande (bouton manuel). Renvoie l'info de MAJ ou None.
#[tauri::command]
pub async fn check_injector_update() -> Result<Option<UpdateInfo>, String> {
    available_update().await
}

/// Télécharge le nouvel exe et remplace l'exe courant, puis relance l'app.
/// Cette commande ne « rend » jamais la main : `app.restart()` termine le
/// process courant et démarre le nouveau binaire.
#[tauri::command]
pub async fn install_injector_update(app: AppHandle, url: String) -> Result<(), String> {
    // 1. Télécharge le nouvel exe.
    let bytes = http_client()?
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Téléchargement de la mise à jour : {e}"))?
        .error_for_status()
        .map_err(|e| format!("Téléchargement de la mise à jour : {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("Lecture de la mise à jour : {e}"))?;

    // 2. Écrit dans un fichier temporaire sur le même volume que l'exe.
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let tmp = exe.with_extension("new");
    std::fs::write(&tmp, &bytes).map_err(|e| format!("Écriture du fichier temporaire : {e}"))?;

    // 3. Remplace l'exe en cours d'exécution (self_replace gère Windows).
    self_replace::self_replace(&tmp).map_err(|e| format!("Remplacement de l'exécutable : {e}"))?;
    let _ = std::fs::remove_file(&tmp);

    // 4. Relance sur le nouveau binaire (diverge : ne revient jamais).
    app.restart();
}
