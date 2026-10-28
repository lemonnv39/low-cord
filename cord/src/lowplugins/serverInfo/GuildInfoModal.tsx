/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import ErrorBoundary from "@components/ErrorBoundary";
import { I18nKey, t, useLang } from "@lowcord/i18n";
import { copyToClipboard } from "@utils/clipboard";
import { classNameFactory } from "@utils/css";
import { getGuildAcronym, openImageModal, openUserProfile } from "@utils/discord";
import { Logger } from "@utils/Logger";
import { useAwaiter } from "@utils/react";
import { Guild, RenderModalProps, User } from "@vencord/discord-types";
import { ChannelType } from "@vencord/discord-types/enums";
import { EmojiStore, FluxDispatcher, Forms, GuildChannelStore, GuildMemberCountStore, GuildMemberStore, GuildRoleStore, IconUtils, Modal, openModal, Parser, PresenceStore, RelationshipStore, ScrollerThin, showToast, SnowflakeUtils, StickersStore, TabBar, Text, Timestamp, useEffect, useMemo, useRef, UserStore, UserUtils, useState, useStateFromStores } from "@webpack/common";
import type { ReactNode } from "react";

const cl = classNameFactory("vc-gp-");
const logger = new Logger("ServerInfo");

export function openGuildInfoModal(guild: Guild) {
    openModal(props => (
        <ErrorBoundary>
            <GuildInfoModal guild={guild} modalProps={props} />
        </ErrorBoundary>
    ));
}

const enum Tabs {
    ServerInfo,
    Friends,
    BlockedUsers,
    IgnoredUsers
}

type ListType = "friends" | "blocked" | "ignored";

/** Lit une valeur sans jamais faire planter la fiche (store absent, API changée…). */
function safe<T>(read: () => T, fallback: T): T {
    try {
        return read() ?? fallback;
    } catch (e) {
        logger.warn("valeur indisponible", e);
        return fallback;
    }
}

function copy(text: string) {
    copyToClipboard(text);
    showToast({ text: t("common.copied"), variant: "success" });
}

function relationshipIds(type: ListType): string[] {
    return safe(() => {
        switch (type) {
            case "friends": return RelationshipStore.getFriendIDs();
            case "blocked": return RelationshipStore.getBlockedIDs();
            case "ignored": return RelationshipStore.getIgnoredIDs();
        }
    }, [] as string[]);
}

/** IDs de la liste présents dans le serveur — réactif sur l'arrivée des membres demandés. */
function useMembersOf(guildId: string, type: ListType) {
    const ids = useMemo(() => relationshipIds(type), [type]);
    const membersKey = useStateFromStores(
        [GuildMemberStore],
        () => ids.filter(id => GuildMemberStore.isMember(guildId, id)).join(","),
        [ids, guildId]
    );
    const members = useMemo(() => (membersKey ? membersKey.split(",") : []), [membersKey]);
    return { ids, members };
}

function GuildInfoModal({ guild, modalProps }: { guild: Guild; modalProps: RenderModalProps; }) {
    useLang();
    const [currentTab, setCurrentTab] = useState(Tabs.ServerInfo);

    // Une seule demande de membres par liste et par fenêtre (plus de drapeau global partagé).
    const requested = useRef(new Set<ListType>());
    const [visited, setVisited] = useState<ListType[]>([]);

    const friends = useMembersOf(guild.id, "friends");
    const blocked = useMembersOf(guild.id, "blocked");
    const ignored = useMembersOf(guild.id, "ignored");

    function requestMissing(type: ListType, ids: string[]) {
        if (requested.current.has(type)) return;
        requested.current.add(type);
        setVisited(v => [...v, type]);
        const missing = ids.filter(id => !GuildMemberStore.isMember(guild.id, id));
        if (!missing.length) return;
        FluxDispatcher.dispatch({ type: "GUILD_MEMBERS_REQUEST", guildIds: [guild.id], userIds: missing });
    }

    const bannerUrl = guild.banner
        ? safe(() => IconUtils.getGuildBannerURL(guild, true)?.replace(/\?size=\d+$/, "?size=1024") ?? null, null)
        : null;
    const iconUrl = guild.icon
        ? safe(() => IconUtils.getGuildIconURL({ id: guild.id, icon: guild.icon, canAnimate: true, size: 512 }) ?? null, null)
        : null;

    // Compteur affiché une fois la liste chargée (ou dès qu'au moins un membre est connu).
    const countOf = (type: ListType, members: string[]) =>
        visited.includes(type) || members.length > 0 ? members.length : null;

    const tabs: [Tabs, I18nKey, number | null][] = [
        [Tabs.ServerInfo, "si.tabInfo", null],
        [Tabs.Friends, "si.tabFriends", countOf("friends", friends.members)],
        [Tabs.BlockedUsers, "si.tabBlocked", countOf("blocked", blocked.members)],
        [Tabs.IgnoredUsers, "si.tabIgnored", countOf("ignored", ignored.members)],
    ];

    return (
        <Modal
            {...modalProps}
            size="lg"
            title={
                <div className={cl("header")}>
                    {iconUrl
                        ? <img
                            className={cl("icon")}
                            src={iconUrl}
                            alt=""
                            onClick={() => openImageModal({ url: iconUrl, height: 512, width: 512 })}
                        />
                        : <div aria-hidden className={cl("acronym")}>{getGuildAcronym(guild)}</div>
                    }
                    <div className={cl("name-and-description")}>
                        <Forms.FormTitle tag="h5" className={cl("name")}>{guild.name}</Forms.FormTitle>
                        {guild.description && <Forms.FormText>{guild.description}</Forms.FormText>}
                    </div>
                </div>
            }
        >
            {bannerUrl && currentTab === Tabs.ServerInfo && (
                <img
                    className={cl("banner")}
                    src={bannerUrl}
                    alt=""
                    onClick={() => openImageModal({ url: bannerUrl, width: 1024 })}
                />
            )}

            <TabBar
                type="top"
                look="brand"
                className={cl("tab-bar")}
                selectedItem={currentTab}
                onItemSelect={setCurrentTab}
            >
                {tabs.map(([id, label, count]) => (
                    <TabBar.Item key={id} className={cl("tab", { selected: currentTab === id })} id={id}>
                        {t(label)}{count !== null ? ` (${count})` : ""}
                    </TabBar.Item>
                ))}
            </TabBar>

            <div className={cl("tab-content")}>
                {currentTab === Tabs.ServerInfo && <ServerInfoTab guild={guild} />}
                {currentTab === Tabs.Friends && <UserList guild={guild} members={friends.members} onOpen={() => requestMissing("friends", friends.ids)} />}
                {currentTab === Tabs.BlockedUsers && <UserList guild={guild} members={blocked.members} onOpen={() => requestMissing("blocked", blocked.ids)} />}
                {currentTab === Tabs.IgnoredUsers && <UserList guild={guild} members={ignored.members} onOpen={() => requestMissing("ignored", ignored.ids)} />}
            </div>
        </Modal>
    );
}

