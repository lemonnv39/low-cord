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
import { useEffect, useState } from "@webpack/common";

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
    presence?: boolean;
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
}

/** Réglages gardés d'une session à l'autre et renvoyés au moteur à chaque connexion. */
export interface MusicalPrefs {
    /** DEFAULT_INPUT ou nom d'un périphérique ; absente = rien n'est capté */
    source?: string;
    gain: number;
    bitrate: number;
    latency: number;
    /** comptes cochés la dernière fois */
    selection: string[];
    /** délai entre deux comptes (connexion, salon), en ms */
    delay: number;
    /** 8D : 0 off, 1 auto (rotation), 2 manuel */
    eightdMode: 0 | 1 | 2;
    /** vitesse de rotation (Hz) */
    eightdSpeed: number;
    /** position gauche → droite [0..1] */
    eightdPos: number;
    reverb: boolean;
    /** taille de la salle [0..1] */
    reverbRoom: number;
    /** distance (dosage réverbéré) [0..1] */
    reverbDistance: number;
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
}

export const DEFAULT_INPUT = "__default__";
/** Plus ancienne version du moteur compatible avec ce panneau. */
export const MIN_ENGINE = "0.3.0";

export const PREF_DEFAULTS: MusicalPrefs = {
    gain: 0, bitrate: 128, latency: 200,
    selection: [], delay: 500,
    eightdMode: 0, eightdSpeed: 0.15, eightdPos: 0.5,
    reverb: false, reverbRoom: 0.5, reverbDistance: 0.4,
    eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], eqPreset: "Flat",
    highpass: 0, width: 1, saturation: 0, compressor: false, compAmount: 0.5, limiter: false,
};

export const EQ_LABELS = ["31", "62", "125", "250", "500", "1k", "2k", "4k", "8k", "16k"];
export const EQ_PRESETS: Record<string, number[]> = {
    "Flat": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    "Bass boost": [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
    "Méga bass": [10, 9, 7, 4, 1, 0, 0, 0, 0, 0],
    "Aigus boost": [0, 0, 0, 0, 0, 2, 4, 6, 7, 8],
    "Voix": [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1],
    "Jazz": [3, 2, 1, 2, -1, -1, 0, 1, 2, 3],
    "Rap": [5, 4, 2, 1, -1, -1, 1, 2, 3, 2],
    "Rock": [4, 3, 1, -1, -2, 0, 2, 3, 4, 4],
    "Pop": [-1, 0, 2, 3, 3, 1, 0, -1, -1, -1],
    "Électro": [4, 3, 0, -1, -2, 1, 1, 3, 4, 5],
    "Loudness": [6, 4, 0, 0, -1, 0, 2, 4, 6, 3],
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

let wired = false;

function wire() {
    if (wired) return;
    wired = true;
    VencordNative.lowMusical.onEvent(msg => {
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
            state = { installed: state.installed, running: false, accounts: {}, exitReason: String(msg.reason ?? "") };
            emit();
        }
    });
    VencordNative.lowMusical.installedVersion().then(installed => set({ installed })).catch(() => { });
    DataStore.get<Partial<MusicalPrefs>>(PREFS_KEY).then(saved => {
        if (saved && typeof saved === "object") {
            prefs = { ...PREF_DEFAULTS, ...saved };
            if (!Array.isArray(prefs.eq) || prefs.eq.length !== 10) prefs.eq = [...PREF_DEFAULTS.eq];
            if (!Array.isArray(prefs.selection)) prefs.selection = [];
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
        call("set_bitrate", { kbps: prefs.bitrate }),
        call("set_latency", { ms: prefs.latency }),
        call("set_8d", { mode: prefs.eightdMode, speed: prefs.eightdSpeed, position: prefs.eightdPos }),
        call("set_reverb", { on: prefs.reverb }),
        call("set_reverb_params", { room: prefs.reverbRoom, distance: prefs.reverbDistance }),
        call("set_eq", { bands: prefs.eq }),
        call("set_processing", processingArgs()),
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
}

export async function disconnect(key?: string) {
    await call("disconnect", key ? { account: key } : {});
    if (!key) return set({ accounts: {} });
    const { [key]: _, ...rest } = state.accounts;
    set({ accounts: rest });
}

const readyKeys = () => Object.entries(state.accounts).filter(([, a]) => isReady(a)).map(([k]) => k);

/** Fait rejoindre le salon à tous les comptes prêts, espacés du délai choisi. */
export async function joinAll(guild: string, channel: string) {
    let first = true;
    for (const key of readyKeys()) {
        if (!first) await sleep(prefs.delay);
        first = false;
        await call("join", { account: key, guild, channel }).catch(e => setAccount(key, { error: errorText(e) }));
    }
}

export const leave = (key?: string) => call("leave", key ? { account: key } : {});
export const setFakeDeafen = (on: boolean, key?: string) => call("set_fake_deafen", { on, ...(key ? { account: key } : {}) });
export const setPresence = (on: boolean) => call("set_presence", { on });
export const setFollow = (target: string | null) => call("set_follow", { target });
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

export function setBitrate(kbps: number) {
    savePrefs({ bitrate: kbps });
    live(() => call("set_bitrate", { kbps }));
}

export function setLatency(ms: number) {
    savePrefs({ latency: ms });
    live(() => call("set_latency", { ms }));
}

export function set8d(patch: Partial<Pick<MusicalPrefs, "eightdMode" | "eightdSpeed" | "eightdPos">>) {
    savePrefs(patch);
    live(() => call("set_8d", { mode: prefs.eightdMode, speed: prefs.eightdSpeed, position: prefs.eightdPos }));
}

export function setReverb(on: boolean) {
    savePrefs({ reverb: on });
    live(() => call("set_reverb", { on }));
}

export function setReverbParams(patch: Partial<Pick<MusicalPrefs, "reverbRoom" | "reverbDistance">>) {
    savePrefs(patch);
    live(() => call("set_reverb_params", { room: prefs.reverbRoom, distance: prefs.reverbDistance }));
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

type ProcessingPrefs = Pick<MusicalPrefs, "highpass" | "width" | "saturation" | "compressor" | "compAmount" | "limiter">;

const processingArgs = () => ({
    highpass: prefs.highpass, width: prefs.width, saturation: prefs.saturation,
    compressor: prefs.compressor, compAmount: prefs.compAmount, limiter: prefs.limiter,
});

/** Coupe-bas, largeur stéréo, saturation, compresseur, limiteur. */
export function setProcessing(patch: Partial<ProcessingPrefs>) {
    savePrefs(patch);
    live(() => call("set_processing", processingArgs()));
}

/** Arrête le moteur : les comptes quittent le vocal et se déconnectent. */
export const stopEngine = () => VencordNative.lowMusical.stop();
