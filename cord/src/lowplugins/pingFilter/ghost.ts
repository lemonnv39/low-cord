/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// PingFilter — détecteur de ghost pings : un message qui te mentionne (toi,
// un de tes rôles, @everyone / @here) est retenu 15 minutes ; s'il est
// supprimé, ou modifié pour retirer la mention, c'est un ghost ping.
//
// Deux façons de le voir :
//  - l'événement de suppression / modification, quand Discord l'envoie ;
//  - une vérification à 45 s, 4 min et 14 min : on redemande le message à
//    Discord. Sur les gros serveurs, Discord n'envoie les suppressions que
//    pour les salons ouverts à l'écran : sans ça, le ghost ping d'un salon
//    que tu ne regardes pas passerait inaperçu.

import { ChannelStore, FluxDispatcher, GuildMemberStore, GuildStore, RestAPI, UserStore } from "@webpack/common";

import { addGhost, GhostLog } from "./logs";

const KEEP = 15 * 60_000;
const MAX = 800;
/** Vérifications du message après la mention. */
const CHECKS = [45_000, 4 * 60_000, 14 * 60_000];

interface Seen {
    at: number;
    target: GhostLog["target"];
    authorId: string;
    author: string;
    channelId: string;
    guildId?: string;
    content: string;
}

const recent = new Map<string, Seen>();
const timers = new Map<string, ReturnType<typeof setTimeout>[]>();
let onGhost: ((g: GhostLog) => void) | null = null;
let enabled: () => boolean = () => false;

/** Ce message mentionne-t-il l'utilisateur ? (toi, un de tes rôles, @everyone / @here) */
function mentionOf(msg: any, me: string, guildId?: string): GhostLog["target"] | null {
    if (msg?.mentions?.some((u: any) => (u?.id ?? u) === me)) return "me";
    if (msg?.mention_everyone) return "everyone";
    const roles: string[] = msg?.mention_roles ?? [];
    if (roles.length && guildId) {
        const mine = GuildMemberStore.getMember(guildId, me)?.roles ?? [];
        if (roles.some(r => mine.includes(r))) return "role";
    }
    return null;
}

function prune() {
    const now = Date.now();
    for (const [id, s] of recent) if (now - s.at > KEEP) forget(id);
    while (recent.size > MAX) forget(recent.keys().next().value!);
}

function forget(id: string) {
    recent.delete(id);
    for (const tm of timers.get(id) ?? []) clearTimeout(tm);
    timers.delete(id);
}

/** Redemande le message à Discord : disparu → supprimé ; sans la mention → modifié. */
async function check(id: string) {
    const seen = recent.get(id);
    if (!seen || !enabled()) return;
    let found: any;
    try {
        const res: any = await RestAPI.get({ url: `/channels/${seen.channelId}/messages`, query: { around: id, limit: 1 } });
        found = (Array.isArray(res?.body) ? res.body : []).find((m: any) => m?.id === id);
    } catch {
        return; // salon plus accessible, réseau… : on ne conclut rien
    }
    if (!recent.has(id)) return; // déjà signalé entre-temps
    if (!found) {
        forget(id);
        report(seen, "delete");
        return;
    }
    const me = UserStore.getCurrentUser()?.id;
    if (me && !mentionOf(found, me, seen.guildId)) {
        forget(id);
        report(seen, "edit");
    }
}

function report(seen: Seen, kind: GhostLog["kind"]) {
    const channel = ChannelStore.getChannel(seen.channelId);
    const g: GhostLog = {
        at: Date.now(),
        kind,
        authorId: seen.authorId,
        author: seen.author,
        guildId: seen.guildId,
        guild: seen.guildId ? GuildStore.getGuild(seen.guildId)?.name : undefined,
        channelId: seen.channelId,
        channel: channel?.name ? `#${channel.name}` : "messages privés",
        content: seen.content.slice(0, 300),
        target: seen.target,
    };
    addGhost(g);
    onGhost?.(g);
}

function onCreate({ message, optimistic }: { message: any; optimistic?: boolean; }) {
    const me = UserStore.getCurrentUser()?.id;
    if (!enabled() || optimistic || !message?.id || !me || message.author?.id === me) return;
    const guildId = message.guild_id ?? ChannelStore.getChannel(message.channel_id)?.guild_id ?? undefined;
    const target = mentionOf(message, me, guildId);
    if (!target) return;
    recent.set(message.id, {
        at: Date.now(),
        target,
        authorId: message.author?.id ?? "",
        author: message.author?.global_name ?? message.author?.username ?? "?",
        channelId: message.channel_id,
        guildId,
        content: String(message.content ?? ""),
    });
    timers.set(message.id, CHECKS.map(ms => setTimeout(() => check(message.id), ms)));
    prune();
}

function onDelete({ id }: { id: string; }) {
    const seen = recent.get(id);
    if (!seen) return;
    forget(id);
    report(seen, "delete");
}

function onDeleteBulk({ ids }: { ids: string[]; }) {
    for (const id of ids ?? []) onDelete({ id });
}

function onUpdate({ message }: { message: any; }) {
    const seen = recent.get(message?.id);
    // Une modification sans contenu (aperçu de lien…) ne compte pas.
    if (!seen || message.content == null) return;
    const me = UserStore.getCurrentUser()?.id;
    if (!me || mentionOf(message, me, seen.guildId)) return;
    forget(message.id);
    report(seen, "edit");
}

/** `isOn` : interrupteur du détecteur (désactivé, rien n'est retenu ni enregistré). */
export function startGhostWatch(isOn: () => boolean, notify: (g: GhostLog) => void) {
    enabled = isOn;
    onGhost = notify;
    FluxDispatcher.subscribe("MESSAGE_CREATE", onCreate);
    FluxDispatcher.subscribe("MESSAGE_DELETE", onDelete);
    FluxDispatcher.subscribe("MESSAGE_DELETE_BULK", onDeleteBulk);
    FluxDispatcher.subscribe("MESSAGE_UPDATE", onUpdate);
}

export function stopGhostWatch() {
    FluxDispatcher.unsubscribe("MESSAGE_CREATE", onCreate);
    FluxDispatcher.unsubscribe("MESSAGE_DELETE", onDelete);
    FluxDispatcher.unsubscribe("MESSAGE_DELETE_BULK", onDeleteBulk);
    FluxDispatcher.unsubscribe("MESSAGE_UPDATE", onUpdate);
    for (const id of [...recent.keys()]) forget(id);
    onGhost = null;
}
