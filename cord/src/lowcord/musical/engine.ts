/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-musical — côté Discord : état du moteur (tenu à jour par ses
// événements), réglages mémorisés et commandes. Le moteur tourne dans le
// processus principal (src/main/lowMusical.ts) ; ici, on ne fait que lui parler.
//
// Plusieurs comptes du Token Importer peuvent être connectés en même temps.
// Chacun est identifié auprès du moteur par son id dans le Token Importer.

import * as DataStore from "@api/DataStore";
import type { SavedAccount } from "@lowplugins/tokenImporter";
import { findByPropsLazy } from "@webpack";
import { useEffect, UserStore, useState } from "@webpack/common";

export interface VoiceChannel { id: string; name: string; }
export interface MusicalGuild { id: string; name: string; icon?: string | null; channels: VoiceChannel[]; }

export type EngineState = "connecting" | "connected" | "reconnecting" | "in_voice" | "connected_left" | "error" | "disconnected";

export interface AccountState {
    state?: EngineState;
    error?: string;
    user?: { id: string; username: string; avatar?: string | null; };
    guilds?: MusicalGuild[];
    current?: { guild: string; channel: string; };
    follow?: string | null;
    fakeDeafen?: boolean;
}

export interface MusicalState {
    /** version du moteur installé (null = pas installé), lue au démarrage de Discord */
    installed?: string | null;
    /** le processus du moteur tourne */
    running: boolean;
    /** comptes connus du moteur, par id Token Importer */
    accounts: Record<string, AccountState>;
    input?: string | null;
    /** une source a été lancée depuis ce panneau depuis le démarrage du moteur */
    sourceOn?: boolean;
    captureError?: string | null;
    /** raison du dernier arrêt du moteur */
    exitReason?: string;
    /** les comptes suivent ton compte (bouton « Rejoindre ma vocale ») */
    following?: boolean;
}

/** Réglages gardés d'une session à l'autre et renvoyés au moteur à chaque connexion. */
export interface MusicalPrefs {
    /** DEFAULT_INPUT ou nom d'un périphérique ; absente = rien n'est capté */
    source?: string;
    gain: number;
    /** volume général de sortie, 0 à 2 (100 % = 1) */
    volume: number;
    bitrate: number;
    latency: number;
    /** comptes cochés la dernière fois */
    selection: string[];
    /** délai entre deux comptes (connexion, salon), en ms */
    delay: number;
    /** Espace : 0 off, 1 mouvement auto, 2 position manuelle */
    spaceMode: 0 | 1 | 2;
    /** mouvement auto : 0 orbite, 1 ping-pong, 2 avant / arrière, 3 spirale, 4 chaos */
    motion: 0 | 1 | 2 | 3 | 4;
    /** vitesse du mouvement (tours par seconde) */
    speed: number;
    /** position manuelle : x gauche (−1) → droite (1), y derrière (−1) → devant (1) */
    posX: number;
    posY: number;
    /** distance du mouvement auto [0..1] */
    radius: number;
    /** largeur stéréo gardée de la source [0..1] */
    spread: number;
    /** la pièce (réflexions + réverbe) */
    reverb: boolean;
    /** taille de la pièce et quantité [0..1] */
    room: number;
    mix: number;
    /** 10 bandes, en dB [-12..12] */
    eq: number[];
    eqPreset: string;
    /** préréglage « Perso » enregistré */
    eqCustom?: number[];
    /** coupe-bas en Hz (0 = off) */
    highpass: number;
    /** largeur stéréo (1 = normale, 0 = mono, 2 = très large) */
    width: number;
    /** saturation [0..1] */
    saturation: number;
    compressor: boolean;
    /** intensité du compresseur [0..1] */
    compAmount: number;
    limiter: boolean;
    /** compresseur : 0 Propre, 1 Fort & propre, 2 Punch */
    compMode: 0 | 1 | 2;
    /** porte anti-souffle et son seuil (dB) */
    gate: boolean;
    gateThreshold: number;
    /** nivellement automatique et niveau visé (dB) */
    agc: boolean;
    agcTarget: number;
    /** 0 stéréo, 1 mono, 2 gauche ↔ droite */
    stereoMode: 0 | 1 | 2;
    /** balance −1 (gauche) .. 1 (droite) */
    balance: number;
    /** graves en mono sous cette fréquence (Hz, 0 = off) */
    bassMono: number;
    /** Basses+, Clarté, dé-esseur, écrêteur : 0..1 (0 = off) */
    bassPlus: number;
    clarity: number;
    deesser: number;
    clipper: number;
    multiband: boolean;
    mbAmount: number;
    /** profil de traitement choisi (ou PROFILE_CUSTOM après un réglage à la main) */
    profile: string;
    /** débit calé sur le plafond de ta vocale */
    autoBitrate: boolean;
    /** préréglage low-musical choisi (ou PRESET_CUSTOM après un réglage à la main) */
    preset: string;
    /** tes préréglages enregistrés */
    userPresets: UserPreset[];
    /** fenêtre invisible en partage d'écran */
    streamProof: boolean;
}

export interface UserPreset { name: string; data: Partial<MusicalPrefs>; }

export const DEFAULT_INPUT = "__default__";
/** Plus ancienne version du moteur compatible avec ce panneau. */
export const MIN_ENGINE = "0.8.0";

export const PREF_DEFAULTS: MusicalPrefs = {
    gain: 0, volume: 1, bitrate: 128, latency: 200,
    selection: [], delay: 500,
    spaceMode: 0, motion: 0, speed: 0.15, posX: 0, posY: 0.5, radius: 0.6, spread: 0.3,
    reverb: false, room: 0.5, mix: 0.5,
    eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], eqPreset: "Flat",
    highpass: 0, width: 1, saturation: 0, compressor: false, compAmount: 0.5, limiter: true,
    compMode: 0, gate: false, gateThreshold: -60, agc: false, agcTarget: -16, stereoMode: 0, balance: 0,
    bassMono: 0, bassPlus: 0, clarity: 0, deesser: 0, clipper: 0, multiband: false, mbAmount: 0.5,
    profile: "Naturel", autoBitrate: true,
    preset: "", userPresets: [], streamProof: false,
};

