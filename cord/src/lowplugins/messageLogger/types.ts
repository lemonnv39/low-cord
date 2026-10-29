/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Modèle de données du journal, partagé entre le rendu (index.tsx) et le
// processus principal (native.ts). Aucun import ici : ce fichier est utilisé
// des deux côtés.

export type ChannelKind = "dm" | "group" | "guild";
export type LogEventType = "delete" | "edit" | "attachments";

export interface LogAuthor {
    id: string;
    username: string;
    /** nom affiché (pseudo global ou surnom du serveur) */
    name: string;
    avatar?: string;
    bot?: boolean;
}

export interface LogAttachment {
    id: string;
    filename: string;
    size: number;
    contentType?: string;
    url: string;
    width?: number;
    height?: number;
}

export interface LogEvent {
    /** identifiant unique de la ligne */
    key: string;
    type: LogEventType;
    /** moment où low-cord a constaté l'événement (ms) */
    at: number;

    channelId: string;
    channelKind: ChannelKind;
    channelName: string;
    guildId?: string | null;
    guildName?: string;

    messageId: string;
    /** date d'envoi du message (ms) */
    sentAt: number;
    author?: LogAuthor;

    /** texte du message (au moment de la suppression, ou ancien texte pour une modification) */
    content: string;
    /** nouveau texte, pour une modification */
    newContent?: string;
    attachments: LogAttachment[];
    stickers?: { id: string; name: string; }[];
    embeds?: number;
    replyTo?: string;
    /** contenu non capturé : message jamais vu par low-cord avant sa suppression */
    partial?: boolean;
    /** suppression en masse (plusieurs messages d'un coup, souvent par un modérateur) */
    bulk?: boolean;
}

/** Copie d'un message privé gardée en mémoire (et sur le disque) jusqu'à sa suppression éventuelle. */
export interface MessageSnapshot {
    channelId: string;
    messageId: string;
    sentAt: number;
    editedAt?: number;
    author: LogAuthor;
    content: string;
    attachments: LogAttachment[];
    stickers?: { id: string; name: string; }[];
    embeds?: number;
    replyTo?: string;
    /** date d'enregistrement (pour l'expiration) */
    seen: number;
}

export interface MediaJob {
    channelId: string;
    messageId: string;
    attachment: LogAttachment;
}

export interface LogQuery {
    channelId?: string;
    authorId?: string;
    type?: LogEventType;
    kind?: "dm" | "guild";
    search?: string;
    offset?: number;
    limit?: number;
}

export interface LogQueryResult {
    items: LogEvent[];
    total: number;
    /** attachmentId -> chemin relatif du média archivé */
    media: Record<string, string>;
}

export interface ConversationSummary {
    channelId: string;
    channelKind: ChannelKind;
    channelName: string;
    guildId?: string | null;
    guildName?: string;
    /** pour un MP : l'autre personne */
    peer?: LogAuthor;
    deletes: number;
    edits: number;
    last: number;
}

export interface LogStats {
    events: number;
    snapshots: number;
    mediaFiles: number;
    mediaBytes: number;
    queue: number;
    dir: string;
}
