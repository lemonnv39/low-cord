/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * MessageLogger (low-cord) — garde les messages supprimés et modifiés.
 *
 * Deux niveaux :
 *  1. Dans le chat (session en cours) : les messages supprimés restent
 *     affichés en rouge, l'historique des modifications sous le message.
 *  2. Journal permanent sur disque (voir native.ts) : chaque suppression /
 *     modification est enregistrée avec l'auteur, le salon, les heures et les
 *     pièces jointes ; les médias reçus en MP sont archivés dès réception ;
 *     une copie des MP permet de retrouver un message supprimé même s'il
 *     n'était pas affiché. Consultable dans « Journal des messages ».
 */

import "./messageLogger.css";

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { updateMessage } from "@api/MessageUpdater";
import { isPluginEnabled } from "@api/PluginManager";
import { definePluginSettings } from "@api/Settings";
import { disableStyle, enableStyle } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import { EyeIcon, LogIcon } from "@components/Icons";
import { t } from "@lowcord/i18n";
import { Devs } from "@utils/constants";
import { getIntlMessage } from "@utils/discord";
import { classes } from "@utils/misc";
import definePlugin, { OptionType } from "@utils/types";
import { Message, MessageAttachment } from "@vencord/discord-types";
import { findCssClassesLazy } from "@webpack";
import { AuthenticationStore, ChannelStore, FluxDispatcher, Menu, MessageStore, Parser, SelectedChannelStore, Timestamp, UserStore, useStateFromStores } from "@webpack/common";

import { attachmentsOf, eventFromMessage, eventFromSnapshot, flush, logger, Native, pushEvent, pushMedia, pushSnapshot, snapshotOf } from "./capture";
import overlayStyle from "./deleteStyleOverlay.css?managed";
import textStyle from "./deleteStyleText.css?managed";
import { openHistoryModal } from "./HistoryModal";
import { JournalPanel, openJournal } from "./JournalModal";

interface MLMessage extends Message {
    deleted?: boolean;
    editHistory?: { timestamp: Date; content: string; }[];
    firstEditTimestamp?: Date;
}

interface MLAttachment extends MessageAttachment {
    /** pièce jointe supprimée (un message non supprimé peut en avoir) */
    deleted?: boolean;
}

const MessageClasses = findCssClassesLazy("edited", "communicationDisabled", "isSystemMessage");
const EPHEMERAL = 64;

const settings = definePluginSettings({
    deleteStyle: {
        type: OptionType.SELECT,
        description: "The style of deleted messages",
        options: [
            { label: "Red text", value: "text", default: true },
            { label: "Red overlay", value: "overlay" }
        ],
        onChange: () => addDeleteStyle()
    },
    logDeletes: {
        type: OptionType.BOOLEAN,
        description: "Whether to log deleted messages",
        default: true,
    },
    collapseDeleted: {
        type: OptionType.BOOLEAN,
        description: "Whether to collapse deleted messages, similar to blocked messages",
        default: false,
        restartNeeded: true,
    },
    logEdits: {
        type: OptionType.BOOLEAN,
        description: "Whether to log edited messages",
        default: true,
    },
    logDeletedAttachments: {
        type: OptionType.BOOLEAN,
        description: "Whether to log deleted attachments",
        default: true,
        restartNeeded: true,
    },
    inlineEdits: {
        type: OptionType.BOOLEAN,
        description: "Whether to display edit history as part of message content",
        default: true
    },
    journal: {
        type: OptionType.BOOLEAN,
        description: "Keep a permanent log on disk (survives restarts)",
        default: true,
    },
    journalServers: {
        type: OptionType.BOOLEAN,
        description: "Also log servers in the permanent log (DMs and groups are always logged)",
        default: false,
    },
    archiveMedia: {
        type: OptionType.SELECT,
        description: "Download received media as soon as they arrive, to keep them even if deleted",
        options: [
            { label: "DMs and groups", value: "dm", default: true },
            { label: "DMs, groups and servers", value: "all" },
            { label: "Off", value: "off" },
        ],
    },
    maxMediaMB: {
        type: OptionType.NUMBER,
        description: "Maximum size of an archived file (MB)",
        // 500 Mo : la taille max d'un envoi Discord, donc tout est archivé par défaut.
        default: 500,
        onChange: () => configureNative(),
    },
    snapshotDays: {
        type: OptionType.NUMBER,
        description: "How many days to remember received DMs (to recover deleted messages that were not on screen)",
        default: 30,
        onChange: () => configureNative(),
    },
    ignoreBots: {
        type: OptionType.BOOLEAN,
        description: "Whether to ignore messages by bots",
        default: true
    },
    ignoreSelf: {
        type: OptionType.BOOLEAN,
        description: "Whether to ignore messages by yourself",
        default: false
    },
    ignoreUsers: {
        type: OptionType.STRING,
        description: "Comma-separated list of user IDs to ignore",
        default: "",
        multiline: true
    },
    ignoreChannels: {
        type: OptionType.STRING,
        description: "Comma-separated list of channel IDs to ignore",
        default: "",
        multiline: true
    },
    ignoreGuilds: {
        type: OptionType.STRING,
        description: "Comma-separated list of guild IDs to ignore",
        default: "",
        multiline: true
    },
});

