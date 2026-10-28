/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { isPluginEnabled } from "@api/PluginManager";
import ErrorBoundary from "@components/ErrorBoundary";
import { I18nKey, t, useLang } from "@lowcord/i18n";
import PermissionsViewerPlugin from "@lowplugins/permissionsViewer";
import openRolesAndUsersPermissionsModal from "@lowplugins/permissionsViewer/components/RolesAndUsersPermissions";
import { sortPermissionOverwrites } from "@lowplugins/permissionsViewer/utils";
import { openUserProfile } from "@utils/discord";
import { classes } from "@utils/misc";
import type { Channel, RoleOrUserPermission } from "@vencord/discord-types";
import { findByPropsLazy, findComponentByCodeLazy, findCssClassesLazy } from "@webpack";
import { ChannelStore, EmojiStore, FluxDispatcher, GuildMemberStore, GuildStore, Parser, PermissionsBits, PermissionStore, SnowflakeUtils, Text, Timestamp, Tooltip, useEffect, UserStore, useState, useStateFromStores, VoiceStateStore } from "@webpack/common";
import { ComponentType, ReactNode } from "react";

import { cl, settings } from "..";

const enum ChannelFlags {
    REQUIRE_TAG = 1 << 4
}

const ChatScrollClasses = findCssClassesLazy("auto", "managedReactiveScroller", "customTheme");
const TagComponent = findComponentByCodeLazy("#{intl::FORUM_TAG_A11Y_FILTER_BY_TAG}");

let ChannelBeginHeader: ComponentType<any> = () => null;
export const setChannelBeginHeader = v => ChannelBeginHeader = v;

const EmojiParser = findByPropsLazy("convertSurrogateToName");
const EmojiUtils = findByPropsLazy("getURL", "getEmojiColors");

// Icône de la fenêtre « lien vers un message auquel tu n'as pas accès »
const HiddenChannelLogo = "/assets/433e3ec4319a9d11b0cbe39342614982.svg";

/** 3600 -> "1 h", 90 -> "1 min 30 s" (unités traduites). */
function formatDuration(seconds: number) {
    const parts: string[] = [];
    let rest = Math.max(0, Math.round(seconds));
    for (const [unit, size] of [["shc.unit.d", 86400], ["shc.unit.h", 3600], ["shc.unit.min", 60], ["shc.unit.s", 1]] as const) {
        const n = Math.floor(rest / size);
        if (n > 0) parts.push(`${n} ${t(unit)}`);
        rest -= n * size;
    }
    return parts.join(" ") || `0 ${t("shc.unit.s")}`;
}

function Info({ label, children }: { label: string; children: ReactNode; }) {
    return (
        <Text variant="text-md/normal" className={cl("info-row")}>
            <span className={cl("info-label")}>{label} :</span> {children}
        </Text>
    );
}

