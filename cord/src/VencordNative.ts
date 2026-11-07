/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Settings } from "@api/Settings";
import type { CspRequestResult } from "@main/csp/manager";
import type { PluginIpcMappings } from "@main/ipcPlugins";
import type { Changes, UpdateStatus } from "@main/lowcordUpdater";
import type { MusicalStatus } from "@main/lowMusical";
import type { UserThemeHeader } from "@main/themes";
import type { UserPluginMeta } from "@main/userPlugins";
import { IpcEvents } from "@shared/IpcEvents";
import type { IpcRes } from "@utils/types";
import { ipcRenderer } from "electron/renderer";

export function invoke<T = any>(event: IpcEvents, ...args: any[]) {
    return ipcRenderer.invoke(event, ...args) as Promise<T>;
}

export function sendSync<T = any>(event: IpcEvents, ...args: any[]) {
    return ipcRenderer.sendSync(event, ...args) as T;
}

const PluginHelpers = {} as Record<string, Record<string, (...args: any[]) => Promise<any>>>;
const pluginIpcMap = sendSync<PluginIpcMappings>(IpcEvents.GET_PLUGIN_IPC_METHOD_MAP);

for (const [plugin, methods] of Object.entries(pluginIpcMap)) {
    const map = PluginHelpers[plugin] = {};
    for (const [methodName, method] of Object.entries(methods)) {
        map[methodName] = (...args: any[]) => invoke(method as IpcEvents, ...args);
    }
}

