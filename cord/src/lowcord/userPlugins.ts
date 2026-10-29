/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — plugins perso (rendu). Chargés au démarrage, AVANT le
// gestionnaire de plugins, pour que leurs patches s'appliquent comme ceux des
// plugins intégrés. Seuls les plugins activés par l'utilisateur sont exécutés.
//
// Format attendu (un seul fichier .js) :
//
//     /**
//      * @name MonPlugin
//      * @description …
//      */
//     module.exports = definePlugin({ name: "MonPlugin", description: "…", authors: [], start() { … } });
//
// Disponibles dans le fichier : module, exports, definePlugin,
// definePluginSettings, OptionType. Le reste de l'API passe par la variable
// globale Vencord (Vencord.Webpack, Vencord.Api…), à utiliser dans les
// fonctions du plugin (start, patches…) et non au chargement du fichier.

import { definePluginSettings, Settings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, Plugin } from "@utils/types";
import { onceReady } from "@webpack";

import Plugins, { PluginMeta } from "~plugins";

const logger = new Logger("low-cord · plugins perso", "#d0d0d0");

/** Délai après le chargement de Discord au bout duquel on considère que tout va bien. */
const BOOT_OK_DELAY = 15_000;

type Store = {
    lowcordUserPlugins?: string[];
    lowcordUserPluginsAccepted?: boolean;
    lowcordUserPluginsSafeMode?: boolean;
};

export const userPluginState = {
    /** fichier -> nom du plugin chargé */
    loaded: new Map<string, string>(),
    /** fichier -> raison de l'échec */
    failed: new Map<string, string>(),
    /** ce démarrage s'est fait en mode sans échec */
    safeMode: false,
};

function store(): Store {
    return (Settings.plugins.Settings ?? {}) as Store;
}

export const getEnabledUserPlugins = () => store().lowcordUserPlugins ?? [];
export const isWarningAccepted = () => !!store().lowcordUserPluginsAccepted;
export const isSafeMode = () => !!store().lowcordUserPluginsSafeMode;

export function setUserPluginEnabled(file: string, on: boolean) {
    const list = new Set(getEnabledUserPlugins());
    if (on) list.add(file);
    else list.delete(file);
    (Settings.plugins.Settings as Store).lowcordUserPlugins = [...list];
}

export function acceptWarning() {
    (Settings.plugins.Settings as Store).lowcordUserPluginsAccepted = true;
}

export function leaveSafeMode() {
    (Settings.plugins.Settings as Store).lowcordUserPluginsSafeMode = false;
}

export const isUserPlugin = (name: string) => !!PluginMeta[name]?.userPlugin;

// OptionType est un enum « const » (effacé à la compilation) : on en refait
// un objet pour le fournir aux plugins perso.
const OPTION_TYPES = {
    STRING: OptionType.STRING,
    NUMBER: OptionType.NUMBER,
    BIGINT: OptionType.BIGINT,
    BOOLEAN: OptionType.BOOLEAN,
    SELECT: OptionType.SELECT,
    SLIDER: OptionType.SLIDER,
    COMPONENT: OptionType.COMPONENT,
    CUSTOM: OptionType.CUSTOM,
};

function evaluate(file: string, code: string): Plugin {
    const module = { exports: {} as any };
    const run = new Function("module", "exports", "definePlugin", "definePluginSettings", "OptionType",
        `${code}\n//# sourceURL=lowcord-userplugins:///${encodeURIComponent(file)}`);
    run(module, module.exports, definePlugin, definePluginSettings, OPTION_TYPES);

    const plugin = module.exports?.default ?? module.exports;
    if (!plugin || typeof plugin !== "object") throw new Error("no-export");
    if (typeof plugin.name !== "string" || !/^[A-Za-z][\w-]{0,63}$/.test(plugin.name)) throw new Error("bad-name");
    if (plugin.name in Plugins) throw new Error("name-taken");

    plugin.description ||= "";
    plugin.authors = Array.isArray(plugin.authors) ? plugin.authors : [];
    // Un plugin perso n'est jamais obligatoire ni caché.
    plugin.required = false;
    plugin.hidden = false;
    return plugin as Plugin;
}

/** Appelé une seule fois, au démarrage, avant initPluginManager(). */
export function loadUserPlugins() {
    if (IS_WEB) return;

    const enabled = isSafeMode() ? [] : getEnabledUserPlugins();
    let boot: ReturnType<typeof VencordNative.userPlugins.boot>;
    try {
        boot = VencordNative.userPlugins.boot(enabled);
    } catch (e) {
        logger.error("Lecture des plugins perso impossible", e);
        return;
    }

    if (boot.safeMode) {
        // Discord n'avait pas fini de démarrer la dernière fois : on démarre
        // sans plugins perso et on le signale dans l'onglet Plugins.
        (Settings.plugins.Settings as Store).lowcordUserPluginsSafeMode = true;
        userPluginState.safeMode = true;
        logger.warn("Mode sans échec : plugins perso non chargés (démarrage précédent interrompu)");
        return;
    }

    for (const { file, code } of boot.plugins) {
        try {
            const plugin = evaluate(file, code);
            Plugins[plugin.name] = plugin;
            PluginMeta[plugin.name] = { folderName: `userplugins/${file}`, userPlugin: true };
            Settings.plugins[plugin.name].enabled = true;
            userPluginState.loaded.set(file, plugin.name);
            logger.info(`Chargé : ${plugin.name} (${file})`);
        } catch (e) {
            const reason = e instanceof Error ? e.message : String(e);
            userPluginState.failed.set(file, reason);
            logger.error(`Échec du chargement de ${file}`, e);
        }
    }

    if (boot.plugins.length) {
        // Discord a démarré normalement : on efface le repère du mode sans échec.
        onceReady.then(() => setTimeout(() => VencordNative.userPlugins.bootOk().catch(() => null), BOOT_OK_DELAY));
    }
}
