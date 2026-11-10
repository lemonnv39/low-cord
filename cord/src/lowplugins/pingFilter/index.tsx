/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// PingFilter — régler les notifications (pings, mentions) de tous ses
// serveurs d'un coup, depuis les réglages du plugin :
//  - on repart de la base (serveurs démutés, réglages par salon effacés),
//  - puis on pose le choix : aucune notification, seulement quand on me
//    mentionne, mentions + @everyone/@here, tous les messages, ou défaut ;
//  - barre de progression, récapitulatif, et « Annuler » (état d'avant).
// Journal : applications faites, et ghost pings repérés (mention supprimée
// ou retirée en modifiant le message).
//
// Inspiré du plugin MuteAllServers (même appel de réglages Discord).

import "./style.css";

import { t } from "@lowcord/i18n";
import definePlugin from "@utils/types";
import { showToast } from "@webpack/common";

import { startGhostWatch, stopGhostWatch } from "./ghost";
import { loadLogs } from "./logs";
import { settings } from "./settings";

export default definePlugin({
    name: "PingFilter",
    description: "Set the notifications (pings, mentions) of all your servers at once, with a progress bar, a summary, undo, and a ghost ping log",
    authors: [],
    tags: ["Notifications", "Servers"],
    settings,

    start() {
        loadLogs();
        startGhostWatch(() => settings.store.ghostWatch, g => {
            if (settings.store.ghostToast) showToast({ text: t("pf.ghostToastText", { author: g.author, where: g.guild ? `${g.guild} · ${g.channel}` : g.channel }) });
        });
    },

    stop() {
        stopGhostWatch();
    },
});
