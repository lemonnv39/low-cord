/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-musical — panneau de gestion, flottant au-dessus de Discord. Il s'ouvre
// toujours centré ; on peut le déplacer en le tenant par son en-tête. Discord
// reste utilisable derrière. Le fermer ne coupe rien : le compte reste en
// vocal et la diffusion continue.

import "./panel.css";

import ErrorBoundary from "@components/ErrorBoundary";
import { type Folder, getAccounts, getFolders, type SavedAccount } from "@lowplugins/tokenImporter";
import { classNameFactory } from "@utils/css";
import { useEffect, useMemo, useRef, useState } from "@webpack/common";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

import {
    connect, DEFAULT_INPUT, devices, disconnect, type EngineState, errorText, getPrefs, join, leave,
    PREF_DEFAULTS, setBitrate, setFakeDeafen, setFollow, setGain, setInput, setLatency, setPresence, useMusical,
} from "./engine";
import { MusicalIcon } from "./LowMusicalTab";

const cl = classNameFactory("lc-mp-");

const STATE_LABEL: Record<EngineState, string> = {
    connecting: "connexion…",
    connected: "connecté",
    reconnecting: "reconnexion…",
    in_voice: "connecté · en vocal",
    connected_left: "connecté",
    error: "erreur",
    disconnected: "déconnecté",
};

// ── Petits composants ───────────────────────────────────────────────────────

function Slider({ label, value, display, min, max, step, reset, onChange }: {
    label: string; value: number; display: string; min: number; max: number; step: number; reset: number;
    onChange(v: number): void;
}) {
    return (
        <label className={cl("slider")}>
            <span className={cl("slider-head")}>
                <span>{label}</span>
                <span className={cl("value")}>{display}</span>
            </span>
            <input
                type="range" min={min} max={max} step={step} value={value}
                onChange={e => onChange(Number(e.currentTarget.value))}
                onDoubleClick={() => onChange(reset)}
                title="Double-clic : valeur par défaut"
            />
        </label>
    );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange(v: boolean): void; label: string; }) {
    return (
        <button role="switch" aria-checked={on} aria-label={label} className={cl("switch", on && "switch-on")} onClick={() => onChange(!on)}>
            <span className={cl("knob")} />
        </button>
    );
}

function Section({ title, children, extra }: { title: string; children: ReactNode; extra?: ReactNode; }) {
    return (
        <div className={cl("sec")}>
            <div className={cl("sec-head")}>
                <span>{title}</span>
                {extra}
            </div>
            {children}
        </div>
    );
}

const HeadsetIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
        <path d="M4 15a2 2 0 0 1 2-2h1v6H6a2 2 0 0 1-2-2z" />
        <path d="M20 15a2 2 0 0 0-2-2h-1v6h1a2 2 0 0 0 2-2z" />
    </svg>
);

const PowerIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 4v8" />
        <path d="M6.5 7a8 8 0 1 0 11 0" />
    </svg>
);

const RefreshIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 12a9 9 0 1 1-2.6-6.4" />
        <path d="M21 3v6h-6" />
    </svg>
);

// ── Colonne audio ───────────────────────────────────────────────────────────

