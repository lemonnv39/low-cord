/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// PingFilter — détecteur de ghost pings : un message qui te mentionne (toi,
// un de tes rôles, @everyone / @here) est retenu une heure ; s'il est
// supprimé, ou modifié pour retirer la mention, c'est un ghost ping. Un
// message privé supprimé dans les 5 minutes compte aussi (option).
//
// Quatre façons de le voir, pour ne rien rater :
//  - l'événement de suppression / modification, quand Discord l'envoie ;
//  - l'ouverture du salon : si le message n'est pas dans ce que Discord vient
//    de charger, il a été supprimé (repéré tout de suite, sans rien demander) ;
//  - des vérifications espacées (5 s, 20 s, 1 min, 4 min, 14 min, 45 min) : on
//    redemande le message à Discord. Sur les gros serveurs, Discord n'envoie
//    les suppressions que pour les salons ouverts à l'écran ;
//  - au démarrage : les mentions encore en attente à la fermeture de Discord
//    sont revérifiées (elles sont gardées sur le disque).

import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";
import { ChannelStore, FluxDispatcher, GuildMemberStore, GuildStore, RestAPI, UserStore } from "@webpack/common";

import { addGhost, GhostLog } from "./logs";

const logger = new Logger("PingFilter");

/** Durée pendant laquelle une mention est surveillée. */
const KEEP = 60 * 60_000;
/** Un message privé (sans mention) supprimé après ce délai n'est pas un ghost ping. */
const DM_WINDOW = 5 * 60_000;
/** Mention en attente à la fermeture de Discord : revérifiée au démarrage si elle a moins de 24 h. */
const KEEP_OFFLINE = 24 * 60 * 60_000;
const MAX = 800;
/** Vérifications après une mention qui te vise ; moins nombreuses pour @everyone / un rôle. */
const CHECKS_ME = [5_000, 20_000, 60_000, 4 * 60_000, 14 * 60_000, 45 * 60_000];
const CHECKS_GROUP = [20_000, 4 * 60_000, 14 * 60_000];
/** Pause entre deux demandes à Discord. */
const REQUEST_GAP = 700;
const PENDING_KEY = "pingfilter-pending";

interface Seen {
    id: string;
    at: number;
    target: GhostLog["target"];
    authorId: string;
    author: string;
    channelId: string;
    guildId?: string;
    content: string;
}

export interface GhostOptions {
    /** interrupteur du détecteur (désactivé, rien n'est retenu ni enregistré) */
    on(): boolean;
    /** compter aussi les messages privés supprimés aussitôt envoyés */
    dms(): boolean;
    notify(g: GhostLog): void;
}

const recent = new Map<string, Seen>();
const timers = new Map<string, ReturnType<typeof setTimeout>[]>();
/** Salons où Discord refuse la lecture de l'historique : inutile de redemander. */
const unreadable = new Set<string>();
let options: GhostOptions | null = null;

const enabled = () => !!options?.on();
const compareIds = (a: string, b: string) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Ce message mentionne-t-il l'utilisateur ? (toi, un de tes rôles, @everyone / @here) */
function mentionOf(msg: any, me: string, guildId?: string): GhostLog["target"] | null {
    if (msg?.mentions?.some((u: any) => (u?.id ?? u) === me)) return "me";
    if (msg?.mention_everyone ?? msg?.mentionEveryone) return "everyone";
    const roles: string[] = msg?.mention_roles ?? msg?.mentionRoles ?? [];
    if (roles.length && guildId) {
        const mine = GuildMemberStore.getMember(guildId, me)?.roles ?? [];
        if (roles.some(r => mine.includes(r))) return "role";
    }
    return null;
}

// ── Mentions en attente, gardées sur le disque ───────────────────────────────
let saveTimer: ReturnType<typeof setTimeout> | null = null;

const writePending = () => DataStore.set(PENDING_KEY, [...recent.values()]).catch(e => logger.error("Mentions en attente non enregistrées", e));

function save() {
    saveTimer ??= setTimeout(() => {
        saveTimer = null;
        void writePending();
    }, 500);
}

function forget(id: string) {
    if (recent.delete(id)) save();
    for (const tm of timers.get(id) ?? []) clearTimeout(tm);
    timers.delete(id);
}

const lifetime = (s: Seen) => (s.target === "dm" ? DM_WINDOW : KEEP);

