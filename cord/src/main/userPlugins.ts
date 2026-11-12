/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — plugins perso (processus principal).
//
// Dossier : <données low-cord>\userplugins. Un plugin perso peut être :
//   - un fichier seul : MonPlugin.js / .ts / .tsx / .jsx ;
//   - un dossier avec un index.(ts|tsx|js|jsx) et ses autres fichiers
//     (composants, .css, .json), comme les plugins Vencord / Equicord ;
//   - un .zip de ce dossier : il est décompressé tout seul à la lecture.
//
// Le nom et la description viennent du bloc d'en-tête (@name, @description,
// @author, @version) s'il existe, sinon de definePlugin({ name, description }).
//
// La liste lit seulement les fichiers : le code d'un plugin n'est JAMAIS
// exécuté tant que l'utilisateur ne l'a pas activé lui-même. Au démarrage, les
// plugins activés sont compilés ici (TypeScript / JSX → JS, imports → require)
// et le rendu les exécute.
//
// Mode sans échec : au démarrage, si des plugins perso sont chargés, on pose
// un repère ; le rendu l'efface une fois Discord bien lancé. Si le repère est
// encore là au démarrage suivant, Discord n'a pas fini de démarrer la fois
// précédente : on démarre SANS plugins perso et on prévient l'utilisateur.

import { IpcEvents } from "@shared/IpcEvents";
import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { unzipSync } from "fflate";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "fs";
import { basename, dirname, extname, join, posix } from "path";
import { type Transform, transform } from "sucrase";

import { DATA_DIR } from "./utils/constants";

export const USER_PLUGINS_DIR = join(DATA_DIR, "userplugins");
const BOOT_MARKER = join(USER_PLUGINS_DIR, ".boot-pending");
/** Taille max d'un plugin (tous ses fichiers). */
const MAX_SIZE = 2 * 1024 * 1024;
const MAX_FILES = 300;

const CODE_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const KEEP_EXT = new Set([...CODE_EXT, ".css", ".json"]);
const INDEX_NAMES = ["index.tsx", "index.ts", "index.jsx", "index.js"];

export interface UserPluginMeta {
    /** Nom du fichier ou du dossier dans userplugins (sert d'identifiant). */
    file: string;
    name: string;
    description: string;
    author: string;
    version: string;
    size: number;
    folder?: boolean;
    error?: string;
}

export interface UserPluginBundle {
    file: string;
    /** Chemin du fichier d'entrée dans `modules`. */
    entry: string;
    /** chemin relatif (séparateur /) -> code compilé, ou texte brut pour .css / .json */
    modules: Record<string, string>;
    error?: string;
}

const ensureDir = () => mkdirSync(USER_PLUGINS_DIR, { recursive: true });

const SINGLE_FILE = /^[\w .()-]{1,100}\.(js|ts|tsx|jsx)$/i;
const FOLDER = /^[\w .()-]{1,100}$/;

/** Identifiant sûr : un nom de fichier ou de dossier, sans chemin. */
function safeEntry(name: unknown): string | null {
    if (typeof name !== "string" || name !== basename(name) || name.startsWith(".")) return null;
    return SINGLE_FILE.test(name) || FOLDER.test(name) ? name : null;
}

// ── Lecture des fichiers d'un plugin ─────────────────────────────────────────

interface Source {
    entry: string;
    files: Record<string, string>;
    size: number;
}

function readSource(name: string): Source {
    const path = join(USER_PLUGINS_DIR, name);
    if (!statSync(path).isDirectory()) {
        const { size } = statSync(path);
        if (size > MAX_SIZE) throw new Error("too-big");
        return { entry: name, files: { [name]: readFileSync(path, "utf-8") }, size };
    }

    const files: Record<string, string> = {};
    let size = 0, count = 0;
    (function walk(dir: string, rel: string) {
        for (const f of readdirSync(dir)) {
            if (f.startsWith(".") || f === "node_modules") continue;
            const abs = join(dir, f);
            const relPath = rel ? `${rel}/${f}` : f;
            const st = statSync(abs);
            if (st.isDirectory()) { walk(abs, relPath); continue; }
            if (!KEEP_EXT.has(extname(f).toLowerCase())) continue;
            size += st.size;
            if (size > MAX_SIZE || ++count > MAX_FILES) throw new Error("too-big");
            files[relPath] = readFileSync(abs, "utf-8");
        }
    })(path, "");

    const entry = INDEX_NAMES.find(n => n in files);
    if (!entry) throw new Error("no-index");
    return { entry, files, size };
}

// ── Nom / description sans exécuter le code ──────────────────────────────────

const STRING = String.raw`(["'\x60])((?:\\.|(?!\1)[^\\])*)\1`;

