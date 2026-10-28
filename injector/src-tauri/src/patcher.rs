/*
 * Patch / unpatch — portée de patcher.go (Vencord/Installer), étendue pour la
 * refonte "flux d'installation" de l'injecteur :
 *   - patch_discord() n'est plus une seule opération silencieuse : elle émet
 *     un événement Tauri "install-progress" à chaque étape (nettoyage d'un
 *     mod tiers, vérification d'environnement, écriture du patch, relance de
 *     Discord) pour que le frontend anime la ligne correspondante en direct,
 *     comme demandé dans la maquette.
 *   - Avant d'écrire le patch de low-cord, si un AUTRE mod (Vencord, Equicord...)
 *     est détecté (voir discord::PatchOwner), on le désinstalle proprement
 *     d'abord (restauration du vrai app.asar) — plus besoin de passer par
 *     l'installeur de l'autre mod pour repartir propre.
 *   - Une fois le patch écrit, Discord.exe est relancé automatiquement via
 *     Update.exe --processStart (lanceur Squirrel officiel de Discord) plutôt
 *     que de laisser l'utilisateur le relancer à la main.
 */

use crate::asar::{self, StubOwner};
use crate::dist_fetch;
use crate::log::{self as ilog, Kind};
use crate::discord::{self, DiscordInstall, PatchOwner};
use crate::presets;
use serde::Serialize;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};
use sysinfo::{Disks, ProcessesToUpdate, System};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
struct ProgressEvent<'a> {
    branch: &'a str,
    step: &'a str,
    status: &'a str, // "ok" | "error"
    message: Option<String>,
}

fn emit_progress(app: &AppHandle, branch: &str, step: &str, status: &str, message: Option<String>) {
    let _ = app.emit("install-progress", ProgressEvent { branch, step, status, message });
}

/// Compte les process encore vivants pour cette branche (nom d'exe exact —
/// inclut les process enfants Electron, qui portent le même nom).
fn count_running(sys: &mut System, exe: &str) -> usize {
    sys.refresh_processes(ProcessesToUpdate::All, true);
    sys.processes()
        .values()
        .filter(|p| p.name().to_string_lossy().eq_ignore_ascii_case(exe))
        .count()
}

fn kill_running(branch: &str) -> bool {
    let exe = discord::exe_name_for_branch(branch);

    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);

    let mut killed = 0usize;
    for process in sys.processes().values() {
        if process.name().to_string_lossy().eq_ignore_ascii_case(exe) {
            process.kill();
            killed += 1;
        }
    }
    let killed_any = killed > 0;

    if !killed_any {
        ilog::emit(Kind::Info, format!("{exe} n'est pas lancé"));
    }

    if killed_any {
        ilog::emit(Kind::Proc, format!("arrêt de {exe} ({killed} processus)"));
        let started = Instant::now();
        // Attend que TOUS les process de cette branche aient réellement disparu
        // avant de rendre la main — pas juste un délai fixe de 700ms. Deux
        // raisons :
        //  1. libérer les handles sur app.asar avant de le réécrire (le retry_io
        //     plus bas reste un filet de sécurité) ;
        //  2. surtout : éviter que la RELANCE démarre une nouvelle instance de
        //     Discord pendant qu'une ancienne agonise encore. Electron
        //     déclenche alors son événement « second-instance » sur une fenêtre
        //     déjà détruite → le dialogue « TypeError: Object has been
        //     destroyed » que Discord affiche en pleine install.
        let deadline = Instant::now() + Duration::from_secs(30);
        while count_running(&mut sys, exe) > 0 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(200));
        }
        let left = count_running(&mut sys, exe);
        if left > 0 {
            ilog::emit(Kind::Warn, format!("{left} processus {exe} encore vivants après 30 s"));
        } else {
            ilog::emit(Kind::Ok, format!("tous les processus {exe} sont fermés ({:.1} s)", started.elapsed().as_secs_f32()));
        }
        // Petit répit pour laisser l'OS/Defender relâcher les derniers handles.
        thread::sleep(Duration::from_millis(400));
    }
    killed_any
}