function addDeleteStyle() {
    if (!isPluginEnabled("MessageLogger")) return;
    if (settings.store.deleteStyle === "overlay") {
        disableStyle(textStyle);
        enableStyle(overlayStyle);
    } else {
        disableStyle(overlayStyle);
        enableStyle(textStyle);
    }
}

function configureNative() {
    Native?.configure({ snapshotDays: settings.store.snapshotDays, maxMediaMB: settings.store.maxMediaMB }).catch(() => null);
}

// ── Listes d'ignorés : de vrais identifiants, pas une recherche de texte ────
const idSetCache = new Map<string, Set<string>>();
function idSet(raw: string) {
    let set = idSetCache.get(raw);
    if (!set) {
        set = new Set(raw.split(/[\s,]+/).filter(Boolean));
        idSetCache.set(raw, set);
    }
    return set;
}

/** Auteur, salon ou serveur dans les listes d'ignorés (vaut aussi pour l'archivage). */
function isIgnoredSource(message: any) {
    try {
        const { ignoreBots, ignoreSelf, ignoreUsers, ignoreChannels, ignoreGuilds } = settings.store;
        const channel = ChannelStore.getChannel(message.channel_id);
        const authorId = message.author?.id;

        return (ignoreBots && !!message.author?.bot)
            || (ignoreSelf && authorId === UserStore.getCurrentUser()?.id)
            || idSet(ignoreUsers).has(authorId)
            || idSet(ignoreChannels).has(message.channel_id)
            || (!!channel?.parent_id && idSet(ignoreChannels).has(channel.parent_id))
            || (!!channel?.guild_id && idSet(ignoreGuilds).has(channel.guild_id));
    } catch {
        return false;
    }
}

function shouldIgnore(message: any, isEdit = false) {
    const { logEdits, logDeletes } = settings.store;
    return (isEdit ? !logEdits : !logDeletes) || isIgnoredSource(message);
}

/** Salon privé (MP ou groupe) : pas de serveur. */
function isPrivate(channelId: string, guildIdHint?: string | null) {
    const channel = ChannelStore.getChannel(channelId);
    return channel ? !channel.guild_id : !guildIdHint;
}

const inJournal = (channelId: string, guildIdHint?: string | null) =>
    settings.store.journal && (isPrivate(channelId, guildIdHint) || settings.store.journalServers);

function archiveWanted(channelId: string, guildIdHint?: string | null) {
    const mode = settings.store.archiveMedia;
    return mode === "all" || (mode === "dm" && isPrivate(channelId, guildIdHint));
}

