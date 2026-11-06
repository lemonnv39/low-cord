/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * ExportMessages — exporter des messages et ta liste de contacts.
 *
 *  - Clic droit sur un message → « Exporter » : ce message, ou toute la
 *    conversation telle qu'elle est chargée à l'écran (aucune requête à
 *    Discord : ce que tu as fait défiler), en texte lisible ou en JSON ; ou
 *    copier le message en texte.
 *  - Réglages du plugin : tes contacts (amis, bloqués, demandes reçues /
 *    envoyées), lus depuis Discord lui-même, à copier ou enregistrer.
 *
 * Rien ne quitte ton PC : les fichiers sont écrits là où tu choisis.
 */

import "./styles.css";

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { t, useLang } from "@lowcord/i18n";
import { copyToClipboard } from "@utils/clipboard";
import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { saveFile } from "@utils/web";
import type { Message } from "@vencord/discord-types";
import { ChannelStore, GuildRoleStore, GuildStore, Menu, MessageStore, RelationshipStore, showToast, useMemo, UserStore, useStateFromStores } from "@webpack/common";

const cl = classNameFactory("lc-em-");
const logger = new Logger("ExportMessages");

const settings = definePluginSettings({
    format: {
        type: OptionType.SELECT,
        description: "File format of exports",
        options: [
            { label: "Readable text (.txt)", value: "txt", default: true },
            { label: "JSON (.json)", value: "json" },
        ],
    },
});

