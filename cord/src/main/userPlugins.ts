/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — plugins perso (processus principal).
//
// Dossier : <données low-cord>\userplugins\*.js. Un plugin perso est un seul
// fichier .js qui commence par un bloc de description :
//
//     /**
//      * @name MonPlugin
//      * @description Ce que fait le plugin
//      * @author pseudo
//      * @version 1.0.0
//      */
//
// La liste lit uniquement ce bloc : le code d'un plugin n'est JAMAIS exécuté
// tant que l'utilisateur ne l'a pas activé lui-même.
//
// Mode sans échec : au démarrage, si des plugins perso sont chargés, on pose
// un repère ; le rendu l'efface une fois Discord bien lancé. Si le repère est
// encore là au démarrage suivant, Discord n'a pas fini de démarrer la fois
// précédente : on démarre SANS plugins perso et on prévient l'utilisateur.

import { IpcEvents } from "@shared/IpcEvents";
import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { basename, join } from "path";

import { DATA_DIR } from "./utils/constants";

export const USER_PLUGINS_DIR = join(DATA_DIR, "userplugins");
const BOOT_MARKER = join(USER_PLUGINS_DIR, ".boot-pending");
const MAX_SIZE = 2 * 1024 * 1024;

export interface UserPluginMeta {
    file: string;
    name: string;
    description: string;
    author: string;
    version: string;
    size: number;
    error?: string;
}

const ensureDir = () => mkdirSync(USER_PLUGINS_DIR, { recursive: true });

/** Nom de fichier sûr : pas de chemin, extension .js. */
function safeFile(file: unknown): string | null {
    if (typeof file !== "string") return null;
    const name = basename(file);
    return /^[\w .()-]{1,100}\.js$/i.test(name) && name === file ? name : null;
}

export function parseMeta(code: string): Omit<UserPluginMeta, "file" | "size"> & { error?: string; } {
    const block = /^\s*\/\*\*([\s\S]*?)\*\//.exec(code)?.[1] ?? "";
    const tag = (t: string) => new RegExp(`@${t}[ \\t]+(.+)`).exec(block)?.[1].trim() ?? "";
    const name = tag("name");
    const meta = { name, description: tag("description"), author: tag("author"), version: tag("version") };
    if (!name) return { ...meta, error: "missing-name" };
    if (!/^[A-Za-z][\w-]{0,63}$/.test(name)) return { ...meta, error: "bad-name" };
    return meta;
}

function listPlugins(): UserPluginMeta[] {
    if (!existsSync(USER_PLUGINS_DIR)) return [];
    return readdirSync(USER_PLUGINS_DIR)
        .filter(f => safeFile(f))
        .map(file => {
            const path = join(USER_PLUGINS_DIR, file);
            const { size } = statSync(path);
            if (size > MAX_SIZE) return { file, name: "", description: "", author: "", version: "", size, error: "too-big" };
            return { file, size, ...parseMeta(readFileSync(path, "utf-8")) };
        });
}

// Démarrage (synchrone : le rendu en a besoin avant que Discord ne charge).
ipcMain.on(IpcEvents.USER_PLUGINS_BOOT, (e, enabledFiles: unknown) => {
    try {
        const wanted = Array.isArray(enabledFiles) ? enabledFiles.map(safeFile).filter(Boolean) as string[] : [];

        if (!wanted.length) {
            if (existsSync(BOOT_MARKER)) unlinkSync(BOOT_MARKER);
            e.returnValue = { safeMode: false, plugins: [] };
            return;
        }

        if (existsSync(BOOT_MARKER)) {
            unlinkSync(BOOT_MARKER);
            e.returnValue = { safeMode: true, plugins: [] };
            return;
        }

        const plugins = wanted
            .map(file => join(USER_PLUGINS_DIR, file))
            .filter(path => existsSync(path) && statSync(path).size <= MAX_SIZE)
            .map(path => ({ file: basename(path), code: readFileSync(path, "utf-8") }));

        if (plugins.length) {
            ensureDir();
            writeFileSync(BOOT_MARKER, String(Date.now()));
        }
        e.returnValue = { safeMode: false, plugins };
    } catch (err) {
        console.error("[low-cord] plugins perso : démarrage impossible", err);
        e.returnValue = { safeMode: false, plugins: [] };
    }
});

ipcMain.handle(IpcEvents.USER_PLUGINS_BOOT_OK, () => {
    if (existsSync(BOOT_MARKER)) unlinkSync(BOOT_MARKER);
});

ipcMain.handle(IpcEvents.USER_PLUGINS_LIST, () => listPlugins());

function importPlugin(fileName: unknown, code: unknown): UserPluginMeta {
    const file = safeFile(typeof fileName === "string" ? basename(fileName) : null);
    if (!file) throw new Error("bad-file");
    if (typeof code !== "string" || code.length > MAX_SIZE) throw new Error("too-big");
    const meta = parseMeta(code);
    if (meta.error) throw new Error(meta.error);
    ensureDir();
    writeFileSync(join(USER_PLUGINS_DIR, file), code, "utf-8");
    return { file, size: code.length, ...meta };
}

ipcMain.handle(IpcEvents.USER_PLUGINS_IMPORT, (_, fileName: unknown, code: unknown) => importPlugin(fileName, code));

// Sélecteur de fichier ouvert directement dans le dossier des plugins perso
// (celui de Discord ne permet pas de choisir le dossier de départ).
// Renvoie null si l'utilisateur annule.
ipcMain.handle(IpcEvents.USER_PLUGINS_PICK, async (e, title: unknown) => {
    ensureDir();
    const win = BrowserWindow.fromWebContents(e.sender);
    const options: Electron.OpenDialogOptions = {
        title: typeof title === "string" ? title : undefined,
        defaultPath: USER_PLUGINS_DIR,
        filters: [{ name: "low-cord plugin", extensions: ["js"] }],
        properties: ["openFile"],
    };
    const { canceled, filePaths } = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (canceled || !filePaths[0]) return null;

    const path = filePaths[0];
    if (statSync(path).size > MAX_SIZE) throw new Error("too-big");
    return importPlugin(basename(path), readFileSync(path, "utf-8"));
});

ipcMain.handle(IpcEvents.USER_PLUGINS_DELETE, (_, fileName: unknown) => {
    const file = safeFile(fileName);
    if (!file) throw new Error("bad-file");
    const path = join(USER_PLUGINS_DIR, file);
    if (existsSync(path)) unlinkSync(path);
});

ipcMain.handle(IpcEvents.USER_PLUGINS_OPEN_FOLDER, () => {
    ensureDir();
    return shell.openPath(USER_PLUGINS_DIR);
});
