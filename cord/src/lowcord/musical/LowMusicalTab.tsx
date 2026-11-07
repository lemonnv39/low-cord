/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-musical — onglet des réglages : installer, mettre à jour ou retirer le
// moteur. Module optionnel, mis à jour séparément de low-cord ; après chaque
// installation, on redémarre Discord.

import "@lowcord/styles.css";

import { SettingsTab, wrapTab } from "@components/settings/tabs/BaseTab";
import type { MusicalStatus } from "@main/lowMusical";
import { classNameFactory } from "@utils/css";
import { relaunch } from "@utils/native";
import type { IconProps } from "@utils/types";
import { useEffect, useState } from "@webpack/common";

import { ConnectionSection } from "./ConnectionSection";

const cl = classNameFactory("lc-mu-");

export function MusicalIcon({ width = 20, height = 20 }: IconProps) {
    return (
        <svg width={width} height={height} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 18V5l12-2v13" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="16" r="3" />
        </svg>
    );
}

// Gardé hors du composant : changer d'onglet ne fait pas oublier qu'il faut redémarrer.
let restartNeeded = false;

const mb = (bytes: number) => (bytes / 1048576).toLocaleString("fr-FR", { maximumFractionDigits: 1 });
const day = (iso?: string) => {
    const d = iso ? new Date(iso) : null;
    return d && !isNaN(d.getTime()) ? d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" }) : "";
};

type Action = "check" | "install" | "uninstall";

function LowMusicalSettings() {
    const [status, setStatus] = useState<MusicalStatus | null>(null);
    const [running, setRunning] = useState<Action | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [confirmRemove, setConfirmRemove] = useState(false);
    const [, rerender] = useState(0);

    async function run(action: Action) {
        if (running) return;
        setRunning(action);
        setError(null);
        setConfirmRemove(false);
        try {
            const next = action === "install" ? await VencordNative.lowMusical.install()
                : action === "uninstall" ? await VencordNative.lowMusical.uninstall()
                    : await VencordNative.lowMusical.status();
            if (action !== "check") restartNeeded = true;
            setStatus(next);
        } catch (e: any) {
            // Les erreurs du processus principal arrivent préfixées par Electron.
            setError(String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
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
                    <span className={cl("logo")}><MusicalIcon width={22} height={22} /></span>
                    <div className={cl("titles")}>
                        <div className={cl("title")}>low-musical <span className={cl("tag")}>beta</span></div>
                        <div className={cl("sub")}>
                            Diffuse de la musique dans un salon vocal avec un ou plusieurs comptes du Token Importer :
                            spatialisation 8D, réverbe, égaliseur, gain, débit et latence réglables.
                        </div>
                    </div>
                </div>

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

                {restartNeeded && !running && (
                    <div className={cl("row", "restart")}>
                        <div className={cl("state")}>
                            <div className={cl("state-name")}>Redémarrage nécessaire</div>
                            <div className={cl("state-detail")}>
                                {installed ? "Redémarre Discord pour activer cette version de low-musical." : "Redémarre Discord pour finir de retirer low-musical."}
                            </div>
                        </div>
                        <button className={cl("btn", "btn-primary")} onClick={relaunch}>Redémarrer Discord</button>
                    </div>
                )}

                {(error || (status?.error && !installed)) && (
                    <div className={cl("error")}>{error ?? `Impossible de joindre GitHub : ${status!.error}`}</div>
                )}

                {installed && (
                    <div className={cl("foot")}>
                        <button className={cl("link")} disabled={!!running} onClick={() => VencordNative.lowMusical.openFolder()}>
                            Ouvrir le dossier
                        </button>
                        {confirmRemove ? (
                            <span className={cl("confirm")}>
                                Retirer low-musical ?
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

            {status?.installed && !running && (
                <>
                    <h3 className={cl("section-title")}>Connexion</h3>
                    <ConnectionSection />
                </>
            )}

            <p className={cl("note")}>
                Module optionnel, mis à jour séparément de low-cord. Le moteur est téléchargé depuis le repo low-cord,
                et son empreinte est vérifiée avant installation. Client vocal tiers : utilise des comptes dédiés,
                pas ton compte principal.
            </p>
        </SettingsTab>
    );
}

export default wrapTab(LowMusicalSettings, "low-musical");