/// Tue TOUTES les branches connues (stable/canary/ptb) d'un coup, sans savoir
/// laquelle est concernée, et retourne celles qui tournaient vraiment (pour
/// pouvoir les relancer ensuite) — utilisé pour l'import/export de
/// préréglages de plugins et le pack par défaut : `settings.json` est
/// partagé entre toutes les branches (même dossier de données low-cord), donc
/// peu importe laquelle tourne, elle peut réécrire le fichier juste après
/// notre propre écriture si on ne la ferme pas d'abord (c'est très
/// probablement le bug rapporté : l'import "ne marchait pas" parce qu'low-cord
/// tournait encore et a resauvegardé son état en mémoire par-dessus).
pub(crate) fn kill_all_known_processes() -> Vec<&'static str> {
    ["stable", "canary", "ptb"].into_iter().filter(|b| kill_running(b)).collect()
}

/// Relance chacune des branches précédemment tuées, si on retrouve encore
/// leur install sur le disque — best-effort, une branche qu'on ne relance pas
/// se relance simplement à la main par l'utilisateur.
pub(crate) fn relaunch_branches(branches: &[&str]) {
    if branches.is_empty() {
        return;
    }
    let dummy_patcher_path = PathBuf::from("__lowcord_presets_relaunch_probe__");
    for install in discord::find_discords(&dummy_patcher_path) {
        if branches.contains(&install.branch.as_str()) {
            if let Some(base) = &install.base_path {
                let _ = relaunch(Path::new(base), &install.branch);
            }
        }
    }
}

/// Réessaie une opération fichier plusieurs fois avant d'abandonner — juste
/// après avoir tué Discord (ou l'avoir relancé nous-mêmes puis re-tué pour un
/// patch rapproché), Windows peut garder un fichier verrouillé plus
/// longtemps que le délai fixe de kill_running. Budget généreux (~45s) plutôt
/// qu'un échec direct : observé en vrai qu'une toute première install de
/// Discord CANARY (fichier tout juste réinstallé, jamais vu par l'antivirus)
/// pouvait dépasser les 20s précédents alors qu'une install stable installée
/// un peu plus tôt passait sans souci — la vérification de réputation cloud
/// d'un fichier totalement neuf est justement le cas le plus lent. Un patch
/// prend de toute façon déjà plusieurs secondes ; quelques dizaines de
/// secondes de retry silencieux valent largement mieux qu'un échec direct.
fn retry_io<F: FnMut() -> io::Result<()>>(mut op: F) -> io::Result<()> {
    let mut last_err = None;
    for attempt in 0..90 {
        match op() {
            Ok(()) => return Ok(()),
            Err(e) => {
                if attempt == 0 {
                    ilog::emit(Kind::Warn, format!("fichier bloqué ({e}) — nouvelles tentatives jusqu'à 45 s (antivirus ?)"));
                } else if attempt % 10 == 0 {
                    ilog::emit(Kind::Warn, format!("toujours bloqué… tentative {}/90", attempt + 1));
                }
                last_err = Some(e);
                if attempt < 89 {
                    thread::sleep(Duration::from_millis(500));
                }
            }
        }
    }

    let err = last_err.unwrap();
    // Une "Accès refusé" qui survit ~20s de retry n'est plus le petit verrou
    // transitoire habituel (antivirus qui scanne l'exe qui vient de sortir) —
    // observé en vrai sur une toute première injection avec seulement
    // Windows Defender (pas d'antivirus tiers, pas d'accès contrôlé aux
    // dossiers, install standard par utilisateur) : le suspect le plus
    // probable devient alors le comportement anti-ransomware général de
    // Defender, qui peut bloquer un renommage suivi d'un remplacement d'un
    // gros fichier — un pattern qui ressemble justement à du chiffrement de
    // ransomware. Le message brut de Windows ("Accès refusé (os error 5)")
    // ne donne aucune piste concrète — remplacé par un message qui dit quoi
    // vérifier.
    if err.raw_os_error() == Some(5) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Accès refusé après plusieurs tentatives — le fichier reste bloqué. \
            Vérifie que Discord est complètement fermé (pas juste dans la barre des tâches), \
            que ton antivirus ne bloque pas l'injecteur (regarde sa quarantaine — y compris Windows \
            Defender, Historique de protection), et si Discord est installé pour tous les \
            utilisateurs de ce PC, relance l'injecteur en tant qu'administrateur.",
        ));
    }
    Err(err)
}

