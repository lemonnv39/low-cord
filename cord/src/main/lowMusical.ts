/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-musical — installation du moteur (processus principal).
//
// Module optionnel, mis à jour séparément de low-cord. La CI publie le moteur
// sur la branche `musical-builds` : low-musical-engine.exe + manifest.json
// (version, taille, sha256). Ici :
//  - on demande à GitHub le commit actuel de la branche, puis on lit le
//    manifeste et l'exe à CE commit (jamais une adresse « dernière version »
//    que le cache peut servir en retard) ;
//  - l'exe téléchargé doit avoir exactement la taille et l'empreinte sha256
//    annoncées, et répondre à `--version` avec la bonne version ;
//  - il est écrit à côté puis mis en place d'un coup (jamais à moitié écrit).
// Dossier : %APPDATA%\low-cord\low-musical\

import { LOWCORD_REPO } from "@lowcord/constants";
import { IpcEvents } from "@shared/IpcEvents";
import { ChildProcess, execFile, spawn } from "child_process";
import { createHash, randomUUID } from "crypto";
import { app, BrowserWindow, ipcMain, net, screen, shell } from "electron";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { createInterface } from "readline";

import { DATA_DIR } from "./utils/constants";

export interface MusicalManifest {
    version: string;
    /** commit de la branche musical-builds où lire les fichiers */
    commit: string;
    /** commit de main dont le moteur est fait */
    sha: string;
    sha256: string;
    size: number;
    date: string;
}

export interface MusicalStatus {
    installed: boolean;
    /** version installée */
    version?: string;
    installedAt?: string;
    /** dernière version publiée (absente si GitHub injoignable) */
    latest?: MusicalManifest;
    updateAvailable: boolean;
    /** une installation / mise à jour / désinstallation est en cours */
    busy: boolean;
    error?: string;
}

const DIR = join(DATA_DIR, "low-musical");
export const ENGINE_EXE = join(DIR, "low-musical-engine.exe");
const META = join(DIR, "installed.json");
const EXE_NAME = "low-musical-engine.exe";
const MAX_SIZE = 100 * 1024 * 1024;
const HEADERS = { "User-Agent": "low-cord", "Accept": "application/vnd.github+json" };

interface Installed { version: string; sha256: string; sha: string; installedAt: string; }

function readInstalled(): Installed | null {
    if (!existsSync(ENGINE_EXE)) return null;
    try {
        const meta = JSON.parse(readFileSync(META, "utf8"));
        if (typeof meta?.version === "string" && typeof meta?.sha256 === "string") return meta;
    } catch { }
    return null;
}

async function latestManifest(): Promise<MusicalManifest> {
    const head = await net.fetch(`https://api.github.com/repos/${LOWCORD_REPO}/commits/musical-builds`, { headers: HEADERS });
    if (!head.ok) throw new Error(head.status === 404 ? "aucune version publiée" : `GitHub : HTTP ${head.status}`);
    const commit = (await head.json())?.sha;
    if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) throw new Error("GitHub : réponse inattendue");

    const res = await net.fetch(`https://raw.githubusercontent.com/${LOWCORD_REPO}/${commit}/manifest.json`, { headers: { "User-Agent": "low-cord" } });
    if (!res.ok) throw new Error(`manifeste : HTTP ${res.status}`);
    const m = await res.json();
    if (
        m?.file !== EXE_NAME
        || typeof m.version !== "string" || !/^\d+\.\d+\.\d+$/.test(m.version)
        || typeof m.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(m.sha256)
        || !Number.isInteger(m.size) || m.size <= 0 || m.size > MAX_SIZE
    ) throw new Error("manifeste invalide");
    return { version: m.version, commit, sha: String(m.sha ?? ""), sha256: m.sha256, size: m.size, date: String(m.date ?? "") };
}

/** Lance l'exe avec --version : il doit démarrer et annoncer la bonne version. */
function engineVersion(exe: string) {
    return new Promise<string>((resolve, reject) => {
        execFile(exe, ["--version"], { timeout: 10_000, windowsHide: true }, (err, stdout) => {
            if (err) reject(new Error(`le moteur ne démarre pas : ${err.message}`));
            else resolve(String(stdout).trim());
        });
    });
}

