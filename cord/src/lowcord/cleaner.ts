/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — Cleaner global (onglet low-cord). Actions de masse sur TON
// compte : quitter les serveurs, quitter les groupes, fermer les MP, retirer
// les amis, annuler / refuser les demandes, débloquer. La suppression des
// messages passe par le moteur de Message Cleaner (sauvegarde, journal,
// historique déjà en place).
//
// Rythme : une requête à la fois, comme Discrub. En mode rapide on suit les
// en-têtes de limite de Discord ; en mode sûr, ~1 s entre deux actions.
// Une 429 est toujours respectée (retry_after), jamais contournée.

import { Settings } from "@api/Settings";
import { fastPause, isFastMode, readBucket, Target } from "@lowplugins/messageCleaner/engine";
import { Logger } from "@utils/Logger";
import { ChannelStore, GuildStore, RelationshipStore, RestAPI, UserStore } from "@webpack/common";

import Plugins from "~plugins";

const logger = new Logger("LowCordCleaner");

export type ActionKind =
    | "leaveServers"
    | "leaveGroups"
    | "closeDms"
    | "removeFriends"
    | "cancelOutgoing"
    | "refuseIncoming"
    | "unblockAll";

export interface Item {
    id: string;
    name: string;
}

export const REL = { FRIEND: 1, BLOCKED: 2, INCOMING: 3, OUTGOING: 4 } as const;

export const state = {
    running: false,
    action: null as ActionKind | null,
    current: null as Item | null,
    total: 0,
    done: 0,
    failed: [] as Item[],
    /** dernier résultat, affiché après la fin */
    last: null as { action: ActionKind; done: number; failed: number; stopped: boolean; } | null,
    slowed: false,
};

const listeners = new Set<() => void>();
export const subscribe = (fn: () => void) => (listeners.add(fn), () => { listeners.delete(fn); });
const emit = () => listeners.forEach(fn => fn());

// ── Liste « à garder » : ID jamais touchés par les actions de masse ──────────
const KEEP_PATH = "lowcordCleanerKeep";

export function getKeep(): Set<string> {
    const raw: string = Settings.plugins.Settings?.[KEEP_PATH] ?? "";
    return new Set(raw.match(/\d{15,21}/g) ?? []);
}

export function setKeepRaw(raw: string) {
    Settings.plugins.Settings[KEEP_PATH] = raw;
}

export const getKeepRaw = (): string => Settings.plugins.Settings?.[KEEP_PATH] ?? "";

export function setFast(on: boolean) {
    Settings.plugins.Settings.lowcordCleanerFast = on;
}

// ── Listes calculées depuis les stores (rien n'est demandé à Discord) ────────
const me = () => UserStore.getCurrentUser()?.id;
const userName = (id: string) => {
    const u: any = UserStore.getUser(id);
    return u?.globalName || u?.username || id;
};

/** Serveurs quittables (pas ceux dont tu es propriétaire, pas ceux gardés). */
export function listServers() {
    const keep = getKeep();
    const all = Object.values(GuildStore.getGuilds()) as any[];
    const owned = all.filter(g => g.ownerId === me());
    const items = all
        .filter(g => g.ownerId !== me() && !keep.has(g.id))
        .map(g => ({ id: g.id, name: g.name }));
    return { items, owned: owned.length, kept: all.filter(g => keep.has(g.id)).length };
}

function privateChannels() {
    return ChannelStore.getSortedPrivateChannels() as any[];
}

const dmKept = (c: any, keep: Set<string>) =>
    keep.has(c.id) || (c.recipients ?? []).some((r: string) => keep.has(r));

export function listGroups(): Item[] {
    const keep = getKeep();
    return privateChannels()
        .filter(c => c.type === 3 && !dmKept(c, keep))
        .map(c => ({ id: c.id, name: c.name || (c.recipients ?? []).map(userName).slice(0, 3).join(", ") }));
}

export function listDms(): Item[] {
    const keep = getKeep();
    return privateChannels()
        .filter(c => c.type === 1 && !dmKept(c, keep))
        .map(c => ({ id: c.id, name: userName(c.recipients?.[0] ?? c.getRecipientId?.()) }));
}

export function listRelations(type: number): Item[] {
    const keep = getKeep();
    const out: Item[] = [];
    for (const [id, t] of RelationshipStore.getMutableRelationships()) {
        if (t === type && !keep.has(id)) out.push({ id, name: userName(id) });
    }
    return out;
}

export function itemsFor(action: ActionKind): Item[] {
    switch (action) {
        case "leaveServers": return listServers().items;
        case "leaveGroups": return listGroups();
        case "closeDms": return listDms();
        case "removeFriends": return listRelations(REL.FRIEND);
        case "cancelOutgoing": return listRelations(REL.OUTGOING);
        case "refuseIncoming": return listRelations(REL.INCOMING);
        case "unblockAll": return listRelations(REL.BLOCKED);
    }
}

/** Cibles pour Message Cleaner : tous les MP / groupes, ou tous les serveurs. */
export function messageTargets(scope: "private" | "servers"): Target[] {
    const keep = getKeep();
    if (scope === "servers") {
        return (Object.values(GuildStore.getGuilds()) as any[])
            .filter(g => !keep.has(g.id))
            .map(g => ({ kind: "server", id: g.id, name: g.name }));
    }
    return [
        ...listDms().map(d => ({ kind: "dm" as const, ...d })),
        ...listGroups().map(g => ({ kind: "group" as const, ...g })),
    ];
}

// ── Exécution ────────────────────────────────────────────────────────────────
let stopRequested = false;
let wake: (() => void) | null = null;

