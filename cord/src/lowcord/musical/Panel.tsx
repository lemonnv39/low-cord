/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-musical — panneau de gestion. Il vit dans sa propre fenêtre (voir
// window.tsx), sur une seule page :
//   Session · [titre + visualisation du son en direct] · Espace
//             [ Signal ][ Égaliseur ]                 Soundboard
// Fond transparent : seuls les blocs sont visibles.
// La fenêtre s'attrape n'importe où sur un fond vide pour la déplacer, y
// compris sur un autre écran. La fermer ne coupe rien.

import "./panel.css";

import ErrorBoundary from "@components/ErrorBoundary";
import { type Folder, getAccounts, getFolders, type SavedAccount } from "@lowplugins/tokenImporter";
import { copyToClipboard } from "@utils/clipboard";
import { ChannelStore, GuildStore, SelectedChannelStore, useEffect, useMemo, useRef, useState, useStateFromStores } from "@webpack/common";
import type { PointerEvent as ReactPointerEvent } from "react";

import { Card, Chip, cl, Dropdown, Slider } from "./controls";
import { EqCard, SignalCard, SpaceCard } from "./Effects";
import {
    type AccountState, applyPreset, connectAccounts, deleteUserPreset, disconnect, type EngineState, errorText, exportPreset,
    followMe, getPrefs, importPreset, isActive, isOutdated, isReady, joinMe, PREF_DEFAULTS, PRESET_CUSTOM, PRESETS, savePrefs,
    saveUserPreset, setFakeDeafen, setStreamProof, setVolume, stopFollowing, syncBitrate, useMusical, wantMeter,
} from "./engine";
import { setAlwaysOnTop, useAlwaysOnTop } from "./popoutKey";
import { SoundboardCard } from "./Soundboard";
import { Visualizer } from "./Visualizer";

type Act = (fn: () => Promise<unknown>) => void;

const STATE_LABEL: Record<EngineState, string> = {
    connecting: "connexion…",
    connected: "connecté",
    reconnecting: "reconnexion…",
    in_voice: "en vocal",
    connected_left: "connecté",
    error: "erreur",
    disconnected: "déconnecté",
};

const svg = (children: React.ReactNode, size = 16) => (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {children}
    </svg>
);

const HeadsetIcon = () => svg(<><path d="M4 14v-2a8 8 0 0 1 16 0v2" /><path d="M4 15a2 2 0 0 1 2-2h1v6H6a2 2 0 0 1-2-2zM20 15a2 2 0 0 0-2-2h-1v6h1a2 2 0 0 0 2-2z" /></>);
const PowerIcon = () => svg(<><path d="M12 4v8" /><path d="M6.5 7a8 8 0 1 0 11 0" /></>);
const PinIcon = () => svg(<><path d="M9 4h6l-1 6 3 3v2H7v-2l3-3-1-6z" /><path d="M12 15v5" /></>);
const CloseIcon = () => svg(<path d="M6 6l12 12M18 6 6 18" />, 17);
const SessionIcon = () => svg(<><path d="M17 20v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1" /><circle cx="10" cy="8" r="3.5" /><path d="M21 20v-1a4 4 0 0 0-3-3.9M16 4.2a3.5 3.5 0 0 1 0 6.6" /></>, 15);
const VoiceIcon = () => svg(<><path d="M11 5 6 9H3v6h3l5 4z" /><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" /></>, 18);

// ── Comptes ─────────────────────────────────────────────────────────────────

function avatarUrl(user: { id: string; avatar?: string | null; }) {
    return user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.webp?size=64` : null;
}

interface FolderGroup { id: string; name: string; accounts: SavedAccount[]; }

/** Comptes du Token Importer rangés par dossier (les « Non classés » à la fin). */
function useAccountGroups() {
    const [accounts, setAccounts] = useState<SavedAccount[] | null>(null);
    const [folders, setFolders] = useState<Folder[]>([]);

    useEffect(() => {
        Promise.all([getAccounts(), getFolders()]).then(([a, f]) => { setAccounts(a); setFolders(f); }).catch(() => setAccounts([]));
    }, []);

    const groups = useMemo<FolderGroup[]>(() => {
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
function AccountPicker({ groups, exclude, pending, act, onCancel }: {
    groups: FolderGroup[]; exclude: Set<string>; pending: boolean; act: Act; onCancel?(): void;
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

    if (!visible.length) return <p className={cl("hint")}>Tous tes comptes sont déjà connectés.</p>;

    return (
        <div className={cl("picker-wrap")}>
            <div className={cl("picker", "scroll")}>
                {visible.map(g => {
                    const ids = g.accounts.filter(usable).map(a => a.id);
                    const all = ids.length > 0 && ids.every(id => selected.has(id));
                    return (
                        <div key={g.id || "none"} className={cl("folder")}>
                            <label className={cl("folder-head")}>
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
                min={0} max={5000} step={100} reset={PREF_DEFAULTS.delay} onChange={v => savePrefs({ delay: v })}
            />
            <div className={cl("row")}>
                {onCancel && <button type="button" className={cl("btn")} onClick={onCancel}>Annuler</button>}
                <button type="button" className={cl("btn", "btn-primary", "btn-grow")} disabled={pending || !chosen.length} onClick={() => act(() => connectAccounts(chosen))}>
                    {chosen.length > 1 ? `Connecter ${chosen.length} comptes` : "Connecter"}
                </button>
            </div>
        </div>
    );
}

function AccountRow({ id, name, account, warning, pending, act }: {
    id: string; name?: string; account: AccountState; warning?: string; pending: boolean; act: Act;
}) {
    const label = account.user?.username ?? name ?? "…";
    const avatar = account.user && avatarUrl(account.user);
    const failed = account.state === "error" || account.state === "disconnected";
    const tone = failed ? "bad" : warning ? "warn" : account.state === "in_voice" ? "live" : isReady(account) ? "ok" : "wait";
    return (
        <div className={cl("account")}>
            <span className={cl("avatar")}>
                {avatar ? <img src={avatar} alt="" /> : label.slice(0, 2)}
                <span className={cl("dot", `dot-${tone}`)} />
            </span>
            <div className={cl("account-id")}>
                <div className={cl("account-name")}>{label}</div>
                <div className={cl("account-state", `state-${tone}`)}>
                    {failed && account.error ? account.error : warning ?? (account.state ? STATE_LABEL[account.state] : "")}
                </div>
            </div>
            <button
                type="button"
                className={cl("icon-btn", account.fakeDeafen && "icon-btn-on")}
                disabled={pending || !isReady(account)}
                onClick={() => act(() => setFakeDeafen(!account.fakeDeafen, id))}
                title="Faux sourd : le compte apparaît sourd mais continue de diffuser"
                aria-label="Faux sourd"
                aria-pressed={!!account.fakeDeafen}
            ><HeadsetIcon /></button>
            <button type="button" className={cl("icon-btn", "icon-btn-danger")} disabled={pending} onClick={() => act(() => disconnect(id))} title={failed ? "Retirer" : "Déconnecter"} aria-label="Déconnecter">
                <PowerIcon />
            </button>
        </div>
    );
}

/** Salon vocal où tu es (ton compte Discord), avec son serveur. */
function useMyVoice() {
    return useStateFromStores([SelectedChannelStore, ChannelStore, GuildStore], () => {
        const id = SelectedChannelStore.getVoiceChannelId();
        const channel = id ? ChannelStore.getChannel(id) : null;
        if (!channel) return null;
        return {
            id: channel.id,
            name: channel.name,
            guild: channel.guild_id ? GuildStore.getGuild(channel.guild_id)?.name : undefined,
            bitrate: (channel as { bitrate?: number; }).bitrate,
        };
    });
}

// ── Session ─────────────────────────────────────────────────────────────────

function SessionCard({ act, pending }: { act: Act; pending: boolean; }) {
    const music = useMusical();
    const voice = useMyVoice();
    const { accounts, groups } = useAccountGroups();
    const [adding, setAdding] = useState(false);

    // Moment où ta vocale a changé : un compte absent de ton salon n'est signalé
    // qu'après son délai et quelques secondes (le temps qu'il arrive).
    const [movedAt, setMovedAt] = useState(Date.now());
    const [, tick] = useState(0);
    useEffect(() => {
        setMovedAt(Date.now());
        // Les comptes qui suivent reçoivent ta vocale directement (ils ne la voient pas toujours).
        joinMe();
    }, [voice?.id]);
    // Débit calé sur le plafond de ta vocale (option « Débit auto »).
    useEffect(() => { syncBitrate(voice?.bitrate); }, [voice?.bitrate, getPrefs().autoBitrate]);
    useEffect(() => {
        const timer = setInterval(() => tick(n => n + 1), 1000);
        return () => clearInterval(timer);
    }, []);

    const entries = Object.entries(music.accounts);
    const active = entries.filter(([, a]) => isActive(a));
    const ready = entries.filter(([, a]) => isReady(a)).map(([, a]) => a);
    const here = voice ? ready.filter(a => a.current?.channel === voice.id).length : 0;
    const allDeaf = ready.length > 0 && ready.every(a => a.fakeDeafen);
    const exitMsg = !music.running && music.exitReason && music.exitReason !== "moteur arrêté" ? music.exitReason : null;

    function warning(a: AccountState) {
        if (!music.following || !voice || !isReady(a) || a.current?.channel === voice.id) return undefined;
        const index = ready.indexOf(a);
        return Date.now() - movedAt > index * getPrefs().delay + 6000 ? "pas dans ta vocale (accès ?)" : undefined;
    }

    return (
        <Card
            title="Session"
            icon={<SessionIcon />}
            className={cl("card-session")}
            extra={entries.length > 0 && (
                <span className={cl("card-actions")}>
                    <button
                        type="button"
                        className={cl("link", allDeaf && "link-on")}
                        disabled={pending || !ready.length}
                        onClick={() => act(() => setFakeDeafen(!allDeaf))}
                        aria-pressed={allDeaf}
                        title="Tous les comptes apparaissent sourds (casque coupé) mais continuent de diffuser"
                    >All fake deafen</button>
                    <button type="button" className={cl("link", "link-danger")} disabled={pending} onClick={() => act(() => disconnect())} title="Déconnecte tous les comptes">Deco all</button>
                </span>
            )}
        >
            {/* Ta vocale + bouton */}
            <div className={cl("voice", music.following && "voice-live")}>
                <span className={cl("voice-icon")}><VoiceIcon /></span>
                <div className={cl("voice-text")}>
                    <span className={cl("voice-name")}>{voice ? voice.name : "Pas en vocal"}</span>
                    <span className={cl("voice-sub")}>
                        {voice ? (voice.guild ?? "Ta vocale") : "Rejoins une vocale sur Discord"}
                        {music.following && voice && ready.length > 0 && ` · ${here}/${ready.length} ici`}
                    </span>
                </div>
            </div>
            {music.following ? (
                <button type="button" className={cl("btn", "btn-leave", "btn-block")} disabled={pending} onClick={() => act(stopFollowing)}>
                    Quitter la vocale
                </button>
            ) : (
                <button type="button" className={cl("btn", "btn-join", "btn-block")} disabled={pending || !ready.length} onClick={() => act(followMe)}>
                    {!ready.length ? "Connecte des comptes" : voice ? "Rejoindre ma vocale" : "Me suivre"}
                </button>
            )}

            <Slider
                label="Volume général" value={getPrefs().volume} display={`${Math.round(getPrefs().volume * 100)} %`}
                min={0} max={2} step={0.01} reset={PREF_DEFAULTS.volume} onChange={setVolume}
            />

            {/* Comptes */}
            <div className={cl("group-title", "accounts-title")}>
                Comptes{active.length > 0 && <span className={cl("count")}>{active.length}</span>}
            </div>
            {accounts && !accounts.length ? (
                <p className={cl("hint")}>Ajoute des comptes dédiés dans le Token Importer pour les utiliser ici.</p>
            ) : !entries.length || adding ? (
                !accounts ? <p className={cl("hint")}>Chargement…</p> : (
                    <AccountPicker
                        groups={groups}
                        exclude={new Set(entries.map(([id]) => id))}
                        pending={pending}
                        act={fn => act(async () => { await fn(); setAdding(false); })}
                        onCancel={entries.length ? () => setAdding(false) : undefined}
                    />
                )
            ) : (
                <>
                    <div className={cl("accounts", "scroll")}>
                        {entries.map(([id, a]) => (
                            <AccountRow
                                key={id} id={id} name={accounts?.find(x => x.id === id)?.username} account={a}
                                warning={warning(a)} pending={pending} act={act}
                            />
                        ))}
                    </div>
                    <button type="button" className={cl("link", "link-add")} disabled={pending || !accounts} onClick={() => setAdding(true)}>+ Ajouter des comptes</button>
                </>
            )}
            {exitMsg && <p className={cl("error-line")}>{exitMsg}</p>}
        </Card>
    );
}

// ── Sous le titre : préréglages et options ──────────────────────────────────

const SaveIcon = () => svg(<><path d="M5 3h11l3 3v15H5z" /><path d="M8 3v6h8V3M8 21v-7h8v7" /></>, 15);
const MoreIcon = () => svg(<><circle cx="5" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="19" cy="12" r="1.2" /></>, 15);

function PresetBar({ act }: { act: Act; }) {
    useMusical();
    const prefs = getPrefs();
    const [form, setForm] = useState<"save" | "import" | "menu" | null>(null);
    const [text, setText] = useState("");
    const [note, setNote] = useState<string | null>(null);

    const isUser = prefs.userPresets.some(p => p.name === prefs.preset);

    const flash = (msg: string) => {
        setNote(msg);
        setTimeout(() => setNote(n => (n === msg ? null : n)), 2500);
    };
    const close = () => { setForm(null); setText(""); };

    return (
        <div className={cl("stage-bar")}>
            <div className={cl("stage-row")}>
                <div className={cl("preset-pick")}>
                    <Dropdown
                        value={prefs.preset}
                        placeholder={prefs.preset === PRESET_CUSTOM ? "Perso (réglé à la main)" : "Préréglages low-musical"}
                        choices={[
                            ...Object.keys(PRESETS).map(name => ({ value: name, label: name })),
                            ...prefs.userPresets.map(p => ({
                                value: p.name,
                                label: `★ ${p.name}`,
                                menu: [
                                    { label: "Exporter (copier)", onClick: () => { copyToClipboard(exportPreset(p.name)); flash("Préréglage copié : colle-le à qui tu veux."); } },
                                    { label: `Supprimer « ${p.name} »`, danger: true, onClick: () => { deleteUserPreset(p.name); flash("Préréglage supprimé."); } },
                                ],
                            })),
                        ]}
                        onChange={applyPreset}
                    />
                </div>
                <button type="button" className={cl("icon-btn", "icon-btn-glass")} onClick={() => setForm(form === "save" ? null : "save")} title="Enregistrer le son actuel comme préréglage" aria-label="Enregistrer"><SaveIcon /></button>
                <button type="button" className={cl("icon-btn", "icon-btn-glass", form === "menu" && "icon-btn-on")} onClick={() => setForm(form === "menu" ? null : "menu")} title="Exporter, importer, supprimer" aria-label="Plus"><MoreIcon /></button>
                <span className={cl("stage-sep")} />
                <Chip on={prefs.streamProof} onClick={() => act(async () => { await setStreamProof(!prefs.streamProof); })} title="La fenêtre de low-musical devient invisible quand tu partages ton écran">Anti-stream</Chip>
            </div>

            {form === "menu" && (
                <div className={cl("stage-pop")}>
                    <button type="button" className={cl("link")} onClick={() => { copyToClipboard(exportPreset(prefs.preset)); close(); flash("Préréglage copié : colle-le à qui tu veux."); }}>Exporter (copier)</button>
                    <button type="button" className={cl("link")} onClick={() => setForm("import")}>Importer (coller)</button>
                    {isUser && <button type="button" className={cl("link", "link-danger")} onClick={() => { deleteUserPreset(prefs.preset); close(); flash("Préréglage supprimé."); }}>Supprimer « {prefs.preset} »</button>}
                </div>
            )}
            {form === "save" && (
                <form className={cl("stage-pop")} onSubmit={e => { e.preventDefault(); act(async () => { saveUserPreset(text); close(); flash("Préréglage enregistré."); }); }}>
                    <input className={cl("text")} autoFocus maxLength={32} placeholder="Nom du préréglage" value={text} onChange={e => setText(e.currentTarget.value)} />
                    <button type="submit" className={cl("btn", "btn-primary", "btn-sm")} disabled={!text.trim()}>Enregistrer</button>
                    <button type="button" className={cl("link")} onClick={close}>Annuler</button>
                </form>
            )}
            {form === "import" && (
                <form className={cl("stage-pop")} onSubmit={e => { e.preventDefault(); act(async () => { const name = importPreset(text); close(); applyPreset(name); flash(`« ${name} » importé.`); }); }}>
                    <input className={cl("text")} autoFocus placeholder="Colle ici le préréglage exporté" value={text} onChange={e => setText(e.currentTarget.value)} />
                    <button type="submit" className={cl("btn", "btn-primary", "btn-sm")} disabled={!text.trim()}>Importer</button>
                    <button type="button" className={cl("link")} onClick={close}>Annuler</button>
                </form>
            )}
            {note && <div className={cl("stage-note")}>{note}</div>}
        </div>
    );
}

// ── Fenêtre ─────────────────────────────────────────────────────────────────

/** Éléments où un clic n'attrape pas la fenêtre. */
const INTERACTIVE = "button, input, label, a, textarea, canvas, form, [role=listbox], [role=option], [role=slider], [role=menu], .lc-mp-pad, .lc-mp-scroll, .lc-mp-modal-back";

/** Attraper un fond vide déplace la fenêtre (elle suit la souris tant que le bouton est tenu). */
function useWindowDrag() {
    return (e: ReactPointerEvent<HTMLDivElement>) => {
        const target = e.target as HTMLElement;
        if (e.button !== 0 || target.closest(INTERACTIVE)) return;
        // Clic sur la barre de défilement d'un bloc : on laisse défiler.
        if (e.nativeEvent.offsetX > target.clientWidth || e.nativeEvent.offsetY > target.clientHeight) return;
        const doc = e.currentTarget.ownerDocument;
        const end = () => {
            doc.removeEventListener("pointerup", end, true);
            doc.defaultView?.removeEventListener("blur", end);
            VencordNative.lowMusical.dragEnd();
        };
        doc.addEventListener("pointerup", end, true);
        doc.defaultView?.addEventListener("blur", end);
        VencordNative.lowMusical.dragStart();
    };
}

function StatusPill() {
    const music = useMusical();
    const accounts = Object.values(music.accounts);
    const live = accounts.filter(a => a.state === "in_voice").length;
    const ready = accounts.filter(isActive).length;
    const [tone, text] = live ? ["live", `En diffusion · ${live} compte${live > 1 ? "s" : ""}`]
        : ready ? ["ok", `${ready} compte${ready > 1 ? "s" : ""} connecté${ready > 1 ? "s" : ""}`]
            : ["idle", "Aucun compte"];
    return <span className={cl("pill", `pill-${tone}`)}><span className={cl("pill-dot")} />{text}</span>;
}

/** Fond transparent : on retire le fond de tout ce qui entoure le panneau dans sa fenêtre. */
function useTransparentWindow(ref: React.RefObject<HTMLElement | null>) {
    useEffect(() => {
        const touched: [HTMLElement, string][] = [];
        for (let el = ref.current?.parentElement; el; el = el.parentElement) {
            touched.push([el, el.style.getPropertyValue("background")]);
            el.style.setProperty("background", "transparent", "important");
        }
        return () => touched.forEach(([el, bg]) => el.style.setProperty("background", bg));
    }, []);
}

/** L'animation d'ouverture ne se joue qu'une fois par lancement de Discord. */
let introPlayed = false;

function PanelBody({ onClose }: { onClose(): void; }) {
    useMusical();
    const rootRef = useRef<HTMLDivElement>(null);
    const [intro] = useState(() => {
        const first = !introPlayed;
        introPlayed = true;
        return first;
    });
    useTransparentWindow(rootRef);
    // Mesures du son seulement tant que le panneau est ouvert.
    useEffect(() => {
        wantMeter(true);
        return () => wantMeter(false);
    }, []);
    // Titre de la fenêtre (sert aussi à la retrouver pour l'anti-stream), puis
    // anti-stream réappliqué à chaque ouverture si l'option est active.
    useEffect(() => {
        const doc = rootRef.current?.ownerDocument;
        if (doc) doc.title = "low-musical";
        if (!getPrefs().streamProof) return;
        const timer = setTimeout(() => setStreamProof(true).catch(() => { }), 400);
        return () => clearTimeout(timer);
    }, []);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const onTop = useAlwaysOnTop();
    const startDrag = useWindowDrag();

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
        <div ref={rootRef} className={cl("panel", intro && "panel-intro")} onPointerDown={startDrag}>
            <main className={cl("grid")}>
                <SessionCard act={act} pending={pending} />

                {/* Scène : titre + visualisation du son en direct */}
                <div className={cl("stage")}>
                    <div className={cl("stage-hero")}>
                        <Visualizer />
                        <div className={cl("stage-text")}>
                            <h1 className={cl("title")} aria-label="low-musical">
                                <span className={cl("title-ink", "title-low")}>low</span>
                                <span className={cl("title-dash")} />
                                <span className={cl("title-ink", "title-musical")}>musical</span>
                            </h1>
                            <StatusPill />
                        </div>
                    </div>
                    <PresetBar act={act} />
                    <div className={cl("window-btns")}>
                        <button
                            type="button"
                            className={cl("icon-btn", "icon-btn-glass", onTop && "icon-btn-on")}
                            onClick={() => setAlwaysOnTop(!onTop)}
                            aria-label="Toujours au premier plan"
                            aria-pressed={onTop}
                            title="Toujours au premier plan"
                        ><PinIcon /></button>
                        <button type="button" className={cl("icon-btn", "icon-btn-glass")} onClick={onClose} aria-label="Fermer" title="Fermer (la diffusion continue)"><CloseIcon /></button>
                    </div>
                    {(isOutdated() || error) && (
                        <div className={cl("banner")} onClick={() => setError(null)} title={error ? "Cliquer pour masquer" : undefined}>
                            {isOutdated() ? "Moteur trop ancien : Paramètres → low-musical → Mettre à jour, puis redémarre Discord." : error}
                        </div>
                    )}
                </div>

                <SignalCard act={act} />
                <EqCard />
                <div className={cl("col-space")}>
                    <SpaceCard />
                    <SoundboardCard act={act} />
                </div>
            </main>
        </div>
    );
}

export const MusicalPanel = ErrorBoundary.wrap(PanelBody, { noop: true });
