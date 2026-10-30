/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — emplacement partagé pour les boutons de la barre du haut.
// Voir src/lowcord/headerBar.tsx.

import { TrailingWrapper } from "@lowcord/headerBar";
import definePlugin from "@utils/types";

export default definePlugin({
    name: "LowCordHeaderBar",
    description: "Shared slot for low-cord buttons in Discord's top bar",
    authors: [{ name: "shitday", id: 0n }],
    required: true,
    hidden: true,

    patches: [
        {
            find: '?"BACK_FORWARD_NAVIGATION":',
            replacement: {
                match: /(trailing:.{0,50}?)\i\.Fragment,(?=\{children:\[)/,
                replace: "$1$self.TrailingWrapper,"
            }
        }
    ],

    TrailingWrapper,
});
