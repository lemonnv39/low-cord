import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// Self-update PORTABLE de l'injecteur (voir src-tauri/src/updater.rs). Pas de
// plugin-updater/NSIS : on parle à nos propres commandes Rust, qui lisent les
// GitHub Releases de lemonnv39/low-cord, téléchargent le nouvel .exe, le
// substituent et relancent l'app.

export interface InjectorUpdate {
    version: string;
    notes: string | null;
    url: string;
}

/** Check manuel (bouton Réglages). Le check silencieux au lancement vit côté
 *  Rust et notifie via l'event `injector-update-available` (voir onUpdateAvailable). */
export async function checkForUpdate(): Promise<InjectorUpdate | null> {
    return await invoke<InjectorUpdate | null>("check_injector_update");
}

/** Télécharge + remplace l'exe + relance. Ne « resolve » jamais : le process
 *  courant est terminé par app.restart() côté Rust dès que l'exe est remplacé. */
export async function installUpdate(update: InjectorUpdate): Promise<void> {
    await invoke("install_injector_update", { url: update.url });
}

/** S'abonne au check silencieux de démarrage. */
export function onUpdateAvailable(cb: (u: InjectorUpdate) => void): Promise<UnlistenFn> {
    return listen<InjectorUpdate>("injector-update-available", e => cb(e.payload));
}