fn copy_with_retry(from: &Path, to: &Path) -> io::Result<()> {
    retry_io(|| fs::copy(from, to).map(|_| ()))
}

/// Supprime `app.asar` qu'il soit un FICHIER (stub classique / vrai asar) ou un
/// DOSSIER (`app.asar/`, la technique d'injection de Vencord/Equicord et de low-cord
/// Abyss). Sans ça, restaurer le vrai asar par-dessus un app.asar en
/// dossier échouait — `fs::copy` refuse d'écraser un dossier — et bouclait ~45s
/// en retry avant d'abandonner, ce qui figeait l'install à « Installation… ».
/// Un `app.asar` absent est un succès (rien à retirer).
fn remove_app_asar(app_asar: &Path) -> io::Result<()> {
    let was = match fs::symlink_metadata(app_asar) {
        Ok(m) if m.is_dir() => Some("dossier"),
        Ok(_) => Some("fichier"),
        Err(_) => None,
    };
    retry_io(|| match fs::symlink_metadata(app_asar) {
        Ok(m) if m.is_dir() => fs::remove_dir_all(app_asar),
        Ok(_) => fs::remove_file(app_asar),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    })?;
    if let Some(kind) = was {
        ilog::emit(Kind::Del, format!("{} ({kind})", app_asar.display()));
    }
    Ok(())
}

fn file_size(path: &Path) -> String {
    fs::metadata(path).map(|m| ilog::size(m.len())).unwrap_or_else(|_| "?".to_string())
}

fn write_stub_with_retry(out_file: &Path, patcher_path: &str, build_sha: Option<&str>) -> io::Result<()> {
    retry_io(|| asar::write_app_asar(out_file, patcher_path, build_sha))
}

/// Sauvegarde/restauration par COPIE plutôt que par renommage : un renommage
/// exige un accès EXCLUSIF au fichier (Windows refuse de renommer un fichier
/// tant qu'un seul handle reste ouvert dessus, même en lecture seule), alors
/// qu'une copie ne nécessite qu'un accès en lecture sur la source. Le nouveau
/// stub est ensuite écrit PAR-DESSUS app.asar en place (simple écrasement,
/// pas de suppression/renommage du fichier lui-même) — un déplacement suivi
/// d'un remplacement à l'identique ressemble justement au pattern que les
/// protections anti-ransomware (dont celle de Windows Defender, active par
/// défaut indépendamment du réglage "accès contrôlé aux dossiers") sont
/// conçues pour repérer et bloquer.
fn unpatch_dir(resources: &Path) -> io::Result<()> {
    let app_asar = resources.join("app.asar");
    let backup = resources.join("_app.asar");

    if !backup.exists() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "Aucune sauvegarde _app.asar trouvée.",
        ));
    }

    // Retire l'app.asar courant (fichier stub OU dossier d'un autre cord) avant
    // de recopier le vrai asar par-dessus — indispensable pour la forme dossier.
    remove_app_asar(&app_asar)?;
    copy_with_retry(&backup, &app_asar)?;
    ilog::emit(Kind::Mod, format!("{} restauré depuis _app.asar ({})", app_asar.display(), file_size(&app_asar)));
    if fs::remove_file(&backup).is_ok() {
        ilog::emit(Kind::Del, format!("{}", backup.display()));
    }

    Ok(())
}