let busy = false;

async function status(): Promise<MusicalStatus> {
    const installed = readInstalled();
    const base = { installed: !!installed, version: installed?.version, installedAt: installed?.installedAt, busy };
    try {
        const latest = await latestManifest();
        return { ...base, latest, updateAvailable: !!installed && installed.sha256 !== latest.sha256 };
    } catch (e: any) {
        return { ...base, updateAvailable: false, error: String(e?.message ?? e) };
    }
}

/** Installe ou met à jour vers la dernière version publiée. */
async function install(): Promise<MusicalStatus> {
    if (busy) throw new Error("une opération est déjà en cours");
    busy = true;
    const tmp = join(DIR, `.download-${process.pid}.exe`);
    try {
        await stopEngine();
        const latest = await latestManifest();
        const res = await net.fetch(`https://raw.githubusercontent.com/${LOWCORD_REPO}/${latest.commit}/${EXE_NAME}`, { headers: { "User-Agent": "low-cord" } });
        if (!res.ok) throw new Error(`téléchargement : HTTP ${res.status}`);
        const data = Buffer.from(await res.arrayBuffer());
        if (data.length !== latest.size) throw new Error("fichier incomplet");
        if (createHash("sha256").update(data).digest("hex") !== latest.sha256) throw new Error("empreinte incorrecte : fichier refusé");

        mkdirSync(DIR, { recursive: true });
        writeFileSync(tmp, data);
        const got = await engineVersion(tmp);
        if (got !== latest.version) throw new Error(`version ${got} au lieu de ${latest.version}`);

        // Renommer remplace d'un coup (même disque).
        renameSync(tmp, ENGINE_EXE);
        const meta: Installed = { version: latest.version, sha256: latest.sha256, sha: latest.sha, installedAt: new Date().toISOString() };
        writeFileSync(META, JSON.stringify(meta, null, 2));
    } finally {
        rmSync(tmp, { force: true });
        busy = false;
    }
    return status();
}

async function uninstall(): Promise<MusicalStatus> {
    if (busy) throw new Error("une opération est déjà en cours");
    busy = true;
    try {
        await stopEngine();
        rmSync(DIR, { recursive: true, force: true });
    } finally {
        busy = false;
    }
    return status();
}

// ── Moteur ──────────────────────────────────────────────────────────────────
// Lancé à la demande, une ligne JSON par message sur son entrée/sortie. Ses
// événements (état du compte, erreurs) sont relayés à toutes les fenêtres de
// Discord. Fermer son entrée = il quitte le vocal et s'arrête : c'est ce qui
// se passe aussi quand Discord se ferme ou plante.

/** Commandes que Discord peut envoyer au moteur (jamais « shutdown » : géré ici). */
const ENGINE_COMMANDS = new Set([
    "version", "status", "devices",
    "connect", "disconnect", "leave", "set_follow", "set_fake_deafen", "set_bitrate", "set_volume",
    "set_input", "set_gain", "set_latency", "set_space", "set_eq", "set_processing", "set_meter",
    "join", "sb_load", "sb_unload", "sb_play", "sb_stop", "sb_volume",
]);
const CALL_TIMEOUT = 15_000;

let engine: ChildProcess | null = null;
let nextId = 1;
const waiting = new Map<number, { resolve(v: any): void; reject(e: Error): void; timer: NodeJS.Timeout; }>();

function broadcast(msg: unknown) {
    for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IpcEvents.LOWMUSICAL_EVENT, msg);
    }
}

