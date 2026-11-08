/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-sound — onglet des réglages : installer, mettre à jour ou retirer le
// moteur. Module optionnel, mis à jour séparément de low-cord. Tout s'applique
// tout de suite, sans redémarrer Discord : les comptes connectés repartent
// seuls sur le nouveau moteur.

import "@lowcord/styles.css";

import { SettingsTab, wrapTab } from "@components/settings/tabs/BaseTab";
import type { SoundStatus } from "@main/lowSound";
import { classNameFactory } from "@utils/css";
import type { IconProps } from "@utils/types";
import { useEffect, useState } from "@webpack/common";

import { engineReplaced, sessionSnapshot } from "./engine";

const cl = classNameFactory("lc-lss-");

export function SoundIcon({ width = 20, height = 20, color }: IconProps & { color?: string; }) {
    return (
        <svg width={width} height={height} viewBox="0 0 24 24" fill="currentColor" style={color ? { color } : undefined} aria-hidden="true">
            {/* Éclair */}
            <path d="M13.6 1.6a.8.8 0 0 0-1.4-.5L2.9 12.6a.8.8 0 0 0 .6 1.3h7.6l-1.3 8.5a.8.8 0 0 0 1.4.6l9.6-11.6a.8.8 0 0 0-.6-1.3h-7.6z" />
        </svg>
    );
}

// Gardé hors du composant : le message reste si on change d'onglet.
let doneNote: string | null = null;

const mb = (bytes: number) => (bytes / 1048576).toLocaleString("fr-FR", { maximumFractionDigits: 1 });
const day = (iso?: string) => {
    const d = iso ? new Date(iso) : null;
    return d && !isNaN(d.getTime()) ? d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" }) : "";
};

type Action = "check" | "install" | "uninstall";

function LowSoundSettings() {
    const [status, setStatus] = useState<SoundStatus | null>(null);
    const [running, setRunning] = useState<Action | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [confirmRemove, setConfirmRemove] = useState(false);
    const [, rerender] = useState(0);

    async function run(action: Action) {
        if (running) return;
        setRunning(action);
        setError(null);
        setConfirmRemove(false);
        const before = sessionSnapshot();
        try {
            const wasInstalled = !!status?.installed;
            const next = action === "install" ? await VencordNative.lowSound.install()
                : action === "uninstall" ? await VencordNative.lowSound.uninstall()
                    : await VencordNative.lowSound.status();
            setStatus(next);
            if (action !== "check") {
                // Appliqué tout de suite : pas besoin de redémarrer Discord.
                await engineReplaced(next.installed ? next.version ?? null : null, before);
                doneNote = action === "uninstall" ? "low-sound a été retiré."
                    : wasInstalled ? `Mis à jour en v${next.version} : c'est déjà actif${before.keys.length ? ", tes comptes se sont reconnectés" : ""}.`
                        : "Installé : le bouton est à côté de micro / casque, en bas à gauche.";
            }
        } catch (e: any) {
            // Les erreurs du processus principal arrivent préfixées par Electron.
            setError(String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
            // Mise à jour ratée après l'arrêt du moteur : les comptes repartent
            // sur le moteur déjà installé.
            if (action === "install" && before.keys.length) {
                const now = await VencordNative.lowSound.status().catch(() => null);
                if (now?.installed) await engineReplaced(now.version ?? null, before).catch(() => { });
            }
        } finally {
            setRunning(null);
            rerender(n => n + 1);
        }
    }

    useEffect(() => { run("check"); }, []);

    const latest = status?.latest;
    const installed = !!status?.installed;
    const update = !!status?.updateAvailable;

    let state: string;
    if (running === "install") state = installed ? "Mise à jour en cours…" : "Installation en cours…";
    else if (running === "uninstall") state = "Désinstallation…";
    else if (!status) state = "Vérification…";
    else if (!installed) state = "Non installé";
    else if (update) state = `Mise à jour disponible : v${latest!.version}`;
    else state = "Installé et à jour";

    return (
        <SettingsTab>
            <div className={cl("card")}>
                <div className={cl("head")}>
                    <span className={cl("logo")}><SoundIcon width={22} height={22} /></span>
                    <div className={cl("titles")}>
                        <div className={cl("title")}>low-sound <span className={cl("tag")}>beta</span></div>
                        <div className={cl("sub")}>
                            Diffuse de la musique dans un salon vocal avec un ou plusieurs comptes du Token Importer :
                            spatialisation 8D, réverbe, égaliseur, gain, débit et latence réglables.
                        </div>
                    </div>
                </div>

                {installed && !doneNote && (
                    <div className={cl("hint-row")}>
                        <SoundIcon width={16} height={16} />
                        <span>Ouvre low-sound avec le bouton à côté de micro / casque, en bas à gauche.</span>
                    </div>
                )}

                <div className={cl("row")}>
                    <span className={cl("dot", installed && !update && "dot-on", update && "dot-update")} />
                    <div className={cl("state")}>
                        <div className={cl("state-name")}>{state}</div>
                        <div className={cl("state-detail")}>
                            {installed && status?.version && `Version installée : v${status.version}${status.installedAt ? ` · ${day(status.installedAt)}` : ""}`}
                            {!installed && latest && `Version v${latest.version} · ${mb(latest.size)} Mo`}
                        </div>
                    </div>
                    <div className={cl("actions")}>
                        {!installed && (
                            <button className={cl("btn", "btn-primary")} disabled={!!running || !latest} onClick={() => run("install")}>
                                Installer
                            </button>
                        )}
                        {installed && update && (
                            <button className={cl("btn", "btn-primary")} disabled={!!running} onClick={() => run("install")}>
                                Mettre à jour
                            </button>
                        )}
                        <button className={cl("btn")} disabled={!!running} onClick={() => run("check")}>
                            Vérifier
                        </button>
                    </div>
                </div>

                {doneNote && !running && (
                    <div className={cl("hint-row")}>
                        <SoundIcon width={16} height={16} />
                        <span>{doneNote}</span>
                    </div>
                )}

                {(error || (status?.error && !installed)) && (
                    <div className={cl("error")}>{error ?? `Impossible de joindre GitHub : ${status!.error}`}</div>
                )}

                {installed && (
                    <div className={cl("foot")}>
                        <button className={cl("link")} disabled={!!running} onClick={() => VencordNative.lowSound.openFolder()}>
                            Ouvrir le dossier
                        </button>
                        {confirmRemove ? (
                            <span className={cl("confirm")}>
                                Retirer low-sound ?
                                <button className={cl("link", "danger")} onClick={() => run("uninstall")}>Oui, désinstaller</button>
                                <button className={cl("link")} onClick={() => setConfirmRemove(false)}>Annuler</button>
                            </span>
                        ) : (
                            <button className={cl("link", "danger")} disabled={!!running} onClick={() => setConfirmRemove(true)}>
                                Désinstaller
                            </button>
                        )}
                    </div>
                )}
            </div>

            <p className={cl("note")}>
                Module optionnel, mis à jour séparément de low-cord. Le moteur est téléchargé depuis le repo low-cord,
                et son empreinte est vérifiée avant installation. Client vocal tiers : utilise des comptes dédiés,
                pas ton compte principal.
            </p>
        </SettingsTab>
    );
}

export default wrapTab(LowSoundSettings, "low-sound");