fn patch_dir(resources: &Path, patcher_path: &str, build_sha: Option<&str>) -> io::Result<()> {
    let app_asar = resources.join("app.asar");
    let backup = resources.join("_app.asar");

    if backup.exists() {
        // Un backup existe (le nôtre OU celui d'un autre cord) : on restaure
        // d'abord le vrai app.asar pour repartir propre. unpatch_dir gère le cas
        // où l'app.asar courant est un dossier.
        unpatch_dir(resources)?;
    } else {
        // Pas de sauvegarde : app.asar DOIT être le vrai asar d'origine, sinon
        // le copier vers _app.asar sauvegarderait un stub comme s'il était le
        // Discord d'origine — et le vrai asar serait définitivement perdu
        // (uninstall restaurerait alors un stub = Discord cassé).
        if app_asar.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "app.asar est un dossier (autre mod) sans sauvegarde _app.asar : \
                impossible de retrouver le Discord d'origine. Réinstalle Discord proprement, puis relance l'injecteur.",
            ));
        }
        match asar::inspect_asar(&app_asar, Path::new("")) {
            // Vrai asar Discord : OK pour le sauvegarder.
            Ok(StubOwner::Genuine) => {
                ilog::emit(Kind::Info, "app.asar vérifié : c'est bien le discord d'origine");
            }
            // Déjà un stub (low-cord ou autre mod) sans backup : le vrai asar
            // manque, on refuse plutôt que de pérenniser la perte.
            Ok(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "app.asar est déjà un stub de mod sans sauvegarde _app.asar : \
                    le Discord d'origine est introuvable. Réinstalle Discord proprement, puis relance l'injecteur.",
                ));
            }
            // Illisible (droits/verrou) : on tente quand même, retry_io gère.
            Err(_) => {}
        }
    }

    copy_with_retry(&app_asar, &backup)?;
    ilog::emit(Kind::Add, format!("{} (sauvegarde du discord d'origine, {})", backup.display(), file_size(&backup)));
    if let Err(e) = write_stub_with_retry(&app_asar, patcher_path, build_sha) {
        ilog::emit(Kind::Err, format!("écriture du stub impossible : {e} — restauration"));
        let _ = copy_with_retry(&backup, &app_asar);
        return Err(e);
    }
    ilog::emit(Kind::Mod, format!("{} → stub low-cord ({})", app_asar.display(), file_size(&app_asar)));
    ilog::emit(Kind::Info, format!("le stub charge {patcher_path}"));

    Ok(())
}

/// Si l'install est actuellement patchée par un AUTRE mod que low-cord, restaure
/// le vrai app.asar d'origine avant de continuer — c'est ce qui évite d'avoir
/// à désinstaller Equicord/Vencord "à la main" avant de pouvoir injecter low-cord.
fn clean_foreign_patch(resources: &Path, our_patcher_path: &Path) -> io::Result<bool> {
    let app_asar = resources.join("app.asar");

    // Stub en forme de DOSSIER (Vencord/Equicord/Abyss) :
    // inspect_asar (File::open) ne sait pas le lire, on le détecte ici. Le vrai
    // asar est dans _app.asar et unpatch_dir le restaure (en retirant d'abord le
    // dossier). Sans backup, unpatch_dir renvoie une erreur explicite.
    if app_asar.is_dir() {
        let who = asar::read_dir_stub_require(&app_asar).unwrap_or_else(|| "inconnu".to_string());
        ilog::emit(Kind::Warn, format!("autre mod détecté (app.asar en dossier → {who}) : retour au discord d'origine"));
        unpatch_dir(resources)?;
        return Ok(true);
    }

    match asar::inspect_asar(&app_asar, our_patcher_path) {
        Ok(StubOwner::Foreign { require_path }) => {
            ilog::emit(Kind::Warn, format!("autre mod détecté ({require_path}) : retour au discord d'origine"));
            unpatch_dir(resources)?;
            Ok(true)
        }
        _ => {
            ilog::emit(Kind::Info, "aucun autre mod à retirer");
            Ok(false)
        }
    }
}

