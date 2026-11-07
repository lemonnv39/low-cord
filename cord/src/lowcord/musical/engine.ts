/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-musical — côté Discord : état du moteur (tenu à jour par ses
// événements), réglages mémorisés et commandes. Le moteur tourne dans le
// processus principal (src/main/lowMusical.ts) ; ici, on ne fait que lui parler.

import * as DataStore from "@api/DataStore";
import type { SavedAccount } from "@lowplugins/tokenImporter";
import { findByPropsLazy } from "@webpack";
import { useEffect, useState } from "@webpack/common";

export interface VoiceChannel { id: string; name: string; }
export interface MusicalGuild { id: string; name: string; icon?: string | null; channels: VoiceChannel[]; }

export type EngineState = "connecting" | "connected" | "reconnecting" | "in_voice" | "connected_left" | "error" | "disconnected";

export interface MusicalState {
    /** le moteur est installé (vérifié au démarrage de Discord) */
    installed?: boolean;
    /** le processus du moteur tourne */
    running: boolean;
    state?: EngineState;
    error?: string;
    user?: { id: string; username: string; avatar?: string | null; };
    guilds?: MusicalGuild[];
    current?: { guild: string; channel: string; };
    follow?: string | null;
    presence?: boolean;
    fakeDeafen?: boolean;
    input?: string | null;
    captureError?: string | null;
    /** compte du Token Importer connecté */
    accountId?: string;
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
    accountId?: string;
}

export const DEFAULT_INPUT = "__default__";
export const PREF_DEFAULTS: MusicalPrefs = { gain: 0, bitrate: 128, latency: 200 };
const PREFS_KEY = "lowmusical-prefs";

let state: MusicalState = { running: false };
let prefs: MusicalPrefs = { ...PREF_DEFAULTS };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(fn => fn());

function set(patch: Partial<MusicalState>) {
    state = { ...state, ...patch };
    emit();
}

export const getState = () => state;
export const getPrefs = () => prefs;

/** Message d'erreur lisible (Electron préfixe les erreurs du processus principal). */
export const errorText = (e: unknown) =>
    String((e as any)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

let wired = false;

function wire() {
    if (wired) return;
    wired = true;
    VencordNative.lowMusical.onEvent(msg => {
        if (msg?.event === "status" && msg.data && typeof msg.data === "object") {
            const patch: Partial<MusicalState> = { running: true, ...msg.data };
            // Même règle que le moteur : `current` n'existe qu'en vocal.
            if (typeof msg.data.state === "string" && msg.data.state !== "in_voice" && !("current" in msg.data)) patch.current = undefined;
            if (msg.data.state === "connecting") patch.error = undefined;
            set(patch);
        } else if (msg?.event === "exit") {
            state = { installed: state.installed, running: false, exitReason: String(msg.reason ?? "") };
            emit();
        }
    });
    VencordNative.lowMusical.isInstalled().then(installed => set({ installed })).catch(() => { });
    DataStore.get<Partial<MusicalPrefs>>(PREFS_KEY).then(saved => {
        if (saved && typeof saved === "object") prefs = { ...PREF_DEFAULTS, ...saved };
        emit();
    }).catch(() => { });
    refresh();
}

/** Recale l'état sur le moteur (panneau rouvert, Discord rechargé). */
export async function refresh() {
    try {
        if (!await VencordNative.lowMusical.isRunning()) return set({ running: false });
        const snap = await VencordNative.lowMusical.call("status");
        set({ running: true, ...snap });
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

function savePrefs(patch: Partial<MusicalPrefs>) {
    prefs = { ...prefs, ...patch };
    emit();
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => DataStore.set(PREFS_KEY, prefs).catch(() => { }), 400);
}

const call = <T = any>(cmd: string, args?: Record<string, unknown>) => VencordNative.lowMusical.call<T>(cmd, args);

// ── Identité du client ───────────────────────────────────────────────────────
// Le compte se présente avec la version, le système et la langue du vrai
// Discord. On ne garde QUE ces champs fixes : jamais les identifiants de
// session ou d'installation, qui relieraient le compte à ton compte principal.
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

// ── Commandes ───────────────────────────────────────────────────────────────

export async function connect(account: SavedAccount) {
    if (!account.token) throw new Error("token indisponible sur ce PC");
    set({ accountId: account.id, state: "connecting", error: undefined, exitReason: undefined, user: undefined, guilds: undefined, current: undefined });
    savePrefs({ accountId: account.id });
    await call("connect", { token: account.token, properties: identity() });
    // Réglages mémorisés : appliqués à chaque connexion.
    await Promise.all([
        call("set_gain", { db: prefs.gain }),
        call("set_bitrate", { kbps: prefs.bitrate }),
        call("set_latency", { ms: prefs.latency }),
    ]);
    // La source n'est relancée que si elle a été choisie à la main avant.
    if (prefs.source) await setInput(prefs.source).catch(() => { });
}

export const disconnect = () => call("disconnect");
export const join = (guild: string, channel: string) => call("join", { guild, channel });
export const leave = () => call("leave");
export const devices = () => call<string[]>("devices");

/** Démarre la capture : jamais automatique au premier usage, pour ne pas diffuser un micro par surprise. */
export async function setInput(source: string) {
    const name = source === DEFAULT_INPUT ? null : source;
    await call("set_input", { name });
    savePrefs({ source });
    set({ input: name });
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

export const setFakeDeafen = (on: boolean) => call("set_fake_deafen", { on });
export const setPresence = (on: boolean) => call("set_presence", { on });
export const setFollow = (target: string | null) => call("set_follow", { target });

/** Arrête le moteur : le compte quitte le vocal et se déconnecte. */
export const stopEngine = () => VencordNative.lowMusical.stop();