// Identifiants déjà traités par la capture principale (store de messages), pour
// que la capture de secours (événements Flux) ne les enregistre pas deux fois.
const handledDeletes = new Set<string>();
const handledEdits = new Set<string>();
function remember(set: Set<string>, key: string) {
    set.add(key);
    if (set.size > 5000) set.delete(set.values().next().value!);
}

// ── Enregistrement dans le journal ───────────────────────────────────────────
function logDeleted(msg: any, bulk: boolean) {
    if (!inJournal(msg.channel_id)) return;
    try {
        const ev = eventFromMessage("delete", msg, bulk ? { bulk: true } : {});
        pushEvent(ev);
        // Sauvetage : on tente aussitôt de télécharger ses pièces jointes.
        if (settings.store.archiveMedia !== "off") pushMedia(ev.channelId, ev.messageId, ev.attachments);
    } catch (e) {
        logger.error("Suppression non enregistrée", e);
    }
}

function logEdit(oldMsg: any, newMsg: any) {
    if (!inJournal(oldMsg.channel_id)) return;
    try {
        const at = new Date(newMsg.edited_timestamp).getTime() || Date.now();
        // Pas de pièces jointes sur une modification : seul le texte a changé.
        pushEvent(eventFromMessage("edit", oldMsg, { key: `e:${oldMsg.id}:${at}`, at, newContent: newMsg.content, attachments: [] }));
    } catch (e) {
        logger.error("Modification non enregistrée", e);
    }
}

function logRemovedAttachments(msg: any, removed: any[]) {
    if (!removed.length || !inJournal(msg.channel_id)) return;
    try {
        const ev = eventFromMessage("attachments", msg, { attachments: attachmentsOf({ attachments: removed }) });
        pushEvent(ev);
        if (settings.store.archiveMedia !== "off") pushMedia(ev.channelId, ev.messageId, ev.attachments);
    } catch (e) {
        logger.error("Pièces jointes retirées non enregistrées", e);
    }
}

/** Message reçu ou chargé : copie des MP + archivage des médias. */
function capture(msg: any, guildIdHint?: string | null) {
    if (!msg?.id || !msg.channel_id) return;
    if (settings.store.journal && isPrivate(msg.channel_id, guildIdHint)) pushSnapshot(snapshotOf(msg));
    if (archiveWanted(msg.channel_id, guildIdHint) && !isIgnoredSource(msg)) {
        const list = attachmentsOf(msg);
        if (list.length) pushMedia(msg.channel_id, msg.id, list);
    }
}

/** Suppression d'un message qui n'était pas affiché : on cherche sa copie. */
async function rescueDeletes(channelId: string, ids: string[], bulk: boolean) {
    const missing = ids.filter(id => !handledDeletes.has(id));
    if (!missing.length || !settings.store.journal || !isPrivate(channelId) || !Native) return;
    missing.forEach(id => remember(handledDeletes, id));

    try {
        const found = await Native.getSnapshots(missing);
        const byId = new Map(found.map(s => [s.messageId, s]));
        for (const id of missing) {
            const snap = byId.get(id);
            if (snap) {
                if (shouldIgnore({ author: snap.author, channel_id: channelId })) continue;
                const ev = eventFromSnapshot("delete", snap, bulk ? { bulk: true } : {});
                pushEvent(ev);
                if (settings.store.archiveMedia !== "off") pushMedia(ev.channelId, ev.messageId, ev.attachments);
            } else {
                // Jamais vu par low-cord (reçu avant son installation, ou expiré).
                pushEvent(eventFromMessage("delete", { id, channel_id: channelId, content: "" }, { partial: true, bulk: bulk || undefined }));
            }
        }
    } catch (e) {
        logger.error("Récupération des copies impossible", e);
    }
}

