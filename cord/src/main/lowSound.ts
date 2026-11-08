/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-sound — installation du moteur (processus principal).
//
// Module optionnel, mis à jour séparément de low-cord. La CI publie le moteur
// sur la branche `sound-builds` : low-sound-engine.exe + manifest.json
// (version, taille, sha256). Ici :
//  - on demande à GitHub le commit actuel de la branche, puis on lit le
//    manifeste et l'exe à CE commit (jamais une adresse « dernière version »
//    que le cache peut servir en retard) ;
//  - l'exe téléchargé doit avoir exactement la taille et l'empreinte sha256
//    annoncées, et répondre à `--version` avec la bonne version ;
//  - il est écrit à côté puis mis en place d'un coup (jamais à moitié écrit).
// Dossier : %APPDATA%\low-cord\low-sound\

import { LOWCORD_REPO } from "@lowcord/constants";
import { IpcEvents } from "@shared/IpcEvents";
import { ChildProcess, execFile, spawn } from "child_process";
import { createHash, randomUUID } from "crypto";
import { app, BrowserWindow, ipcMain, nativeImage, net, screen, shell } from "electron";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { createInterface } from "readline";

import { ICON_ICO, ICON_PNG } from "./lowSoundIcon";
import { DATA_DIR } from "./utils/constants";

export interface SoundManifest {
    version: string;
    /** commit de la branche sound-builds où lire les fichiers */
    commit: string;
    /** commit de main dont le moteur est fait */
    sha: string;
    sha256: string;
    size: number;
    date: string;
}

export interface SoundStatus {
    installed: boolean;
    /** version installée */
    version?: string;
    installedAt?: string;
    /** dernière version publiée (absente si GitHub injoignable) */
    latest?: SoundManifest;
    updateAvailable: boolean;
    /** une installation / mise à jour / désinstallation est en cours */
    busy: boolean;
    error?: string;
}

const DIR = join(DATA_DIR, "low-sound");
export const ENGINE_EXE = join(DIR, "low-sound-engine.exe");
const META = join(DIR, "installed.json");
const EXE_NAME = "low-sound-engine.exe";

// ── Ancien nom (low-musical) → low-sound ────────────────────────────────────
// Une seule fois, au démarrage de Discord (le moteur ne tourne pas encore) :
// les dossiers gardent tout leur contenu (sons, IR, plugins VST, moteur).
function migrateOldName() {
    const moves: [string, string][] = [
        ["low-musical-sounds", "low-sound-sounds"],
        ["low-musical-ir", "low-sound-ir"],
        ["low-musical-vst", "low-sound-vst"],
        ["low-musical", "low-sound"],
    ];
    for (const [from, to] of moves) {
        const src = join(DATA_DIR, from), dst = join(DATA_DIR, to);
        try {
            if (existsSync(src) && !existsSync(dst)) renameSync(src, dst);
        } catch (e) {
            console.error(`[low-sound] migration ${from} :`, e);
        }
    }
    try {
        const oldExe = join(DIR, "low-musical-engine.exe");
        if (existsSync(oldExe) && !existsSync(ENGINE_EXE)) renameSync(oldExe, ENGINE_EXE);
    } catch (e) {
        console.error("[low-sound] migration du moteur :", e);
    }
}
migrateOldName();
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

