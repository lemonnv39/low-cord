/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — plugins perso (rendu). Chargés au démarrage, AVANT le
// gestionnaire de plugins, pour que leurs patches s'appliquent comme ceux des
// plugins intégrés. Seuls les plugins activés par l'utilisateur sont exécutés.
//
// Formats acceptés (compilés par le processus principal, voir src/main/userPlugins.ts) :
//   - un fichier seul (.js, .ts, .tsx, .jsx) ou un dossier avec un index, écrit
//     comme un plugin Vencord : import … from "@api/Settings", "@webpack/common",
//     "./components/X", "./style.css"… puis `export default definePlugin({ … })` ;
//   - l'ancien format : module.exports = definePlugin({ … }).
//
// Les imports « @… » sont reliés aux modules de low-cord listés dans
// userPluginModules.ts. definePlugin, definePluginSettings et OptionType sont
// aussi disponibles directement, sans import.

import { definePluginSettings, Settings } from "@api/Settings";
import type { UserPluginBundle } from "@main/userPlugins";
import { Logger } from "@utils/Logger";
import definePlugin, { Plugin } from "@utils/types";
import { onceReady } from "@webpack";
import { React } from "@webpack/common";

import Plugins, { PluginMeta } from "~plugins";

import { addHeaderBarButton, removeHeaderBarButton } from "./headerBar";
import { getUserPluginModules, OPTION_TYPES } from "./userPluginModules";

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

// Les imports compilés (sucrase) n'utilisent `default` que si le module est
// marqué __esModule : on le marque sans copier (les exports de
// @webpack/common sont remplis plus tard, il faut garder les liaisons).
const asEsModule = (ns: any) => new Proxy(ns, {
    get: (target, key) => key === "__esModule" ? true : target[key],
    has: (target, key) => key === "__esModule" || key in target,
});
const registry = new Map<string, any>();
function aliasModule(spec: string) {
    const all = getUserPluginModules();
    if (!(spec in all)) return undefined;
    let mod = registry.get(spec);
    if (!mod) registry.set(spec, mod = asEsModule(all[spec]));
    return mod;
}

// Pragma JSX des plugins compilés : React n'existe qu'une fois Discord chargé.
const JSX_SCOPE = { get React() { return React; } };

const CODE_EXT = [".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs"];

function injectStyle(id: string, css: string) {
    const add = () => {
        if (document.querySelector(`style[data-lowcord-userplugin="${CSS.escape(id)}"]`)) return;
        const style = document.createElement("style");
        style.dataset.lowcordUserplugin = id;
        style.textContent = css;
        document.head.append(style);
    };
    if (document.head) add();
    else document.addEventListener("DOMContentLoaded", add, { once: true });
}

/** Exécute un plugin compilé : petit `require` limité à ses propres fichiers et aux modules de low-cord. */
function evaluate({ file, entry, modules }: UserPluginBundle): Plugin {
    const cache = new Map<string, { exports: any; }>();

    function resolve(from: string, spec: string) {
        const parts = from.split("/").slice(0, -1);
        for (const seg of spec.split("/")) {
            if (seg === "." || seg === "") continue;
            if (seg === "..") parts.pop();
            else parts.push(seg);
        }
        const p = parts.join("/");
        const candidates = [p, ...[...CODE_EXT, ".css", ".json"].map(e => p + e), ...CODE_EXT.map(e => `${p}/index${e}`)];
        return candidates.find(c => c in modules);
    }

    function load(path: string) {
        let mod = cache.get(path);
        if (mod) return mod;
        mod = { exports: {} };
        cache.set(path, mod);
        const src = modules[path];

        if (path.endsWith(".css")) {
            injectStyle(`${file}/${path}`, src);
            mod.exports = { __esModule: true, default: src };
        } else if (path.endsWith(".json")) {
            mod.exports = JSON.parse(src);
        } else {
            const run = new Function("module", "exports", "require", "__lc", "definePlugin", "definePluginSettings", "OptionType",
                `${src}\n//# sourceURL=lowcord-userplugins:///${encodeURIComponent(file)}/${path}`);
            run(mod, mod.exports, (spec: string) => requireFrom(path, spec), JSX_SCOPE, definePlugin, definePluginSettings, OPTION_TYPES);
        }
        return mod;
    }

    function requireFrom(from: string, rawSpec: string) {
        // « ./style.css?managed » et compagnie : le suffixe ne change rien ici.
        const spec = rawSpec.replace(/\?.*$/, "");
        if (spec.startsWith(".") || spec.startsWith("/")) {
            const path = resolve(from, spec);
            if (!path) throw new Error(`fichier introuvable : ${rawSpec} (dans ${from})`);
            return load(path).exports;
        }
        const alias = aliasModule(spec);
        if (alias === undefined) throw new Error(`module non disponible dans low-cord : ${spec}`);
        return alias;
    }

    const exported = load(entry).exports;
    const plugin = exported?.default ?? exported;
    if (!plugin || typeof plugin !== "object") throw new Error("no-export");
    if (typeof plugin.name !== "string" || !/^[A-Za-z][\w-]{0,63}$/.test(plugin.name)) throw new Error("bad-name");
    if (plugin.name in Plugins) throw new Error("name-taken");

    plugin.description ||= "";
    plugin.authors = Array.isArray(plugin.authors) ? plugin.authors : [];
    // Un plugin perso n'est jamais obligatoire ni caché.
    plugin.required = false;
    plugin.hidden = false;
    // Dépendances d'autres mods (HeaderBarAPI d'Equicord…) : ignorées si low-cord ne les a pas.
    if (Array.isArray(plugin.dependencies)) plugin.dependencies = plugin.dependencies.filter((d: string) => d in Plugins);
    adaptHeaderBarButton(plugin);
    return plugin as Plugin;
}

/** `headerBarButton: { render, priority }` (format Equicord) → barre du haut de low-cord. */
function adaptHeaderBarButton(plugin: any) {
    const button = plugin.headerBarButton;
    if (!button || typeof button.render !== "function") return;
    const { start, stop } = plugin;
    plugin.start = function () {
        addHeaderBarButton(plugin.name, button.render, button.priority ?? 10);
        return start?.call(this);
    };
    plugin.stop = function () {
        removeHeaderBarButton(plugin.name);
        return stop?.call(this);
    };
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

    for (const bundle of boot.plugins) {
        const { file } = bundle;
        try {
            if (bundle.error) throw new Error(bundle.error);
            const plugin = evaluate(bundle);
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
