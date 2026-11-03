/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * ViewIcons — voir les images en grand :
 *  - clic sur l'avatar ou la bannière du profil de quelqu'un (popout, profil
 *    complet, panneau des MP). Jamais sur ton propre profil ni dans l'éditeur
 *    de profil, où le clic sert à changer l'image.
 *  - clic droit sur une personne, un serveur ou un groupe : « Voir l'avatar »,
 *    « Voir la bannière », « Voir l'icône »…
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { ImageIcon } from "@components/Icons";
import { t } from "@lowcord/i18n";
import { openFullImage, ProfileImageKind, setProfileImageHandler } from "@lowcord/profileImages";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import type { Channel, Guild, User } from "@vencord/discord-types";
import { GuildMemberStore, IconUtils, Menu, UserProfileStore } from "@webpack/common";

const settings = definePluginSettings({
    format: {
        type: OptionType.SELECT,
        description: "Format of still images (animated images keep their format)",
        options: [
            { label: "webp", value: "webp", default: true },
            { label: "png", value: "png" },
            { label: "jpg", value: "jpg" },
        ],
    },
    imgSize: {
        type: OptionType.SELECT,
        description: "Size of the enlarged image",
        options: ["256", "512", "1024", "2048", "4096"].map(n => ({ label: n, value: n, default: n === "1024" })),
    },
});

function open(url: string | null | undefined, kind: ProfileImageKind) {
    if (!url) return;
    openFullImage(url, kind, Number(settings.store.imgSize) || 1024, settings.store.format);
}

function item(id: string, label: string, action: () => void) {
    return <Menu.MenuItem id={id} key={id} label={label} action={action} leadingAccessory={{ type: "icon", icon: ImageIcon }} />;
}

const UserContext: NavContextMenuPatchCallback = (children, { user, guildId }: { user?: User; guildId?: string; }) => {
    if (!user) return;
    const memberAvatar = guildId ? GuildMemberStore.getMember(guildId, user.id)?.avatar : null;
    const decoration = user.avatarDecorationData;
    // Bannière : connue seulement si le profil a déjà été chargé (ouvert une fois).
    const banner = UserProfileStore.getUserProfile(user.id)?.banner;

    children.splice(-1, 0, (
        <Menu.MenuGroup key="vc-view-icons">
            {item("vc-view-avatar", t("vi.avatar"), () => open(IconUtils.getUserAvatarURL(user, true), "avatar"))}
            {memberAvatar && item("vc-view-server-avatar", t("vi.serverAvatar"), () => open(IconUtils.getGuildMemberAvatarURLSimple({
                userId: user.id,
                avatar: memberAvatar,
                guildId: guildId!,
                canAnimate: true,
            }), "avatar"))}
            {banner && item("vc-view-banner", t("vi.banner"), () => open(IconUtils.getUserBannerURL({ id: user.id, banner, canAnimate: true, size: 1024 }), "banner"))}
            {decoration && item("vc-view-decoration", t("vi.decoration"), () => open(IconUtils.getAvatarDecorationURL({
                avatarDecoration: decoration,
                size: 1024,
                canAnimate: true,
            }), "avatar"))}
        </Menu.MenuGroup>
    ));
};

const GuildContext: NavContextMenuPatchCallback = (children, { guild }: { guild?: Guild; }) => {
    if (!guild || (!guild.icon && !guild.banner)) return;

    children.splice(-1, 0, (
        <Menu.MenuGroup key="vc-view-icons">
            {guild.icon && item("vc-view-icon", t("vi.icon"), () => open(IconUtils.getGuildIconURL({ id: guild.id, icon: guild.icon, canAnimate: true }), "avatar"))}
            {guild.banner && item("vc-view-guild-banner", t("vi.banner"), () => open(IconUtils.getGuildBannerURL(guild, true), "banner"))}
        </Menu.MenuGroup>
    ));
};

const GroupDMContext: NavContextMenuPatchCallback = (children, { channel }: { channel?: Channel; }) => {
    // Groupe sans image : rien à voir.
    if (!channel?.icon) return;

    children.splice(-1, 0, (
        <Menu.MenuGroup key="vc-view-icons">
            {item("vc-view-group-icon", t("vi.icon"), () => open(IconUtils.getChannelIconURL(channel), "avatar"))}
        </Menu.MenuGroup>
    ));
};

export default definePlugin({
    name: "ViewIcons",
    description: "Click the avatar or banner of someone's profile to enlarge it, and view avatars, banners and server/group icons from the right-click menu.",
    tags: ["Media", "Servers", "Appearance"],
    authors: [Devs.Ven, Devs.TheKodeToad, Devs.Nuckyz, Devs.nyx],
    dependencies: ["DynamicImageModalAPI"],
    settings,

    contextMenus: {
        "user-context": UserContext,
        "guild-context": GuildContext,
        "gdm-context": GroupDMContext,
    },

    start() {
        setProfileImageHandler("click", "ViewIcons", image => open(image.url, image.kind));
    },

    stop() {
        setProfileImageHandler("click", "ViewIcons", null);
    },
});