function sleep(ms: number) {
    return new Promise<void>(resolve => {
        const timer = setTimeout(done, ms);
        function done() {
            clearTimeout(timer);
            if (wake === done) wake = null;
            resolve();
        }
        wake = done;
    });
}

export function stop() {
    stopRequested = true;
    wake?.();
    emit();
}

function call(action: ActionKind, id: string) {
    switch (action) {
        case "leaveServers":
            return RestAPI.del({ url: `/users/@me/guilds/${id}`, body: { lurking: false } });
        case "leaveGroups":
            return RestAPI.del({ url: `/channels/${id}?silent=true` });
        case "closeDms":
            return RestAPI.del({ url: `/channels/${id}` });
        default:
            if (action === "removeFriends") (Plugins.RelationshipNotifier as any)?.removeFriend?.(id);
            return RestAPI.del({ url: `/users/@me/relationships/${id}` });
    }
}

/** Une action, avec respect des 429. Renvoie la pause à faire ensuite. */
async function runOne(action: ActionKind, item: Item): Promise<{ ok: boolean; pause: number; }> {
    const safe = 900 + Math.random() * 400;
    for (let attempt = 0; attempt < 10; attempt++) {
        if (stopRequested) return { ok: false, pause: 0 };
        try {
            const res = await call(action, item.id);
            state.slowed = false;
            return { ok: true, pause: isFastMode() ? fastPause(readBucket(res), safe) : safe };
        } catch (e: any) {
            if (e?.status === 404) return { ok: true, pause: safe / 2 }; // déjà fait
            if (e?.status === 429) {
                state.slowed = true;
                emit();
                await sleep(Math.ceil((e?.body?.retry_after ?? 5) * 1000) + 300);
                continue;
            }
            if ((e?.status == null || e.status >= 500) && attempt < 3) {
                await sleep(2000 * (attempt + 1));
                continue;
            }
            logger.error(action, item.id, e?.status, e?.body?.message ?? e);
            return { ok: false, pause: safe };
        }
    }
    return { ok: false, pause: safe };
}

export async function runAction(action: ActionKind, items: Item[]) {
    if (state.running || !items.length) return;
    stopRequested = false;
    Object.assign(state, { running: true, action, current: null, total: items.length, done: 0, failed: [], slowed: false, last: null });
    emit();

    try {
        for (const item of items) {
            if (stopRequested) break;
            state.current = item;
            emit();
            const { ok, pause } = await runOne(action, item);
            if (stopRequested && !ok) break;
            if (ok) state.done++;
            else state.failed.push(item);
            emit();
            await sleep(pause);
        }
    } finally {
        state.last = { action, done: state.done, failed: state.failed.length, stopped: stopRequested };
        Object.assign(state, { running: false, current: null, slowed: false });
        stopRequested = false;
        emit();
    }
}

// ── Recherche par ID ─────────────────────────────────────────────────────────
export type FoundKind = "server" | "channel" | "dm" | "group" | "user";

export interface Found {
    kind: FoundKind;
    id: string;
    name: string;
    sub?: string;
    icon?: string;
    /** salon : son serveur ; personne : son MP s'il existe */
    guildId?: string;
    dmId?: string;
    owner?: boolean;
    relation?: number;
}

const guildIcon = (g: any) => g?.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=64` : undefined;
const userIcon = (u: any) => u?.getAvatarURL?.(undefined, 64) ?? (u?.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : undefined);

function fromChannel(c: any): Found | null {
    if (!c?.id) return null;
    if (c.type === 1) {
        const rid = c.recipients?.[0] ?? c.getRecipientId?.();
        return { kind: "dm", id: c.id, name: userName(rid), sub: rid, icon: userIcon(UserStore.getUser(rid)), dmId: c.id, relation: RelationshipStore.getMutableRelationships().get(rid) };
    }
    if (c.type === 3) return { kind: "group", id: c.id, name: c.name || (c.recipients ?? []).map(userName).slice(0, 3).join(", ") };
    const g: any = c.guild_id ? GuildStore.getGuild(c.guild_id) : null;
    return { kind: "channel", id: c.id, name: `#${c.name ?? c.id}`, sub: g?.name, icon: guildIcon(g), guildId: c.guild_id };
}

function fromUser(u: any): Found {
    return {
        kind: "user",
        id: u.id,
        name: u.globalName || u.global_name || u.username || u.id,
        sub: u.username,
        icon: userIcon(u),
        dmId: ChannelStore.getDMFromUserId(u.id) ?? undefined,
        relation: RelationshipStore.getMutableRelationships().get(u.id),
    };
}

/** Devine ce qu'est un ID : serveur, salon, MP, groupe ou personne. */
export async function resolveId(id: string): Promise<Found | null> {
    const g: any = GuildStore.getGuild(id);
    if (g) return { kind: "server", id, name: g.name, icon: guildIcon(g), owner: g.ownerId === me() };
    const c = fromChannel(ChannelStore.getChannel(id));
    if (c) return c;
    const u = UserStore.getUser(id);
    if (u) return fromUser(u);

    // Pas en mémoire : on demande à Discord (salon d'abord, puis personne).
    try {
        const res: any = await RestAPI.get({ url: `/channels/${id}` });
        const found = fromChannel({ ...res.body, recipients: res.body?.recipients?.map((r: any) => r.id) });
        if (found) return found;
    } catch { }
    try {
        const res: any = await RestAPI.get({ url: `/users/${id}` });
        if (res?.body?.id) return fromUser(res.body);
    } catch { }
    return null;
}
