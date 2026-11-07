/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-musical — côté Discord : état du moteur (tenu à jour par ses
// événements) et commandes. Le moteur tourne dans le processus principal
// (src/main/lowMusical.ts) ; ici, on ne fait que lui parler.

import type { SavedAccount } from "@lowplugins/tokenImporter";
import { findByPropsLazy } from "@webpack";
import { useEffect, useState } from "@webpack/common";

export interface VoiceChannel { id: string; name: string; }
export interface MusicalGuild { id: string; name: string; icon?: string | null; channels: VoiceChannel[]; }

export type EngineState = "connecting" | "connected" | "reconnecting" | "in_voice" | "connected_left" | "error" | "disconnected";

export interface MusicalState {
    /** le processus du moteur tourne */
    running: boolean;
    state?: EngineState;
    error?: string;
    user?: { id: string; username: string; avatar?: string | null; };
    guilds?: MusicalGuild[];
    current?: { guild: string; channel: string; };
    input?: string | null;
    /** source choisie ici : DEFAULT_INPUT ou nom d'un périphérique ; absente = rien n'est capté */
    source?: string;
    captureError?: string | null;
    /** compte du Token Importer connecté */
    accountId?: string;
    /** raison du dernier arrêt du moteur */
    exitReason?: string;
}

let state: MusicalState = { running: false };
const listeners = new Set<() => void>();

function set(patch: Partial<MusicalState>) {
    state = { ...state, ...patch };
    listeners.forEach(fn => fn());
}

export const getState = () => state;

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
            state = { running: false, exitReason: String(msg.reason ?? "") };
            listeners.forEach(fn => fn());
        }
    });
    refresh();
}

/** Recale l'état sur le moteur (panneau rouvert, Discord rechargé). */
export async function refresh() {
    try {
        if (!await VencordNative.lowMusical.isRunning()) return set({ running: false });
        const snap = await VencordNative.lowMusical.call("status");
        set({ running: true, ...snap, source: state.source ?? (typeof snap.input === "string" ? snap.input : undefined) });
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
    await call("connect", { token: account.token, properties: identity() });
}

export const disconnect = () => call("disconnect");
export const join = (guild: string, channel: string) => call("join", { guild, channel });
export const leave = () => call("leave");
export const devices = () => call<string[]>("devices");

export const DEFAULT_INPUT = "__default__";

/** Démarre la capture : jamais automatique, pour ne pas diffuser un micro par surprise. */
export async function setInput(source: string) {
    const name = source === DEFAULT_INPUT ? null : source;
    await call("set_input", { name });
    set({ input: name, source });
}

/** Arrête le moteur : le compte quitte le vocal et se déconnecte. */
export const stopEngine = () => VencordNative.lowMusical.stop();
