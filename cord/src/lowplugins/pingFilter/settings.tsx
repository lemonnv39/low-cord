/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

import type { Options, Profile } from "./apply";
import { Panel } from "./Panel";

// Tout se règle dans le panneau (réglages masqués de la liste automatique).
export const settings = definePluginSettings({
    // Le panneau complet, affiché dans les réglages du plugin.
    panel: { type: OptionType.COMPONENT, component: () => <Panel /> },
    profile: { type: OptionType.STRING, description: "", default: "mentions", hidden: true },
    includeRoles: { type: OptionType.BOOLEAN, description: "", default: false, hidden: true },
    muteServers: { type: OptionType.BOOLEAN, description: "", default: false, hidden: true },
    mobilePush: { type: OptionType.BOOLEAN, description: "", default: true, hidden: true },
    noHighlights: { type: OptionType.BOOLEAN, description: "", default: true, hidden: true },
    excluded: { type: OptionType.CUSTOM, default: [] as string[] },
    ghostWatch: { type: OptionType.BOOLEAN, description: "", default: true, hidden: true },
    ghostToast: { type: OptionType.BOOLEAN, description: "", default: true, hidden: true },
});

export const currentOptions = (): Options => {
    const s = settings.store;
    return {
        profile: s.profile as Profile,
        includeRoles: s.includeRoles,
        muteServers: s.muteServers,
        mobilePush: s.mobilePush,
        noHighlights: s.noHighlights,
        excluded: [...(s.excluded ?? [])],
    };
};