// ── Onglet Infos ─────────────────────────────────────────────────────────

function Owner({ guildId, owner }: { guildId: string; owner: User; }) {
    const guildAvatar = GuildMemberStore.getMember(guildId, owner.id)?.avatar;
    const ownerAvatarUrl = safe(() => (guildAvatar
        ? IconUtils.getGuildMemberAvatarURLSimple({ userId: owner.id, avatar: guildAvatar, guildId, canAnimate: true })
        : IconUtils.getUserAvatarURL(owner, true)), "");

    return (
        <div className={cl("owner")}>
            {ownerAvatarUrl && (
                <img
                    className={cl("owner-avatar")}
                    src={ownerAvatarUrl}
                    alt=""
                    onClick={() => openImageModal({ url: ownerAvatarUrl, height: 512, width: 512 })}
                />
            )}
            {Parser.parse(`<@${owner.id}>`)}
        </div>
    );
}

function Copyable({ text, label = text }: { text: string; label?: string; }) {
    return <span className={cl("copyable")} title={t("common.clickToCopy")} onClick={() => copy(text)}>{label}</span>;
}

const ts = (ms: number) => <Timestamp timestamp={new Date(ms)} />;
const num = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) ? n.toLocaleString() : "-");
const label = (prefix: string, value: number | undefined) => {
    const key = `${prefix}.${value}` as I18nKey;
    return value != null ? t(key) ?? String(value) : "-";
};

/** "COMMUNITY" -> "Community", "ANIMATED_ICON" -> "Animated Icon" */
const featureLabel = (f: string) => f.toLowerCase().split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

