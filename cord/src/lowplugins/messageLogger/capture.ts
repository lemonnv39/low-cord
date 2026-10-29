/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// MessageLogger — capture côté rendu : transforme les messages de Discord en
// événements du journal, garde une copie des MP, envoie les médias à
// archiver. Tout part en lots vers le processus principal (native.ts).

import { Logger } from "@utils/Logger";
import { PluginNative } from "@utils/types";
import { ChannelStore, GuildMemberStore, GuildStore, UserStore } from "@webpack/common";

import type { ChannelKind, LogAttachment, LogAuthor, LogEvent, MediaJob, MessageSnapshot } from "./types";

export const Native = VencordNative.pluginHelpers.MessageLogger as PluginNative<typeof import("./native")> | undefined;
export const logger = new Logger("MessageLogger");

const DISCORD_EPOCH = 1420070400000n;

/** Date d'envoi tirée de l'identifiant du message (toujours fiable). */
export function snowflakeTime(id: string) {
    try {
        return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
    } catch {
        return Date.now();
    }
}

// ── Lecture des données Discord (objets du store ou bruts de l'API) ─────────
export interface ChannelInfo {
    kind: ChannelKind;
    name: string;
    guildId: string | null;
    guildName?: string;
}

export function channelInfo(channelId: string, guildIdHint?: string | null): ChannelInfo {
    const channel = ChannelStore.getChannel(channelId);
    const guildId = channel?.guild_id ?? guildIdHint ?? null;

    if (guildId) {
        return {
            kind: "guild",
            name: channel?.name ? `#${channel.name}` : `#${channelId}`,
            guildId,
            guildName: GuildStore.getGuild(guildId)?.name,
        };
    }

    if (channel?.isDM?.()) {
        const recipient = channel.getRecipientId?.();
        const user = recipient ? UserStore.getUser(recipient) : undefined;
        return { kind: "dm", name: user ? (user.globalName || user.username) : channelId, guildId: null };
    }

    const names = (channel?.recipients ?? []).map(id => {
        const u = UserStore.getUser(id);
        return u?.globalName || u?.username;
    }).filter(Boolean);
    return { kind: channel ? "group" : "dm", name: channel?.name || names.join(", ") || channelId, guildId: null };
}

function avatarUrl(author: any, guildId: string | null): string | undefined {
    try {
        if (typeof author.getAvatarURL === "function") return author.getAvatarURL(guildId ?? undefined, 64, false);
        if (author.avatar) return `https://cdn.discordapp.com/avatars/${author.id}/${author.avatar}.webp?size=64`;
    } catch { /* rien */ }
    return undefined;
}

export function authorInfo(author: any, guildId: string | null): LogAuthor | undefined {
    if (!author?.id) return undefined;
    const user = UserStore.getUser(author.id) ?? author;
    const nick = guildId ? GuildMemberStore.getNick(guildId, author.id) : null;
    return {
        id: author.id,
        username: user.username ?? author.username ?? "",
        name: nick || user.globalName || author.global_name || user.username || author.username || author.id,
        avatar: avatarUrl(user, guildId),
        bot: !!(user.bot ?? author.bot),
    };
}

export function attachmentsOf(msg: any): LogAttachment[] {
    const list = Array.isArray(msg?.attachments) ? msg.attachments : [];
    return list
        .filter((a: any) => a?.id && a.url)
        .map((a: any): LogAttachment => ({
            id: String(a.id),
            filename: String(a.filename ?? "fichier"),
            size: Number(a.size ?? 0),
            contentType: a.content_type ?? a.contentType,
            url: String(a.url),
            width: a.width ?? undefined,
            height: a.height ?? undefined,
        }));
}

function stickersOf(msg: any) {
    const list = msg?.stickerItems ?? msg?.sticker_items ?? msg?.stickers;
    return Array.isArray(list) && list.length ? list.map((s: any) => ({ id: String(s.id), name: String(s.name ?? "") })) : undefined;
}

