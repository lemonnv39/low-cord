import { invoke } from "@tauri-apps/api/core";
import type { DiscordInstall, FixResult, InjectorSettings, UpdateResult } from "../types";

// Fine couche au-dessus de `invoke()` : le reste du frontend ne connaît pas
// les noms exacts des commandes Tauri, juste cette API.
export const patcherApi = {
    // `repoPath` est un override optionnel (dev local) — omis/null, l'injecteur
    // télécharge et met en cache le dernier build public de low-cord tout seul.
    // Sert aussi à reconnaître nos propres stubs déjà en place (voir discord.rs).
    listInstalls: (repoPath?: string | null) =>
        invoke<DiscordInstall[]>("list_discord_installs", { repoPath: repoPath || null }),

    patch: (resourcesPath: string, basePath: string, branch: string, repoPath?: string | null) =>
        invoke<void>("patch_discord", { resourcesPath, basePath, branch, repoPath: repoPath || null }),

    unpatch: (resourcesPath: string, basePath: string, branch: string) =>
        invoke<void>("unpatch_discord", { resourcesPath, basePath, branch }),

    updateLowCordBuild: () => invoke<UpdateResult[]>("update_lowcord_build"),

    checkLowCordBuildUpdate: () => invoke<string | null>("check_lowcord_build_update"),

    getLatestBuildSha: () => invoke<string | null>("get_latest_build_sha"),

    getSettings: () => invoke<InjectorSettings>("get_settings"),

    saveSettings: (settings: InjectorSettings) =>
        invoke<void>("save_settings", { settings }),

    fixLowCord: () => invoke<FixResult[]>("fix_lowcord"),

    exportPluginPresets: (destPath: string) =>
        invoke<void>("export_plugin_presets", { destPath }),

    importPluginPresets: (srcPath: string) =>
        invoke<void>("import_plugin_presets", { srcPath }),
};