function ServerInfoTab({ guild }: { guild: Guild; }) {
    const [owner, , ownerPending] = useAwaiter(() => UserUtils.getUser(guild.ownerId), {
        deps: [guild.ownerId],
        fallbackValue: null
    });

    // Store filtré : s'il manquait, useStateFromStores planterait toute la fenêtre.
    const counts = useStateFromStores([GuildMemberCountStore].filter(Boolean), () => ({
        members: safe(() => GuildMemberCountStore.getMemberCount(guild.id), null as number | null),
        online: safe(() => GuildMemberCountStore.getOnlineCount(guild.id), null as number | null),
    }), [guild.id], (a, b) => a.members === b.members && a.online === b.online);

    const channels = safe(() => GuildChannelStore.getChannels(guild.id), null);
    const text = channels?.SELECTABLE?.length;
    const voice = channels?.VOCAL?.length;
    // Discord ajoute une fausse catégorie « null » (salons sans catégorie) : exclue.
    const categories = channels?.[ChannelType.GUILD_CATEGORY]?.filter(c => c?.channel && c.channel.id !== "null").length;

    const roles = safe(() => GuildRoleStore.getSortedRoles(guild.id).length - 1, null as number | null); // - @everyone
    const emojis = safe(() => EmojiStore.getGuildEmoji(guild.id).length, null as number | null);
    const stickers = safe(() => StickersStore.getStickersByGuildId(guild.id)?.length ?? 0, null as number | null);

    const joinedAt = safe(() => (guild.joinedAt ? new Date(guild.joinedAt).getTime() : null), null as number | null);
    const features = safe(() => [...(guild.features ?? [])].sort(), [] as string[]);

    const sections: [I18nKey, [I18nKey, ReactNode][]][] = [
        ["si.general", [
            ["si.owner", owner ? <Owner key="owner" guildId={guild.id} owner={owner} /> : ownerPending ? t("common.loading") : "-"],
            ["si.id", <Copyable key="id" text={guild.id} />],
            ["si.created", ts(SnowflakeUtils.extractTimestamp(guild.id))],
            ["si.joined", joinedAt ? ts(joinedAt) : "-"], // indisponible si serveur seulement « visité »
            ["si.vanity", guild.vanityURLCode ? <Copyable key="vanity" text={`https://discord.gg/${guild.vanityURLCode}`} label={`discord.gg/${guild.vanityURLCode}`} /> : "-"],
            ["si.locale", guild.preferredLocale || "-"],
        ]],
        ["si.members", [
            ["si.memberCount", num(counts.members)],
            ["si.online", num(counts.online)],
            ["si.maxMembers", num(guild.maxMembers)],
        ]],
        ["si.content", [
            ["si.textChannels", num(text)],
            ["si.voiceChannels", num(voice)],
            ["si.categories", num(categories)],
            ["si.roles", num(roles)],
            ["si.emojis", num(emojis)],
            ["si.stickers", num(stickers)],
        ]],
        ["si.security", [
            ["si.verification", label("si.verif", guild.verificationLevel)],
            ["si.contentFilter", label("si.filter", guild.explicitContentFilter)],
            ["si.mfa", t(guild.mfaLevel === 1 ? "common.yes" : "common.no")],
            ["si.nsfw", label("si.nsfw", guild.nsfwLevel)],
            ["si.notifications", label("si.notif", guild.defaultMessageNotifications)],
        ]],
        ["si.boosts", [
            ["si.boostCount", num(guild.premiumSubscriberCount ?? 0)],
            ["si.boostLevel", String(guild.premiumTier ?? 0)],
            ["si.progressBar", t(guild.premiumProgressBarEnabled ? "common.yes" : "common.no")],
        ]],
    ];

    return (
        <div className={cl("sections")}>
            {sections.map(([title, fields]) => (
                <section key={title}>
                    <Text variant="text-xs/bold" className={cl("section-title")}>{t(title)}</Text>
                    <div className={cl("info")}>
                        {fields.map(([name, node]) => (
                            <div className={cl("server-info-pair")} key={name}>
                                <Forms.FormTitle tag="h5">{t(name)}</Forms.FormTitle>
                                {typeof node === "string" ? <span>{node}</span> : node}
                            </div>
                        ))}
                    </div>
                </section>
            ))}

            {features.length > 0 && (
                <section>
                    <Text variant="text-xs/bold" className={cl("section-title")}>{t("si.features")} ({features.length})</Text>
                    <div className={cl("features")}>
                        {features.map(f => <span key={f} className={cl("feature")}>{featureLabel(f)}</span>)}
                    </div>
                </section>
            )}
        </div>
    );
}

// ── Listes amis / bloqués / ignorés ──────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
    online: "var(--status-positive, #23a55a)",
    idle: "var(--status-warning, #f0b232)",
    dnd: "var(--status-danger, #f23f43)",
    streaming: "#593695",
};

function UserRow({ userId, guildId }: { userId: string; guildId: string; }) {
    const user = UserStore.getUser(userId);
    const status = useStateFromStores([PresenceStore], () => safe(() => PresenceStore.getStatus(userId), "offline"), [userId]);
    if (!user) return null;

    const nick = GuildMemberStore.getMember(guildId, userId)?.nick;
    const avatar = safe(() => user.getAvatarURL(guildId, 40, false), "");

    return (
        <div className={cl("user-row")} role="button" tabIndex={0} onClick={() => openUserProfile(userId)}>
            <div className={cl("user-avatar-wrap")}>
                {avatar && <img className={cl("user-avatar")} src={avatar} alt="" />}
                <span className={cl("user-status")} style={{ backgroundColor: STATUS_COLOR[status] ?? "var(--status-offline, #80848e)" }} />
            </div>
            <div className={cl("user-names")}>
                <Text variant="text-md/semibold">{nick ?? user.globalName ?? user.username}</Text>
                <Text variant="text-xs/normal" className={cl("muted")}>@{user.username}</Text>
            </div>
        </div>
    );
}

function UserList({ guild, members, onOpen }: { guild: Guild; members: string[]; onOpen(): void; }) {
    // Demande les membres manquants à la première ouverture de l'onglet.
    useEffect(onOpen, []);

    if (!members.length) return <Text variant="text-sm/normal" className={cl("muted")}>{t("si.emptyList")}</Text>;

    return (
        <ScrollerThin fade className={cl("scroller")}>
            {members.map(id => (
                <ErrorBoundary noop key={id}>
                    <UserRow userId={id} guildId={guild.id} />
                </ErrorBoundary>
            ))}
        </ScrollerThin>
    );
}
