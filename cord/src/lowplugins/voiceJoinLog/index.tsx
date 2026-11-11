/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// VoiceJoinLog — qui arrive et qui part dans le salon vocal où tu es.
// Les logs ne sont pris que pendant que tu es dans le salon. Clic droit sur
// un salon vocal → « Voir les logs de joins » : petite fenêtre avec l'heure,
// le compte (nom, @pseudo, ID) et ce qu'il a fait (rejoint, parti, déplacé).

import "./style.css";

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { addLowCordMenuItem } from "@lowcord/contextMenu";
import { t } from "@lowcord/i18n";
import definePlugin from "@utils/types";
import { Menu } from "@webpack/common";

import { countFor, loadLogs, onVoiceStates } from "./logs";
import { openLogWindow } from "./Window";

// Salon vocal (2) ou de conférence (13).
const VOICE_TYPES = new Set([2, 13]);

const channelMenu: NavContextMenuPatchCallback = (children, { channel }) => {
    if (!channel || !VOICE_TYPES.has(channel.type)) return;
    const n = countFor(channel.id);
    addLowCordMenuItem(children, "view", (
        <Menu.MenuItem
            id="lc-voice-join-log"
            label={n ? t("vjl.menuCount", { n }) : t("vjl.menu")}
            action={() => openLogWindow(channel)}
        />
    ), 30);
};

export default definePlugin({
    name: "VoiceJoinLog",
    description: "Logs who joins and leaves the voice channel you're in (only while you're in it). Right-click a voice channel → View join logs",
    authors: [],
    tags: ["Voice", "Utility"],

    contextMenus: {
        "channel-context": channelMenu,
    },

    flux: {
        VOICE_STATE_UPDATES: onVoiceStates,
    },

    start() {
        loadLogs();
    },
});
