/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — mises à jour automatiques (processus principal).
//
// La CI publie chaque version sur la branche `builds` du repo. Ici :
//  1. on demande à GitHub le dernier commit de `builds` ;
//  2. s'il diffère de la version installée (.build-sha, écrit par
//     l'injecteur), on télécharge les 4 fichiers à CE commit précis (jamais
//     une adresse « dernière version » que le cache de GitHub peut servir en
//     retard), on vérifie que c'est bien une build low-cord, et on la met de
//     côté dans dist/.pending ;
//  3. la nouvelle version remplace l'ancienne seulement quand Discord se
//     ferme ou redémarre : jamais pendant qu'il tourne (une fenêtre
//     rechargée mélangerait les deux versions).
//
// Actif seulement sur une installation faite par l'injecteur (présence de
// .build-sha à côté de patcher.js) : une build de développement n'est pas
// touchée.

import { LOWCORD_REPO } from "@lowcord/constants";
import { IpcEvents } from "@shared/IpcEvents";
import { app, ipcMain, net } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

export interface UpdateStatus {
    enabled: boolean;
    current?: string;
    latest?: string;
    /** une nouvelle version est téléchargée et prête */
    ready: boolean;
    error?: string;
}

const DIST = __dirname;
const SHA_FILE = join(DIST, ".build-sha");
const PENDING = join(DIST, ".pending");
const FILES = ["patcher.js", "preload.js", "renderer.js", "renderer.css"];
const SHA = /^[0-9a-f]{40}$/;
const HEADERS = { "User-Agent": "low-cord", "Accept": "application/vnd.github+json" };

const enabled = () => existsSync(SHA_FILE);
const readText = (file: string) => {
    try { return readFileSync(file, "utf8").trim(); } catch { return null; }
};

async function latestSha() {
    const res = await net.fetch(`https://api.github.com/repos/${LOWCORD_REPO}/commits/builds`, { headers: HEADERS });
    if (!res.ok) throw new Error(`GitHub : HTTP ${res.status}`);
    const sha = (await res.json())?.sha;
    if (typeof sha !== "string" || !SHA.test(sha)) throw new Error("GitHub : réponse inattendue");
    return sha;
}

/** Télécharge la version `sha` dans un dossier temporaire, puis la met de côté d'un coup. */
async function stage(sha: string) {
    const tmp = join(DIST, `.download-${process.pid}`);
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    try {
        for (const file of FILES) {
            const res = await net.fetch(`https://raw.githubusercontent.com/${LOWCORD_REPO}/${sha}/${file}`, { headers: { "User-Agent": "low-cord" } });
            if (!res.ok) throw new Error(`${file} : HTTP ${res.status}`);
            const data = Buffer.from(await res.arrayBuffer());
            if (data.length < 100) throw new Error(`${file} : fichier vide`);
            writeFileSync(join(tmp, file), data);
        }
        // Même contrôle que la CI : c'est bien une build low-cord.
        if (!readFileSync(join(tmp, "renderer.js"), "utf8").includes("\"low-cord\"")) throw new Error("build invalide");
        writeFileSync(join(tmp, ".sha"), sha);
        rmSync(PENDING, { recursive: true, force: true });
        renameSync(tmp, PENDING);
    } catch (e) {
        rmSync(tmp, { recursive: true, force: true });
        throw e;
    }
}

let running: Promise<UpdateStatus> | null = null;

export function checkForUpdate(): Promise<UpdateStatus> {
    // Plusieurs fenêtres peuvent demander en même temps : une seule vérification.
    return running ??= (async (): Promise<UpdateStatus> => {
        if (!enabled()) return { enabled: false, ready: false };
        const current = readText(SHA_FILE) ?? undefined;
        try {
            const latest = await latestSha();
            if (latest === current) {
                rmSync(PENDING, { recursive: true, force: true });
                return { enabled: true, current, latest, ready: false };
            }
            if (readText(join(PENDING, ".sha")) !== latest) await stage(latest);
            return { enabled: true, current, latest, ready: true };
        } catch (e: any) {
            return { enabled: true, current, ready: readText(join(PENDING, ".sha")) != null, error: String(e?.message ?? e) };
        }
    })().finally(() => { running = null; });
}

/** Remplace la version installée par celle mise de côté (Discord fermé ou en train de redémarrer). */
function applyPending() {
    const sha = readText(join(PENDING, ".sha"));
    if (!sha || !SHA.test(sha) || !FILES.every(f => existsSync(join(PENDING, f)))) return false;
    // Renommer remplace le fichier d'un coup (même disque) : jamais de fichier à moitié écrit.
    for (const file of FILES) renameSync(join(PENDING, file), join(DIST, file));
    writeFileSync(SHA_FILE, sha);
    rmSync(PENDING, { recursive: true, force: true });
    return true;
}

ipcMain.handle(IpcEvents.LOWCORD_UPDATE_CHECK, () => checkForUpdate());

ipcMain.handle(IpcEvents.LOWCORD_UPDATE_RESTART, () => {
    try {
        applyPending();
    } catch (e) {
        console.error("[low-cord] mise à jour non appliquée :", e);
    }
    app.relaunch();
    app.exit(0);
});

// Discord quitté sans redémarrer depuis l'icône : la mise à jour s'applique
// quand même, pour le prochain lancement.
app.on("will-quit", () => {
    try {
        applyPending();
    } catch (e) {
        console.error("[low-cord] mise à jour non appliquée :", e);
    }
});
