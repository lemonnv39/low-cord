/*
 * low-cord — filtre de plugins au build.
 *
 * Les ~150 plugins livrés par Vencord (src/plugins/<nom>) restent dans le repo
 * pour que `git subtree pull` reste sans conflit, mais ils ne sont PAS embarqués
 * dans la dist. Seuls passent :
 *   - src/plugins/_api et src/plugins/_core (cœur Vencord, toujours embarqués)
 *   - src/lowplugins/* (nos plugins)
 *   - les plugins Vencord listés dans VENCORD_PLUGINS_ALLOWLIST ci-dessous
 *
 * Pour réactiver un plugin Vencord : ajouter le nom de son DOSSIER/fichier
 * (ex. "fakeNitro") dans la liste, commit, push.
 */

// @ts-check

/** @type {string[]} */
export const VENCORD_PLUGINS_ALLOWLIST = [];

/**
 * Plugins du cœur (_core) retirés quand même : SupportHelper ne sert qu'au
 * serveur d'aide officiel de Vencord.
 */
export const CORE_PLUGINS_EXCLUDED = ["supportHelper"];

/** Dossier (relatif à src/) de nos plugins. */
export const LOWCORD_PLUGIN_DIR = "lowplugins";

/**
 * @param {string} dir dossier relatif à src/ ("plugins", "plugins/_core", "lowplugins"…)
 * @param {string} fileName nom du fichier ou dossier du plugin
 */
export function isPluginAllowed(dir, fileName) {
    const base = fileName.replace(/\.tsx?$/, "");
    if (dir === "plugins/_core") return !CORE_PLUGINS_EXCLUDED.includes(base);
    if (dir !== "plugins") return true;
    return VENCORD_PLUGINS_ALLOWLIST.includes(base);
}