type ProcessingKey =
    "highpass" | "width" | "saturation" | "compressor" | "compMode" | "compAmount" | "limiter" | "gate" | "gateThreshold"
    | "agc" | "agcTarget" | "stereoMode" | "balance" | "bassMono" | "bassPlus" | "clarity" | "deesser" | "clipper"
    | "multiband" | "mbAmount";
export type ProcessingPrefs = Pick<MusicalPrefs, ProcessingKey>;
const PROCESSING_KEYS: ProcessingKey[] = [
    "highpass", "width", "saturation", "compressor", "compMode", "compAmount", "limiter", "gate", "gateThreshold",
    "agc", "agcTarget", "stereoMode", "balance", "bassMono", "bassPlus", "clarity", "deesser", "clipper",
    "multiband", "mbAmount",
];

export const PROFILE_CUSTOM = "Perso";

/**
 * Profils de traitement : un clic règle toute la chaîne « fort et propre ».
 * Les réglages qu'un profil ne cite pas (largeur, balance, coupe-bas…) restent tels quels.
 */
export const PROFILES: Record<string, { desc: string; set: Partial<ProcessingPrefs>; }> = {
    "Naturel": {
        desc: "Le son tel quel, juste protégé",
        set: { agc: false, multiband: false, compressor: true, compMode: 0, compAmount: 0.3, bassMono: 0, bassPlus: 0, clarity: 0, deesser: 0, saturation: 0, clipper: 0, limiter: true },
    },
    "Radio": {
        desc: "Niveau constant, clair, voix en avant",
        set: { agc: true, agcTarget: -16, multiband: true, mbAmount: 0.6, compressor: true, compMode: 1, compAmount: 0.5, bassMono: 120, bassPlus: 0.2, clarity: 0.3, deesser: 0.4, saturation: 0, clipper: 0.3, limiter: true },
    },
    "Club": {
        desc: "Basses puissantes, punch",
        set: { agc: true, agcTarget: -14, multiband: true, mbAmount: 0.5, compressor: true, compMode: 2, compAmount: 0.6, bassMono: 120, bassPlus: 0.6, clarity: 0.2, deesser: 0.3, saturation: 0.1, clipper: 0.4, limiter: true },
    },
    "Ultra fort": {
        desc: "Le plus fort possible, toujours propre",
        set: { agc: true, agcTarget: -12, multiband: true, mbAmount: 1, compressor: true, compMode: 1, compAmount: 1, bassMono: 120, bassPlus: 0.5, clarity: 0.4, deesser: 0.6, saturation: 0.15, clipper: 0.8, limiter: true },
    },
};

