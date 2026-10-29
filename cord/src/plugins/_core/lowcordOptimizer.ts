/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — moteur de la section « Optimisation » (onglet low-cord).
// Toujours chargé, invisible dans la liste des plugins : il ne fait rien tant
// qu'aucune optimisation n'est activée. Voir src/lowcord/optimize.ts.

import { applyAll, isOn } from "@lowcord/optimize";
import definePlugin from "@utils/types";

export default definePlugin({
    name: "LowCordOptimizer",
    description: "Applies the optimizations chosen in the low-cord settings tab",
    authors: [{ name: "shitday", id: 0n }],
    required: true,
    hidden: true,

    patches: [
        // Mode jeu : Discord ne l'ouvre qu'aux comptes d'un test. Si
        // l'utilisateur l'active dans low-cord, on répond « activé ».
        {
            find: '"2026-08-game-mode"',
            replacement: {
                match: /(function \i\(\i\){let{location:\i}=\i;return )(\i\.getConfig\({location:\i}\))/,
                replace: "$1$self.gameModeOn()?{enabled:!0}:$2"
            }
        }
    ],

    gameModeOn: () => isOn("gameMode"),

    flux: {
        // Discord peut vider ses surcouches de réglages à la connexion.
        POST_CONNECTION_OPEN: applyAll,
    },

    start() {
        applyAll();
    },
});
