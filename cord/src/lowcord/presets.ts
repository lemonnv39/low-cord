/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — préréglages : export / import des plugins activés, de leurs
// réglages, de la langue et des optimisations. Même format que l'injecteur
// low-cord ({ lowcordPluginPreset, version, plugins }), pour qu'un fichier
// marche des deux côtés.
//
// À l'import, seuls les plugins intégrés à low-cord sont pris en compte : un
// préréglage ne peut jamais activer un plugin perso, ni toucher au cœur.

import { isPluginEnabled } from "@api/PluginManager";
import { PlainSettings, Settings } from "@api/Settings";
import { Plugin } from "@utils/types";
import { chooseFile, saveFile } from "@utils/web";

import Plugins from "~plugins";

import { Lang, setLang } from "./i18n";
import { OptimizeKey, setOptimize } from "./optimize";
import { isUserPlugin } from "./userPlugins";

const OPTIMIZE_KEYS: OptimizeKey[] = ["animations", "gameMode", "reducedMotion"];

/** Plugins qu'un préréglage peut lire et modifier. */
const isPresetPlugin = (p: Plugin | undefined): p is Plugin =>
    !!p && !p.required && !p.hidden && !p.name.endsWith("API") && !isUserPlugin(p.name);

export function buildPreset() {
    const plugins: Record<string, any> = {};
    for (const p of Object.values(Plugins)) {
        if (!isPresetPlugin(p)) continue;
        plugins[p.name] = structuredClone(PlainSettings.plugins[p.name] ?? { enabled: false });
    }

    const core = PlainSettings.plugins.Settings as any;
    const optimize = Object.fromEntries(OPTIMIZE_KEYS.map(k => [k, !!core?.lowcordOptimize?.[k]]));
    plugins.Settings = { lowcordLanguage: core?.lowcordLanguage ?? "fr", lowcordOptimize: optimize };

    return { lowcordPluginPreset: true, version: 1, plugins };
}

export async function exportPreset() {
    const date = new Date().toISOString().slice(0, 10);
    const filename = `low-cord-preset-${date}.json`;
    const data = new TextEncoder().encode(JSON.stringify(buildPreset(), null, 4));

    if (IS_DISCORD_DESKTOP) await DiscordNative.fileManager.saveWithDialog(data, filename);
    else saveFile(new File([data], filename, { type: "application/json" }));
}

/** Ouvre un fichier .json ; null si l'utilisateur annule. */
export async function pickPresetFile(): Promise<string | null> {
    if (IS_DISCORD_DESKTOP) {
        const [file] = await DiscordNative.fileManager.openFiles({
            filters: [{ name: "low-cord preset", extensions: ["json"] }, { name: "all", extensions: ["*"] }]
        });
        return file ? new TextDecoder().decode(file.data) : null;
    }
    const file = await chooseFile("application/json");
    return file ? await file.text() : null;
}

export interface PresetPlan {
    /** plugins dont l'activation change */
    toggled: { name: string; enabled: boolean; }[];
    /** plugins dont seuls des réglages changent */
    tuned: string[];
    /** entrées du fichier ignorées (plugin inconnu, cœur, plugin perso) */
    ignored: string[];
    needsRestart: boolean;
    apply(): void;
}

/** Lit un préréglage et prépare les changements, sans rien appliquer. */
export function planPreset(raw: string): PresetPlan {
    let data: any;
    try {
        data = JSON.parse(raw);
    } catch {
        throw new Error("not-json");
    }
    if (data?.lowcordPluginPreset !== true || typeof data.plugins !== "object" || !data.plugins) throw new Error("not-preset");

    const toggled: PresetPlan["toggled"] = [];
    const tuned: string[] = [];
    const ignored: string[] = [];
    const steps: (() => void)[] = [];
    let needsRestart = false;

    for (const [name, value] of Object.entries<any>(data.plugins)) {
        if (!value || typeof value !== "object") continue;

        if (name === "Settings") {
            if (value.lowcordLanguage === "fr" || value.lowcordLanguage === "en") {
                const lang = value.lowcordLanguage as Lang;
                steps.push(() => setLang(lang));
            }
            const opt = value.lowcordOptimize;
            if (opt && typeof opt === "object") {
                for (const key of OPTIMIZE_KEYS) {
                    if (typeof opt[key] === "boolean") steps.push(() => setOptimize(key, opt[key]));
                }
            }
            continue;
        }

        const plugin = Plugins[name];
        if (!isPresetPlugin(plugin)) {
            ignored.push(name);
            continue;
        }

        const current = Settings.plugins[name];
        let changed = false;

        if (typeof value.enabled === "boolean" && value.enabled !== isPluginEnabled(name)) {
            toggled.push({ name, enabled: value.enabled });
            needsRestart = true;
            steps.push(() => { current.enabled = value.enabled; });
        }

        const defs = plugin.settings?.def ?? {};
        for (const [key, v] of Object.entries(value)) {
            if (key === "enabled" || !(key in defs)) continue;
            if (JSON.stringify(current[key]) === JSON.stringify(v)) continue;
            changed = true;
            const def = defs[key];
            if ("restartNeeded" in def && def.restartNeeded) needsRestart = true;
            steps.push(() => { current[key] = structuredClone(v); });
        }

        if (changed && !toggled.some(t => t.name === name)) tuned.push(name);
    }

    return {
        toggled,
        tuned,
        ignored,
        needsRestart,
        apply: () => steps.forEach(step => step()),
    };
}