export const EQ_LABELS = ["31", "62", "125", "250", "500", "1k", "2k", "4k", "8k", "16k"];
// Courbes douces (les bandes voisines se chevauchent et s'additionnent) : au
// plus +8 dB, avec un léger creux dans les médiums quand on pousse les graves,
// pour garder de la clarté.
export const EQ_PRESETS: Record<string, number[]> = {
    "Flat": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    "Bass boost": [5, 4.5, 3, 1, 0, 0, 0, 0, 0, 0],
    "Méga bass": [8, 7, 5, 2, 0, -1, 0, 0, 0, 0],
    "Aigus boost": [0, 0, 0, 0, 0, 0, 1, 3, 4.5, 5],
    "Voix": [-3, -2, -1, 1, 2, 3, 3, 1.5, 0, -1],
    "Jazz": [3, 2, 1, 1, -1, -1, 0, 1, 2, 2.5],
    "Rap": [5, 4, 2, 0, -1, -1, 1, 1.5, 2, 1.5],
    "Rock": [4, 3, 1, -1, -2, -1, 1, 2.5, 3, 3],
    "Pop": [-1, 0, 1.5, 2.5, 2, 0.5, 0, 1, 1.5, 1],
    "Électro": [5, 4, 1, -1, -2, 0, 1, 2.5, 3.5, 4],
    "Loudness": [5, 3, 0, -1, -1.5, -1, 0, 2, 4, 4],
    "Casque": [2, 1.5, 0.5, 0, -0.5, -1, 0, 1, 1.5, 1],
    "Clarté": [-1, -1, -1, 0, 0, 1, 2, 3, 3, 2],
    "Chill": [3, 2.5, 1.5, 0.5, 0, -0.5, -1, -1.5, -2, -2.5],
};
export const EQ_CUSTOM = "Perso";
const PREFS_KEY = "lowmusical-prefs";

let state: MusicalState = { running: false, accounts: {} };
let prefs: MusicalPrefs = { ...PREF_DEFAULTS };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(fn => fn());

function set(patch: Partial<MusicalState>) {
    state = { ...state, ...patch };
    emit();
}

function setAccount(key: string, patch: Partial<AccountState>) {
    set({ accounts: { ...state.accounts, [key]: { ...state.accounts[key], ...patch } } });
}

export const getState = () => state;
export const getPrefs = () => prefs;

