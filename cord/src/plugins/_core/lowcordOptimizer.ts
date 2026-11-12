/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — moteur de la section « Optimisation » (onglet low-cord).
// Toujours chargé, invisible dans la liste des plugins : il ne fait rien tant
// qu'aucune optimisation n'est activée. Voir src/lowcord/optimize.ts.

import { applyAll, isOn, touchChannel } from "@lowcord/optimize";
import definePlugin from "@utils/types";

export default definePlugin({
    name: "LowCordOptimizer",
    description: "Applies the optimizations chosen in the low-cord settings tab",
    authors: [],
    required: true,
    hidden: true,

    patches: [
        // Journal interne de Discord : chaque ligne passe par cette fonction
        // (nom du module, niveau, message) avant d'aller dans la console, que
        // Discord recopie ensuite dans un fichier.
        {
            find: '"file-only"!==',
            replacement: {
                match: /(?<="file-only"!==\i&&)(?=console)/,
                replace: "$self.shouldLog(arguments[0],arguments[1])&&"
            }
        },
        // Mode jeu : Discord ne l'ouvre qu'aux comptes d'un test. Si
        // l'utilisateur l'active dans low-cord, on répond « activé ».
        {
            find: '"2026-08-game-mode"',
            replacement: {
                // « function x(e){ » ou « v:function(e){ » (nouvelle compilation rspack)
                match: /(function(?: \i)?\(\i\){let{location:\i}=\i;return )(\i\.getConfig\({location:\i}\))/,
                replace: "$1$self.gameModeOn()?{enabled:!0}:$2"
            }
        }
    ],

    gameModeOn: () => isOn("gameMode"),

    // Journal interne de Discord : seuls « warn » et « error » passent.
    shouldLog: (_name: string, level: string) => !isOn("quietLogs") || level === "warn" || level === "error",

    flux: {
        // Discord peut vider ses surcouches de réglages à la connexion.
        POST_CONNECTION_OPEN: applyAll,
        // Dernière utilisation de chaque conversation (pour « Mémoire des conversations »).
        CHANNEL_SELECT: ({ channelId }: { channelId?: string; }) => touchChannel(channelId),
        LOAD_MESSAGES_SUCCESS: ({ channelId }: { channelId?: string; }) => touchChannel(channelId),
    },

    start() {
        applyAll();
    },
});
