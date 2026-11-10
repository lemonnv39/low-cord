/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// PingFilter — réglage des notifications de tous les serveurs d'un coup.
//
// Pour chaque serveur visé, en un seul envoi : on repart de la base (serveur
// démuté, réglages par salon effacés, notifications d'origine), puis on pose
// le choix fait dans les réglages du plugin. Discord le fait lui-même avec
// PATCH /users/@me/guilds/settings { guilds: { id: réglages } } : on envoie
// les serveurs par paquets de 10, en attendant si Discord demande de ralentir.
//
// Avant d'appliquer, l'état de chaque serveur est sauvegardé : « Annuler »
// remet tout comme avant.

import * as DataStore from "@api/DataStore";
import { GuildStore, RestAPI, UserGuildSettingsStore } from "@webpack/common";

// Valeurs de Discord pour message_notifications.
const ALL_MESSAGES = 0, ONLY_MENTIONS = 1, NO_MESSAGES = 2, SERVER_DEFAULT = 3;

export type Profile = "mentions" | "mentionsEveryone" | "none" | "all" | "default";

export interface Options {
    profile: Profile;
    /** les mentions de mes rôles comptent comme une mention de moi */
    includeRoles: boolean;
    /** serveurs en sourdine (plus de non-lus) */
    muteServers: boolean;
    /** notifications sur téléphone */
    mobilePush: boolean;
    /** couper les « temps forts » (messages populaires) */
    noHighlights: boolean;
    /** serveurs laissés tels quels */
    excluded: string[];
}

interface ChannelState { muted?: boolean; mute_config?: unknown; message_notifications?: number; }

export interface GuildState {
    muted: boolean;
    mute_config: unknown;
    message_notifications: number;
    suppress_everyone: boolean;
    suppress_roles: boolean;
    mobile_push: boolean;
    notify_highlights: number;
    mute_scheduled_events: boolean;
    channel_overrides: Record<string, ChannelState>;
}

/** Les réglages Discord qu'on envoie pour un serveur, d'après le choix. */
export function payloadFor(guildId: string, o: Options) {
    const p = o.profile;
    const body: Record<string, unknown> = {
        // 1. la base : démuté (ou en sourdine si demandé), comme à l'origine
        muted: o.muteServers,
        mute_config: o.muteServers ? { selected_time_window: -1, end_time: null } : null,
        mobile_push: o.mobilePush,
        notify_highlights: o.noHighlights ? 1 : 0,
        mute_scheduled_events: p === "none",
        // 2. le choix
        message_notifications: p === "all" ? ALL_MESSAGES : p === "none" ? NO_MESSAGES : p === "default" ? SERVER_DEFAULT : ONLY_MENTIONS,
        suppress_everyone: p === "mentions" || p === "none",
        suppress_roles: p === "none" || ((p === "mentions" || p === "mentionsEveryone") && !o.includeRoles),
    };
    // Réglages par salon remis à zéro : démutés, notifications « comme le serveur ».
    const overrides = UserGuildSettingsStore.getChannelOverrides(guildId) ?? {};
    const reset: Record<string, ChannelState> = {};
    for (const channelId of Object.keys(overrides)) reset[channelId] = { muted: false, mute_config: null, message_notifications: SERVER_DEFAULT };
    if (Object.keys(reset).length) body.channel_overrides = reset;
    return { body, resetChannels: Object.keys(reset).length };
}

/** État actuel d'un serveur (pour pouvoir annuler). */
function snapshotOf(guildId: string): GuildState {
    const s = UserGuildSettingsStore;
    const overrides: Record<string, ChannelState> = {};
    for (const [id, ov] of Object.entries(s.getChannelOverrides(guildId) ?? {}) as [string, any][]) {
        overrides[id] = { muted: !!ov?.muted, mute_config: ov?.mute_config ?? null, message_notifications: ov?.message_notifications ?? SERVER_DEFAULT };
    }
    return {
        muted: s.isMuted(guildId),
        mute_config: s.getMuteConfig(guildId) ?? null,
        message_notifications: s.getMessageNotifications(guildId) ?? SERVER_DEFAULT,
        suppress_everyone: !!(s as any).isSuppressEveryoneEnabled(guildId),
        suppress_roles: !!(s as any).isSuppressRolesEnabled(guildId),
        mobile_push: !!(s as any).isMobilePushEnabled(guildId),
        notify_highlights: Number(s.getNotifyHighlights(guildId) ?? 0),
        mute_scheduled_events: !!(s as any).isMuteScheduledEventsEnabled(guildId),
        channel_overrides: overrides,
    };
}

export interface GuildInfo { id: string; name: string; icon: string | null; }

