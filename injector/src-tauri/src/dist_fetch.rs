/*
 * Récupère le build JS de low-cord (patcher.js/preload.js/renderer.js/
 * renderer.css) depuis la branche "builds" du repo principal
 * (lemonnv39/low-cord) — alimentée automatiquement par
 * .github/workflows/publish-dist.yml à chaque push sur main — plutôt que
 * d'exiger un clone local de low-cord avec Node/pnpm.
 *
 * C'est ce qui permet à quelqu'un qui n'a QUE l'exe de l'injecteur (aucun
 * repo, aucun Node) de patcher son Discord : le champ "Dossier du repo
 * low-cord" dans Réglages reste possible en override pour le développement
 * local, mais n'est plus requis.
 *
 * Ce module gère aussi la détection de nouvelle version : le SHA du dernier
 * commit sur la branche "builds" est mis en cache à côté des fichiers
 * téléchargés ; un check silencieux au lancement (voir spawn_silent_check)
 * le compare au SHA distant et prévient le frontend si ça a changé,
 * séparément du check de mise à jour de l'injecteur lui-même (qui, lui,
 * passe par updater.rs).
 */

use serde::Deserialize;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use crate::config::{BUILD_BASE_URL, COMMITS_API_URL, USER_AGENT};
use crate::log::{self as ilog, Kind};
const FILES: &[&str] = &["patcher.js", "preload.js", "renderer.js", "renderer.css"];

#[derive(Deserialize)]
struct CommitResponse {
    sha: String,
}

/// `%APPDATA%\low-cord\dist` — à côté des réglages du cord
/// (`%APPDATA%\low-cord\settings`), un seul dossier à connaître pour l'utilisateur.
fn dist_dir(app: &AppHandle) -> PathBuf {
    let dir = app.path().data_dir().expect("dossier de données introuvable").join(crate::config::DATA_DIR_NAME).join("dist");
    let _ = fs::create_dir_all(&dir);
    dir
}

pub fn cached_patcher_path(app: &AppHandle) -> PathBuf {
    dist_dir(app).join("patcher.js")
}

/// SHA du build actuellement en cache (celui qu'un patch écrirait MAINTENANT
/// dans le stub, voir asar::write_app_asar) — None si jamais téléchargé ou si
/// le cache du SHA a échoué à un précédent téléchargement (best-effort, voir
/// download_latest).
pub fn cached_sha(app: &AppHandle) -> Option<String> {
    fs::read_to_string(sha_cache_path(app)).ok().map(|s| s.trim().to_string())
}

fn sha_cache_path(app: &AppHandle) -> PathBuf {
    dist_dir(app).join(".build-sha")
}

/// Dernier SHA distant CONNU — distinct de sha_cache_path (qui suit le SHA du
/// build réellement téléchargé sur disque) : celui-ci est rafraîchi à chaque
/// lancement de l'injecteur (voir spawn_silent_check) même si aucun
/// téléchargement n'a eu lieu, pour que chaque ligne Discord puisse comparer
/// son propre build_sha (embarqué dans son stub, voir asar.rs) à la dernière
/// version connue et afficher "à jour" / "mettre à jour" sans jamais avoir
/// besoin d'un check manuel.
fn latest_sha_path(app: &AppHandle) -> PathBuf {
    dist_dir(app).join(".latest-sha")
}

/// Interroge GitHub pour le dernier SHA publié et le mémorise comme "dernier
/// connu" (bouton "vérifier les mises à jour" d'une branche).
pub async fn refresh_latest_sha(app: &AppHandle) -> Result<String, String> {
    let client = http_client()?;
    let sha = fetch_latest_sha(&client).await?;
    let _ = fs::write(latest_sha_path(app), &sha);
    Ok(sha)
}

pub fn latest_known_sha(app: &AppHandle) -> Option<String> {
    fs::read_to_string(latest_sha_path(app)).ok().map(|s| s.trim().to_string())
}

fn http_client() -> Result<reqwest::Client, String> {
    // Timeouts explicites : sans eux, un réseau qui stalle fige l'install à
    // l'infini (reqwest n'a aucun timeout par défaut). On préfère une erreur
    // claire après un délai généreux.
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())
}

async fn fetch_latest_sha(client: &reqwest::Client) -> Result<String, String> {
    let resp = client
        .get(COMMITS_API_URL)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Échec de la vérification de version : {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Échec de la vérification de version : HTTP {}", resp.status()));
    }

    let commit: CommitResponse = resp.json().await.map_err(|e| e.to_string())?;
    Ok(commit.sha)
}

