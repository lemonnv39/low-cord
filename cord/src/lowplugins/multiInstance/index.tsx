/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import definePlugin from "@utils/types";

// MultiInstance n'a pas d'interface : TokenImporter appelle ses fonctions
// natives (VencordNative.pluginHelpers.MultiInstance.*) pour ouvrir un compte
// enregistré dans sa propre fenêtre. Il est activé automatiquement avec
// TokenImporter (dépendance), d'où sa place cachée dans la liste.
export default definePlugin({
    name: "MultiInstance",
    description: "Opens an account saved in TokenImporter in its own window, with its own isolated session. Used by TokenImporter, no settings.",
    authors: [{ name: "0ctane", id: 0n }],
    hidden: true,
});