export function allGuilds(): GuildInfo[] {
    return (Object.values(GuildStore.getGuilds() ?? {}) as any[])
        .map(g => ({ id: g.id, name: g.name, icon: g.icon ?? null }))
        .sort((a, b) => a.name.localeCompare(b.name, "fr"));
}

// ── Envoi ────────────────────────────────────────────────────────────────────
const CHUNK = 10;
const PAUSE = 350;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Envoie, en attendant puis réessayant si Discord demande de ralentir (429). */
async function send(guilds: Record<string, unknown>, signal: { stopped: boolean; }) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await RestAPI.patch({ url: "/users/@me/guilds/settings", body: { guilds } });
        } catch (e: any) {
            const retry = e?.status === 429 ? Number(e?.body?.retry_after ?? 1) : null;
            if (retry == null || attempt >= 4 || signal.stopped) throw e;
            await sleep(Math.min(30, retry) * 1000 + 250);
        }
    }
}

const errorText = (e: any) => e?.body?.message ?? e?.message ?? (e?.status ? `HTTP ${e.status}` : String(e));

export interface Progress {
    done: number;
    total: number;
    current: string;
    waiting?: boolean;
}

export interface RunResult {
    ok: string[];
    failed: { id: string; name: string; error: string; }[];
    stopped: boolean;
    resetChannels: number;
}

/**
 * Applique `bodies` (id → réglages) par paquets. Un paquet refusé est
 * renvoyé serveur par serveur pour isoler celui qui pose problème.
 */
async function runBodies(bodies: Map<string, Record<string, unknown>>, onProgress: (p: Progress) => void, signal: { stopped: boolean; }) {
    const ids = [...bodies.keys()];
    const result: RunResult = { ok: [], failed: [], stopped: false, resetChannels: 0 };
    const name = (id: string) => GuildStore.getGuild(id)?.name ?? id;
    for (let i = 0; i < ids.length; i += CHUNK) {
        if (signal.stopped) { result.stopped = true; break; }
        const chunk = ids.slice(i, i + CHUNK);
        onProgress({ done: i, total: ids.length, current: chunk.map(name).join(", ") });
        try {
            await send(Object.fromEntries(chunk.map(id => [id, bodies.get(id)])), signal);
            result.ok.push(...chunk);
        } catch {
            for (const id of chunk) {
                if (signal.stopped) break;
                try {
                    await send({ [id]: bodies.get(id) }, signal);
                    result.ok.push(id);
                } catch (e) {
                    result.failed.push({ id, name: name(id), error: errorText(e) });
                }
            }
        }
        onProgress({ done: Math.min(i + CHUNK, ids.length), total: ids.length, current: "" });
        if (i + CHUNK < ids.length) await sleep(PAUSE);
    }
    return result;
}

const BACKUP_KEY = "pingfilter-backup";

export interface Backup { at: number; guilds: Record<string, GuildState>; }

export const getBackup = () => DataStore.get<Backup>(BACKUP_KEY);

/** Sauvegarde, puis applique le choix à tous les serveurs visés. */
export async function applyToAll(o: Options, onProgress: (p: Progress) => void, signal: { stopped: boolean; }) {
    const targets = allGuilds().filter(g => !o.excluded.includes(g.id));
    const backup: Backup = { at: Date.now(), guilds: {} };
    const bodies = new Map<string, Record<string, unknown>>();
    let resetChannels = 0;
    for (const g of targets) {
        backup.guilds[g.id] = snapshotOf(g.id);
        const { body, resetChannels: n } = payloadFor(g.id, o);
        bodies.set(g.id, body);
        resetChannels += n;
    }
    await DataStore.set(BACKUP_KEY, backup);
    const result = await runBodies(bodies, onProgress, signal);
    result.resetChannels = resetChannels;
    // « Annuler » ne remet que les serveurs vraiment modifiés.
    const kept: Record<string, GuildState> = {};
    for (const id of result.ok) kept[id] = backup.guilds[id];
    await DataStore.set(BACKUP_KEY, { at: backup.at, guilds: kept });
    return result;
}

/** Remet chaque serveur comme avant la dernière application. */
export async function restoreBackup(onProgress: (p: Progress) => void, signal: { stopped: boolean; }) {
    const backup = await getBackup();
    if (!backup) throw new Error("aucune sauvegarde");
    const bodies = new Map<string, Record<string, unknown>>();
    for (const [id, st] of Object.entries(backup.guilds)) {
        if (!GuildStore.getGuild(id)) continue; // serveur quitté depuis
        bodies.set(id, { ...st, channel_overrides: Object.keys(st.channel_overrides).length ? st.channel_overrides : undefined });
    }
    const result = await runBodies(bodies, onProgress, signal);
    if (!result.stopped && !result.failed.length) await DataStore.del(BACKUP_KEY);
    return result;
}