function startEngine(): ChildProcess {
    if (engine) return engine;
    if (busy) throw new Error("installation en cours");
    if (!readInstalled()) throw new Error("low-musical n'est pas installé");

    const proc = spawn(ENGINE_EXE, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    engine = proc;

    createInterface({ input: proc.stdout! }).on("line", line => {
        let msg: any;
        try { msg = JSON.parse(line); } catch { return; }
        if (typeof msg?.id === "number" && waiting.has(msg.id)) {
            const w = waiting.get(msg.id)!;
            waiting.delete(msg.id);
            clearTimeout(w.timer);
            if (msg.ok) w.resolve(msg.result);
            else w.reject(new Error(String(msg.error ?? "erreur du moteur")));
        } else if (typeof msg?.event === "string") {
            broadcast(msg);
        }
    });
    // Le moteur n'écrit sur stderr qu'en cas de plantage : utile dans les logs.
    createInterface({ input: proc.stderr! }).on("line", line => console.error("[low-musical]", line));

    const finish = (reason: string) => {
        if (engine !== proc) return;
        engine = null;
        for (const [id, w] of waiting) {
            clearTimeout(w.timer);
            w.reject(new Error(reason));
            waiting.delete(id);
        }
        broadcast({ event: "exit", reason });
    };
    proc.on("exit", code => finish(code === 0 ? "moteur arrêté" : `le moteur s'est arrêté (code ${code})`));
    proc.on("error", e => finish(`le moteur ne démarre pas : ${e.message}`));
    proc.stdin!.on("error", () => { }); // moteur déjà fermé : on ignore
    return proc;
}

function callEngine(cmd: string, args: Record<string, unknown>) {
    const proc = startEngine();
    const id = nextId++;
    return new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => {
            waiting.delete(id);
            reject(new Error("le moteur ne répond pas"));
        }, CALL_TIMEOUT);
        waiting.set(id, { resolve, reject, timer });
        proc.stdin!.write(JSON.stringify({ ...args, id, cmd }) + "\n");
    });
}

/** Arrêt propre (le moteur quitte le vocal), forcé au bout de 3 s. */
function stopEngine() {
    const proc = engine;
    if (!proc) return Promise.resolve();
    return new Promise<void>(resolve => {
        const timer = setTimeout(() => { proc.kill(); resolve(); }, 3000);
        proc.once("exit", () => { clearTimeout(timer); resolve(); });
        proc.stdin!.end();
    });
}

ipcMain.handle(IpcEvents.LOWMUSICAL_ENGINE_CALL, (_, cmd: unknown, args: unknown) => {
    if (typeof cmd !== "string" || !ENGINE_COMMANDS.has(cmd)) throw new Error("commande refusée");
    const plain = args && typeof args === "object" && !Array.isArray(args) ? { ...args as Record<string, unknown> } : {};
    if (cmd === "sb_load") {
        // Le moteur ne lit que les sons importés : jamais un chemin venu de Discord.
        plain.path = soundPath(plain.file);
        delete plain.file;
    }
    return callEngine(cmd, plain);
});
ipcMain.handle(IpcEvents.LOWMUSICAL_ENGINE_RUNNING, () => engine !== null);
ipcMain.handle(IpcEvents.LOWMUSICAL_INSTALLED, () => readInstalled()?.version ?? null);
ipcMain.handle(IpcEvents.LOWMUSICAL_ENGINE_STOP, () => stopEngine());

// Discord se ferme : le moteur quitte le vocal de lui-même en voyant son entrée se fermer.
app.on("will-quit", () => engine?.stdin?.end());

ipcMain.handle(IpcEvents.LOWMUSICAL_STATUS, () => status());
ipcMain.handle(IpcEvents.LOWMUSICAL_INSTALL, () => install());
ipcMain.handle(IpcEvents.LOWMUSICAL_UNINSTALL, () => uninstall());
ipcMain.handle(IpcEvents.LOWMUSICAL_OPEN_FOLDER, () => {
    if (existsSync(DIR)) return shell.openPath(DIR);
});

// ── Déplacement de la fenêtre du panneau ────────────────────────────────────
// La fenêtre du panneau (sans cadre) se déplace en l'attrapant n'importe où
// sur un fond vide. Une zone de déplacement Windows bloquerait la molette et
// les barres de défilement : ici, tant que le bouton est tenu, on recale la
// fenêtre sur la souris (fonctionne d'un écran à l'autre).
let dragTimer: NodeJS.Timeout | null = null;

function stopDrag() {
    if (dragTimer) clearInterval(dragTimer);
    dragTimer = null;
}