/** Modification d'un MP qui n'était pas affiché : comparaison avec sa copie. */
async function rescueEdit(raw: any) {
    if (!settings.store.journal || !settings.store.logEdits || !Native) return;
    const at = new Date(raw.edited_timestamp).getTime();
    if (!at || handledEdits.has(`${raw.id}:${at}`)) return;
    remember(handledEdits, `${raw.id}:${at}`);
    try {
        const [snap] = await Native.getSnapshots([raw.id]);
        if (!snap || snap.content === raw.content) return;
        if (shouldIgnore({ author: snap.author, channel_id: raw.channel_id }, true)) return;
        pushEvent(eventFromSnapshot("edit", snap, { key: `e:${raw.id}:${at}`, at, newContent: raw.content, attachments: [] }));
    } catch (e) {
        logger.error("Récupération de la copie impossible", e);
    }
}

// ── Historique dans le chat ──────────────────────────────────────────────────
function clearMessageHistory(msg: MLMessage) {
    if (msg.deleted) {
        FluxDispatcher.dispatch({
            type: "MESSAGE_DELETE",
            channelId: msg.channel_id,
            id: msg.id,
            mlDeleted: true
        });
    } else {
        const attachments = msg.attachments?.filter((a: MLAttachment) => !a.deleted);
        updateMessage(msg.channel_id, msg.id, { editHistory: [], attachments });
    }
}

function doesMessageHaveHistory(message: MLMessage): boolean {
    return !!message && (!!message.deleted || !!message.editHistory?.length || !!message.attachments?.some((a: MLAttachment) => a.deleted));
}

function ClearHistoryIcon({ height = 24, width = 24, className }: { height?: number | string; width?: number | string; className?: string; }) {
    return (
        <svg className={className} width={width} height={height} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M5.63606 18.3639C9.15077 21.8786 14.8493 21.8786 18.364 18.3639C21.8787 14.8492 21.8787 9.1507 18.364 5.63598C14.8493 2.12126 9.15077 2.12126 5.63606 5.63598C3.87757 7.39447 2.99889 9.6996 3.00002 12.0044L3 13.9999" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" style={{ fill: "none" }} />
            <path d="M1 11.9999L3 13.9999L5 11.9999" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" style={{ fill: "none" }} />
            <path d="M11 7.99994L11 12.9999L16 12.9999" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" style={{ fill: "none" }} />
        </svg>
    );
}

const patchMessageContextMenu: NavContextMenuPatchCallback = (children, props) => {
    const { message } = props;
    if (!message || !doesMessageHaveHistory(message)) return;

    if (message.deleted) {
        const domElement = document.getElementById(`chat-messages-${message.channel_id}-${message.id}`);
        if (domElement) {
            children.push(
                <Menu.MenuItem
                    id="ml-toggle-style"
                    key="ml-toggle-style"
                    label={t("ml.toggleHighlight")}
                    leadingAccessory={{ type: "icon", icon: EyeIcon }}
                    action={() => domElement.classList.toggle("messagelogger-deleted")}
                />
            );
        }
    }

    children.push(
        <Menu.MenuItem
            id="ml-remove-history"
            key="ml-remove-history"
            label={t("ml.clearHistory")}
            leadingAccessory={{ type: "icon", icon: ClearHistoryIcon }}
            color="danger"
            action={() => clearMessageHistory(message)}
        />
    );
};

const patchChannelContextMenu: NavContextMenuPatchCallback = (children, props) => {
    const channel = props?.channel;
    const user = props?.user;
    const group = findGroupChildrenByChildId("mark-channel-read", children) ?? children;

    // Un seul accès au journal : la conversation si on en a une (MP, salon),
    // sinon les messages de la personne.
    if (channel?.id || user?.id) {
        group.push(
            <Menu.MenuItem
                id="vc-ml-open-journal"
                label={t("ml.journal")}
                leadingAccessory={{ type: "icon", icon: LogIcon }}
                action={() => openJournal(channel?.id ? { channelId: channel.id } : { authorId: user.id })}
            />
        );
    }

    const messages = channel?.id ? MessageStore.getMessages(channel.id) : null;
    if (!messages?.some((msg: MLMessage) => doesMessageHaveHistory(msg))) return;
    group.push(
        <Menu.MenuItem
            id="vc-ml-clear-channel"
            label={t("ml.clearChannel")}
            color="danger"
            action={() => messages.forEach((msg: MLMessage) => clearMessageHistory(msg))}
        />
    );
};