/** Membres actuellement connectés dans le vocal caché (Discord envoie les états vocaux de tout le serveur). */
function VoiceConnected({ channel }: { channel: Channel; }) {
    const userIds = useStateFromStores(
        [VoiceStateStore],
        () => Object.keys(VoiceStateStore.getVoiceStatesForChannel(channel.id) ?? {}).join(","),
        [channel.id]
    );
    const ids = userIds ? userIds.split(",") : [];
    if (!ids.length) return null;

    return (
        <div className={cl("voice-container")}>
            <Text variant="text-lg/bold">{t("shc.inVoice", { count: ids.length })}</Text>
            <div className={cl("voice-users")}>
                {ids.map(id => {
                    const user = UserStore.getUser(id);
                    if (!user) return null;
                    const name = GuildMemberStore.getMember(channel.guild_id, id)?.nick ?? user.globalName ?? user.username;
                    return (
                        <div key={id} className={cl("voice-user")} role="button" tabIndex={0} onClick={() => openUserProfile(id)}>
                            <img className={cl("voice-avatar")} src={user.getAvatarURL(channel.guild_id, 32, false)} alt="" />
                            <Text variant="text-sm/medium">{name}</Text>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function HiddenChannelLockScreen({ channel }: { channel: Channel; }) {
    useLang();
    const { defaultAllowedUsersAndRolesDropdownState } = settings.use(["defaultAllowedUsersAndRolesDropdownState"]);
    const [permissions, setPermissions] = useState<RoleOrUserPermission[]>([]);

    const {
        type,
        topic,
        lastMessageId,
        defaultForumLayout,
        lastPinTimestamp,
        defaultAutoArchiveDuration,
        availableTags,
        id: channelId,
        rateLimitPerUser,
        defaultThreadRateLimitPerUser,
        defaultSortOrder,
        defaultReactionEmoji,
        bitrate,
        rtcRegion,
        videoQualityMode,
        guild_id
    } = channel;
    const permissionOverwrites = channel.permissionOverwrites ?? {};

    const isVoice = channel.isGuildVoice() || channel.isGuildStageVoice();
    const isForum = channel.isForumChannel();
    const permViewerOn = isPluginEnabled(PermissionsViewerPlugin.name);

    useEffect(() => {
        const membersToFetch = new Set<string>();

        const guildOwnerId = GuildStore.getGuild(guild_id)?.ownerId;
        if (guildOwnerId && !GuildMemberStore.getMember(guild_id, guildOwnerId)) membersToFetch.add(guildOwnerId);

        for (const { type, id } of Object.values(permissionOverwrites)) {
            if (type === 1 && id && !GuildMemberStore.getMember(guild_id, id)) membersToFetch.add(id);
        }

        if (membersToFetch.size > 0) {
            FluxDispatcher.dispatch({ type: "GUILD_MEMBERS_REQUEST", guildIds: [guild_id], userIds: [...membersToFetch] });
        }

        if (permViewerOn) {
            setPermissions(sortPermissionOverwrites(Object.values(permissionOverwrites).map(overwrite => ({
                type: overwrite.type,
                id: overwrite.id,
                overwriteAllow: overwrite.allow,
                overwriteDeny: overwrite.deny
            })), guild_id));
        }
    }, [channelId]);

    const typeKey = `shc.type.${type}` as I18nKey;
    const typeName = t(typeKey) ?? t("shc.type.other");
    const state = t(!PermissionStore.can(PermissionsBits.VIEW_CHANNEL, channel) ? "shc.hidden" : "shc.locked");
    const category = channel.parent_id ? ChannelStore.getChannel(channel.parent_id)?.name : null;

    return (
        <div className={classes(ChatScrollClasses.auto, ChatScrollClasses.customTheme, ChatScrollClasses.managedReactiveScroller)}>
            <div className={cl("container")}>
                <img className={cl("logo")} src={HiddenChannelLogo} alt="" />

                <div className={cl("heading-container")}>
                    <Text variant="heading-xxl/bold">{t("shc.title", { type: typeName, state }).replace(/\s+/g, " ")}</Text>
                    {channel.isNSFW() &&
                        <Tooltip text="NSFW">
                            {({ onMouseLeave, onMouseEnter }) => (
                                <svg
                                    onMouseLeave={onMouseLeave}
                                    onMouseEnter={onMouseEnter}
                                    className={cl("heading-nsfw-icon")}
                                    width="32"
                                    height="32"
                                    viewBox="0 0 48 48"
                                    aria-hidden={true}
                                    role="img"
                                >
                                    <path fill="currentColor" d="M.7 43.05 24 2.85l23.3 40.2Zm23.55-6.25q.75 0 1.275-.525.525-.525.525-1.275 0-.75-.525-1.3t-1.275-.55q-.8 0-1.325.55-.525.55-.525 1.3t.55 1.275q.55.525 1.3.525Zm-1.85-6.1h3.65V19.4H22.4Z" />
                                </svg>
                            )}
                        </Tooltip>
                    }
                </div>

                {!isVoice && (
                    <Text variant="text-lg/normal">
                        {t(isForum ? "shc.cantSeePosts" : "shc.cantSeeMessages")}
                        {isForum && topic && topic.length > 0 && ` ${t("shc.guidelines")}`}
                    </Text>
                )}

                {topic && topic.length > 0 && (
                    <ErrorBoundary noop>
                        {!isForum && <Text variant="text-lg/bold">{t("shc.topic")}</Text>}
                        <div className={cl("topic-container")}>
                            {Parser.parseTopic(topic, false, { channelId })}
                        </div>
                    </ErrorBoundary>
                )}

                <div className={cl("infos")}>
                    <Info label={t("shc.id")}>{channelId}</Info>
                    <Info label={t("shc.created")}><Timestamp timestamp={new Date(SnowflakeUtils.extractTimestamp(channelId))} /></Info>
                    {category && <Info label={t("shc.category")}>{category}</Info>}
                    {lastMessageId &&
                        <Info label={t(isForum ? "shc.lastPost" : "shc.lastMessage")}>
                            <Timestamp timestamp={new Date(SnowflakeUtils.extractTimestamp(lastMessageId))} />
                        </Info>
                    }
                    {lastPinTimestamp &&
                        <Info label={t("shc.lastPin")}><Timestamp timestamp={new Date(lastPinTimestamp)} /></Info>
                    }
                    {(rateLimitPerUser ?? 0) > 0 &&
                        <Info label={t("shc.slowmode")}>{formatDuration(rateLimitPerUser!)}</Info>
                    }
                    {(defaultThreadRateLimitPerUser ?? 0) > 0 &&
                        <Info label={t("shc.threadSlowmode")}>{formatDuration(defaultThreadRateLimitPerUser!)}</Info>
                    }
                    {isVoice && bitrate != null &&
                        <Info label={t("shc.bitrate")}>{Math.round(bitrate / 1000)} kbps</Info>
                    }
                    {isVoice &&
                        <Info label={t("shc.userLimit")}>{channel.userLimit > 0 ? channel.userLimit : t("shc.unlimited")}</Info>
                    }
                    {isVoice &&
                        <Info label={t("shc.region")}>{rtcRegion ?? t("shc.auto")}</Info>
                    }
                    {isVoice &&
                        <Info label={t("shc.videoQuality")}>{videoQualityMode === 2 ? "720p" : t("shc.auto")}</Info>
                    }
                    {(defaultAutoArchiveDuration ?? 0) > 0 &&
                        <Info label={t(isForum ? "shc.archivePosts" : "shc.archiveThreads")}>{formatDuration(defaultAutoArchiveDuration! * 60)}</Info>
                    }
                    {defaultForumLayout != null &&
                        <Info label={t("shc.layout")}>{t(`shc.layout.${defaultForumLayout}` as I18nKey) ?? String(defaultForumLayout)}</Info>
                    }
                    {defaultSortOrder != null &&
                        <Info label={t("shc.sort")}>{t(`shc.sort.${defaultSortOrder}` as I18nKey) ?? String(defaultSortOrder)}</Info>
                    }
                </div>

                {defaultReactionEmoji != null &&
                    <ErrorBoundary noop>
                        <div className={cl("default-emoji-container")}>
                            <Text variant="text-md/normal">{t("shc.reaction")} :</Text>
                            {Parser.defaultRules[defaultReactionEmoji.emojiName ? "emoji" : "customEmoji"].react({
                                name: defaultReactionEmoji.emojiName
                                    ? EmojiParser.convertSurrogateToName(defaultReactionEmoji.emojiName)
                                    : EmojiStore.getCustomEmojiById(defaultReactionEmoji.emojiId)?.name ?? "",
                                emojiId: defaultReactionEmoji.emojiId ?? void 0,
                                surrogate: defaultReactionEmoji.emojiName ?? void 0,
                                src: defaultReactionEmoji.emojiName
                                    ? EmojiUtils.getURL(defaultReactionEmoji.emojiName)
                                    : void 0
                            }, void 0, { key: 0 })}
                        </div>
                    </ErrorBoundary>
                }
                {channel.hasFlag(ChannelFlags.REQUIRE_TAG) &&
                    <Text variant="text-md/normal">{t("shc.requireTag")}</Text>
                }
                {availableTags && availableTags.length > 0 &&
                    <ErrorBoundary noop>
                        <div className={cl("tags-container")}>
                            <Text variant="text-lg/bold">{t("shc.tags")}</Text>
                            <div className={cl("tags")}>
                                {availableTags.map(tag => <TagComponent tag={tag} key={tag.id} />)}
                            </div>
                        </div>
                    </ErrorBoundary>
                }

                {isVoice && <ErrorBoundary noop><VoiceConnected channel={channel} /></ErrorBoundary>}

                <div className={cl("allowed-users-and-roles-container")}>
                    <div className={cl("allowed-users-and-roles-container-title")}>
                        {permViewerOn && (
                            <Tooltip text={t("shc.permDetails")}>
                                {({ onMouseLeave, onMouseEnter }) => (
                                    <button
                                        onMouseLeave={onMouseLeave}
                                        onMouseEnter={onMouseEnter}
                                        className={cl("allowed-users-and-roles-container-permdetails-btn")}
                                        onClick={() => {
                                            const guild = GuildStore.getGuild(channel.guild_id);
                                            if (guild) openRolesAndUsersPermissionsModal(permissions, guild, channel.name);
                                        }}
                                    >
                                        <svg
                                            width="24"
                                            height="24"
                                            viewBox="0 0 24 24"
                                        >
                                            <path fill="currentColor" d="M7 12.001C7 10.8964 6.10457 10.001 5 10.001C3.89543 10.001 3 10.8964 3 12.001C3 13.1055 3.89543 14.001 5 14.001C6.10457 14.001 7 13.1055 7 12.001ZM14 12.001C14 10.8964 13.1046 10.001 12 10.001C10.8954 10.001 10 10.8964 10 12.001C10 13.1055 10.8954 14.001 12 14.001C13.1046 14.001 14 13.1055 14 12.001ZM19 10.001C20.1046 10.001 21 10.8964 21 12.001C21 13.1055 20.1046 14.001 19 14.001C17.8954 14.001 17 13.1055 17 12.001C17 10.8964 17.8954 10.001 19 10.001Z" />
                                        </svg>
                                    </button>
                                )}
                            </Tooltip>
                        )}
                        <Text variant="text-lg/bold">{t("shc.allowed")}</Text>
                        <Tooltip text={t(defaultAllowedUsersAndRolesDropdownState ? "shc.hideAllowed" : "shc.showAllowed")}>
                            {({ onMouseLeave, onMouseEnter }) => (
                                <button
                                    onMouseLeave={onMouseLeave}
                                    onMouseEnter={onMouseEnter}
                                    className={cl("allowed-users-and-roles-container-toggle-btn")}
                                    onClick={() => settings.store.defaultAllowedUsersAndRolesDropdownState = !defaultAllowedUsersAndRolesDropdownState}
                                >
                                    <svg
                                        width="24"
                                        height="24"
                                        viewBox="0 0 24 24"
                                        transform={defaultAllowedUsersAndRolesDropdownState ? "scale(1 -1)" : "scale(1 1)"}
                                    >
                                        <path fill="currentColor" d="M16.59 8.59003L12 13.17L7.41 8.59003L6 10L12 16L18 10L16.59 8.59003Z" />
                                    </svg>
                                </button>
                            )}
                        </Tooltip>
                    </div>
                    {defaultAllowedUsersAndRolesDropdownState && <ErrorBoundary noop><ChannelBeginHeader channel={channel} /></ErrorBoundary>}
                </div>
            </div>
        </div>
    );
}

export default ErrorBoundary.wrap(HiddenChannelLockScreen);