/// Vérifications de base avant d'écrire quoi que ce soit : dossier resources
/// bien accessible en écriture, et assez de place disque (le build de low-cord
/// tient largement dans quelques Mo, 100 Mo de marge est trèstrès confortable
/// et évite un échec absurde sur un disque plein).
fn check_environment(resources: &Path) -> Result<(), String> {
    let probe = resources.join(".lowcord-write-test");
    fs::write(&probe, b"x").map_err(|e| format!("Dossier resources non accessible en écriture : {e}"))?;
    let _ = fs::remove_file(&probe);
    ilog::emit(Kind::Ok, format!("écriture autorisée dans {}", resources.display()));

    const MIN_FREE_BYTES: u64 = 100 * 1024 * 1024;
    let disks = Disks::new_with_refreshed_list();
    let mut best_match: Option<(&Path, u64)> = None;
    for disk in disks.list() {
        let mount = disk.mount_point();
        if resources.starts_with(mount) {
            let is_better = match best_match {
                Some((best, _)) => mount.as_os_str().len() > best.as_os_str().len(),
                None => true,
            };
            if is_better {
                best_match = Some((mount, disk.available_space()));
            }
        }
    }
    if let Some((_, available)) = best_match {
        ilog::emit(Kind::Info, format!("espace disque libre : {}", ilog::size(available)));
        if available < MIN_FREE_BYTES {
            return Err(format!(
                "Espace disque insuffisant ({} Mo libres, {} Mo requis).",
                available / (1024 * 1024),
                MIN_FREE_BYTES / (1024 * 1024)
            ));
        }
    }

    Ok(())
}

/// Relance Discord après un patch/unpatch réussi — Update.exe --processStart
/// est le lanceur Squirrel que Discord installe lui-même à côté des dossiers
/// app-X.Y.Z, donc toujours présent.
fn relaunch(base_path: &Path, branch: &str) -> io::Result<()> {
    let update_exe = base_path.join("Update.exe");
    let exe_name = discord::exe_name_for_branch(branch);
    Command::new(&update_exe).arg("--processStart").arg(exe_name).spawn()?;
    ilog::emit(Kind::Proc, format!("lancement : {} --processStart {exe_name}", update_exe.display()));
    Ok(())
}

#[tauri::command]
pub async fn list_discord_installs(app: AppHandle, repo_path: Option<String>) -> Vec<DiscordInstall> {
    let our_patcher_path = resolve_our_patcher_path(&app, repo_path.as_deref());
    discord::find_discords(&our_patcher_path)
}

fn resolve_patcher_path(repo_path: &str) -> PathBuf {
    Path::new(repo_path).join("dist").join("desktop").join("patcher.js")
}

/// Chemin que NOTRE patch utiliserait — sert uniquement à reconnaître nos
/// propres stubs (asar::inspect_asar), donc ne télécharge jamais rien : si
/// rien n'est en cache, on retombe sur le chemin où le téléchargement
/// atterrirait de toute façon.
fn resolve_our_patcher_path(app: &AppHandle, repo_path: Option<&str>) -> PathBuf {
    match repo_path.filter(|p| !p.trim().is_empty()) {
        Some(repo) => resolve_patcher_path(repo),
        None => dist_fetch::cached_patcher_path(app),
    }
}

