/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// VoiceJoinLog — enregistrement des arrivées / départs dans le salon vocal où
// tu es, et seulement pendant que tu y es. Gardé d'une session à l'autre
// (300 entrées par salon, 60 salons au plus).

import * as DataStore from "@api/DataStore";
import { ChannelStore, GuildMemberStore, SelectedChannelStore, useEffect, UserStore, useState, VoiceStateStore } from "@webpack/common";

export type Kind = "join" | "leave" | "moveIn" | "moveOut" | "selfJoin" | "selfLeave";

export interface Entry {
    at: number;
    kind: Kind;
    userId: string;
    /** nom affiché au moment de l'entrée (la personne peut quitter le serveur ensuite) */
    name: string;
    username: string;
    /** salon d'où la personne arrive / où elle part (déplacement) */
    other?: string;
    /** à ton arrivée : qui était déjà là */
    present?: { id: string; name: string; }[];
}

const KEY = "voicejoinlog-logs";
const PER_CHANNEL = 300;
const MAX_CHANNELS = 60;

let logs: Record<string, Entry[]> = {};
let loaded = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

export async function loadLogs() {
    if (loaded) return;
    const stored = await DataStore.get<Record<string, Entry[]>>(KEY);
    // Ce qui a été noté avant la fin du chargement passe devant.
    logs = { ...(stored ?? {}), ...logs };
    for (const [id, list] of Object.entries(logs)) if (stored?.[id] && list !== stored[id]) logs[id] = [...list, ...stored[id]].slice(0, PER_CHANNEL);
    loaded = true;
    listeners.forEach(fn => fn());
}

function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        DataStore.set(KEY, logs);
    }, 1500);
}

function add(channelId: string, e: Entry) {
    const list = [e, ...(logs[channelId] ?? [])].slice(0, PER_CHANNEL);
    delete logs[channelId];
    logs[channelId] = list; // le plus récent en dernier : les plus anciens salons partent d'abord
    const ids = Object.keys(logs);
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_CHANNELS))) delete logs[id];
    listeners.forEach(fn => fn());
    save();
}

export function clearChannel(channelId: string) {
    delete logs[channelId];
    listeners.forEach(fn => fn());
    save();
}

export const countFor = (channelId: string) => logs[channelId]?.length ?? 0;

export function useChannelLogs(channelId: string) {
    const [, tick] = useState(0);
    useEffect(() => {
        const fn = () => tick(n => n + 1);
        listeners.add(fn);
        loadLogs();
        return () => { listeners.delete(fn); };
    }, []);
    return logs[channelId] ?? [];
}

// ── Événements vocaux ────────────────────────────────────────────────────────
function who(userId: string, guildId?: string | null) {
    const user = UserStore.getUser(userId);
    const nick = guildId ? GuildMemberStore.getNick(guildId, userId) : null;
    return {
        name: nick ?? (user as any)?.globalName ?? user?.username ?? userId,
        username: user?.username ?? "",
    };
}

const channelName = (id?: string | null) => {
    const c = id ? ChannelStore.getChannel(id) : null;
    return c?.name ? c.name : undefined;
};

interface VoiceState { userId: string; channelId?: string | null; oldChannelId?: string | null; guildId?: string | null; }

export function onVoiceStates({ voiceStates }: { voiceStates?: VoiceState[]; }) {
    if (!Array.isArray(voiceStates)) return;
    const me = UserStore.getCurrentUser()?.id;
    if (!me) return;
    for (const s of voiceStates) {
        const now = s.channelId ?? null, before = s.oldChannelId ?? null;
        if (now === before) continue; // micro, caméra, stream… : pas un mouvement
        if (s.userId === me) {
            if (before) add(before, { at: Date.now(), kind: "selfLeave", userId: me, ...who(me, s.guildId) });
            if (now) {
                const present = Object.keys(VoiceStateStore.getVoiceStatesForChannel(now) ?? {})
                    .filter(id => id !== me)
                    .map(id => ({ id, name: who(id, s.guildId).name }));
                add(now, { at: Date.now(), kind: "selfJoin", userId: me, ...who(me, s.guildId), present });
            }
            continue;
        }
        // Les autres : seulement dans le salon où je suis en ce moment.
        const mine = SelectedChannelStore.getVoiceChannelId();
        if (!mine) continue;
        if (now === mine) add(mine, { at: Date.now(), kind: before ? "moveIn" : "join", userId: s.userId, ...who(s.userId, s.guildId), other: channelName(before) });
        else if (before === mine) add(mine, { at: Date.now(), kind: now ? "moveOut" : "leave", userId: s.userId, ...who(s.userId, s.guildId), other: channelName(now) });
    }
}