export function parseEditContent(content: string, message: { channel_id: string; id: string; }) {
    return Parser.parse(content, true, {
        channelId: message.channel_id,
        messageId: message.id,
        allowLinks: true,
        allowHeading: true,
        allowList: true,
        allowEmojiLinks: true,
        viewingChannelId: SelectedChannelStore.getChannelId(),
    });
}

export default definePlugin({
    name: "MessageLogger",
    description: "Keeps deleted and edited messages, with a permanent on-disk log and archived DM media.",
    tags: ["Chat", "Utility"],
    authors: [Devs.rushii, Devs.Ven, Devs.AutumnVN, Devs.Nickyux, Devs.Kyuuhachi, Devs.sadan, Devs.f3tch],
    dependencies: ["MessageUpdaterAPI"],
    settings,
    settingsAboutComponent: JournalPanel,

    contextMenus: {
        "message": patchMessageContextMenu,
        "channel-context": patchChannelContextMenu,
        "thread-context": patchChannelContextMenu,
        "user-context": patchChannelContextMenu,
        "gdm-context": patchChannelContextMenu
    },

    start() {
        addDeleteStyle();
        configureNative();
        // Fermeture de Discord : on écrit ce qui attend encore (au plus 1 s).
        window.addEventListener("beforeunload", flush);
    },

    stop() {
        disableStyle(textStyle);
        disableStyle(overlayStyle);
        window.removeEventListener("beforeunload", flush);
        flush();
    },

    flux: {
        MESSAGE_CREATE({ message, optimistic }: { message: any; optimistic?: boolean; }) {
            if (optimistic) return;
            capture(message, message?.guild_id);
        },
        LOAD_MESSAGES_SUCCESS({ channelId, messages }: { channelId: string; messages: any[]; }) {
            if (!Array.isArray(messages)) return;
            for (const msg of messages) capture({ ...msg, channel_id: msg.channel_id ?? channelId });
        },
        MESSAGE_UPDATE({ message }: { message: any; }) {
            if (!message?.id || !message.channel_id || !isPrivate(message.channel_id, message.guild_id)) return;
            // Après la capture principale (store) : seul ce qui lui a échappé est traité ici.
            setTimeout(async () => {
                if (typeof message.content === "string" && message.edited_timestamp) await rescueEdit(message);
                if (typeof message.content === "string") capture(message, message.guild_id);
            }, 50);
        },
        MESSAGE_DELETE({ id, channelId, mlDeleted }: { id: string; channelId: string; mlDeleted?: boolean; }) {
            if (mlDeleted || !id || !channelId) return;
            setTimeout(() => rescueDeletes(channelId, [id], false), 50);
        },
        MESSAGE_DELETE_BULK({ ids, channelId }: { ids: string[]; channelId: string; }) {
            if (!Array.isArray(ids) || !channelId) return;
            setTimeout(() => rescueDeletes(channelId, ids, true), 50);
        },
    },

    messagePopoverButton: {
        icon: ClearHistoryIcon,
        render(message) {
            const current = MessageStore.getMessage(message.channel_id, message.id) as MLMessage | undefined;
            if (!current || !doesMessageHaveHistory(current)) return null;

            return {
                label: t("ml.clearHistoryShort"),
                icon: ClearHistoryIcon,
                onClick: () => {
                    const latest = MessageStore.getMessage(message.channel_id, message.id) as MLMessage | undefined;
                    if (latest) clearMessageHistory(latest);
                }
            };
        }
    },

    renderEdits: ErrorBoundary.wrap(({ message: { id: messageId, channel_id: channelId } }: { message: Message; }) => {
        const message = useStateFromStores(
            [MessageStore],
            () => MessageStore.getMessage(channelId, messageId) as MLMessage,
            null,
            (oldMsg, newMsg) => oldMsg?.editHistory === newMsg?.editHistory
        );

        if (!settings.store.inlineEdits || !message?.editHistory?.length) return null;
        return (
            <>
                {message.editHistory.map((edit, idx) => (
                    <div key={idx} className="messagelogger-edited">
                        {parseEditContent(edit.content, message)}
                        <Timestamp timestamp={edit.timestamp} isEdited={true} isInline={false}>
                            <span className={MessageClasses.edited}>{" "}({getIntlMessage("MESSAGE_EDITED")})</span>
                        </Timestamp>
                    </div>
                ))}
            </>
        );
    }, { noop: true }),

    makeEdit(newMessage: any, oldMessage: any) {
        const at = new Date(newMessage.edited_timestamp).getTime();
        if (at) remember(handledEdits, `${oldMessage.id}:${at}`);
        logEdit(oldMessage, newMessage);
        return {
            timestamp: new Date(newMessage.edited_timestamp),
            content: oldMessage.content
        };
    },

    shouldIgnore,

    handleUpdateAttachments(newMessage: MLMessage): MLAttachment[] {
        const oldMessage = MessageStore.getMessage(newMessage.channel_id, newMessage.id) as MLMessage | undefined;
        const fresh = newMessage.attachments ?? [];
        // Nouveau message (pas encore en mémoire) : rien à comparer.
        if (!oldMessage || shouldIgnore(newMessage, true)) return fresh;
        const old = oldMessage.attachments ?? [];

        const removed: MLAttachment[] = [];
        const merged = old.map((oldAttachment): MLAttachment => {
            const kept = fresh.find(a => a.id === oldAttachment.id);
            if (kept) return kept;
            if (!(oldAttachment as MLAttachment).deleted) removed.push(oldAttachment);
            return { ...oldAttachment, deleted: true };
        }).concat(fresh.filter(a => !old.some(o => o.id === a.id)));

        logRemovedAttachments(oldMessage, removed);
        return merged;
    },

    handleDelete(cache: any, data: { ids: string[], id: string; mlDeleted?: boolean; }, isBulk: boolean) {
        try {
            if (cache == null || (!isBulk && !cache.has(data.id))) return cache;

            const mutate = (id: string) => {
                const msg = cache.get(id);
                if (!msg) return;
                remember(handledDeletes, id);

                const ignore = data.mlDeleted || (msg.flags & EPHEMERAL) === EPHEMERAL || shouldIgnore(msg);
                if (ignore) {
                    cache = cache.remove(id);
                    return;
                }

                // Déjà supprimé (affiché en rouge) : pas de deuxième entrée.
                if (!msg.deleted) logDeleted(msg, isBulk);
                // Copies des pièces jointes : on ne modifie jamais les objets
                // d'origine, partagés avec d'autres parties de Discord.
                cache = cache.update(id, (m: any) => m
                    .set("deleted", true)
                    .set("attachments", (m.attachments ?? []).map((a: any) => ({ ...a, deleted: true }))));
            };

            if (isBulk) data.ids?.forEach(mutate);
            else mutate(data.id);
        } catch (e) {
            logger.error("Error during handleDelete", e);
        }
        return cache;
    },

    // Remplacer un message en renvoyant un message avec le même « nonce » ne
    // compte pas comme une modification : on casse ce contournement.
    normalizeNonce(msg: Message) {
        try {
            if (!msg?.nonce || msg.author?.id === AuthenticationStore.getId()) return;
            const prevMsg = MessageStore.getMessage(msg.channel_id, msg.nonce);
            if (!prevMsg || prevMsg.state !== "SENT") return;
            if (prevMsg.id !== msg.id) delete msg.nonce;
        } catch (e) {
            logger.error("Error normalizing nonce", e);
        }
    },

    EditMarker({ message, className, children, ...props }: any) {
        return (
            <span
                {...props}
                className={classes("messagelogger-edit-marker", className)}
                onClick={() => openHistoryModal(message)}
                role="button"
            >
                {children}
            </span>
        );
    },

    DELETED_MESSAGE_COUNT: () => ({
        ast: [[
            6,
            "count",
            {
                "=0": [t("ml.deletedCount0")],
                one: [[1, "count"], ` ${t("ml.deletedCountOne")}`],
                other: [[1, "count"], ` ${t("ml.deletedCountOther")}`]
            },
            0,
            "cardinal"
        ]]
    }),

    patches: [
        {
            find: '"MessageStore"',
            replacement: [
                {
                    // MESSAGE_DELETE : le message est marqué supprimé au lieu d'être retiré
                    match: /(?<=MESSAGE_DELETE:function\((\i)\)\{)(?=let.{0,100}(\i\.\i)\.getOrCreate)/,
                    replace: `
                        let cache = $2.getOrCreate($1.channelId);
                        cache = $self.handleDelete(cache, $1, false);
                        $2.commit(cache);
                        return;
                    `
                },
                {
                    // MESSAGE_DELETE_BULK : idem pour les suppressions en masse
                    match: /(?<=MESSAGE_DELETE_BULK:function\((\i)\){)(?=let.{0,100}(\i\.\i)\.getOrCreate)/,
                    replace: `
                        let cache = $2.getOrCreate($1.channelId);
                        cache = $self.handleDelete(cache, $1, true);
                        $2.commit(cache);
                        return;
                    `
                },
                {
                    // MESSAGE_UPDATE : ancien texte ajouté à l'historique des modifications.
                    // Uniquement si la mise à jour contient vraiment un texte (les mises à
                    // jour d'aperçus de liens n'en ont pas).
                    match: /(MESSAGE_UPDATE:function\((\i)\).{0,200}?)\.update\((\i)/,
                    replace: `
                        $1
                        .update($3, m =>
                            (($2.message.flags & 64) === 64 || $self.shouldIgnore($2.message, true)) ? m :
                            $2.message.edited_timestamp && typeof $2.message.content === "string" && $2.message.content !== m.content ?
                                m.set('editHistory',[...(m.editHistory || []), $self.makeEdit($2.message, m)]) :
                                m
                        )
                        .update($3
                    `
                },
                {
                    // Flèche du haut (modifier son dernier message) : ignore les messages supprimés
                    match: /(?<=getLastEditableMessage\(\i\)\{.{0,200}\.find\((\i)=>)/,
                    replace: "!$1.deleted &&"
                }
            ]
        },
        {
            // Modèle de message
            find: "}addReaction(",
            replacement: [
                {
                    match: /this\.customRenderedContent=(\i)\.customRenderedContent,/,
                    replace: "this.customRenderedContent = $1.customRenderedContent," +
                        "this.deleted = $1.deleted || false," +
                        "this.editHistory = $1.editHistory || []," +
                        "this.firstEditTimestamp = $1.firstEditTimestamp || this.editedTimestamp || this.timestamp,"
                }
            ]
        },
        {
            // Transformation d'un message modifié
            find: ".PREMIUM_REFERRAL&&(",
            replacement: [
                {
                    match: /(?<=null!=\i\.edited_timestamp\)return )\i\(\i,\{reactions:(\i)\.reactions.{0,50}\}\)/,
                    replace: "Object.assign($&,{ deleted:$1.deleted, editHistory:$1.editHistory, firstEditTimestamp:$1.firstEditTimestamp })"
                },
                {
                    match: /attachments:(\i)\.attachments\?\?\[\],/,
                    predicate: () => settings.store.logDeletedAttachments,
                    replace: "attachments: $self.handleUpdateAttachments($1),"
                }
            ]
        },
        {
            // Affichage des pièces jointes
            find: "#{intl::REMOVE_ATTACHMENT_TOOLTIP_TEXT}",
            replacement: [
                {
                    match: /\.SPOILER,(?=\[\i\.\i\]:)(?<=item:(\i),.{0,200}?)/,
                    replace: '$&"messagelogger-deleted-attachment": $1?.originalItem?.deleted,'
                },
                {
                    match: /(?<=\{let\{[^}]*?item:(\i),autoPlayGif:\i,)canRemoveItem:(\i)(?=,onRemoveItem:)/,
                    replace: "_canRemoveItem:$2 = arguments[0].canRemoveItem && !$1?.originalItem?.deleted",
                }
            ]
        },
        {
            // Rendu d'un message : classe « supprimé »
            find: "Message must not be a thread starter message",
            replacement: [
                {
                    match: /\)\("li",\{(.+?),className:/,
                    replace: ")(\"li\",{$1,className:(arguments[0].message.deleted ? \"messagelogger-deleted \" : \"\")+"
                }
            ]
        },
        {
            // Contenu d'un message : historique des modifications
            find: ".SEND_FAILED,",
            replacement: {
                match: /\]:\i.isUnsupported.{0,20}?,children:\[/,
                replace: "$&arguments[0]?.message?.editHistory?.length>0&&$self.renderEdits(arguments[0]),"
            }
        },
        {
            find: "#{intl::MESSAGE_EDITED}",
            replacement: {
                // « (modifié) » cliquable : ouvre l'historique
                match: /(isInline:!1,children:.{0,50}?)"span",\{(?=className:)/,
                replace: "$1$self.EditMarker,{message:arguments[0].message,"
            }
        },
        {
            // Réponses : garder le message cité même s'il est supprimé
            find: '"ReferencedMessageStore"',
            replacement: [
                {
                    match: /(?<=MESSAGE_DELETE:function\(\i\)\{)/,
                    replace: "return;"
                },
                {
                    match: /(?<=MESSAGE_DELETE_BULK:function\(\i\)\{)/,
                    replace: "return;"
                }
            ]
        },
        {
            // Menu d'un message supprimé : retire les actions impossibles
            find: ".MESSAGE,commandTargetId:",
            replacement: [
                {
                    match: /children:(\[""===.+?\])/,
                    replace: "children:arguments[0].message.deleted?[]:$1"
                }
            ]
        },
        {
            find: "NON_COLLAPSIBLE.has(",
            replacement: {
                match: /if\((\i)\.blocked\)return \i\.\i\.MESSAGE_GROUP_BLOCKED;/,
                replace: '$&else if($1.deleted) return"MESSAGE_GROUP_DELETED";',
            },
            predicate: () => settings.store.collapseDeleted
        },
        {
            find: "#{intl::NEW_MESSAGES_ESTIMATED_WITH_DATE}",
            replacement: [
                {
                    match: /(\i).type===\i\.\i\.MESSAGE_GROUP_BLOCKED\|\|/,
                    replace: '$&$1.type==="MESSAGE_GROUP_DELETED"||',
                },
                {
                    match: /(\i).type===\i\.\i\.MESSAGE_GROUP_BLOCKED\?(\i)=.*?:/,
                    replace: '$&$1.type==="MESSAGE_GROUP_DELETED"?$2=$self.DELETED_MESSAGE_COUNT:',
                },
            ],
            predicate: () => settings.store.collapseDeleted
        },
        {
            find: "this.truncateTop",
            replacement: {
                match: /receiveMessage\((\i)\)\{/,
                replace: "$& $self.normalizeNonce($1);"
            }
        }
    ]
});