ipcMain.handle(IpcEvents.LOWMUSICAL_DRAG_START, event => {
    stopDrag();
    // Le clic vient de donner le focus à la fenêtre du panneau (jamais la fenêtre principale).
    const win = BrowserWindow.getFocusedWindow();
    if (!win || win.isDestroyed() || win === BrowserWindow.fromWebContents(event.sender)) return false;
    if (!win.webContents.getURL().includes("/popout")) return false;
    const start = screen.getCursorScreenPoint();
    const [x, y] = win.getPosition();
    const startedAt = Date.now();
    dragTimer = setInterval(() => {
        // Garde-fou : jamais plus d'une minute (relâchement du bouton perdu).
        if (win.isDestroyed() || Date.now() - startedAt > 60_000) return stopDrag();
        const cursor = screen.getCursorScreenPoint();
        win.setPosition(x + cursor.x - start.x, y + cursor.y - start.y);
    }, 8);
    return true;
});
ipcMain.handle(IpcEvents.LOWMUSICAL_DRAG_END, () => stopDrag());

// Anti-stream : la fenêtre du panneau (titre « low-musical ») devient
// invisible dans les partages d'écran et les captures. Renvoie le nombre de
// fenêtres touchées (0 = panneau fermé : appliqué à sa prochaine ouverture).
ipcMain.handle(IpcEvents.LOWMUSICAL_STREAM_PROOF, (_, on: unknown) => {
    let n = 0;
    for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed() || win.getTitle() !== "low-musical" || !win.webContents.getURL().includes("/popout")) continue;
        win.setContentProtection(on === true);
        n++;
    }
    return n;
});

// ── Soundboard : sons importés ───────────────────────────────────────────────
// Copiés dans leur propre dossier (gardé si le moteur est désinstallé), sous
// un nom tiré au hasard : Discord ne donne jamais de chemin, seulement le nom.
const SOUNDS_DIR = join(DATA_DIR, "low-musical-sounds");
const SOUND_FILE = /^[0-9a-f-]{36}\.(mp3|wav|ogg|flac)$/;
const MAX_SOUND = 25 * 1024 * 1024;

function soundPath(file: unknown) {
    if (typeof file !== "string" || !SOUND_FILE.test(file)) throw new Error("son invalide");
    return join(SOUNDS_DIR, file);
}

ipcMain.handle(IpcEvents.LOWMUSICAL_SOUND_IMPORT, (_, name: unknown, data: unknown) => {
    const ext = typeof name === "string" ? /\.(mp3|wav|ogg|flac)$/i.exec(name)?.[1]?.toLowerCase() : undefined;
    if (!ext) throw new Error("format non pris en charge (mp3, wav, ogg, flac)");
    if (!(data instanceof Uint8Array) || !data.length) throw new Error("fichier vide");
    if (data.length > MAX_SOUND) throw new Error("fichier trop lourd (25 Mo au plus)");
    mkdirSync(SOUNDS_DIR, { recursive: true });
    const file = `${randomUUID()}.${ext}`;
    writeFileSync(join(SOUNDS_DIR, file), data);
    return file;
});
ipcMain.handle(IpcEvents.LOWMUSICAL_SOUND_DELETE, (_, file: unknown) => {
    rmSync(soundPath(file), { force: true });
});
ipcMain.handle(IpcEvents.LOWMUSICAL_SOUND_READ, (_, file: unknown) => readFileSync(soundPath(file)));
/** Sons encore présents sur le disque (les autres ont été effacés à la main). */
ipcMain.handle(IpcEvents.LOWMUSICAL_SOUND_LIST, () => {
    try {
        return readdirSync(SOUNDS_DIR).filter(f => SOUND_FILE.test(f) && statSync(join(SOUNDS_DIR, f)).isFile());
    } catch {
        return [];
    }
});

// Reste d'un téléchargement interrompu (Discord fermé en plein milieu).
app.whenReady().then(() => {
    try {
        if (!existsSync(DIR)) return;
        for (const f of readdirSync(DIR)) {
            if (f.startsWith(".download-")) rmSync(join(DIR, f), { force: true });
        }
    } catch { }
});
