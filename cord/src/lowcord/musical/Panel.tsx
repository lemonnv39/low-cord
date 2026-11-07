/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-musical — panneau de gestion. Il vit dans sa propre fenêtre (voir
// window.tsx) : ouverte centrée sur Discord, déplaçable par son en-tête sur
// n'importe quel écran. Le fermer ne coupe rien : les comptes restent en vocal
// et la diffusion continue. Plusieurs comptes peuvent diffuser ensemble.

import "./panel.css";

import ErrorBoundary from "@components/ErrorBoundary";
import { type Folder, getAccounts, getFolders, type SavedAccount } from "@lowplugins/tokenImporter";
import { useEffect, useMemo, useState } from "@webpack/common";

import { cl, Section, Slider, Toggle } from "./controls";
import { EqSection, ProcessingSection, SpatialSection } from "./Effects";
import {
    type AccountState, connectAccounts, DEFAULT_INPUT, devices, disconnect, type EngineState, errorText, getPrefs, isActive,
    isOutdated, isReady, joinAll, leave, type MusicalGuild, PREF_DEFAULTS, savePrefs, setBitrate, setFakeDeafen, setFollow,
    setGain, setInput, setLatency, setPresence, useMusical,
} from "./engine";
import { MusicalIcon } from "./LowMusicalTab";
import { setAlwaysOnTop, useAlwaysOnTop } from "./popoutKey";

const STATE_LABEL: Record<EngineState, string> = {
    connecting: "connexion…",
    connected: "connecté",
    reconnecting: "reconnexion…",
    in_voice: "connecté · en vocal",
    connected_left: "connecté",
    error: "erreur",
    disconnected: "déconnecté",
};

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

    const connected = music.running && Object.values(music.accounts).some(isActive);

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

            <SpatialSection />
            <EqSection />
            <ProcessingSection />
        </div>
    );
}

// ── Colonne Discord ─────────────────────────────────────────────────────────

