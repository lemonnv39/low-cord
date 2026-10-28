/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — traduction de l'interface (FR par défaut, EN au choix).
//
// Coût nul : dictionnaires statiques compilés dans le bundle, lecture
// synchrone d'une clé. Pas de MutationObserver, pas de réseau, pas de cache.
// Seuls les composants low-cord appellent t() ; le reste de Discord n'est
// jamais touché.

import { Settings, useSettings } from "@api/Settings";
import type { PluginSettingDef } from "@utils/types";

import { en } from "./en";
import { fr } from "./fr";
import { PLUGIN_STRINGS } from "./plugins";

export type Lang = "fr" | "en";
export type I18nKey = keyof typeof fr;

export const LANGS: { value: Lang; label: string; }[] = [
    { value: "fr", label: "Français" },
    { value: "en", label: "English" },
];

const DICTS: Record<Lang, Record<I18nKey, string>> = { fr, en };

// Stocké dans les réglages du plugin Settings (toujours actif), hors de sa
// définition : n'apparaît donc dans aucune liste de réglages.
const STORE_PATH = "plugins.Settings.lowcordLanguage";

export function getLang(): Lang {
    return Settings.plugins.Settings?.lowcordLanguage === "en" ? "en" : "fr";
}

export function setLang(lang: Lang) {
    Settings.plugins.Settings.lowcordLanguage = lang;
}

/** Hook : re-rend le composant quand la langue change, et la renvoie. */
export function useLang(): Lang {
    useSettings([STORE_PATH as never]);
    return getLang();
}

export function t(key: I18nKey, vars?: Record<string, string | number>): string {
    let text = DICTS[getLang()][key] ?? fr[key];
    if (vars) {
        for (const name in vars) text = text.replaceAll(`{${name}}`, String(vars[name]));
    }
    return text;
}

export function pluginDescription(plugin: { name: string; description: string; }): string {
    return PLUGIN_STRINGS[getLang()][plugin.name]?.description ?? plugin.description;
}

/** Copie traduite d'une définition de réglage (libellé, description, options). */
export function localizeSetting<T extends PluginSettingDef>(pluginName: string, key: string, setting: T): T {
    const strings = PLUGIN_STRINGS[getLang()][pluginName]?.settings?.[key];
    if (!strings) return setting;

    const copy: any = { ...setting };
    if (strings.name) copy.displayName = strings.name;
    if (strings.description) copy.description = strings.description;
    if (strings.options && Array.isArray(copy.options)) {
        copy.options = copy.options.map((o: { value: string; label: string; }) => ({
            ...o,
            label: strings.options![o.value] ?? o.label,
        }));
    }
    return copy;
}
