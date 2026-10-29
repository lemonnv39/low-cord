/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — retouches de l'interface de Discord. Toujours chargé, invisible
// dans la liste des plugins.

import definePlugin from "@utils/types";

export default definePlugin({
    name: "LowCordInterface",
    description: "low-cord tweaks to the Discord interface",
    authors: [{ name: "shitday", id: 0n }],
    required: true,
    hidden: true,

    patches: [
        // Bouton vert « Mise à jour prête ! » de la barre du haut : retiré.
        // Discord s'installe quand même tout seul au prochain démarrage.
        {
            find: 'type:"AUTO_UPDATER_QUIT_AND_INSTALL"})',
            replacement: {
                match: /(render\(\){let (\i)="UPDATE_AVAILABLE"===this\.props\.mode,(\i)=[^;]{0,120};return )\2\|\|\3\?/,
                replace: "$1!1?"
            }
        }
    ],
});