const replyOf = (msg: any): string | undefined =>
    msg?.messageReference?.message_id ?? msg?.message_reference?.message_id ?? undefined;

export function snapshotOf(msg: any): MessageSnapshot | null {
    if (!msg?.id || !msg.channel_id || typeof msg.content !== "string") return null;
    const author = authorInfo(msg.author, null);
    if (!author) return null;
    const edited = msg.editedTimestamp ?? msg.edited_timestamp;
    return {
        channelId: msg.channel_id,
        messageId: msg.id,
        sentAt: snowflakeTime(msg.id),
        editedAt: edited ? new Date(edited).getTime() : undefined,
        author,
        content: msg.content,
        attachments: attachmentsOf(msg),
        stickers: stickersOf(msg),
        embeds: Array.isArray(msg.embeds) ? msg.embeds.length : undefined,
        replyTo: replyOf(msg),
        seen: Date.now(),
    };
}

// ── Construction des événements ──────────────────────────────────────────────
export function eventFromMessage(type: LogEvent["type"], msg: any, extra: Partial<LogEvent> = {}): LogEvent {
    const info = channelInfo(msg.channel_id, msg.guild_id);
    return {
        key: "",
        type,
        at: Date.now(),
        channelId: msg.channel_id,
        channelKind: info.kind,
        channelName: info.name,
        guildId: info.guildId,
        guildName: info.guildName,
        messageId: msg.id,
        sentAt: snowflakeTime(msg.id),
        author: authorInfo(msg.author, info.guildId),
        content: typeof msg.content === "string" ? msg.content : "",
        attachments: attachmentsOf(msg),
        stickers: stickersOf(msg),
        embeds: Array.isArray(msg.embeds) && msg.embeds.length ? msg.embeds.length : undefined,
        replyTo: replyOf(msg),
        ...extra,
    };
}

export function eventFromSnapshot(type: LogEvent["type"], s: MessageSnapshot, extra: Partial<LogEvent> = {}): LogEvent {
    const info = channelInfo(s.channelId);
    return {
        key: "",
        type,
        at: Date.now(),
        channelId: s.channelId,
        channelKind: info.kind,
        channelName: info.name,
        guildId: null,
        messageId: s.messageId,
        sentAt: s.sentAt,
        author: s.author,
        content: s.content,
        attachments: s.attachments,
        stickers: s.stickers,
        embeds: s.embeds,
        replyTo: s.replyTo,
        ...extra,
    };
}

// ── Files d'envoi vers le disque ─────────────────────────────────────────────
const events: LogEvent[] = [];
const snaps: MessageSnapshot[] = [];
const media: MediaJob[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function schedule(soon = false) {
    if (timer && !soon) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, soon ? 50 : 1000);
}

export function flush() {
    timer = null;
    if (!Native) return;
    if (events.length) Native.appendEvents(events.splice(0)).catch(e => logger.error("Écriture du journal impossible", e));
    if (snaps.length) Native.saveSnapshots(snaps.splice(0)).catch(e => logger.error("Copie des MP impossible", e));
    if (media.length) Native.archiveMedia(media.splice(0)).catch(e => logger.error("Archivage des médias impossible", e));
}

export function pushEvent(ev: LogEvent) {
    // Clé stable : un même événement capté deux fois n'est écrit qu'une fois.
    ev.key ||= ev.type === "delete"
        ? `d:${ev.messageId}`
        : ev.type === "edit"
            ? `e:${ev.messageId}:${ev.at}`
            : `a:${ev.messageId}:${ev.attachments.map(a => a.id).join(",")}`;
    events.push(ev);
    schedule(events.length >= 25);
}

export function pushSnapshot(s: MessageSnapshot | null) {
    if (!s) return;
    snaps.push(s);
    schedule(snaps.length >= 100);
}

export function pushMedia(channelId: string, messageId: string, attachments: LogAttachment[]) {
    for (const attachment of attachments) media.push({ channelId, messageId, attachment });
    if (attachments.length) schedule();
}