/// `repo_path` est un override optionnel pour le développement local (pointe
/// vers un clone de low-cord buildé à la main). Sans ça — le cas d'un ami qui n'a
/// que l'exe de l'injecteur — le patcher.js est téléchargé depuis la branche
/// `builds` du repo et mis en cache (voir dist_fetch.rs).
#[tauri::command]
pub async fn patch_discord(
    app: AppHandle,
    resources_path: String,
    base_path: String,
    branch: String,
    repo_path: Option<String>,
) -> Result<(), String> {
    let resources = Path::new(&resources_path);
    let base = Path::new(&base_path);
    let _log = ilog::scope(&app, &branch);
    let started = Instant::now();
    ilog::emit(Kind::Info, format!("installation de low-cord sur {}", resources.display()));

    let our_patcher_path = resolve_our_patcher_path(&app, repo_path.as_deref());

    // Capturé AVANT de patcher : settings.json est écrit par low-cord lui-même à
    // son tout premier lancement, donc "il n'existe pas encore" est le seul
    // signal fiable pour reconnaître une machine qui n'a jamais eu low-cord —
    // c'est là qu'on veut appliquer le pack de plugins par défaut, jamais sur
    // une install existante dont on écraserait les choix déjà faits.
    let is_fresh_install = !presets::settings_json_exists();

    kill_running(&branch);

    emit_progress(&app, &branch, "cleaning", "ok", None);
    let cleaned = clean_foreign_patch(resources, &our_patcher_path).map_err(|e| {
        let msg = e.to_string();
        emit_progress(&app, &branch, "cleaning", "error", Some(msg.clone()));
        msg
    })?;
    if cleaned {
        // Laisse les handles se relâcher après la restauration avant de re-toucher au dossier.
        thread::sleep(Duration::from_millis(200));
    }

    emit_progress(&app, &branch, "checking", "ok", None);
    if let Err(msg) = check_environment(resources) {
        emit_progress(&app, &branch, "checking", "error", Some(msg.clone()));
        return Err(msg);
    }
    emit_progress(&app, &branch, "checked", "ok", None);

    emit_progress(&app, &branch, "installing", "ok", None);
    let (patcher_path, build_sha) = match repo_path.filter(|p| !p.trim().is_empty()) {
        Some(repo) => {
            let p = resolve_patcher_path(&repo);
            if !p.exists() {
                let msg = format!(
                    "patcher.js introuvable dans {} — build low-cord d'abord (node scripts/build/build.mjs --disable-updater).",
                    p.display()
                );
                emit_progress(&app, &branch, "installing", "error", Some(msg.clone()));
                return Err(msg);
            }
            (p, None)
        }
        None => {
            // Toujours récupérer la DERNIÈRE build à l'install/réapplication —
            // sinon une réinjection (après une MAJ Discord, ou un simple
            // "Installer") réutilisait la dist EN CACHE et restait coincée sur
            // une vieille version. Repli sur le cache si le réseau est indispo.
            let p = match dist_fetch::download_latest(&app).await {
                Ok(p) => p,
                Err(e) => {
                    let cached = dist_fetch::cached_patcher_path(&app);
                    if cached.exists() {
                        ilog::emit(Kind::Warn, format!("téléchargement impossible ({e}) — utilisation de la build en cache"));
                        cached
                    } else {
                        emit_progress(&app, &branch, "installing", "error", Some(e.clone()));
                        return Err(e);
                    }
                }
            };
            let sha = dist_fetch::cached_sha(&app);
            (p, sha)
        }
    };

    if let Err(e) = patch_dir(resources, &patcher_path.to_string_lossy(), build_sha.as_deref()) {
        let msg = e.to_string();
        emit_progress(&app, &branch, "installing", "error", Some(msg.clone()));
        return Err(msg);
    }
    emit_progress(&app, &branch, "installed", "ok", None);

    emit_progress(&app, &branch, "restarting", "ok", None);
    kill_running(&branch);
    if let Err(e) = relaunch(base, &branch) {
        // Le patch a réussi, seule la relance auto a échoué — pas bloquant,
        // l'utilisateur peut relancer Discord lui-même.
        ilog::emit(Kind::Warn, format!("relance automatique impossible ({e}) — relance discord toi-même"));
        emit_progress(&app, &branch, "ready", "ok", Some(format!("Relance auto échouée ({e}) — relance Discord toi-même.")));
        return Ok(());
    }

    if is_fresh_install && presets::has_default_plugins() {
        apply_default_plugins_once_ready(&app, &branch);
    }

    ilog::emit(Kind::Ok, format!("terminé en {:.1} s — low-cord est installé", started.elapsed().as_secs_f32()));
    emit_progress(&app, &branch, "ready", "ok", None);
    Ok(())
}

/// Attend que settings.json apparaisse (créé par low-cord à son tout premier
/// lancement, juste déclenché par relaunch() ci-dessus) puis lui applique le
/// pack de plugins par défaut — best-effort : si low-cord met plus de 20s à
/// démarrer ou que l'application échoue, on n'échoue pas toute l'install pour
/// autant, l'utilisateur peut toujours importer un préréglage à la main.
fn apply_default_plugins_once_ready(app: &AppHandle, branch: &str) {
    emit_progress(app, branch, "finalizing", "ok", None);

    let mut waited = Duration::ZERO;
    let timeout = Duration::from_secs(20);
    while !presets::settings_json_exists() && waited < timeout {
        thread::sleep(Duration::from_millis(500));
        waited += Duration::from_millis(500);
    }

    if !presets::settings_json_exists() {
        return;
    }

    if let Err(e) = presets::apply_default_plugins() {
        emit_progress(
            app,
            branch,
            "ready",
            "ok",
            Some(format!("Pack de plugins par défaut non appliqué : {e}")),
        );
    }
}