export default {
    themes: {
        uploadTheme: async (fileName: string, fileData: string): Promise<void> => {
            throw new Error("uploadTheme is WEB only");
        },
        deleteTheme: async (fileName: string): Promise<void> => {
            throw new Error("deleteTheme is WEB only");
        },
        getThemesList: () => invoke<Array<UserThemeHeader>>(IpcEvents.GET_THEMES_LIST),
        getThemeData: (fileName: string) => invoke<string | undefined>(IpcEvents.GET_THEME_DATA, fileName),
        getSystemValues: () => invoke<Record<string, string>>(IpcEvents.GET_THEME_SYSTEM_VALUES),

        openFolder: () => invoke<void>(IpcEvents.OPEN_THEMES_FOLDER),
    },

    updater: {
        getUpdates: () => invoke<IpcRes<Record<"hash" | "author" | "message", string>[]>>(IpcEvents.GET_UPDATES),
        update: () => invoke<IpcRes<boolean>>(IpcEvents.UPDATE),
        rebuild: () => invoke<IpcRes<boolean>>(IpcEvents.BUILD),
        getRepo: () => invoke<IpcRes<string>>(IpcEvents.GET_REPO),
    },

    settings: {
        get: () => sendSync<Settings>(IpcEvents.GET_SETTINGS),
        set: (settings: Settings, pathToNotify?: string) => invoke<void>(IpcEvents.SET_SETTINGS, settings, pathToNotify),

        openFolder: () => invoke<void>(IpcEvents.OPEN_SETTINGS_FOLDER),
    },

    quickCss: {
        get: () => invoke<string>(IpcEvents.GET_QUICK_CSS),
        set: (css: string) => invoke<void>(IpcEvents.SET_QUICK_CSS, css),

        addChangeListener(cb: (newCss: string) => void) {
            ipcRenderer.on(IpcEvents.QUICK_CSS_UPDATE, (_, css) => cb(css));
        },

        addThemeChangeListener(cb: () => void) {
            ipcRenderer.on(IpcEvents.THEME_UPDATE, () => cb());
        },

        openFile: () => invoke<void>(IpcEvents.OPEN_QUICKCSS),
        openEditor: () => invoke<void>(IpcEvents.OPEN_MONACO_EDITOR),
        getEditorTheme: () => sendSync<string>(IpcEvents.GET_MONACO_THEME),
    },

    native: {
        getVersions: () => process.versions as Partial<NodeJS.ProcessVersions>,
        supportsWindowsMaterial: () => sendSync<boolean>(IpcEvents.SUPPORTS_WINDOWS_MATERIAL),
        openExternal: (url: string) => invoke<void>(IpcEvents.OPEN_EXTERNAL, url),
        /** low-cord : mémoire (Ko) et processeur (% de la machine) utilisés par Discord. */
        getAppMetrics: () => invoke<{ memoryKB: number; cpuPercent: number; }>(IpcEvents.GET_APP_METRICS),
        getRendererCss: () => invoke<string>(IpcEvents.GET_RENDERER_CSS),
        onRendererCssUpdate: (cb: (newCss: string) => void) => {
            if (!IS_DEV) return;

            ipcRenderer.on(IpcEvents.RENDERER_CSS_UPDATE, (_e, newCss: string) => cb(newCss));
        }
    },

    /** low-cord : plugins perso (voir src/main/userPlugins.ts). */
    userPlugins: {
        boot: (enabledFiles: string[]) => sendSync<{ safeMode: boolean; plugins: { file: string; code: string; }[]; }>(IpcEvents.USER_PLUGINS_BOOT, enabledFiles),
        bootOk: () => invoke<void>(IpcEvents.USER_PLUGINS_BOOT_OK),
        list: () => invoke<UserPluginMeta[]>(IpcEvents.USER_PLUGINS_LIST),
        import: (fileName: string, code: string) => invoke<UserPluginMeta>(IpcEvents.USER_PLUGINS_IMPORT, fileName, code),
        /** Ouvre le sélecteur dans le dossier des plugins perso et importe le fichier choisi. */
        pick: (title: string) => invoke<UserPluginMeta | null>(IpcEvents.USER_PLUGINS_PICK, title),
        delete: (fileName: string) => invoke<void>(IpcEvents.USER_PLUGINS_DELETE, fileName),
        openFolder: () => invoke<string>(IpcEvents.USER_PLUGINS_OPEN_FOLDER),
    },

    /** low-cord : mises à jour automatiques (voir src/main/lowcordUpdater.ts). */
    lowcordUpdate: {
        check: () => invoke<UpdateStatus>(IpcEvents.LOWCORD_UPDATE_CHECK),
        /** Installe la version prête et redémarre Discord. */
        restart: () => invoke<void>(IpcEvents.LOWCORD_UPDATE_RESTART),
        /** Version installée + changements depuis `since` (version vue la dernière fois). */
        changes: (since?: string) => invoke<Changes>(IpcEvents.LOWCORD_UPDATE_CHANGES, since),
    },

    /** low-musical : installation du moteur (voir src/main/lowMusical.ts). */
    lowMusical: {
        status: () => invoke<MusicalStatus>(IpcEvents.LOWMUSICAL_STATUS),
        /** Installe ou met à jour vers la dernière version publiée. */
        install: () => invoke<MusicalStatus>(IpcEvents.LOWMUSICAL_INSTALL),
        uninstall: () => invoke<MusicalStatus>(IpcEvents.LOWMUSICAL_UNINSTALL),
        openFolder: () => invoke<void>(IpcEvents.LOWMUSICAL_OPEN_FOLDER),
        /** Envoie une commande au moteur (lancé à la demande). */
        call: <T = any>(cmd: string, args?: Record<string, unknown>) => invoke<T>(IpcEvents.LOWMUSICAL_ENGINE_CALL, cmd, args ?? {}),
        isRunning: () => invoke<boolean>(IpcEvents.LOWMUSICAL_ENGINE_RUNNING),
        /** Version installée (null = pas installé), lue sur le disque, sans réseau. */
        installedVersion: () => invoke<string | null>(IpcEvents.LOWMUSICAL_INSTALLED),
        /** Déplacement de la fenêtre du panneau : elle suit la souris jusqu'à dragEnd. */
        dragStart: () => invoke<boolean>(IpcEvents.LOWMUSICAL_DRAG_START),
        dragEnd: () => invoke<void>(IpcEvents.LOWMUSICAL_DRAG_END),
        /** Fenêtre du panneau invisible en partage d'écran. */
        setStreamProof: (on: boolean) => invoke<number>(IpcEvents.LOWMUSICAL_STREAM_PROOF, on),
        /** soundboard : copie un son importé, renvoie son nom de fichier */
        importSound: (name: string, data: Uint8Array) => invoke<string>(IpcEvents.LOWMUSICAL_SOUND_IMPORT, name, data),
        deleteSound: (file: string) => invoke<void>(IpcEvents.LOWMUSICAL_SOUND_DELETE, file),
        listSounds: () => invoke<string[]>(IpcEvents.LOWMUSICAL_SOUND_LIST),
        stop: () => invoke<void>(IpcEvents.LOWMUSICAL_ENGINE_STOP),
        /** Événements du moteur : { event: "status", data } ou { event: "exit", reason }. */
        onEvent(cb: (msg: any) => void) {
            ipcRenderer.on(IpcEvents.LOWMUSICAL_EVENT, (_, msg) => cb(msg));
        },
    },

    csp: {
        /**
         * Note: Only supports full explicit matches, not wildcards.
         *
         * If `*.example.com` is allowed, `isDomainAllowed("https://sub.example.com")` will return false.
         */
        isDomainAllowed: (url: string, directives: string[]) => invoke<boolean>(IpcEvents.CSP_IS_DOMAIN_ALLOWED, url, directives),
        removeOverride: (url: string) => invoke<boolean>(IpcEvents.CSP_REMOVE_OVERRIDE, url),
        requestAddOverride: (url: string, directives: string[], callerName: string) =>
            invoke<CspRequestResult>(IpcEvents.CSP_REQUEST_ADD_OVERRIDE, url, directives, callerName),
    },

    pluginHelpers: PluginHelpers
};