// ── Mise en forme ────────────────────────────────────────────────────────────
const toDate = (ts: any) => new Date(typeof ts?.valueOf === "function" ? ts.valueOf() : ts);
const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const fileStamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
const safeName = (s: string) => s.replace(/[\\/:*?"<>|\r\n]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 80) || "export";

const tag = (u: { username?: string; discriminator?: string; } | undefined) =>
    !u?.username ? "?" : u.discriminator && u.discriminator !== "0" ? `${u.username}#${u.discriminator}` : u.username;

/** Mentions brutes (<@id>, <#id>, <@&id>, <:emoji:id>) → noms lisibles. */
function readable(content: string, guildId?: string | null) {
    return content
        .replace(/<@!?(\d+)>/g, (m, id) => {
            const u = UserStore.getUser(id);
            return u ? `@${u.globalName || u.username}` : m;
        })
        .replace(/<#(\d+)>/g, (m, id) => {
            const c = ChannelStore.getChannel(id);
            return c?.name ? `#${c.name}` : m;
        })
        .replace(/<@&(\d+)>/g, (m, id) => {
            const r = guildId ? GuildRoleStore.getRole(guildId, id) : null;
            return r?.name ? `@${r.name}` : m;
        })
        .replace(/<a?(:\w+:)\d+>/g, "$1");
}

function conversationName(channelId: string) {
    const c = ChannelStore.getChannel(channelId);
    if (!c) return channelId;
    if (c.guild_id) return `${GuildStore.getGuild(c.guild_id)?.name ?? c.guild_id} — #${c.name}`;
    if (c.name) return c.name;
    const names = (c.recipients ?? []).map(id => {
        const u = UserStore.getUser(id);
        return u?.globalName || u?.username || id;
    });
    return names.join(", ") || channelId;
}

function toText(msg: Message) {
    const guildId = ChannelStore.getChannel(msg.channel_id)?.guild_id;
    const lines = [`[${stamp(toDate(msg.timestamp))}] ${tag(msg.author)}${msg.editedTimestamp ? ` (${t("em.edited")})` : ""}: ${readable(msg.content ?? "", guildId)}`];

    const reply = msg.messageReference?.message_id;
    if (reply) {
        const ref = MessageStore.getMessage(msg.channel_id, reply);
        lines.push(`  ↳ ${t("em.replyTo")} ${ref ? `${tag(ref.author)}: ${readable(ref.content ?? "", guildId).slice(0, 80)}` : reply}`);
    }
    for (const a of msg.attachments ?? []) lines.push(`  📎 ${a.filename} (${a.url})`);
    for (const s of (msg as any).stickerItems ?? []) lines.push(`  🏷 ${t("em.sticker")}: ${s.name}`);
    for (const e of msg.embeds ?? []) {
        const parts = [e.rawTitle, e.rawDescription, e.url].filter(Boolean);
        if (parts.length) lines.push(`  ▣ ${parts.join(" — ")}`);
    }
    return lines.join("\n");
}

function toJson(msg: Message) {
    return {
        id: msg.id,
        timestamp: toDate(msg.timestamp).toISOString(),
        edited: msg.editedTimestamp ? toDate(msg.editedTimestamp).toISOString() : null,
        author: { id: msg.author?.id, username: msg.author?.username, globalName: (msg.author as any)?.globalName ?? null },
        content: msg.content ?? "",
        replyTo: msg.messageReference?.message_id ?? null,
        attachments: (msg.attachments ?? []).map(a => ({ filename: a.filename, url: a.url, size: a.size })),
        embeds: (msg.embeds ?? []).map(e => ({ title: e.rawTitle ?? null, description: e.rawDescription ?? null, url: e.url ?? null })),
        stickers: ((msg as any).stickerItems ?? []).map((s: any) => s.name),
    };
}

// ── Écriture ─────────────────────────────────────────────────────────────────
async function writeFile(filename: string, content: string) {
    try {
        const data = new TextEncoder().encode(content);
        if (IS_DISCORD_DESKTOP) await DiscordNative.fileManager.saveWithDialog(data, filename);
        else saveFile(new File([data], filename, { type: filename.endsWith(".json") ? "application/json" : "text/plain" }));
        return true;
    } catch (e) {
        logger.error("Export impossible", e);
        showToast({ text: t("em.failed"), variant: "critical" });
        return false;
    }
}

function exportMessages(channelId: string, messages: Message[], label: string) {
    const now = new Date();
    const name = conversationName(channelId);
    const json = settings.store.format === "json";
    const content = json
        ? JSON.stringify({ conversation: name, channelId, exportedAt: now.toISOString(), count: messages.length, messages: messages.map(toJson) }, null, 2)
        : [`# ${name}`, `# ${t("em.exportedAt")} ${stamp(now)} — ${t("em.count", { count: messages.length })}`, "", ...messages.map(toText)].join("\n\n").replace(/\n\n\n/g, "\n\n");
    return writeFile(`${safeName(`${label} ${name}`)} ${fileStamp(now)}.${json ? "json" : "txt"}`, content);
}

/** Messages de la conversation déjà chargés (dans l'ordre, sans requête à Discord). */
function loadedMessages(channelId: string): Message[] {
    const list: any = MessageStore.getMessages(channelId);
    const arr: Message[] = typeof list?.toArray === "function" ? list.toArray() : Array.isArray(list?._array) ? list._array : [];
    // Pas les messages pas encore envoyés / échoués.
    return arr.filter(m => m?.id && (m as any).state !== "SENDING" && (m as any).state !== "SEND_FAILED");
}

// ── Menu d'un message ────────────────────────────────────────────────────────
function ExportIcon({ width = 24, height = 24, className }: { width?: number | string; height?: number | string; className?: string; }) {
    return (
        <svg className={className} width={width} height={height} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3v12" />
            <path d="m7 10 5 5 5-5" />
            <path d="M5 21h14" />
        </svg>
    );
}

const messageMenu: NavContextMenuPatchCallback = (children, { message }: { message?: Message; }) => {
    if (!message?.id || !message.channel_id) return;
    const loaded = loadedMessages(message.channel_id).length;

    children.push(
        <Menu.MenuGroup key="lc-em-group">
            <Menu.MenuItem id="lc-em-export" label={t("em.export")} leadingAccessory={{ type: "icon", icon: ExportIcon }}>
                <Menu.MenuItem id="lc-em-export-one" label={t("em.thisMessage")} action={() => void exportMessages(message.channel_id, [message], t("em.fileMessage"))} />
                <Menu.MenuItem
                    id="lc-em-export-all"
                    label={t("em.conversation", { count: loaded })}
                    disabled={loaded === 0}
                    action={() => void exportMessages(message.channel_id, loadedMessages(message.channel_id), t("em.fileConversation"))}
                />
                <Menu.MenuSeparator />
                <Menu.MenuItem id="lc-em-copy" label={t("em.copyText")} action={() => {
                    void copyToClipboard(toText(message));
                    showToast({ text: t("em.copied"), variant: "success" });
                }} />
            </Menu.MenuItem>
        </Menu.MenuGroup>
    );
};

// ── Contacts (réglages du plugin) ────────────────────────────────────────────
const CONTACT_GROUPS = [
    { key: "friends", type: 1, label: "em.friends" },
    { key: "blocked", type: 2, label: "em.blocked" },
    { key: "incoming", type: 3, label: "em.incoming" },
    { key: "outgoing", type: 4, label: "em.outgoing" },
] as const;

function readContacts() {
    const map: Map<string, number> | undefined = (RelationshipStore as any).getMutableRelationships?.();
    const out: Record<string, { id: string; username: string; name: string; since: string | null; }[]> = { friends: [], blocked: [], incoming: [], outgoing: [] };
    if (!map) return out;
    for (const [id, type] of map) {
        const group = CONTACT_GROUPS.find(g => g.type === type);
        if (!group) continue;
        const u = UserStore.getUser(id);
        out[group.key].push({
            id,
            username: tag(u),
            name: RelationshipStore.getNickname(id) || u?.globalName || u?.username || id,
            since: RelationshipStore.getSince(id) || null,
        });
    }
    for (const list of Object.values(out)) list.sort((a, b) => a.name.localeCompare(b.name));
    return out;
}

function contactsText(contacts: ReturnType<typeof readContacts>) {
    return CONTACT_GROUPS.map(g => [
        `# ${t(g.label)} (${contacts[g.key].length})`,
        ...contacts[g.key].map(c => `${c.name} — @${c.username} — ${c.id}${c.since ? ` — ${t("em.since")} ${stamp(new Date(c.since)).slice(0, 10)}` : ""}`),
    ].join("\n")).join("\n\n");
}

function ContactsPanel() {
    useLang();
    // Relu seulement quand la liste change (version du store), pas à chaque affichage.
    const version = useStateFromStores([RelationshipStore], () => RelationshipStore.getVersion());
    const contacts = useMemo(readContacts, [version]);
    const json = settings.store.format === "json";
    const content = () => (json ? JSON.stringify(contacts, null, 2) : contactsText(contacts));

    return (
        <div className={cl("panel")}>
            <div className={cl("title")}>{t("em.contacts")}</div>
            <div className={cl("counts")}>
                {CONTACT_GROUPS.map(g => (
                    <div key={g.key}><b>{contacts[g.key].length}</b><span>{t(g.label)}</span></div>
                ))}
            </div>
            <div className={cl("actions")}>
                <button className={cl("btn")} onClick={() => {
                    void copyToClipboard(content());
                    showToast({ text: t("em.contactsCopied"), variant: "success" });
                }}>{t("em.copy")}</button>
                <button className={cl("btn")} onClick={() => void writeFile(`${safeName(t("em.contacts"))} ${fileStamp(new Date())}.${json ? "json" : "txt"}`, content())}>
                    {t("em.save")}
                </button>
            </div>
            <div className={cl("hint")}>{t("em.contactsHint")}</div>
        </div>
    );
}

export default definePlugin({
    name: "ExportMessages",
    description: "Export a message or a whole loaded conversation (text or JSON), and your contacts list, from the message menu and the plugin settings.",
    tags: ["Chat", "Utility"],
    authors: [{ name: "veygax", id: 0n }, { name: "dat_insanity", id: 0n }],
    settings,
    settingsAboutComponent: ContactsPanel,

    contextMenus: {
        "message": messageMenu,
    },
});