#[tauri::command]
pub async fn unpatch_discord(app: AppHandle, resources_path: String, base_path: String, branch: String) -> Result<(), String> {
    let _log = ilog::scope(&app, &branch);
    let started = Instant::now();
    ilog::emit(Kind::Info, format!("désinstallation de low-cord sur {resources_path}"));

    emit_progress(&app, &branch, "stopping", "ok", None);
    kill_running(&branch);

    emit_progress(&app, &branch, "restoring", "ok", None);
    if let Err(e) = unpatch_dir(Path::new(&resources_path)) {
        let msg = e.to_string();
        ilog::emit(Kind::Err, msg.clone());
        emit_progress(&app, &branch, "restoring", "error", Some(msg.clone()));
        return Err(msg);
    }
    emit_progress(&app, &branch, "restored", "ok", None);

    emit_progress(&app, &branch, "restarting", "ok", None);
    if let Err(e) = relaunch(Path::new(&base_path), &branch) {
        ilog::emit(Kind::Warn, format!("relance automatique impossible ({e}) — relance discord toi-même"));
    }
    ilog::emit(Kind::Ok, format!("terminé en {:.1} s — discord est revenu à l'origine", started.elapsed().as_secs_f32()));
    emit_progress(&app, &branch, "ready", "ok", None);
    Ok(())
}

#[derive(Serialize)]
pub struct FixResult {
    branch: String,
    was_broken: bool,
    fixed: bool,
    message: Option<String>,
}

/// Réapplique low-cord sur une install (mise à jour de build ou réparation),
/// avec le même journal et la même progression qu'une installation.
/// `download` = retélécharger la dernière dist (sinon on réutilise celle déjà
/// téléchargée juste avant pour une autre branche).
async fn reapply(app: &AppHandle, resources: &Path, base: &Path, branch: &str, what: &str, download: bool) -> Result<(), String> {
    let _log = ilog::scope(app, branch);
    let started = Instant::now();
    ilog::emit(Kind::Info, format!("{what} de low-cord sur {}", resources.display()));

    emit_progress(app, branch, "stopping", "ok", None);
    kill_running(branch);

    emit_progress(app, branch, "installing", "ok", None);
    let fail = |msg: String| {
        ilog::emit(Kind::Err, msg.clone());
        emit_progress(app, branch, "installing", "error", Some(msg.clone()));
        msg
    };
    let patcher_path = if download {
        dist_fetch::download_latest(app).await.map_err(fail)?
    } else {
        let cached = dist_fetch::cached_patcher_path(app);
        ilog::emit(Kind::Info, format!("build déjà téléchargée : {}", cached.display()));
        cached
    };
    let sha = dist_fetch::cached_sha(app);
    patch_dir(resources, &patcher_path.to_string_lossy(), sha.as_deref()).map_err(|e| fail(e.to_string()))?;
    emit_progress(app, branch, "installed", "ok", None);

    emit_progress(app, branch, "restarting", "ok", None);
    kill_running(branch);
    if let Err(e) = relaunch(base, branch) {
        ilog::emit(Kind::Warn, format!("relance automatique impossible ({e}) — relance discord toi-même"));
    }
    let build = sha.as_deref().map(|s| &s[..s.len().min(7)]).unwrap_or("?");
    ilog::emit(Kind::Ok, format!("terminé en {:.1} s — low-cord à jour (build {build})", started.elapsed().as_secs_f32()));
    emit_progress(app, branch, "ready", "ok", None);
    Ok(())
}

async fn repair_one(app: &AppHandle, resources: &Path, base: &Path, branch: &str) -> Result<(), String> {
    reapply(app, resources, base, branch, "réparation", true).await
}