async function latestManifest(): Promise<SoundManifest> {
    const head = await net.fetch(`https://api.github.com/repos/${LOWCORD_REPO}/commits/sound-builds`, { headers: HEADERS });
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

async function status(): Promise<SoundStatus> {
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
/**
 * Windows garde l'exe verrouillé un court instant après l'arrêt du moteur (le
 * temps que ses hôtes VST se ferment aussi) : on réessaie au lieu d'échouer.
 */
async function retryLocked<T>(fn: () => T, tries = 25): Promise<T> {
    for (let i = 0; ; i++) {
        try {
            return fn();
        } catch (e: any) {
            if (i >= tries || !["EPERM", "EBUSY", "EACCES"].includes(e?.code)) throw e;
            await new Promise(r => setTimeout(r, 150));
        }
    }
}

async function install(): Promise<SoundStatus> {
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
        await retryLocked(() => renameSync(tmp, ENGINE_EXE));
        const meta: Installed = { version: latest.version, sha256: latest.sha256, sha: latest.sha, installedAt: new Date().toISOString() };
        writeFileSync(META, JSON.stringify(meta, null, 2));
    } finally {
        rmSync(tmp, { force: true });
        busy = false;
    }
    return status();
}

async function uninstall(): Promise<SoundStatus> {
    if (busy) throw new Error("une opération est déjà en cours");
    busy = true;
    try {
        await stopEngine();
        await retryLocked(() => rmSync(DIR, { recursive: true, force: true }));
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
    "join", "set_apo", "vst_param", "vst_editor", "vst_state", "sb_load", "sb_unload", "sb_play", "sb_stop", "sb_volume",
]);
const CALL_TIMEOUT = 15_000;
/** Commandes qui peuvent être longues : connexion, set APO avec plugins VST lourds. */
const SLOW_COMMANDS = new Set(["connect", "set_apo"]);
const SLOW_TIMEOUT = 60_000;

let engine: ChildProcess | null = null;
let nextId = 1;
const waiting = new Map<number, { resolve(v: any): void; reject(e: Error): void; timer: NodeJS.Timeout; }>();

function broadcast(msg: unknown) {
    for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IpcEvents.LOWSOUND_EVENT, msg);
    }
}

function startEngine(): ChildProcess {
    if (engine) return engine;
    if (busy) throw new Error("installation en cours");
    if (!readInstalled()) throw new Error("low-sound n'est pas installé");

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
    createInterface({ input: proc.stderr! }).on("line", line => console.error("[low-sound]", line));

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
        }, SLOW_COMMANDS.has(cmd) ? SLOW_TIMEOUT : CALL_TIMEOUT);
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

ipcMain.handle(IpcEvents.LOWSOUND_ENGINE_CALL, (_, cmd: unknown, args: unknown) => {
    if (typeof cmd !== "string" || !ENGINE_COMMANDS.has(cmd)) throw new Error("commande refusée");
    const plain = args && typeof args === "object" && !Array.isArray(args) ? { ...args as Record<string, unknown> } : {};
    if (cmd === "sb_load") {
        // Le moteur ne lit que les sons importés : jamais un chemin venu de Discord.
        plain.path = soundPath(plain.file);
        delete plain.file;
    }
    if (cmd === "set_apo" && Array.isArray(plain.stages)) {
        // Convolution : seulement les IR importées, chemin résolu ici.
        plain.stages = plain.stages.map((s: any) => {
            if (s?.t === "conv") {
                const { ir, ...rest } = s;
                return { ...rest, path: irPath(ir) };
            }
            if (s?.t === "vst") {
                // Plugins VST : seulement ceux déposés dans le dossier VST de low-sound.
                const { lib, ...rest } = s;
                return { ...rest, path: vstPath(lib) };
            }
            return s;
        });
    }
    return callEngine(cmd, plain);
});
ipcMain.handle(IpcEvents.LOWSOUND_ENGINE_RUNNING, () => engine !== null);
ipcMain.handle(IpcEvents.LOWSOUND_INSTALLED, () => readInstalled()?.version ?? null);
ipcMain.handle(IpcEvents.LOWSOUND_ENGINE_STOP, () => stopEngine());

// Discord se ferme : le moteur quitte le vocal de lui-même en voyant son entrée se fermer.
app.on("will-quit", () => engine?.stdin?.end());