function avatarUrl(user: { id: string; avatar?: string | null; }) {
    return user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.webp?size=64` : null;
}

interface Group { id: string; name: string; accounts: SavedAccount[]; }

/** Comptes du Token Importer rangés par dossier (les « Non classés » à la fin). */
function useAccountGroups() {
    const [accounts, setAccounts] = useState<SavedAccount[] | null>(null);
    const [folders, setFolders] = useState<Folder[]>([]);

    useEffect(() => {
        Promise.all([getAccounts(), getFolders()]).then(([a, f]) => { setAccounts(a); setFolders(f); }).catch(() => setAccounts([]));
    }, []);

    const groups = useMemo<Group[]>(() => {
        if (!accounts) return [];
        const byFolder = new Map<string | null, SavedAccount[]>([[null, []]]);
        for (const f of folders) byFolder.set(f.id, []);
        for (const a of accounts) byFolder.get(a.folderId && byFolder.has(a.folderId) ? a.folderId : null)!.push(a);
        return [
            ...folders.map(f => ({ id: f.id, name: f.name, accounts: byFolder.get(f.id)! })),
            { id: "", name: folders.length ? "Non classés" : "Comptes", accounts: byFolder.get(null)! },
        ].filter(g => g.accounts.length);
    }, [accounts, folders]);

    return { accounts, groups };
}

/** Liste à cocher : un dossier entier d'un clic, ou compte par compte. */
function AccountPicker({ groups, exclude, pending, act }: {
    groups: Group[]; exclude: Set<string>; pending: boolean; act(fn: () => Promise<unknown>): void;
}) {
    const prefs = getPrefs();
    const [selected, setSelected] = useState<Set<string>>(() => new Set(prefs.selection));

    const visible = groups
        .map(g => ({ ...g, accounts: g.accounts.filter(a => !exclude.has(a.id)) }))
        .filter(g => g.accounts.length);
    const usable = (a: SavedAccount) => !a.locked && !!a.token;
    const chosen = visible.flatMap(g => g.accounts).filter(a => usable(a) && selected.has(a.id));

    function toggle(ids: string[], on: boolean) {
        const next = new Set(selected);
        for (const id of ids) on ? next.add(id) : next.delete(id);
        setSelected(next);
        savePrefs({ selection: [...next] });
    }

    if (!visible.length) return <p className={cl("note")}>Tous tes comptes sont déjà connectés.</p>;

    return (
        <>
            <div className={cl("picker")}>
                {visible.map(g => {
                    const ids = g.accounts.filter(usable).map(a => a.id);
                    const all = ids.length > 0 && ids.every(id => selected.has(id));
                    return (
                        <div key={g.id || "none"} className={cl("group")}>
                            <label className={cl("group-head")}>
                                <input type="checkbox" checked={all} disabled={!ids.length} onChange={e => toggle(ids, e.currentTarget.checked)} />
                                <span>{g.name}</span>
                                <span className={cl("count")}>{g.accounts.length}</span>
                            </label>
                            {g.accounts.map(a => (
                                <label key={a.id} className={cl("pick", !usable(a) && "pick-off")}>
                                    <input type="checkbox" checked={selected.has(a.id)} disabled={!usable(a)} onChange={e => toggle([a.id], e.currentTarget.checked)} />
                                    <span>{a.username}</span>
                                    {!usable(a) && <span className={cl("muted")}>illisible sur ce PC</span>}
                                </label>
                            ))}
                        </div>
                    );
                })}
            </div>
            <Slider
                label="Délai entre chaque compte" value={prefs.delay} display={`${prefs.delay} ms`}
                min={0} max={5000} step={100} reset={PREF_DEFAULTS.delay}
                onChange={v => savePrefs({ delay: v })}
            />
            <button className={cl("btn", "btn-primary", "btn-block")} disabled={pending || !chosen.length} onClick={() => act(() => connectAccounts(chosen))}>
                {chosen.length > 1 ? `Connecter ${chosen.length} comptes` : "Connecter"}
            </button>
        </>
    );
}

function AccountRow({ id, name, account, pending, act }: {
    id: string; name?: string; account: AccountState; pending: boolean; act(fn: () => Promise<unknown>): void;
}) {
    const label = account.user?.username ?? name ?? "…";
    const avatar = account.user && avatarUrl(account.user);
    const failed = account.state === "error" || account.state === "disconnected";
    return (
        <div className={cl("account")}>
            <span className={cl("avatar")}>
                {avatar ? <img src={avatar} alt="" /> : label.slice(0, 2)}
                <span className={cl("presence", isReady(account) && "presence-on", failed && "presence-off")} />
            </span>
            <div className={cl("account-id")}>
                <div className={cl("account-name")}>{label}</div>
                <div className={cl("account-state", failed && "account-error")}>
                    {failed && account.error ? account.error : account.state ? STATE_LABEL[account.state] : ""}
                </div>
            </div>
            <button
                className={cl("icon-btn", account.fakeDeafen && "icon-btn-on")}
                disabled={pending || !isReady(account)}
                onClick={() => act(() => setFakeDeafen(!account.fakeDeafen, id))}
                title="Faux sourd : le compte apparaît sourd mais continue de diffuser"
                aria-label="Faux sourd"
                aria-pressed={!!account.fakeDeafen}
            ><HeadsetIcon /></button>
            <button className={cl("icon-btn")} disabled={pending} onClick={() => act(() => disconnect(id))} title={failed ? "Retirer" : "Déconnecter"} aria-label="Déconnecter">
                <PowerIcon />
            </button>
        </div>
    );
}

function DiscordColumn({ act, pending }: { act(fn: () => Promise<unknown>): void; pending: boolean; }) {
    const music = useMusical();
    const { accounts, groups } = useAccountGroups();
    const [guildId, setGuildId] = useState("");
    const [channelId, setChannelId] = useState("");
    const [followInput, setFollowInput] = useState("");
    const [adding, setAdding] = useState(false);

    const entries = Object.entries(music.accounts);
    const active = entries.filter(([, a]) => isActive(a));
    const ready = entries.filter(([, a]) => isReady(a)).map(([, a]) => a);
    const inVoice = ready.filter(a => a.state === "in_voice");
    const current = inVoice[0]?.current;

    // Serveurs communs à tous les comptes prêts : là où ils peuvent tous aller.
    const guilds = useMemo<MusicalGuild[]>(() => {
        if (!ready.length) return [];
        const [first, ...rest] = ready;
        return (first.guilds ?? []).filter(g => rest.every(a => a.guilds?.some(x => x.id === g.id)));
    }, [ready.map(a => a.user?.id + ":" + a.guilds?.length).join()]);

    useEffect(() => {
        if (current) {
            setGuildId(current.guild);
            setChannelId(current.channel);
        }
    }, [current?.guild, current?.channel]);

    const guild = guilds.find(g => g.id === guildId);
    const currentGuild = guilds.find(g => g.id === current?.guild);
    const currentChannel = currentGuild?.channels.find(c => c.id === current?.channel);
    const allDeaf = ready.length > 0 && ready.every(a => a.fakeDeafen);
    const allPresence = ready.length > 0 && ready.every(a => a.presence);
    const follow = ready.find(a => a.follow)?.follow;
    const exitMsg = !music.running && music.exitReason && music.exitReason !== "moteur arrêté" ? music.exitReason : null;

    if (accounts && !accounts.length) {
        return (
            <div className={cl("col")}>
                <div className={cl("col-title")}>Discord</div>
                <p className={cl("note")}>Aucun compte. Ajoute des comptes dédiés dans le Token Importer pour les utiliser ici.</p>
            </div>
        );
    }

    // ── Aucun compte connecté : choix des comptes ──
    if (!entries.length) {
        return (
            <div className={cl("col")}>
                <div className={cl("col-title")}>Discord</div>
                <Section title="Comptes">
                    {!accounts ? <p className={cl("note")}>Chargement…</p> : (
                        <AccountPicker groups={groups} exclude={new Set()} pending={pending} act={act} />
                    )}
                    <p className={cl("note")}>
                        Coche un dossier pour prendre tous ses comptes, ou choisis-les un par un. Aucun token ne
                        s'affiche, même en partage d'écran. Utilise des comptes dédiés, pas ton compte principal.
                    </p>
                    {exitMsg && <p className={cl("error-line")}>{exitMsg}</p>}
                </Section>
            </div>
        );
    }

    // ── Comptes connectés ──
    return (
        <div className={cl("col")}>
            <div className={cl("col-title")}>Discord</div>

            <Section
                title={`Comptes · ${active.length}`}
                extra={
                    <span className={cl("head-actions")}>
                        <button className={cl("mini")} disabled={pending || !ready.length} onClick={() => act(() => setFakeDeafen(!allDeaf))}>
                            {allDeaf ? "Tout réentendre" : "Tout assourdir"}
                        </button>
                        <button className={cl("mini")} disabled={pending} onClick={() => act(() => disconnect())}>Tout déconnecter</button>
                    </span>
                }
            >
                <div className={cl("accounts")}>
                    {entries.map(([id, a]) => <AccountRow key={id} id={id} name={accounts?.find(x => x.id === id)?.username} account={a} pending={pending} act={act} />)}
                </div>
                {adding ? (
                    <AccountPicker groups={groups} exclude={new Set(entries.map(([id]) => id))} pending={pending} act={fn => act(async () => { await fn(); setAdding(false); })} />
                ) : (
                    <button className={cl("mini")} disabled={pending || !accounts} onClick={() => setAdding(true)}>+ Ajouter des comptes</button>
                )}
            </Section>

            {current && (
                <div className={cl("live")}>
                    <span>
                        En vocal : <b>{currentChannel?.name ?? "salon"}</b>
                        <span className={cl("muted")}> · {inVoice.length}/{ready.length} compte{ready.length > 1 ? "s" : ""}</span>
                    </span>
                    <span className={cl("live-tag")}>LIVE</span>
                    <button className={cl("mini")} disabled={pending} onClick={() => act(() => leave())}>Quitter</button>
                </div>
            )}

            {ready.length > 0 && (
                <Section title="Serveur & salon">
                    {guilds.length ? (
                        <>
                            <select className={cl("select")} value={guildId} disabled={pending} onChange={e => { setGuildId(e.currentTarget.value); setChannelId(""); }}>
                                <option value="">Choisir un serveur</option>
                                {guilds.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                            </select>
                            <select
                                className={cl("select")}
                                value={channelId}
                                disabled={pending || !guild}
                                onChange={e => {
                                    const id = e.currentTarget.value;
                                    setChannelId(id);
                                    if (id) act(() => joinAll(guildId, id));
                                }}
                            >
                                <option value="">Choisir un salon</option>
                                {guild?.channels.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                            </select>
                            <p className={cl("note")}>
                                {ready.length > 1
                                    ? "Seuls les serveurs communs à tous les comptes sont proposés. Choisir un salon y envoie tous les comptes, un par un."
                                    : "Choisir un salon le rejoint aussitôt."}
                            </p>
                        </>
                    ) : (
                        <p className={cl("note")}>{ready.length > 1 ? "Aucun serveur avec un salon vocal en commun entre ces comptes." : "Aucun serveur avec un salon vocal pour ce compte."}</p>
                    )}
                </Section>
            )}

            {ready.length > 0 && (
                <Section title="Présence & suivi">
                    <div className={cl("toggle-row")}>
                        <div>
                            <div className={cl("toggle-name")}>Présence low-musical</div>
                            <div className={cl("toggle-desc")}>Affiche « Joue à low-musical » sur les comptes</div>
                        </div>
                        <Toggle on={allPresence} label="Présence low-musical" onChange={on => act(() => setPresence(on))} />
                    </div>
                    <span className={cl("label")}>Compte à suivre</span>
                    <div className={cl("follow")}>
                        <input
                            className={cl("input")}
                            placeholder={follow ? `Suivi : ${follow}` : "ID du compte"}
                            value={followInput}
                            onChange={e => setFollowInput(e.currentTarget.value.replace(/\D/g, ""))}
                        />
                        {follow ? (
                            <button className={cl("btn")} disabled={pending} onClick={() => act(() => setFollow(null))}>Arrêter</button>
                        ) : (
                            <button className={cl("btn")} disabled={pending || followInput.length < 15} onClick={() => act(() => setFollow(followInput).then(() => setFollowInput("")))}>
                                Suivre
                            </button>
                        )}
                    </div>
                    <p className={cl("note")}>Colle l'ID d'un compte : les comptes rejoignent automatiquement son salon vocal (serveurs en commun).</p>
                </Section>
            )}
        </div>
    );
}

// ── Panneau ─────────────────────────────────────────────────────────────────

const PinIcon = () => (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9 4h6l-1 6 3 3v2H7v-2l3-3-1-6z" />
        <path d="M12 15v5" />
    </svg>
);

/** Le panneau remplit sa fenêtre ; l'en-tête sert de poignée pour la déplacer (sur n'importe quel écran). */
function PanelBody({ onClose }: { onClose(): void; }) {
    useMusical();
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const onTop = useAlwaysOnTop();

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

    return (
        <div className={cl("panel")} aria-label="low-musical">
            <header className={cl("head")} title="Glisser pour déplacer la fenêtre">
                <span className={cl("logo")}><MusicalIcon width={18} height={18} /></span>
                <span className={cl("title")}>low-musical</span>
                <span className={cl("tag")}>beta</span>
                <span className={cl("head-note")}>Diffuse de l'audio dans un salon vocal avec un compte <b>dédié</b>.</span>
                <button
                    className={cl("close", onTop && "close-on")}
                    onClick={() => setAlwaysOnTop(!onTop)}
                    aria-label="Toujours au premier plan"
                    aria-pressed={onTop}
                    title="Toujours au premier plan"
                ><PinIcon /></button>
                <button className={cl("close")} onClick={onClose} aria-label="Fermer" title="Fermer (la diffusion continue)">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
                </button>
            </header>
            {isOutdated() && (
                <div className={cl("error")}>
                    Le moteur installé est trop ancien pour ce panneau : Paramètres → low-musical → Mettre à jour, puis redémarre Discord.
                </div>
            )}
            {error && <div className={cl("error")}>{error}</div>}
            <div className={cl("cols")}>
                <AudioColumn act={act} />
                <DiscordColumn act={act} pending={pending} />
            </div>
        </div>
    );
}

export const MusicalPanel = ErrorBoundary.wrap(PanelBody, { noop: true });