function prune() {
    const now = Date.now();
    for (const [id, s] of recent) if (now - s.at > lifetime(s)) forget(id);
    while (recent.size > MAX) forget(recent.keys().next().value!);
}

/** Retient une mention et programme ses vérifications (celles qui restent à venir). */
function track(seen: Seen) {
    // MP : Discord envoie toujours la suppression, rien à redemander.
    const checks = seen.target === "dm" ? [] : seen.target === "me" ? CHECKS_ME : CHECKS_GROUP;
    const age = Date.now() - seen.at;
    recent.set(seen.id, seen);
    timers.set(seen.id, checks.filter(ms => ms > age).map(ms => setTimeout(() => queueCheck(seen.id), ms - age)));
    save();
    prune();
}

// ── Signalement ──────────────────────────────────────────────────────────────
function report(seen: Seen, kind: GhostLog["kind"]) {
    forget(seen.id);
    // MP supprimé longtemps après : simple ménage, pas un ghost ping.
    if (seen.target === "dm" && Date.now() - seen.at > DM_WINDOW) return;
    const channel = ChannelStore.getChannel(seen.channelId);
    const g: GhostLog = {
        at: Date.now(),
        messageId: seen.id,
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
    const { notify } = options ?? {};
    // Déjà noté (Discord fermé juste après un signalement) : pas de doublon.
    void addGhost(g).then(added => { if (added) notify?.(g); });
}

// ── Vérifications auprès de Discord, une à la fois ───────────────────────────
const queue: string[] = [];
let working = false;

function queueCheck(id: string) {
    if (!recent.has(id) || queue.includes(id)) return;
    queue.push(id);
    if (!working) void work();
}

async function work() {
    working = true;
    try {
        while (queue.length) {
            await check(queue.shift()!);
            await sleep(REQUEST_GAP);
        }
    } finally {
        working = false;
    }
}

/** Redemande le message à Discord : disparu → supprimé ; sans la mention → modifié. */
async function check(id: string) {
    const seen = recent.get(id);
    if (!seen || !enabled() || unreadable.has(seen.channelId)) return;
    let found: any;
    for (let attempt = 0; ; attempt++) {
        try {
            const res: any = await RestAPI.get({ url: `/channels/${seen.channelId}/messages`, query: { around: id, limit: 1 } });
            found = (Array.isArray(res?.body) ? res.body : []).find((m: any) => m?.id === id);
            break;
        } catch (e: any) {
            // Discord demande de ralentir : on attend ce qu'il indique, puis on redemande.
            if (e?.status === 429 && attempt < 2) {
                await sleep(Math.ceil((e?.body?.retry_after ?? 2) * 1000) + 300);
                continue;
            }
            // Pas le droit de lire l'historique de ce salon : seuls les événements comptent.
            if (e?.status === 403 || e?.status === 404) unreadable.add(seen.channelId);
            return; // sinon réseau… : la prochaine vérification tranchera
        }
    }
    if (!recent.has(id)) return; // déjà signalé entre-temps
    if (!found) return report(seen, "delete");
    const me = UserStore.getCurrentUser()?.id;
    if (seen.target !== "dm" && me && !mentionOf(found, me, seen.guildId)) return report(seen, "edit");
    if (Date.now() - seen.at > KEEP) forget(id);
}

// ── Événements de Discord ────────────────────────────────────────────────────
function onCreate({ message, optimistic }: { message: any; optimistic?: boolean; }) {
    const me = UserStore.getCurrentUser()?.id;
    if (!enabled() || optimistic || !message?.id || !me || message.author?.id === me || recent.has(message.id)) return;
    const channel = ChannelStore.getChannel(message.channel_id);
    const guildId = message.guild_id ?? channel?.guild_id ?? undefined;
    let target = mentionOf(message, me, guildId);
    // MP ou groupe : chaque message te prévient, mention ou pas.
    if (!target && !guildId && options?.dms() && channel && (channel.isDM?.() || channel.isMultiUserDM?.()) && !message.author?.bot) target = "dm";
    if (!target) return;
    track({
        id: message.id,
        at: Date.now(),
        target,
        authorId: message.author?.id ?? "",
        author: message.author?.global_name ?? message.author?.username ?? "?",
        channelId: message.channel_id,
        guildId,
        content: String(message.content ?? ""),
    });
}

function onDelete({ id }: { id: string; }) {
    const seen = recent.get(id);
    if (seen) report(seen, "delete");
}

function onDeleteBulk({ ids }: { ids: string[]; }) {
    for (const id of ids ?? []) onDelete({ id });
}

function onUpdate({ message }: { message: any; }) {
    const seen = recent.get(message?.id);
    // Une modification sans contenu (aperçu de lien…) ne compte pas.
    if (!seen || seen.target === "dm" || message.content == null) return;
    const me = UserStore.getCurrentUser()?.id;
    if (!me || mentionOf(message, me, seen.guildId)) return;
    report(seen, "edit");
}

interface LoadEvent {
    channelId: string;
    messages: any[];
    isBefore?: boolean;
    hasMoreAfter?: boolean;
    requestStartTime?: number;
}

/**
 * Discord vient de charger des messages d'un salon (ouverture, défilement) :
 * une mention en attente qui devrait s'y trouver et n'y est pas est
 * peut-être supprimée. Ce n'est qu'un indice : on redemande le message à
 * Discord (check) au lieu de signaler directement.
 *
 * Pourquoi pas directement : en remontant l'historique (isBefore), Discord
 * envoie toujours hasMoreAfter:false, et un message arrivé pendant le
 * chargement n'est pas dans la réponse. Les deux faisaient passer des MP
 * bien présents pour des ghost pings.
 */
function onLoad({ channelId, messages, isBefore, hasMoreAfter, requestStartTime }: LoadEvent) {
    if (!enabled() || !Array.isArray(messages) || !messages.length) return;
    const pending = [...recent.values()].filter(s => s.channelId === channelId);
    if (!pending.length) return;
    const me = UserStore.getCurrentUser()?.id;
    const byId = new Map<string, any>(messages.map(m => [String(m.id), m]));
    const ids = [...byId.keys()].sort(compareIds);
    const [oldest, newest] = [ids[0], ids[ids.length - 1]];
    for (const seen of pending) {
        const loaded = byId.get(seen.id);
        if (loaded) {
            if (seen.target !== "dm" && me && !mentionOf(loaded, me, seen.guildId)) report(seen, "edit");
            continue;
        }
        // Reçu après le départ de la demande : ne pouvait pas y être.
        // (heure en ms depuis 1970 seulement : sinon on ne peut pas comparer)
        if (requestStartTime && requestStartTime > 1e12 && seen.at >= requestStartTime - 2000) continue;
        const inRange = compareIds(seen.id, oldest) > 0 && compareIds(seen.id, newest) < 0;
        const afterEnd = !isBefore && compareIds(seen.id, newest) > 0 && hasMoreAfter === false;
        if (inRange || afterEnd) queueCheck(seen.id);
    }
}

/** Mentions qui étaient en attente quand Discord s'est fermé : revérifiées une fois. */
async function resumePending() {
    try {
        const saved = await DataStore.get<Seen[]>(PENDING_KEY);
        const now = Date.now();
        for (const s of Array.isArray(saved) ? saved : []) {
            if (!s?.id || !s.channelId || recent.has(s.id)) continue;
            if (now - s.at > (s.target === "dm" ? DM_WINDOW : KEEP_OFFLINE)) continue;
            // Encore dans sa période de surveillance : ses vérifications reprennent.
            if (now - s.at < lifetime(s)) track(s);
            else recent.set(s.id, s);
            // Dans tous les cas, on regarde tout de suite ce qu'il est devenu.
            if (s.target !== "dm") queueCheck(s.id);
        }
        save();
    } catch (e) {
        logger.error("Mentions en attente illisibles", e);
    }
}

const EVENTS = {
    MESSAGE_CREATE: onCreate,
    MESSAGE_DELETE: onDelete,
    MESSAGE_DELETE_BULK: onDeleteBulk,
    MESSAGE_UPDATE: onUpdate,
    LOAD_MESSAGES_SUCCESS: onLoad,
} as const;

export function startGhostWatch(opts: GhostOptions) {
    options = opts;
    for (const [type, fn] of Object.entries(EVENTS)) FluxDispatcher.subscribe(type as never, fn as never);
    void resumePending();
}

export function stopGhostWatch() {
    for (const [type, fn] of Object.entries(EVENTS)) FluxDispatcher.unsubscribe(type as never, fn as never);
    for (const tms of timers.values()) tms.forEach(clearTimeout);
    timers.clear();
    queue.length = 0;
    // Les mentions en attente restent sur le disque : revérifiées au prochain démarrage.
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
        void writePending();
    }
    recent.clear();
    options = null;
}