/** Message d'erreur lisible (Electron préfixe les erreurs du processus principal). */
export const errorText = (e: unknown) =>
    String((e as any)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/** a < b, pour des versions « x.y.z ». */
export function olderThan(a: string, b: string) {
    const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
    return false;
}

export const isOutdated = () => !!state.installed && olderThan(state.installed, MIN_ENGINE);

// Comptes « en ligne » : ni arrêtés, ni en erreur.
export const isActive = (a?: AccountState) => !!a?.state && a.state !== "disconnected" && a.state !== "error";
export const isReady = (a?: AccountState) => a?.state === "connected" || a?.state === "connected_left" || a?.state === "in_voice";

// ── Mesures du son (visualisation) ─────────────────────────────────────────
// Gardées hors de React : elles arrivent 20 fois par seconde et sont lues
// directement par l'animation, sans refaire le rendu du panneau.
export interface Meter {
    level: number;
    peak: number;
    bands: number[];
    /** réduction de gain (dB) du compresseur et du limiteur */
    comp: number;
    limit: number;
    /** position de la source dans l'espace (absente quand l'espace est coupé) */
    pos: [number, number] | null;
    at: number;
}
let meter: Meter | null = null;
export const getMeter = () => meter;

let meterWanted = false;

/** Le panneau demande (ou plus) les mesures au moteur. */
export function wantMeter(on: boolean) {
    meterWanted = on;
    if (!on) meter = null;
    if (state.running) call("set_meter", { on }).catch(() => { });
}

let wired = false;

function wire() {
    if (wired) return;
    wired = true;
    VencordNative.lowMusical.onEvent(msg => {
        if (msg?.event === "meter" && Array.isArray(msg.bands)) {
            meter = {
                level: Number(msg.level) || 0, peak: Number(msg.peak) || 0, bands: msg.bands,
                comp: Number(msg.comp) || 0, limit: Number(msg.limit) || 0,
                pos: Array.isArray(msg.pos) && msg.pos.length === 2 ? [Number(msg.pos[0]) || 0, Number(msg.pos[1]) || 0] : null,
                at: performance.now(),
            };
            return;
        }
        if (msg?.event === "status" && msg.data && typeof msg.data === "object") {
            if (typeof msg.account !== "string") {
                set({ running: true, ...msg.data });
                return;
            }
            const patch: Partial<AccountState> = { ...msg.data };
            // Même règle que le moteur : `current` n'existe qu'en vocal.
            if (typeof msg.data.state === "string" && msg.data.state !== "in_voice" && !("current" in msg.data)) patch.current = undefined;
            if (msg.data.state === "connecting") patch.error = undefined;
            state = { ...state, running: true };
            setAccount(msg.account, patch);
        } else if (msg?.event === "exit") {
            state = { installed: state.installed, running: false, accounts: {}, following: false, exitReason: String(msg.reason ?? "") };
            emit();
        }
    });
    VencordNative.lowMusical.installedVersion().then(installed => set({ installed })).catch(() => { });
    DataStore.get<Partial<MusicalPrefs>>(PREFS_KEY).then(saved => {
        if (saved && typeof saved === "object") {
            prefs = { ...PREF_DEFAULTS, ...saved };
            if (!Array.isArray(prefs.eq) || prefs.eq.length !== 10) prefs.eq = [...PREF_DEFAULTS.eq];
            if (!Array.isArray(prefs.selection)) prefs.selection = [];
            if (!Array.isArray(prefs.userPresets)) prefs.userPresets = [];
            // Réglages d'avant les profils : on ne prétend pas qu'ils suivent « Naturel ».
            if (!("profile" in saved)) prefs.profile = PROFILE_CUSTOM;
            // Réglages d'avant l'espace 360° : on reprend ce qui a un équivalent.
            const old = saved as Record<string, unknown>;
            if (!("spaceMode" in saved) && "eightdMode" in old) {
                prefs.spaceMode = old.eightdMode === 1 ? 1 : old.eightdMode === 2 ? 2 : 0;
                if (typeof old.eightdSpeed === "number") prefs.speed = old.eightdSpeed;
                if (typeof old.reverbRoom === "number") prefs.room = old.reverbRoom;
            }
        }
        emit();
    }).catch(() => { });
    refresh();
}

/** Recale l'état sur le moteur (panneau rouvert, Discord rechargé). */
export async function refresh() {
    try {
        if (!await VencordNative.lowMusical.isRunning()) return set({ running: false });
        const { accounts, ...snap } = await VencordNative.lowMusical.call("status");
        set({ running: true, ...snap, accounts: accounts && typeof accounts === "object" ? accounts : {} });
    } catch { }
}

export function useMusical() {
    const [, tick] = useState(0);
    useEffect(() => {
        wire();
        const fn = () => tick(n => n + 1);
        listeners.add(fn);
        return () => { listeners.delete(fn); };
    }, []);
    return state;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function savePrefs(patch: Partial<MusicalPrefs>) {
    // Toucher au son = on n'est plus sur le préréglage choisi.
    if (!("preset" in patch) && Object.keys(patch).some(k => (SOUND_KEYS as readonly string[]).includes(k))) patch = { ...patch, preset: PRESET_CUSTOM };
    prefs = { ...prefs, ...patch };
    emit();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => DataStore.set(PREFS_KEY, prefs).catch(() => { }), 400);
}

const call = <T = any>(cmd: string, args?: Record<string, unknown>) => VencordNative.lowMusical.call<T>(cmd, args);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Identité du client ───────────────────────────────────────────────────────
// Les comptes se présentent avec la version, le système et la langue du vrai
// Discord. On ne garde QUE ces champs fixes : jamais les identifiants de
// session ou d'installation, qui relieraient les comptes à ton compte principal.
const SuperProperties = findByPropsLazy("getSuperProperties", "getSuperPropertiesBase64");
const IDENTITY_KEYS = [
    "os", "browser", "release_channel", "client_version", "os_version", "os_arch", "app_arch",
    "system_locale", "browser_user_agent", "browser_version", "client_build_number", "native_build_number", "client_event_source",
];

function identity(): Record<string, unknown> | undefined {
    try {
        const props = SuperProperties.getSuperProperties();
        const out: Record<string, unknown> = {};
        for (const k of IDENTITY_KEYS) if (k in props) out[k] = props[k];
        return typeof out.client_build_number === "number" ? out : undefined;
    } catch {
        return undefined;
    }
}

// ── Comptes ─────────────────────────────────────────────────────────────────

/** Renvoie au moteur les réglages audio mémorisés (communs à tous les comptes). */
async function applyAudio() {
    await Promise.all([
        call("set_gain", { db: prefs.gain }),
        call("set_volume", { volume: prefs.volume }),
        call("set_bitrate", { kbps: prefs.bitrate }),
        call("set_latency", { ms: prefs.latency }),
        call("set_space", spaceArgs()),
        call("set_eq", { bands: prefs.eq }),
        call("set_processing", processingArgs()),
        call("set_meter", { on: meterWanted }),
    ]);
    // La source n'est relancée que si elle a été choisie à la main avant.
    if (prefs.source && !state.sourceOn) await setInput(prefs.source).catch(() => { });
}

/** Connecte des comptes l'un après l'autre, espacés du délai choisi. */
export async function connectAccounts(accounts: SavedAccount[]) {
    if (isOutdated()) throw new Error("Mets à jour le moteur : Paramètres → low-musical → Mettre à jour.");
    const usable = accounts.filter(a => a.token);
    if (!usable.length) throw new Error("aucun compte utilisable sur ce PC");
    set({ exitReason: undefined });

    let first = true;
    for (const account of usable) {
        if (!first) await sleep(prefs.delay);
        setAccount(account.id, { state: "connecting", error: undefined, user: undefined, guilds: undefined, current: undefined });
        try {
            await call("connect", { account: account.id, token: account.token, properties: identity() });
        } catch (e) {
            setAccount(account.id, { state: "error", error: errorText(e) });
        }
        if (first) await applyAudio();
        first = false;
    }
    // Comptes ajoutés pendant le suivi : ils suivent aussi.
    if (state.following) await followMe(usable.map(a => a.id));
}

export async function disconnect(key?: string) {
    await call("disconnect", key ? { account: key } : {});
    if (!key) return set({ accounts: {}, following: false });
    const { [key]: _, ...rest } = state.accounts;
    set({ accounts: rest });
}

const activeKeys = () => Object.entries(state.accounts).filter(([, a]) => isActive(a)).map(([k]) => k);

/**
 * Les comptes suivent ton compte : ils rejoignent ta vocale tout de suite et
 * te suivent quand tu changes de salon. Chaque compte a son délai (1er : 0,
 * 2e : le délai choisi, 3e : deux fois…), appliqué par le moteur à chaque
 * déplacement. `keys` = seulement ces comptes (ajoutés en cours de route).
 */
export async function followMe(keys?: string[]) {
    const me = UserStore.getCurrentUser()?.id;
    if (!me) throw new Error("compte Discord introuvable");
    const all = activeKeys();
    await Promise.all((keys ?? all).map(key =>
        call("set_follow", { account: key, target: me, delay: Math.max(0, all.indexOf(key)) * prefs.delay })
            .catch(e => setAccount(key, { error: errorText(e) }))
    ));
    set({ following: true });
}

/** Les comptes arrêtent de te suivre et quittent la vocale (ils restent connectés). */
export async function stopFollowing() {
    set({ following: false });
    await call("set_follow", { target: null }).catch(() => { });
    await call("leave").catch(() => { });
}
export const setFakeDeafen = (on: boolean, key?: string) => call("set_fake_deafen", { on, ...(key ? { account: key } : {}) });
export const devices = () => call<string[]>("devices");

// ── Audio ───────────────────────────────────────────────────────────────────

/** Démarre la capture : jamais automatique au premier usage, pour ne pas diffuser un micro par surprise. */
export async function setInput(source: string) {
    const name = source === DEFAULT_INPUT ? null : source;
    await call("set_input", { name });
    savePrefs({ source });
    set({ input: name, sourceOn: true });
}

// Réglages audio : mémorisés tout de suite, envoyés au moteur s'il tourne.
const live = (fn: () => Promise<unknown>) => { if (state.running) fn().catch(() => { }); };

export function setGain(db: number) {
    savePrefs({ gain: db });
    live(() => call("set_gain", { db }));
}

export function setVolume(volume: number) {
    savePrefs({ volume });
    live(() => call("set_volume", { volume }));
}

export function setBitrate(kbps: number) {
    savePrefs({ bitrate: kbps });
    live(() => call("set_bitrate", { kbps }));
}

export function setLatency(ms: number) {
    savePrefs({ latency: ms });
    live(() => call("set_latency", { ms }));
}

type SpaceKey = "spaceMode" | "motion" | "speed" | "posX" | "posY" | "radius" | "spread" | "reverb" | "room" | "mix";

const spaceArgs = () => ({
    mode: prefs.spaceMode, motion: prefs.motion, speed: prefs.speed, x: prefs.posX, y: prefs.posY,
    radius: prefs.radius, spread: prefs.spread, reverb: prefs.reverb, room: prefs.room, mix: prefs.mix,
});

/** Espace : position 360°, mouvement, pièce. */
export function setSpace(patch: Partial<Pick<MusicalPrefs, SpaceKey>>) {
    savePrefs(patch);
    live(() => call("set_space", spaceArgs()));
}

/** Bandes de l'égaliseur ; `preset` = nom affiché (une bande touchée à la main repasse en « Perso »). */
export function setEq(bands: number[], preset: string) {
    savePrefs({ eq: bands, eqPreset: preset });
    live(() => call("set_eq", { bands }));
}

export function applyEqPreset(name: string) {
    const bands = name === EQ_CUSTOM ? prefs.eqCustom : EQ_PRESETS[name];
    if (bands) setEq([...bands], name);
}

/** Enregistre les bandes actuelles comme préréglage « Perso ». */
export function saveEqCustom() {
    savePrefs({ eqCustom: [...prefs.eq], eqPreset: EQ_CUSTOM });
}

const processingArgs = () => Object.fromEntries(PROCESSING_KEYS.map(k => [k, prefs[k]]));

/** Un réglage de traitement touché à la main : le profil passe en « Perso ». */
export function setProcessing(patch: Partial<ProcessingPrefs>) {
    savePrefs({ ...patch, profile: PROFILE_CUSTOM });
    live(() => call("set_processing", processingArgs()));
}

export function applyProfile(name: string) {
    const profile = PROFILES[name];
    if (!profile) return;
    savePrefs({ ...profile.set, profile: name });
    live(() => call("set_processing", processingArgs()));
}

/** Débit calé sur le plafond de ta vocale (kbps), si l'option est active. */
export function syncBitrate(channelBps: number | undefined) {
    if (!prefs.autoBitrate || !channelBps) return;
    const kbps = Math.max(32, Math.min(512, Math.round(channelBps / 1000)));
    if (kbps !== prefs.bitrate) setBitrate(kbps);
}

/** Arrête le moteur : les comptes quittent le vocal et se déconnectent. */
export const stopEngine = () => VencordNative.lowMusical.stop();

// ── Préréglages low-musical ─────────────────────────────────────────────────
// Un préréglage règle TOUT le son d'un coup (comme un set Equalizer APO) :
// gain, chaîne de traitement, égaliseur, espace. Jamais les comptes, le
// volume général, le débit ni la latence.

const SOUND_KEYS = [
    "gain", ...PROCESSING_KEYS, "profile", "eq", "eqPreset",
    "spaceMode", "motion", "speed", "posX", "posY", "radius", "spread", "reverb", "room", "mix",
] as const satisfies readonly (keyof MusicalPrefs)[];

export const PRESET_CUSTOM = "Perso";

const eq = (name: string) => ({ eq: [...EQ_PRESETS[name]], eqPreset: name });
const SPACE_OFF = { spaceMode: 0, reverb: false } as const;

export const PRESETS: Record<string, { desc: string; data: Partial<MusicalPrefs>; }> = {
    "Écoute casque": {
        desc: "Naturel et doux, pour une longue écoute",
        data: { gain: 0, ...PROFILES.Naturel.set, profile: "Naturel", ...eq("Casque"), ...SPACE_OFF },
    },
    "Soirée": {
        desc: "Basses qui tapent, niveau de club",
        data: { gain: 0, ...PROFILES.Club.set, profile: "Club", ...eq("Électro"), ...SPACE_OFF },
    },
    "8D immersif": {
        desc: "Le son tourne autour de ta tête, dans une pièce",
        data: {
            gain: 0, ...PROFILES.Radio.set, profile: "Radio", ...eq("Casque"),
            spaceMode: 1, motion: 0, speed: 0.12, radius: 0.7, spread: 0.2, reverb: true, room: 0.5, mix: 0.35,
        },
    },
    "Radio FM": {
        desc: "Niveau constant, voix claires",
        data: { gain: 0, ...PROFILES.Radio.set, profile: "Radio", ...eq("Voix"), ...SPACE_OFF },
    },
    "Ultra fort": {
        desc: "Le plus fort possible, toujours propre",
        data: { gain: 0, ...PROFILES["Ultra fort"].set, profile: "Ultra fort", ...eq("Loudness"), ...SPACE_OFF },
    },
};

/** Garde seulement les réglages de son valides (préréglage importé, ancien format…). */
function soundOnly(data: Record<string, unknown>): Partial<MusicalPrefs> {
    const out: Record<string, unknown> = {};
    for (const k of SOUND_KEYS) {
        const v = data[k], def = PREF_DEFAULTS[k];
        if (k === "eq") {
            if (Array.isArray(v) && v.length === 10 && v.every(n => typeof n === "number" && Number.isFinite(n))) out.eq = v.map(n => Math.max(-12, Math.min(12, n)));
        } else if (typeof v === typeof def && (typeof v !== "number" || Number.isFinite(v))) {
            out[k] = v;
        }
    }
    return out as Partial<MusicalPrefs>;
}

/** Envoie au moteur tout le son (après un préréglage). */
function sendSound() {
    live(() => call("set_gain", { db: prefs.gain }));
    live(() => call("set_processing", processingArgs()));
    live(() => call("set_eq", { bands: prefs.eq }));
    live(() => call("set_space", spaceArgs()));
}

export function applyPreset(name: string) {
    const data = PRESETS[name]?.data ?? prefs.userPresets.find(p => p.name === name)?.data;
    if (!data) return;
    savePrefs({ ...soundOnly(data as Record<string, unknown>), preset: name });
    sendSound();
}

/** Enregistre le son actuel comme préréglage (remplace celui du même nom). */
export function saveUserPreset(rawName: string) {
    const name = rawName.trim().slice(0, 32);
    if (!name) throw new Error("donne un nom au préréglage");
    if (PRESETS[name]) throw new Error("ce nom est déjà pris par un préréglage intégré");
    const data = Object.fromEntries(SOUND_KEYS.map(k => [k, prefs[k]])) as Partial<MusicalPrefs>;
    const others = prefs.userPresets.filter(p => p.name !== name);
    savePrefs({ userPresets: [...others, { name, data }], preset: name });
}

export function deleteUserPreset(name: string) {
    savePrefs({ userPresets: prefs.userPresets.filter(p => p.name !== name), ...(prefs.preset === name ? { preset: PRESET_CUSTOM } : {}) });
}

const EXPORT_FORMAT = "low-musical-preset";

/** Préréglage au format texte (à partager, à coller ailleurs). */
export function exportPreset(name: string) {
    const data = PRESETS[name]?.data ?? prefs.userPresets.find(p => p.name === name)?.data
        ?? Object.fromEntries(SOUND_KEYS.map(k => [k, prefs[k]]));
    return JSON.stringify({ format: EXPORT_FORMAT, version: 1, name: name || PRESET_CUSTOM, data });
}

/** Ajoute un préréglage collé (texte exporté) ; renvoie son nom. */
export function importPreset(text: string) {
    let parsed: any;
    try {
        parsed = JSON.parse(text.trim());
    } catch {
        throw new Error("ce texte n'est pas un préréglage low-musical");
    }
    if (parsed?.format !== EXPORT_FORMAT || typeof parsed.data !== "object" || !parsed.data) {
        throw new Error("ce texte n'est pas un préréglage low-musical");
    }
    const data = soundOnly(parsed.data);
    if (!Object.keys(data).length) throw new Error("préréglage vide");
    let name = String(parsed.name ?? "Importé").trim().slice(0, 32) || "Importé";
    if (PRESETS[name]) name = `${name} (importé)`;
    const others = prefs.userPresets.filter(p => p.name !== name);
    savePrefs({ userPresets: [...others, { name, data }] });
    return name;
}

// ── Options ─────────────────────────────────────────────────────────────────

/** Fenêtre du panneau invisible en partage d'écran (et dans les captures). */
export function setStreamProof(on: boolean) {
    savePrefs({ streamProof: on });
    return VencordNative.lowMusical.setStreamProof(on);
}