function AudioColumn({ act }: { act(fn: () => Promise<unknown>): void; }) {
    const music = useMusical();
    const prefs = getPrefs();
    const [inputs, setInputs] = useState<string[] | null>(null);

    const loadInputs = () => act(() => devices().then(setInputs));
    useEffect(() => { if (music.running && !inputs) loadInputs(); }, [music.running]);

    const connected = music.running && music.state !== "disconnected" && music.state !== "error";

    return (
        <div className={cl("col")}>
            <div className={cl("col-title")}>Réglages audio</div>

            <Section
                title="Source audio"
                extra={<button className={cl("mini")} disabled={!music.running} onClick={loadInputs}><RefreshIcon /> Rafraîchir</button>}
            >
                <select
                    className={cl("select")}
                    value={prefs.source ?? ""}
                    disabled={!connected || !inputs}
                    onChange={e => { const v = e.currentTarget.value; if (v) act(() => setInput(v)); }}
                >
                    <option value="" disabled>{connected ? "Aucune source (silence)" : "Connecte un compte d'abord"}</option>
                    <option value={DEFAULT_INPUT}>Entrée par défaut</option>
                    {inputs?.map(n => <option key={n} value={n}>{n}</option>)}
                    {prefs.source && prefs.source !== DEFAULT_INPUT && inputs && !inputs.includes(prefs.source) && (
                        <option value={prefs.source}>{prefs.source} (absent)</option>
                    )}
                </select>
                {music.captureError && <p className={cl("error-line")}>{music.captureError}</p>}
                <Slider
                    label="Gain" value={prefs.gain} display={`${prefs.gain > 0 ? "+" : ""}${prefs.gain} dB`}
                    min={-60} max={24} step={1} reset={PREF_DEFAULTS.gain} onChange={setGain}
                />
                <p className={cl("note")}>
                    Rien n'est diffusé tant qu'aucune source n'est choisie. Prends un câble virtuel (CABLE Output,
                    Voicemeeter) pour diffuser ta musique. Double-clic sur un curseur pour le réinitialiser.
                </p>
            </Section>

            <Section title="Débit & latence">
                <Slider
                    label="Débit Opus" value={prefs.bitrate} display={`${prefs.bitrate} kbps`}
                    min={32} max={512} step={8} reset={PREF_DEFAULTS.bitrate} onChange={setBitrate}
                />
                <Slider
                    label="Latence (tampon)" value={prefs.latency} display={`${prefs.latency} ms`}
                    min={40} max={1000} step={10} reset={PREF_DEFAULTS.latency} onChange={setLatency}
                />
                <p className={cl("note")}>
                    Latence : plus bas = plus réactif, mais trop bas peut causer des micro-coupures (essaie 120 à 200 ms).
                    Le débit dépend aussi du salon : Discord peut le limiter.
                </p>
            </Section>
        </div>
    );
}

// ── Colonne Discord ─────────────────────────────────────────────────────────

