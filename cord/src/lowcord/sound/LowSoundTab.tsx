/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-sound — onglet des réglages : présentation, installation, mise à jour
// ou retrait du moteur. Module optionnel, mis à jour séparément de low-cord.
// Tout s'applique tout de suite, sans redémarrer Discord : les comptes
// connectés repartent seuls sur le nouveau moteur. Le téléchargement affiche
// sa progression (téléchargement, vérification de l'empreinte, installation).

import "@lowcord/styles.css";

import { SettingsTab, wrapTab } from "@components/settings/tabs/BaseTab";
import { ShinyLogo } from "@lowcord/ShinyLogo";
import type { SoundStatus } from "@main/lowSound";
import { classNameFactory } from "@utils/css";
import type { IconProps } from "@utils/types";
import { useEffect, useState } from "@webpack/common";
import banner from "file://../assets/banner-lowsound.png?base64";

import { engineReplaced, sessionSnapshot, useLowSound } from "./engine";

const cl = classNameFactory("lc-lss-");
const BANNER = `data:image/png;base64,${banner}`;

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

const STEPS = [
    { title: "Installe le moteur", text: "Un clic ci-dessus. Il est téléchargé depuis le repo low-cord et son empreinte est vérifiée." },
    { title: "Ajoute des comptes dédiés", text: "Dans le Token Importer de low-cord. Utilise des comptes à part, pas ton compte principal." },
    { title: "Ouvre low-sound", text: "Avec l'éclair à côté de micro / casque, en bas à gauche. Connecte tes comptes, puis « Rejoindre ma vocale »." },
];

const FEATURES = [
    { title: "Multi-comptes", text: "Autant de comptes que tu veux, qui suivent ta vocale." },
    { title: "Traitement audio", text: "Compresseur, limiteur, égaliseur 10 bandes, tonalité." },
    { title: "Spatialisation 8D", text: "Son qui tourne autour de la tête, pièce et réverbe." },
    { title: "Soundboard", text: "Tes sons, superposables, découpables." },
    { title: "Mini APO", text: "Tes sets Equalizer APO, IR et plugins VST." },
    { title: "Discret", text: "Anti-stream, fenêtre à part, rien à redémarrer." },
];

const PHASES: Record<"download" | "verify" | "install", string> = {
    download: "Téléchargement",
    verify: "Vérification de l'empreinte",
    install: "Installation",
};

function LowSoundSettings() {
    const music = useLowSound();
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
                        : "Installé : l'éclair est à côté de micro / casque, en bas à gauche.";
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
    const progress = running === "install" ? music.install : null;
    const pct = progress && progress.total > 0 ? Math.min(100, progress.received / progress.total * 100) : 0;

    let state: string;
    if (running === "install") state = installed ? "Mise à jour en cours" : "Installation en cours";
    else if (running === "uninstall") state = "Désinstallation…";
    else if (!status) state = "Vérification…";
    else if (!installed) state = "Pas encore installé";
    else if (update) state = "Mise à jour disponible";
    else state = "Installé et à jour";

    return (
        <SettingsTab>
            {/* Bannière : logo détouré, reflet doré et éclat de l'éclair. */}
            <div className={cl("banner")}>
                <ShinyLogo src={BANNER} label="low-sound" tone="gold">
                    <span className={cl("bolt-flash")} aria-hidden="true" />
                </ShinyLogo>
                <p className={cl("tagline")}>
                    Diffuse ta musique dans un salon vocal avec un ou plusieurs comptes, avec un son travaillé.
                </p>
            </div>

            {/* État et actions */}
            <div className={cl("card")}>
                <div className={cl("row")}>
                    <span className={cl("dot", installed && !update && "dot-on", update && "dot-update", running && "dot-busy")} />
                    <div className={cl("state")}>
                        <div className={cl("state-name")}>{state}</div>
                        <div className={cl("versions")}>
                            {installed && status?.version && (
                                <span className={cl("chip")}>
                                    Installée <b>v{status.version}</b>{status.installedAt ? ` · ${day(status.installedAt)}` : ""}
                                </span>
                            )}
                            {latest && (!installed || update) && (
                                <span className={cl("chip", "chip-new")}>
                                    {installed ? "Nouvelle" : "Disponible"} <b>v{latest.version}</b>
                                    {latest.date ? ` · ${day(latest.date)}` : ""} · {mb(latest.size)} Mo
                                </span>
                            )}
                            {installed && latest && !update && <span className={cl("chip")}>Dernière version</span>}
                        </div>
                    </div>
                    <div className={cl("actions")}>
                        {!installed && (
                            <button className={cl("btn", "btn-primary")} disabled={!!running || !latest} onClick={() => run("install")}>
                                <SoundIcon width={14} height={14} /> Installer
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

                {/* Progression du téléchargement */}
                {running === "install" && (
                    <div className={cl("progress")}>
                        <div className={cl("progress-head")}>
                            <span>{progress ? PHASES[progress.phase] : "Préparation"}{progress?.version ? ` · v${progress.version}` : ""}</span>
                            <span className={cl("progress-num")}>
                                {progress?.phase === "download" && progress.total > 0 ? `${mb(progress.received)} / ${mb(progress.total)} Mo` : ""}
                            </span>
                        </div>
                        <div className={cl("bar", (!progress || progress.phase !== "download") && "bar-busy")}>
                            <span style={{ width: `${progress?.phase === "download" ? pct : 100}%` }} />
                        </div>
                        <div className={cl("steps")}>
                            {(["download", "verify", "install"] as const).map((p, i) => {
                                const at = progress ? ["download", "verify", "install"].indexOf(progress.phase) : -1;
                                return <span key={p} className={cl("step", i < at && "step-done", i === at && "step-now")}>{PHASES[p]}</span>;
                            })}
                        </div>
                    </div>
                )}

                {doneNote && !running && (
                    <div className={cl("note-ok")}>
                        <SoundIcon width={14} height={14} />
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

            {/* Comment ça marche */}
            <div className={cl("section-title")}>Comment ça marche</div>
            <div className={cl("how")}>
                {STEPS.map((s, i) => (
                    <div key={s.title} className={cl("how-step")}>
                        <span className={cl("how-n")}>{i + 1}</span>
                        <div>
                            <div className={cl("how-title")}>{s.title}</div>
                            <div className={cl("how-text")}>{s.text}</div>
                        </div>
                    </div>
                ))}
            </div>

            {/* Ce qu'il y a dedans */}
            <div className={cl("section-title")}>Dans low-sound</div>
            <div className={cl("features")}>
                {FEATURES.map(f => (
                    <div key={f.title} className={cl("feature")}>
                        <div className={cl("feature-title")}>{f.title}</div>
                        <div className={cl("feature-text")}>{f.text}</div>
                    </div>
                ))}
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