async fn download_file(client: &reqwest::Client, filename: &str, dest_dir: &PathBuf) -> Result<(), String> {
    let url = format!("{BUILD_BASE_URL}/{filename}");
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Échec du téléchargement de {filename} : {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Échec du téléchargement de {filename} : HTTP {}", resp.status()));
    }

    let bytes = resp.bytes().await.map_err(|e| format!("Échec de lecture de {filename} : {e}"))?;
    ilog::emit(Kind::Net, format!("{filename} téléchargé ({})", ilog::size(bytes.len() as u64)));
    let dest = dest_dir.join(filename);
    let existed = dest.exists();
    fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    ilog::emit(if existed { Kind::Mod } else { Kind::Add }, format!("{}", dest.display()));
    Ok(())
}

/// Télécharge la dernière version du build depuis la branche builds et écrase le
/// cache local. Utilisé au patch quand aucun repo local n'est configuré, et
/// par le bouton "Mettre à jour le build low-cord" des Réglages.
pub async fn download_latest(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = dist_dir(app);
    let client = http_client()?;

    // Best-effort : l'API commits (limitée niveau rate-limit) est secondaire
    // par rapport au téléchargement des fichiers eux-mêmes (raw.githubusercontent,
    // bien plus permissif) — si elle échoue, on télécharge quand même, on
    // perd juste la capacité de détecter la PROCHAINE mise à jour tant que
    // le SHA n'aura pas pu être rafraîchi.
    let sha = fetch_latest_sha(&client).await.ok();
    match &sha {
        Some(sha) => ilog::emit(Kind::Net, format!("dernière build publiée : {}", &sha[..sha.len().min(7)])),
        None => ilog::emit(Kind::Warn, "version de la build inconnue (API GitHub indisponible)"),
    }

    for filename in FILES {
        download_file(&client, filename, &dir).await?;
    }

    if let Some(sha) = sha {
        let _ = fs::write(sha_cache_path(app), sha);
    }

    Ok(dir.join("patcher.js"))
}

/// Compare le SHA distant à celui en cache. Ne retourne Some(...) QUE s'il y
/// a déjà un cache ET qu'il diffère — pas de "mise à jour disponible" pour
/// quelqu'un qui n'a encore jamais rien téléchargé (ça n'aurait pas de sens
/// avant même un premier patch).
pub async fn check_for_update(app: &AppHandle) -> Result<Option<String>, String> {
    let Ok(cached_sha) = fs::read_to_string(sha_cache_path(app)) else {
        return Ok(None);
    };

    let client = http_client()?;
    let remote_sha = fetch_latest_sha(&client).await?;

    if remote_sha.trim() != cached_sha.trim() {
        Ok(Some(remote_sha))
    } else {
        Ok(None)
    }
}

/// Check silencieux et non-bloquant au lancement, comme updater::spawn_silent_check
/// mais pour le CONTENU de low-cord plutôt que pour l'injecteur lui-même —
/// n'installe/télécharge jamais rien tout seul, prévient juste le frontend.
///
/// Rafraîchit systématiquement latest_sha_path (un seul appel API, léger) et
/// émet "latest-build-sha" à chaque lancement, pour que les lignes Discord de
/// la liste sachent immédiatement si leur build est à jour — sans ça,
/// "mettre à jour" ne s'afficherait jamais avant un check manuel, ce qui ne
/// servirait à rien. L'ancien event "lowcord-build-update-available" (cache de
/// fichiers téléchargés vs distant) reste émis séparément pour la bannière de
/// mise à jour du build en Réglages.
pub fn spawn_silent_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let Ok(client) = http_client() else { return };
        let Ok(remote_sha) = fetch_latest_sha(&client).await else {
            eprintln!("[dist_fetch] check silencieux échoué (récupération du SHA distant)");
            return;
        };

        let _ = fs::write(latest_sha_path(&app), &remote_sha);
        let _ = app.emit("latest-build-sha", serde_json::json!({ "sha": remote_sha }));

        if let Ok(cached) = fs::read_to_string(sha_cache_path(&app)) {
            if cached.trim() != remote_sha.trim() {
                let _ = app.emit("lowcord-build-update-available", serde_json::json!({ "sha": remote_sha }));
            }
        }
    });
}
