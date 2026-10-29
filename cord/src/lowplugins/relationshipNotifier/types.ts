/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Channel } from "@vencord/discord-types";

export interface ChannelDelete {
    type: "CHANNEL_DELETE";
    channel: Channel;
}

export interface GuildDelete {
    type: "GUILD_DELETE";
    guild: {
        id: string;
        unavailable?: boolean;
    };
}

export interface RelationshipRemove {
    type: "RELATIONSHIP_REMOVE";
    relationship: {
        id: string;
        nickname: string;
        type: number;
    };
}

export interface SimpleGroupChannel {
    id: string;
    name: string;
    iconURL?: string;
}

export interface SimpleGuild {
    id: string;
    name: string;
    iconURL?: string;
}

/**
 * friend  : un ami t'a retiré (ou bloqué — Discord ne fait pas la différence)
 * request : une demande d'ami reçue a été annulée
 * server  : tu n'es plus sur un serveur (expulsé, banni ou serveur supprimé)
 * group   : tu n'es plus dans un groupe privé
 */
export type LogKind = "friend" | "request" | "server" | "group";

export interface LogEntry {
    /** identifiant unique de la ligne */
    key: string;
    /** horodatage (ms) — moment où low-cord l'a constaté */
    ts: number;
    kind: LogKind;
    /** constaté au démarrage : c'est arrivé pendant que tu étais hors ligne */
    offline?: boolean;
    /** ID de l'utilisateur, du serveur ou du groupe */
    targetId: string;
    /** nom affiché au moment de l'événement */
    name: string;
    /** nom d'utilisateur (@…) pour les personnes */
    username?: string;
    icon?: string;
}
