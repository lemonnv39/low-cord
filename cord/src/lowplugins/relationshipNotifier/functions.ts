/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChannelType, RelationshipType } from "@vencord/discord-types/enums";
import { RelationshipStore, UserStore, UserUtils } from "@webpack/common";

import { ChannelDelete, GuildDelete, RelationshipRemove } from "./types";
import { deleteGroup, deleteGuild, getGroup, getGuild, GuildAvailabilityStore, logger, report, userInfo } from "./utils";

// Ce que TU retires toi-même (patches sur les actions de Discord) : on ne le
// signale pas. Chaque marque expire : si l'action échoue côté Discord, une
// vraie suppression plus tard ne sera pas ignorée.
const MANUAL_TTL = 30_000;

class ManualMarks {
    private marks = new Map<string, number>();
    add(id: string) { this.marks.set(String(id), Date.now()); }
    /** true si l'ID a été marqué récemment (et retire la marque) */
    consume(id: string) {
        const at = this.marks.get(id);
        this.marks.delete(id);
        return at != null && Date.now() - at < MANUAL_TTL;
    }
}

const manualFriends = new ManualMarks();
const manualGuilds = new ManualMarks();
const manualGroups = new ManualMarks();

export const removeFriend = (id: string) => manualFriends.add(id);
export const removeGuild = (id: string) => manualGuilds.add(id);
export const removeGroup = (id: string) => manualGroups.add(id);

// Délai avant de conclure : si c'est toi qui viens de bloquer la personne,
// Discord met à jour la relation juste après la suppression.
const SETTLE_DELAY = 1500;

export function onRelationshipRemove({ relationship }: RelationshipRemove) {
    const { type, id } = relationship ?? {};
    if (!id) return;
    if (manualFriends.consume(id)) return;
    if (type !== RelationshipType.FRIEND && type !== RelationshipType.INCOMING_REQUEST) return;

    setTimeout(async () => {
        try {
            const now = RelationshipStore.getRelationshipType(id);
            if (now === RelationshipType.BLOCKED || now === RelationshipType.FRIEND) return;

            const user = UserStore.getUser(id) ?? await UserUtils.getUser(id).catch(() => null);
            const info = user ? userInfo(user) : { targetId: id, name: id };
            report(type === RelationshipType.FRIEND ? "friend" : "request", info);
        } catch (e) {
            logger.error("Suppression d'ami non traitée", e);
        }
    }, SETTLE_DELAY);
}

export function onGuildDelete({ guild }: GuildDelete) {
    const id = guild?.id;
    if (!id) return;
    // Serveur temporairement indisponible (panne Discord) : pas une suppression.
    if (guild.unavailable || GuildAvailabilityStore.isUnavailable(id)) return;

    const known = getGuild(id);
    deleteGuild(id);
    if (manualGuilds.consume(id) || !known) return;

    report("server", { targetId: id, name: known.name, icon: known.iconURL });
}

export function onChannelDelete({ channel }: ChannelDelete) {
    if (channel?.type !== ChannelType.GROUP_DM) return;
    const { id } = channel;

    const known = getGroup(id);
    deleteGroup(id);
    if (manualGroups.consume(id) || !known) return;

    report("group", { targetId: id, name: known.name, icon: known.iconURL });
}
