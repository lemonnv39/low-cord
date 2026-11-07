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
import { execFile } from "child_process";
import { createHash } from "crypto";
import { app, ipcMain, net, shell } from "electron";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

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
        rmSync(DIR, { recursive: true, force: true });
    } finally {
        busy = false;
    }
    return status();
}

ipcMain.handle(IpcEvents.LOWMUSICAL_STATUS, () => status());
ipcMain.handle(IpcEvents.LOWMUSICAL_INSTALL, () => install());
ipcMain.handle(IpcEvents.LOWMUSICAL_UNINSTALL, () => uninstall());
ipcMain.handle(IpcEvents.LOWMUSICAL_OPEN_FOLDER, () => {
    if (existsSync(DIR)) return shell.openPath(DIR);
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