ipcMain.handle(IpcEvents.LOWSOUND_STATUS, () => status());
ipcMain.handle(IpcEvents.LOWSOUND_INSTALL, () => install());
ipcMain.handle(IpcEvents.LOWSOUND_UNINSTALL, () => uninstall());
ipcMain.handle(IpcEvents.LOWSOUND_OPEN_FOLDER, () => {
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

ipcMain.handle(IpcEvents.LOWSOUND_DRAG_START, event => {
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
ipcMain.handle(IpcEvents.LOWSOUND_DRAG_END, () => stopDrag());

// Anti-stream : la fenêtre du panneau (titre « low-sound ») devient
// invisible dans les partages d'écran et les captures. Renvoie le nombre de
// fenêtres touchées (0 = panneau fermé : appliqué à sa prochaine ouverture).
ipcMain.handle(IpcEvents.LOWSOUND_STREAM_PROOF, (_, on: unknown) => {
    let n = 0;
    for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed() || win.getTitle() !== PANEL_TITLE || !win.webContents.getURL().includes("/popout")) continue;
        win.setContentProtection(on === true);
        n++;
    }
    return n;
});

// ── Soundboard : sons importés ───────────────────────────────────────────────
// Copiés dans leur propre dossier (gardé si le moteur est désinstallé), sous
// un nom tiré au hasard : Discord ne donne jamais de chemin, seulement le nom.
const SOUNDS_DIR = join(DATA_DIR, "low-sound-sounds");
const SOUND_FILE = /^[0-9a-f-]{36}\.(mp3|wav|ogg|flac)$/;
const MAX_SOUND = 25 * 1024 * 1024;

function soundPath(file: unknown) {
    if (typeof file !== "string" || !SOUND_FILE.test(file)) throw new Error("son invalide");
    return join(SOUNDS_DIR, file);
}

ipcMain.handle(IpcEvents.LOWSOUND_SOUND_IMPORT, (_, name: unknown, data: unknown) => {
    const ext = typeof name === "string" ? /\.(mp3|wav|ogg|flac)$/i.exec(name)?.[1]?.toLowerCase() : undefined;
    if (!ext) throw new Error("format non pris en charge (mp3, wav, ogg, flac)");
    if (!(data instanceof Uint8Array) || !data.length) throw new Error("fichier vide");
    if (data.length > MAX_SOUND) throw new Error("fichier trop lourd (25 Mo au plus)");
    mkdirSync(SOUNDS_DIR, { recursive: true });
    const file = `${randomUUID()}.${ext}`;
    writeFileSync(join(SOUNDS_DIR, file), data);
    return file;
});
ipcMain.handle(IpcEvents.LOWSOUND_SOUND_DELETE, (_, file: unknown) => {
    rmSync(soundPath(file), { force: true });
});
ipcMain.handle(IpcEvents.LOWSOUND_SOUND_READ, (_, file: unknown) => readFileSync(soundPath(file)));

// ── Mini APO : réponses impulsionnelles importées (Convolution) ─────────────
const IR_DIR = join(DATA_DIR, "low-sound-ir");
const IR_FILE = /^[0-9a-f-]{36}\.(wav|flac|ogg)$/;
const MAX_IR_FILE = 25 * 1024 * 1024;

function irPath(file: unknown) {
    if (typeof file !== "string" || !IR_FILE.test(file)) throw new Error("réponse impulsionnelle invalide");
    return join(IR_DIR, file);
}

ipcMain.handle(IpcEvents.LOWSOUND_IR_IMPORT, (_, name: unknown, data: unknown) => {
    const ext = typeof name === "string" ? /\.(wav|flac|ogg)$/i.exec(name)?.[1]?.toLowerCase() : undefined;
    if (!ext) throw new Error("format non pris en charge (wav, flac, ogg)");
    if (!(data instanceof Uint8Array) || !data.length) throw new Error("fichier vide");
    if (data.length > MAX_IR_FILE) throw new Error("fichier trop lourd (25 Mo au plus)");
    mkdirSync(IR_DIR, { recursive: true });
    const file = `${randomUUID()}.${ext}`;
    writeFileSync(join(IR_DIR, file), data);
    return file;
});
ipcMain.handle(IpcEvents.LOWSOUND_IR_DELETE, (_, file: unknown) => { rmSync(irPath(file), { force: true }); });
ipcMain.handle(IpcEvents.LOWSOUND_IR_READ, (_, file: unknown) => readFileSync(irPath(file)));

// ── Mini APO : dossier des plugins VST ──────────────────────────────────────
// L'utilisateur y dépose ses plugins (.dll VST2 64 bits). Rien n'est chargé
// tant qu'un set ne le demande pas, et chaque plugin tourne à part.
const VST_DIR = join(DATA_DIR, "low-sound-vst");
const VST_NAME = /^[^\\/:*?"<>|]{1,120}\.dll$/i;

function vstPath(name: unknown) {
    if (typeof name !== "string" || !VST_NAME.test(name)) throw new Error("plugin VST invalide");
    return join(VST_DIR, name);
}

ipcMain.handle(IpcEvents.LOWSOUND_VST_LIST, () => {
    try {
        return readdirSync(VST_DIR).filter(f => VST_NAME.test(f) && statSync(join(VST_DIR, f)).isFile());
    } catch {
        return [];
    }
});
ipcMain.handle(IpcEvents.LOWSOUND_VST_FOLDER, () => {
    mkdirSync(VST_DIR, { recursive: true });
    return shell.openPath(VST_DIR);
});
/** Sons encore présents sur le disque (les autres ont été effacés à la main). */
ipcMain.handle(IpcEvents.LOWSOUND_SOUND_LIST, () => {
    try {
        return readdirSync(SOUNDS_DIR).filter(f => SOUND_FILE.test(f) && statSync(join(SOUNDS_DIR, f)).isFile());
    } catch {
        return [];
    }
});

// ── Volet Mini APO : la fenêtre s'élargit vers la droite ────────────────────
// (ou vers la gauche s'il n'y a pas la place), puis reprend sa taille.
const widened = new WeakMap<BrowserWindow, { extra: number; shift: number; }>();

ipcMain.handle(IpcEvents.LOWSOUND_WIDEN, (_, extra: unknown) => {
    const want = typeof extra === "number" && Number.isFinite(extra) ? Math.max(0, Math.min(800, Math.round(extra))) : 0;
    for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed() || win.getTitle() !== "low-sound" || !win.webContents.getURL().includes("/popout")) continue;
        if (win.isMaximized() || win.isFullScreen()) continue;
        const prev = widened.get(win) ?? { extra: 0, shift: 0 };
        if (prev.extra === want) continue;
        const b = win.getBounds();
        // Retour à la taille d'origine, puis nouvel élargissement.
        const baseX = b.x + prev.shift, baseW = b.width - prev.extra;
        const area = screen.getDisplayMatching(b).workArea;
        const width = baseW + want;
        const shift = Math.max(0, baseX + width - (area.x + area.width));
        const x = Math.max(area.x, baseX - shift);
        win.setBounds({ x, y: b.y, width, height: b.height });
        widened.set(win, { extra: want, shift: baseX - x });
    }
});

// ── Icône de la fenêtre du panneau (barre des tâches) ───────────────────────
// La fenêtre du panneau (titre « low-sound ») a sa propre icône éclair et
// son propre identifiant Windows : elle a son bouton dans la barre des tâches
// au lieu d'être rangée sous l'icône de Discord.
const PANEL_TITLE = "low-sound";
const decorated = new WeakSet<BrowserWindow>();

function decoratePanel(win: BrowserWindow) {
    if (decorated.has(win) || win.isDestroyed()) return;
    decorated.add(win);
    try {
        win.setIcon(nativeImage.createFromBuffer(Buffer.from(ICON_PNG, "base64")));
        if (process.platform === "win32") {
            const ico = join(DATA_DIR, "low-sound.ico");
            writeFileSync(ico, Buffer.from(ICON_ICO, "base64"));
            win.setAppDetails({ appId: "lowcord.lowsound", appIconPath: ico, appIconIndex: 0, relaunchDisplayName: "low-sound" });
        }
    } catch (e) {
        console.error("[low-sound] icône du panneau :", e);
    }
}

app.on("browser-window-created", (_, win) => {
    win.on("page-title-updated", (_e, title) => {
        if (title === PANEL_TITLE && win.webContents.getURL().includes("/popout")) decoratePanel(win);
    });
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
