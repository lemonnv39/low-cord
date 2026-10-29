/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import { popNotice, showNotice } from "@api/Notices";
import { t } from "@lowcord/i18n";
import { debounce } from "@shared/debounce";
import { Logger } from "@utils/Logger";
import { FluxStore, User } from "@vencord/discord-types";
import { ChannelType, RelationshipType } from "@vencord/discord-types/enums";
import { findStoreLazy } from "@webpack";
import { ChannelStore, GuildStore, RelationshipStore, showToast, UserStore, UserUtils } from "@webpack/common";

import { addLogEntry, loadLog } from "./log";
import settings from "./settings";
import { LogKind, SimpleGroupChannel, SimpleGuild } from "./types";

export const logger = new Logger("RelationshipNotifier");

export const GuildAvailabilityStore = findStoreLazy("GuildAvailabilityStore") as FluxStore & {
    isUnavailable(guildId: string): boolean;
};

const guilds = new Map<string, SimpleGuild>();
const groups = new Map<string, SimpleGroupChannel>();
const friends = {
    friends: [] as string[],
    requests: [] as string[]
};

const me = () => UserStore.getCurrentUser()?.id;
const guildsKey = (id: string) => `relationship-notifier-guilds-${id}`;
const groupsKey = (id: string) => `relationship-notifier-groups-${id}`;
const friendsKey = (id: string) => `relationship-notifier-friends-${id}`;

// ── Notification + journal ───────────────────────────────────────────────────
const NOTIFY_SETTING: Record<LogKind, "friends" | "friendRequestCancels" | "servers" | "groups"> = {
    friend: "friends",
    request: "friendRequestCancels",
    server: "servers",
    group: "groups",
};

export function userInfo(user: User) {
    return {
        targetId: user.id,
        name: user.globalName || user.username,
        username: user.username,
        icon: user.getAvatarURL(undefined, 80, false),
    };
}

/** Enregistre l'événement dans le journal et affiche la pop-up si elle est activée. */
export function report(kind: LogKind, info: { targetId: string; name: string; username?: string; icon?: string; }, offline = false) {
    addLogEntry({ kind, offline, ...info });

    if (!settings.store[NOTIFY_SETTING[kind]]) return;
    if (offline && !settings.store.offlineRemovals) return;

    const who = info.username && info.username !== info.name ? `${info.name} (@${info.username})` : info.name;
    const text = t(offline ? `rn.toast.${kind}.offline` : `rn.toast.${kind}`, { name: who });

    showToast({ text, variant: kind === "request" ? "default" : "critical", duration: 6000 });
    if (settings.store.notices) showNotice(text, "OK", () => popNotice());
}

// ── Synchronisation de l'état connu ──────────────────────────────────────────
function persistGuilds() {
    const id = me();
    if (id) return DataStore.set(guildsKey(id), guilds).catch(e => logger.error(e));
}
function persistGroups() {
    const id = me();
    if (id) return DataStore.set(groupsKey(id), groups).catch(e => logger.error(e));
}
function persistFriends() {
    const id = me();
    if (id) return DataStore.set(friendsKey(id), friends).catch(e => logger.error(e));
}
// Les événements GUILD_CREATE arrivent en rafale à la connexion : on n'écrit
// sur le disque qu'une fois la rafale passée.
const persistGuildsSoon = debounce(persistGuilds, 1000);
const persistGroupsSoon = debounce(persistGroups, 1000);
const persistFriendsSoon = debounce(persistFriends, 1000);

function readGuilds() {
    guilds.clear();
    // Un serveur présent dans GuildStore = un serveur dont tu es membre.
    for (const [id, { name, icon }] of Object.entries(GuildStore.getGuilds())) {
        guilds.set(id, {
            id,
            name,
            iconURL: icon ? `https://cdn.discordapp.com/icons/${id}/${icon}.png` : undefined
        });
    }
}

function readGroups() {
    groups.clear();
    for (const { type, id, name, rawRecipients, icon } of ChannelStore.getSortedPrivateChannels()) {
        if (type !== ChannelType.GROUP_DM) continue;
        groups.set(id, {
            id,
            name: name || (rawRecipients ?? []).map(r => r.username).join(", "),
            iconURL: icon ? `https://cdn.discordapp.com/channel-icons/${id}/${icon}.png` : undefined
        });
    }
}

function readFriends() {
    friends.friends = [];
    friends.requests = [];
    for (const [id, type] of RelationshipStore.getMutableRelationships()) {
        if (type === RelationshipType.FRIEND) friends.friends.push(id);
        else if (type === RelationshipType.INCOMING_REQUEST) friends.requests.push(id);
    }
}

export function syncGuilds() {
    if (!me()) return;
    readGuilds();
    persistGuildsSoon();
}

export function syncGroups() {
    if (!me()) return;
    readGroups();
    persistGroupsSoon();
}

export function syncFriends() {
    if (!me()) return;
    readFriends();
    persistFriendsSoon();
}

export const getGuild = (id: string) => guilds.get(id);
export const getGroup = (id: string) => groups.get(id);

export function deleteGuild(id: string) {
    guilds.delete(id);
    persistGuildsSoon();
}

export function deleteGroup(id: string) {
    groups.delete(id);
    persistGroupsSoon();
}

// ── Vérification au démarrage (suppressions pendant que tu étais hors ligne) ─
let checking = false;

export async function syncAndRunChecks() {
    const id = me();
    if (!id || checking) return;
    checking = true;

    try {
        await loadLog();

        const [oldGuilds, oldGroups, oldFriends] = await DataStore.getMany([
            guildsKey(id),
            groupsKey(id),
            friendsKey(id)
        ]) as [Map<string, SimpleGuild> | undefined, Map<string, SimpleGroupChannel> | undefined, Record<"friends" | "requests", string[]> | undefined];

        readGuilds();
        readGroups();
        readFriends();
        await Promise.all([persistGuilds(), persistGroups(), persistFriends()]);

        // Première utilisation sur ce compte : rien à comparer.
        if (oldGroups instanceof Map) {
            for (const [gid, group] of oldGroups) {
                if (!groups.has(gid)) report("group", { targetId: gid, name: group.name, icon: group.iconURL }, true);
            }
        }

        if (oldGuilds instanceof Map) {
            for (const [gid, guild] of oldGuilds) {
                if (!guilds.has(gid) && !GuildAvailabilityStore.isUnavailable(gid))
                    report("server", { targetId: gid, name: guild.name, icon: guild.iconURL }, true);
            }
        }

        for (const uid of oldFriends?.friends ?? []) {
            if (friends.friends.includes(uid)) continue;
            // Bloqué par toi entre-temps : ce n'est pas lui qui t'a retiré.
            if (RelationshipStore.getRelationshipType(uid) === RelationshipType.BLOCKED) continue;

            const user = await UserUtils.getUser(uid).catch(() => null);
            report("friend", user ? userInfo(user) : { targetId: uid, name: uid }, true);
        }

        for (const uid of oldFriends?.requests ?? []) {
            const type = RelationshipStore.getRelationshipType(uid);
            if (friends.requests.includes(uid) || type === RelationshipType.FRIEND || type === RelationshipType.BLOCKED || type === RelationshipType.OUTGOING_REQUEST) continue;

            const user = await UserUtils.getUser(uid).catch(() => null);
            report("request", user ? userInfo(user) : { targetId: uid, name: uid }, true);
        }
    } catch (e) {
        logger.error("Vérification au démarrage impossible", e);
    } finally {
        checking = false;
    }
}
