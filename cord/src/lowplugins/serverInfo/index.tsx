/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * ServerInfo — fiche complète d'un serveur (clic droit sur le serveur ou menu
 * de l'en-tête → « Infos du serveur ») : infos générales, membres, contenu,
 * sécurité, boosts, fonctionnalités, et tes amis / bloqués / ignorés présents.
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { InfoIcon } from "@components/Icons";
import { addLowCordMenuItem } from "@lowcord/contextMenu";
import { t } from "@lowcord/i18n";
import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { Guild } from "@vencord/discord-types";
import { Menu } from "@webpack/common";

import { openGuildInfoModal } from "./GuildInfoModal";

const makePatch: (showIcon: boolean) => NavContextMenuPatchCallback = showIcon => (children, props: { guild?: Guild; }) => {
    const guild = props?.guild;
    if (!guild) return;

    addLowCordMenuItem(children, "view", (
        <Menu.MenuItem
            id="vc-server-info"
            key="vc-server-info"
            label={t("si.menu")}
            leadingAccessory={showIcon ? { type: "icon", icon: InfoIcon } : undefined}
            action={() => openGuildInfoModal(guild)}
        />
    ), 30);
};

export default definePlugin({
    name: "ServerInfo",
    description: "Allows you to view info about a server",
    tags: ["Servers", "Utility"],
    authors: [Devs.Ven, Devs.Nuckyz],
    dependencies: ["DynamicImageModalAPI"],
    searchTerms: ["guild", "info", "ServerProfile"],

    contextMenus: {
        "guild-context": makePatch(false),
        "guild-header-popout": makePatch(true)
    }
});