function pluginField(code: string, field: string) {
    const i = code.search(/definePlugin\s*\(\s*\{/);
    if (i < 0) return "";
    return new RegExp(`\\b${field}\\s*:\\s*${STRING}`).exec(code.slice(i))?.[2].replace(/\\(.)/g, "$1") ?? "";
}

export function parseMeta(code: string, allCode = code): Omit<UserPluginMeta, "file" | "size"> {
    const block = /^\s*\/\*\*([\s\S]*?)\*\//.exec(code)?.[1] ?? "";
    const tag = (t: string) => new RegExp(`@${t}[ \\t]+(.+)`).exec(block)?.[1].trim() ?? "";
    const name = tag("name") || pluginField(allCode, "name");
    const meta = {
        name,
        description: tag("description") || pluginField(allCode, "description"),
        author: tag("author"),
        version: tag("version"),
    };
    if (!name) return { ...meta, error: "missing-name" };
    if (!/^[A-Za-z][\w-]{0,63}$/.test(name)) return { ...meta, error: "bad-name" };
    return meta;
}

function metaOf(name: string): UserPluginMeta {
    const folder = statSync(join(USER_PLUGINS_DIR, name)).isDirectory();
    try {
        const { entry, files, size } = readSource(name);
        // definePlugin peut être dans un autre fichier que l'index : on cherche partout.
        const all = files[entry] + "\n" + Object.entries(files).filter(([p]) => p !== entry && CODE_EXT.includes(extname(p))).map(([, c]) => c).join("\n");
        return { file: name, size, folder, ...parseMeta(files[entry], all) };
    } catch (e) {
        const error = e instanceof Error && ["too-big", "no-index"].includes(e.message) ? e.message : "read";
        return { file: name, name: "", description: "", author: "", version: "", size: 0, folder, error };
    }
}

// ── Archives .zip ────────────────────────────────────────────────────────────

/** Décompresse userplugins/X.zip dans userplugins/X/ puis supprime l'archive. */
function extractZip(zipName: string): string {
    const zipPath = join(USER_PLUGINS_DIR, zipName);
    if (statSync(zipPath).size > MAX_SIZE * 4) throw new Error("too-big");
    // Taille une fois décompressé contrôlée AVANT de décompresser : une archive
    // de quelques Ko peut en annoncer des Go (« zip bomb »).
    let announced = 0, count = 0;
    const raw = unzipSync(readFileSync(zipPath), {
        filter: f => {
            if (f.name.endsWith("/") || f.name.startsWith("__MACOSX/") || !KEEP_EXT.has(extname(f.name).toLowerCase())) return false;
            announced += f.originalSize;
            if (announced > MAX_SIZE || ++count > MAX_FILES) throw new Error("too-big");
            return true;
        },
    });

    // Chemins propres uniquement (pas de « .. », pas de chemin absolu).
    let entries = Object.entries(raw)
        .map(([p, data]) => [posix.normalize(p.replaceAll("\\", "/")), data] as const)
        .filter(([p]) => !p.startsWith("..") && !p.startsWith("/") && !/^[a-z]:/i.test(p));
    if (!entries.length) throw new Error("empty-zip");
    if (entries.reduce((n, [, d]) => n + d.length, 0) > MAX_SIZE) throw new Error("too-big");

    // Un zip contient souvent un seul dossier racine : on le retire.
    const hasRootIndex = entries.some(([p]) => INDEX_NAMES.includes(p));
    const roots = new Set(entries.map(([p]) => p.split("/")[0]));
    let folderName = zipName.replace(/\.zip$/i, "");
    if (!hasRootIndex && roots.size === 1 && entries.every(([p]) => p.includes("/"))) {
        const [root] = roots;
        entries = entries.map(([p, d]) => [p.slice(root.length + 1), d] as const);
        if (FOLDER.test(root) && !root.startsWith(".")) folderName = root;
    }
    if (!safeEntry(folderName)) folderName = "plugin-" + Date.now();

    const target = join(USER_PLUGINS_DIR, folderName);
    rmSync(target, { recursive: true, force: true });
    for (const [p, data] of entries) {
        const dest = join(target, ...p.split("/"));
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, data);
    }
    unlinkSync(zipPath);
    return folderName;
}

function extractPendingZips() {
    for (const f of readdirSync(USER_PLUGINS_DIR)) {
        if (!/\.zip$/i.test(f)) continue;
        try { extractZip(f); } catch (e) { console.error(`[low-cord] plugins perso : ${f} illisible`, e); }
    }
}

function listPlugins(): UserPluginMeta[] {
    if (!existsSync(USER_PLUGINS_DIR)) return [];
    extractPendingZips();
    return readdirSync(USER_PLUGINS_DIR)
        .filter(f => safeEntry(f) && (SINGLE_FILE.test(f) || statSync(join(USER_PLUGINS_DIR, f)).isDirectory()))
        .map(metaOf);
}

// ── Compilation ──────────────────────────────────────────────────────────────

function compile(path: string, code: string) {
    const ext = extname(path).toLowerCase();
    const transforms: Transform[] = ["imports"];
    if (ext === ".ts" || ext === ".tsx") transforms.push("typescript");
    if (ext !== ".ts") transforms.push("jsx");
    return transform(code, {
        transforms,
        filePath: path,
        production: true,
        // React est fourni par le rendu (pas encore chargé au moment où le fichier est lu).
        jsxPragma: "__lc.React.createElement",
        jsxFragmentPragma: "__lc.React.Fragment",
        disableESTransforms: true,
    }).code;
}

function bundle(name: string): UserPluginBundle {
    try {
        const { entry, files } = readSource(name);
        const modules: Record<string, string> = {};
        for (const [p, code] of Object.entries(files)) {
            try {
                modules[p] = CODE_EXT.includes(extname(p).toLowerCase()) ? compile(p, code) : code;
            } catch (e) {
                return { file: name, entry, modules: {}, error: `${p} : ${e instanceof Error ? e.message : e}` };
            }
        }
        return { file: name, entry, modules };
    } catch (e) {
        return { file: name, entry: "", modules: {}, error: e instanceof Error ? e.message : String(e) };
    }
}

// ── IPC ──────────────────────────────────────────────────────────────────────

// Démarrage (synchrone : le rendu en a besoin avant que Discord ne charge).
ipcMain.on(IpcEvents.USER_PLUGINS_BOOT, (e, enabledFiles: unknown) => {
    try {
        const wanted = Array.isArray(enabledFiles) ? enabledFiles.map(safeEntry).filter(Boolean) as string[] : [];

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

        const plugins = wanted.filter(f => existsSync(join(USER_PLUGINS_DIR, f))).map(bundle);

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

/** Copie un fichier (plugin seul ou .zip) dans le dossier et renvoie ses infos. */
function importFile(fileName: string, data: Buffer): UserPluginMeta {
    const name = basename(fileName);
    if (data.length > MAX_SIZE * 4) throw new Error("too-big");
    ensureDir();

    if (/\.zip$/i.test(name)) {
        const tmp = `import-${Date.now()}.zip`;
        writeFileSync(join(USER_PLUGINS_DIR, tmp), data);
        let folder: string;
        try {
            folder = extractZip(tmp);
        } finally {
            if (existsSync(join(USER_PLUGINS_DIR, tmp))) unlinkSync(join(USER_PLUGINS_DIR, tmp));
        }
        // Le dossier prend le nom du zip choisi, pas du fichier temporaire.
        const wantedName = name.replace(/\.zip$/i, "");
        if (folder.startsWith("import-") && safeEntry(wantedName)) {
            const dest = join(USER_PLUGINS_DIR, wantedName);
            rmSync(dest, { recursive: true, force: true });
            renameSync(join(USER_PLUGINS_DIR, folder), dest);
            folder = wantedName;
        }
        const meta = metaOf(folder);
        if (meta.error) {
            rmSync(join(USER_PLUGINS_DIR, folder), { recursive: true, force: true });
            throw new Error(meta.error);
        }
        return meta;
    }

    const file = safeEntry(name);
    if (!file || !SINGLE_FILE.test(file)) throw new Error("bad-file");
    if (data.length > MAX_SIZE) throw new Error("too-big");
    const meta = parseMeta(data.toString("utf-8"));
    if (meta.error) throw new Error(meta.error);
    writeFileSync(join(USER_PLUGINS_DIR, file), data);
    return { file, size: data.length, ...meta };
}

ipcMain.handle(IpcEvents.USER_PLUGINS_IMPORT, (_, fileName: unknown, code: unknown) => {
    if (typeof fileName !== "string" || typeof code !== "string") throw new Error("bad-file");
    return importFile(fileName, Buffer.from(code, "utf-8"));
});

// Sélecteur de fichier ouvert directement dans le dossier des plugins perso
// (celui de Discord ne permet pas de choisir le dossier de départ).
// Renvoie null si l'utilisateur annule.
ipcMain.handle(IpcEvents.USER_PLUGINS_PICK, async (e, title: unknown) => {
    ensureDir();
    const win = BrowserWindow.fromWebContents(e.sender);
    const options: Electron.OpenDialogOptions = {
        title: typeof title === "string" ? title : undefined,
        defaultPath: USER_PLUGINS_DIR,
        filters: [{ name: "low-cord plugin", extensions: ["zip", "js", "ts", "tsx", "jsx"] }],
        properties: ["openFile"],
    };
    const { canceled, filePaths } = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (canceled || !filePaths[0]) return null;

    const path = filePaths[0];
    if (statSync(path).size > MAX_SIZE * 4) throw new Error("too-big");
    return importFile(basename(path), readFileSync(path));
});

ipcMain.handle(IpcEvents.USER_PLUGINS_DELETE, (_, fileName: unknown) => {
    const file = safeEntry(fileName);
    if (!file) throw new Error("bad-file");
    const path = join(USER_PLUGINS_DIR, file);
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
});

ipcMain.handle(IpcEvents.USER_PLUGINS_OPEN_FOLDER, () => {
    ensureDir();
    return shell.openPath(USER_PLUGINS_DIR);
});
