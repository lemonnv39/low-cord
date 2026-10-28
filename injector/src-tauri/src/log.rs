/*
 * Journal d'installation en temps réel : chaque opération réelle faite sur le
 * Discord de l'utilisateur (process arrêtés, fichiers supprimés/créés/restaurés,
 * téléchargements, relance) est émise au frontend via l'événement Tauri
 * "install-log", pour que l'utilisateur voie EXACTEMENT ce qui est fait.
 *
 * Les fonctions bas niveau (patcher.rs, dist_fetch.rs) n'ont pas toutes un
 * AppHandle sous la main : une commande ouvre un `scope` (AppHandle + branche)
 * et tout `log::emit` fait pendant ce scope est rattaché à cette branche.
 */

use serde::Serialize;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// Information neutre (vérification, état).
    Info,
    /// Étape réussie.
    Ok,
    /// Avertissement (fichier verrouillé, repli sur le cache…).
    Warn,
    /// Erreur.
    Err,
    /// Fichier créé.
    Add,
    /// Fichier ou dossier supprimé.
    Del,
    /// Fichier modifié / restauré.
    Mod,
    /// Processus arrêté / lancé.
    Proc,
    /// Téléchargement réseau.
    Net,
}

#[derive(Clone, Serialize)]
struct LogEvent {
    branch: String,
    kind: Kind,
    message: String,
    /// Horodatage en millisecondes (epoch).
    ts: u64,
}

static SINK: Mutex<Option<(AppHandle, String)>> = Mutex::new(None);

/// Rattache les logs suivants à `branch` jusqu'à ce que le guard soit détruit.
pub struct Scope;

pub fn scope(app: &AppHandle, branch: &str) -> Scope {
    if let Ok(mut s) = SINK.lock() {
        *s = Some((app.clone(), branch.to_string()));
    }
    Scope
}

impl Drop for Scope {
    fn drop(&mut self) {
        if let Ok(mut s) = SINK.lock() {
            *s = None;
        }
    }
}

pub fn emit(kind: Kind, message: impl Into<String>) {
    let Ok(sink) = SINK.lock() else { return };
    let Some((app, branch)) = sink.as_ref() else { return };
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let _ = app.emit(
        "install-log",
        LogEvent { branch: branch.clone(), kind, message: message.into(), ts },
    );
}

/// Taille lisible : 512 o, 30,4 Ko, 82,1 Mo.
pub fn size(bytes: u64) -> String {
    const K: f64 = 1024.0;
    let b = bytes as f64;
    if b < K {
        format!("{bytes} o")
    } else if b < K * K {
        format!("{:.1} Ko", b / K).replace('.', ",")
    } else if b < K * K * K {
        format!("{:.1} Mo", b / (K * K)).replace('.', ",")
    } else {
        format!("{:.1} Go", b / (K * K * K)).replace('.', ",")
    }
}