function avatarUrl(user: { id: string; avatar?: string | null; }) {
    return user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.webp?size=64` : null;
}

function DiscordColumn({ act, pending }: { act(fn: () => Promise<unknown>): void; pending: boolean; }) {
    const music = useMusical();
    const [accounts, setAccounts] = useState<SavedAccount[] | null>(null);
    const [folders, setFolders] = useState<Folder[]>([]);
    const [accountId, setAccountId] = useState(getPrefs().accountId ?? "");
    const [guildId, setGuildId] = useState("");
    const [channelId, setChannelId] = useState("");
    const [followInput, setFollowInput] = useState("");

    useEffect(() => {
        Promise.all([getAccounts(), getFolders()]).then(([a, f]) => { setAccounts(a); setFolders(f); }).catch(() => setAccounts([]));
    }, []);

    // Se recaler sur le salon où le compte est déjà.
    useEffect(() => {
        if (music.current) {
            setGuildId(music.current.guild);
            setChannelId(music.current.channel);
        }
    }, [music.current?.guild, music.current?.channel]);

    const groups = useMemo(() => {
        if (!accounts) return [];
        const byFolder = new Map<string | null, SavedAccount[]>([[null, []]]);
        for (const f of folders) byFolder.set(f.id, []);
        for (const a of accounts) byFolder.get(a.folderId && byFolder.has(a.folderId) ? a.folderId : null)!.push(a);
        return [
            ...folders.map(f => ({ name: f.name, accounts: byFolder.get(f.id)! })),
            { name: folders.length ? "Non classés" : "Comptes", accounts: byFolder.get(null)! },
        ].filter(g => g.accounts.length);
    }, [accounts, folders]);

    const connected = music.running && !!music.state && music.state !== "disconnected" && music.state !== "error";
    const ready = music.state === "connected" || music.state === "connected_left" || music.state === "in_voice";
    const guild = music.guilds?.find(g => g.id === guildId);
    const currentGuild = music.guilds?.find(g => g.id === music.current?.guild);
    const currentChannel = currentGuild?.channels.find(c => c.id === music.current?.channel);
    const errorMsg = (music.state === "error" || music.state === "disconnected") && music.error ? music.error
        : !music.running && music.exitReason && music.exitReason !== "moteur arrêté" ? music.exitReason : null;

    // ── Pas connecté : choix du compte ──
    if (!connected) {
        return (
            <div className={cl("col")}>
                <div className={cl("col-title")}>Discord</div>
                <Section title="Compte">
                    {accounts && !accounts.length ? (
                        <p className={cl("note")}>Aucun compte. Ajoute un compte dédié dans le Token Importer pour l'utiliser ici.</p>
                    ) : (
                        <>
                            <select className={cl("select")} value={accountId} disabled={pending || !accounts} onChange={e => setAccountId(e.currentTarget.value)}>
                                <option value="">{accounts ? "Choisir un compte" : "Chargement…"}</option>
                                {groups.map(g => (
                                    <optgroup key={g.name} label={g.name}>
                                        {g.accounts.map(a => (
                                            <option key={a.id} value={a.id} disabled={!!a.locked}>
                                                {a.username}{a.locked ? " (illisible sur ce PC)" : ""}
                                            </option>
                                        ))}
                                    </optgroup>
                                ))}
                            </select>
                            <button
                                className={cl("btn", "btn-primary", "btn-block")}
                                disabled={pending || !accounts?.some(a => a.id === accountId)}
                                onClick={() => {
                                    const account = accounts?.find(a => a.id === accountId);
                                    if (account) act(() => connect(account));
                                }}
                            >
                                {music.state === "connecting" ? "Connexion…" : "Connecter"}
                            </button>
                            <p className={cl("note")}>
                                Les comptes viennent du Token Importer : aucun token ne s'affiche, même en partage d'écran.
                                Utilise des comptes dédiés, pas ton compte principal.
                            </p>
                        </>
                    )}
                    {errorMsg && <p className={cl("error-line")}>{errorMsg}</p>}
                </Section>
            </div>
        );
    }

    // ── Connecté ──
    const avatar = music.user && avatarUrl(music.user);
    return (
        <div className={cl("col")}>
            <div className={cl("col-title")}>Discord</div>

            <div className={cl("account")}>
                <span className={cl("avatar")}>
                    {avatar ? <img src={avatar} alt="" /> : (music.user?.username ?? "?").slice(0, 2)}
                    <span className={cl("presence", ready && "presence-on")} />
                </span>
                <div className={cl("account-id")}>
                    <div className={cl("account-name")}>{music.user?.username ?? "…"}</div>
                    <div className={cl("account-state")}>{music.state ? STATE_LABEL[music.state] : ""}</div>
                </div>
                <button
                    className={cl("icon-btn", music.fakeDeafen && "icon-btn-on")}
                    disabled={pending || !ready}
                    onClick={() => act(() => setFakeDeafen(!music.fakeDeafen))}
                    title="Faux sourd : le compte apparaît sourd mais continue de diffuser"
                    aria-label="Faux sourd"
                    aria-pressed={!!music.fakeDeafen}
                ><HeadsetIcon /></button>
                <button className={cl("icon-btn")} disabled={pending} onClick={() => act(disconnect)} title="Déconnecter" aria-label="Déconnecter">
                    <PowerIcon />
                </button>
            </div>

            {music.current && (
                <div className={cl("live")}>
                    <span>En vocal : <b>{currentChannel?.name ?? "salon"}</b>{currentGuild && <span className={cl("muted")}> · {currentGuild.name}</span>}</span>
                    <span className={cl("live-tag")}>LIVE</span>
                    <button className={cl("mini")} disabled={pending} onClick={() => act(leave)}>Quitter</button>
                </div>
            )}

            {ready && (
                <Section title="Serveur & salon">
                    {music.guilds?.length ? (
                        <>
                            <select className={cl("select")} value={guildId} disabled={pending} onChange={e => { setGuildId(e.currentTarget.value); setChannelId(""); }}>
                                <option value="">Choisir un serveur</option>
                                {music.guilds.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                            </select>
                            <select
                                className={cl("select")}
                                value={channelId}
                                disabled={pending || !guild}
                                onChange={e => {
                                    const id = e.currentTarget.value;
                                    setChannelId(id);
                                    if (id && id !== music.current?.channel) act(() => join(guildId, id));
                                }}
                            >
                                <option value="">Choisir un salon</option>
                                {guild?.channels.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                            </select>
                            <p className={cl("note")}>Choisir un salon le rejoint aussitôt.</p>
                        </>
                    ) : (
                        <p className={cl("note")}>Aucun serveur avec un salon vocal pour ce compte.</p>
                    )}
                </Section>
            )}

            {ready && (
                <Section title="Présence & suivi">
                    <div className={cl("toggle-row")}>
                        <div>
                            <div className={cl("toggle-name")}>Présence low-musical</div>
                            <div className={cl("toggle-desc")}>Affiche « Joue à low-musical » sur le compte</div>
                        </div>
                        <Toggle on={!!music.presence} label="Présence low-musical" onChange={on => act(() => setPresence(on))} />
                    </div>
                    <span className={cl("label")}>Compte à suivre</span>
                    <div className={cl("follow")}>
                        <input
                            className={cl("input")}
                            placeholder={music.follow ? `Suivi : ${music.follow}` : "ID du compte"}
                            value={followInput}
                            onChange={e => setFollowInput(e.currentTarget.value.replace(/\D/g, ""))}
                        />
                        {music.follow ? (
                            <button className={cl("btn")} disabled={pending} onClick={() => act(() => setFollow(null))}>Arrêter</button>
                        ) : (
                            <button className={cl("btn")} disabled={pending || followInput.length < 15} onClick={() => act(() => setFollow(followInput).then(() => setFollowInput("")))}>
                                Suivre
                            </button>
                        )}
                    </div>
                    <p className={cl("note")}>Colle l'ID d'un compte : low-musical rejoint automatiquement son salon vocal (serveurs en commun).</p>
                </Section>
            )}
        </div>
    );
}

// ── Panneau ─────────────────────────────────────────────────────────────────

function PanelBody({ onClose }: { onClose(): void; }) {
    const ref = useRef<HTMLDivElement>(null);
    // null = centré ; sinon position choisie en le déplaçant.
    const [pos, setPos] = useState<{ x: number; y: number; } | null>(null);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function act(fn: () => Promise<unknown>) {
        setPending(true);
        setError(null);
        try {
            await fn();
        } catch (e) {
            setError(errorText(e));
        } finally {
            setPending(false);
        }
    }

    function startDrag(e: ReactMouseEvent) {
        if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
        const box = ref.current!.getBoundingClientRect();
        const dx = e.clientX - box.left;
        const dy = e.clientY - box.top;
        e.preventDefault();

        const move = (ev: MouseEvent) => {
            // Toujours au moins 80 px de l'en-tête dans la fenêtre : on peut le rattraper.
            const x = Math.min(Math.max(ev.clientX - dx, 80 - box.width), window.innerWidth - 80);
            const y = Math.min(Math.max(ev.clientY - dy, 0), window.innerHeight - 48);
            setPos({ x, y });
        };
        const up = () => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
    }

    return (
        <div
            ref={ref}
            className={cl("panel", !pos && "centered")}
            style={pos ? { left: pos.x, top: pos.y } : undefined}
            role="dialog"
            aria-label="low-musical"
        >
            <header className={cl("head")} onMouseDown={startDrag} onDoubleClick={() => setPos(null)} title="Glisser pour déplacer · double-clic pour recentrer">
                <span className={cl("logo")}><MusicalIcon width={18} height={18} /></span>
                <span className={cl("title")}>low-musical</span>
                <span className={cl("tag")}>beta</span>
                <span className={cl("head-note")}>Diffuse de l'audio dans un salon vocal avec un compte <b>dédié</b>.</span>
                <button className={cl("close")} onClick={onClose} aria-label="Fermer" title="Fermer (la diffusion continue)">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
                </button>
            </header>
            {error && <div className={cl("error")}>{error}</div>}
            <div className={cl("cols")}>
                <AudioColumn act={act} />
                <DiscordColumn act={act} pending={pending} />
            </div>
        </div>
    );
}

export const MusicalPanel = ErrorBoundary.wrap(PanelBody, { noop: true });
