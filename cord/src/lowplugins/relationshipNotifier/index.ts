/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * RelationshipNotifier — te prévient quand un ami te retire, qu'une demande
 * d'ami est annulée, ou que tu n'es plus sur un serveur / dans un groupe.
 * Pop-up en haut de l'écran + journal daté dans la fenêtre de réglages.
 */

import "./style.css";

import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";
import { findStoreLazy } from "@webpack";

import { onChannelDelete, onGuildDelete, onRelationshipRemove, removeFriend, removeGroup, removeGuild } from "./functions";
import { LogPanel } from "./LogPanel";
import settings from "./settings";
import { syncAndRunChecks, syncFriends, syncGroups, syncGuilds } from "./utils";

const GatewayConnectionStore = findStoreLazy("GatewayConnectionStore");

export default definePlugin({
    name: "RelationshipNotifier",
    description: "Notifies you when a friend, group chat, or server removes you.",
    tags: ["Friends", "Notifications"],
    authors: [Devs.nick],
    settings,
    settingsAboutComponent: LogPanel,

    patches: [
        // Ce que tu retires toi-même n'est pas signalé
        {
            find: "removeRelationship:(",
            replacement: {
                match: /(removeRelationship:\((\i),\i,\i\)=>)/,
                replace: "$1($self.removeFriend($2),0)||"
            }
        },
        {
            find: "async leaveGuild(",
            replacement: {
                match: /(leaveGuild\((\i)\){)/,
                replace: "$1$self.removeGuild($2);"
            }
        },
        {
            find: "},closePrivateChannel(",
            replacement: {
                match: /(closePrivateChannel\((\i)\){)/,
                replace: "$1$self.removeGroup($2);"
            }
        }
    ],

    flux: {
        GUILD_CREATE: syncGuilds,
        GUILD_DELETE: onGuildDelete,
        CHANNEL_CREATE: syncGroups,
        CHANNEL_UPDATES: syncGroups,
        CHANNEL_DELETE: onChannelDelete,
        RELATIONSHIP_ADD: syncFriends,
        RELATIONSHIP_UPDATE: syncFriends,
        RELATIONSHIP_REMOVE(e) {
            onRelationshipRemove(e);
            syncFriends();
        },
        CONNECTION_OPEN: syncAndRunChecks
    },

    start() {
        // Plugin activé alors que Discord est déjà connecté : CONNECTION_OPEN
        // est déjà passé, on lance la vérification nous-mêmes. Au démarrage de
        // Discord on attend CONNECTION_OPEN : avant, les listes (serveurs,
        // amis) ne viennent que du cache et sont incomplètes.
        let connected = false;
        try {
            connected = !!GatewayConnectionStore.isConnected?.();
        } catch {
            // store pas encore chargé : Discord démarre, CONNECTION_OPEN suivra
        }
        if (connected) syncAndRunChecks();
    },

    removeFriend,
    removeGroup,
    removeGuild
});