/// "Fixer low-cord" (Réglages) : réinstalle proprement chaque install actuellement
/// gérée par low-cord — restaure le vrai app.asar depuis la sauvegarde, re-télécharge
/// la dernière dist, ré-écrit le stub et relance Discord. Opération idempotente :
/// qu'un build soit cassé (fichier manquant, écriture partielle, stub périmé) ou
/// non, on repart d'un état propre et à jour. Ne touche jamais une install non
/// gérée par low-cord (autre mod, ou Discord d'origine) ni les branches non
/// installées ; une install dont la sauvegarde _app.asar manque remonte une
/// erreur explicite (le patch_dir refuse de sauvegarder un stub comme "vrai" asar).
#[tauri::command]
pub async fn fix_lowcord(app: AppHandle) -> Result<Vec<FixResult>, String> {
    let our_patcher_path = resolve_our_patcher_path(&app, None);
    let installs = discord::find_discords(&our_patcher_path);
    let mut results = Vec::new();

    for install in installs {
        // On réinstalle les installs déjà en low-cord ET celles où Discord s'est
        // mis à jour en perdant low-cord (needs_reinject) — pas les autres mods ni
        // les Discord vierges jamais injectés.
        if install.patch_owner != PatchOwner::LowCord && !install.needs_reinject {
            continue;
        }
        let (Some(resources), Some(base)) = (&install.resources_path, &install.base_path) else {
            continue;
        };

        match repair_one(&app, Path::new(resources), Path::new(base), &install.branch).await {
            Ok(()) => results.push(FixResult { branch: install.branch, was_broken: true, fixed: true, message: None }),
            Err(e) => results.push(FixResult { branch: install.branch, was_broken: true, fixed: false, message: Some(e) }),
        }
    }

    Ok(results)
}

#[derive(Serialize)]
pub struct UpdateResult {
    branch: String,
    updated: bool,
    message: Option<String>,
}

/// Retélécharge le build low-cord public ET réinjecte chaque install déjà
/// patchée par low-cord avec ce nouveau build (bouton "mettre à jour" de la
/// bannière liste).
///
/// Avant ce fix, cette commande ne faisait QUE rafraîchir le cache — elle ne
/// touchait à aucun app.asar déjà patché. Le bouton semblait pourtant
/// "réussir" (spinner puis bannière qui disparaît), donnant l'impression
/// fausse que la mise à jour était appliquée, alors qu'il fallait en plus
/// aller cliquer sur CHAQUE ligne Discord individuellement pour vraiment
/// réinjecter — un ami a fini bloqué avec le statut "mettre à jour" qui ne
/// bougeait jamais et aucun nouveau plugin, faute de connaître cette
/// deuxième étape cachée.
#[tauri::command]
pub async fn update_lowcord_build(app: AppHandle) -> Result<Vec<UpdateResult>, String> {
    let our_patcher_path = resolve_our_patcher_path(&app, None);
    let installs = discord::find_discords(&our_patcher_path);

    let mut results = Vec::new();
    let mut downloaded = false;
    for install in installs {
        if install.patch_owner != PatchOwner::LowCord {
            continue;
        }
        let (Some(resources), Some(base)) = (&install.resources_path, &install.base_path) else {
            continue;
        };

        // La dist n'est téléchargée qu'une fois (dans le journal de la 1re branche).
        let outcome = reapply(&app, Path::new(resources), Path::new(base), &install.branch, "mise à jour", !downloaded).await;
        if outcome.is_ok() {
            downloaded = true;
        }

        match outcome {
            Ok(()) => results.push(UpdateResult { branch: install.branch, updated: true, message: None }),
            Err(e) => results.push(UpdateResult { branch: install.branch, updated: false, message: Some(e) }),
        }
    }

    Ok(results)
}

/// Check manuel (en plus du check silencieux au lancement, voir
/// dist_fetch::spawn_silent_check) — Some(sha) si une nouvelle version du
/// build low-cord existe, None si déjà à jour ou si rien n'est encore en cache.
#[tauri::command]
pub async fn check_lowcord_build_update(app: AppHandle) -> Result<Option<String>, String> {
    dist_fetch::check_for_update(&app).await
}

/// Dernier SHA distant connu (rafraîchi au lancement, voir
/// dist_fetch::spawn_silent_check) — sert au frontend à calculer "à jour" /
/// "mettre à jour" par ligne en comparant à `DiscordInstall.build_sha`. Filet
/// de sécurité en plus de l'event "latest-build-sha" au cas où le listener
/// s'attache après l'émission au lancement.
#[tauri::command]
pub fn get_latest_build_sha(app: AppHandle) -> Option<String> {
    dist_fetch::latest_known_sha(&app)
}
