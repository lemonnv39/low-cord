/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — mises à jour automatiques (processus principal).
//
// La CI publie chaque version sur la branche `builds` du repo. Ici :
//  1. dès le lancement de Discord (puis régulièrement), on demande à GitHub
//     le dernier commit de `builds` ;
//  2. s'il diffère de la version installée (.build-sha, écrit par
//     l'injecteur), on télécharge les 4 fichiers à CE commit précis (jamais
//     une adresse « dernière version » que le cache de GitHub peut servir en
//     retard), on vérifie que c'est bien une build low-cord, et on la met de
//     côté dans dist/.pending ;
//  3. la nouvelle version remplace l'ancienne seulement quand Discord
//     redémarre (flèche verte) ou se ferme : jamais pendant qu'il tourne
//     (une fenêtre rechargée mélangerait les deux versions). Le remplacement
//     est tout ou rien : en cas d'échec, l'ancienne version est remise.
//
// Deux protections :
//  - intégrité : chaque fichier téléchargé doit avoir exactement l'empreinte
//    que Git a enregistrée pour ce commit (un fichier tronqué, abîmé ou
//    différent de celui publié est refusé) ;
//  - retour arrière : l'ancienne version est gardée. Si Discord n'arrive pas
//    à démarrer 3 fois de suite après une mise à jour, elle est remise toute
//    seule et la version fautive est mise de côté jusqu'à la suivante.
//
// Actif seulement sur une installation faite par l'injecteur (présence de
// .build-sha à côté de patcher.js) : une build de développement n'est pas
// touchée.

import { LOWCORD_REPO } from "@lowcord/constants";
import { IpcEvents } from "@shared/IpcEvents";
import { createHash } from "crypto";
import { app, ipcMain, net } from "electron";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

export interface UpdateStatus {
    enabled: boolean;
    current?: string;
    latest?: string;
    /** une nouvelle version est téléchargée et prête */
    ready: boolean;
    error?: string;
    /** date (ms) de la dernière vérification réussie */
    checkedAt?: number;
    /** version mise de côté : Discord ne démarrait plus avec elle, l'ancienne a été remise */
    skipped?: string;
}

const DIST = __dirname;
const SHA_FILE = join(DIST, ".build-sha");
const PENDING = join(DIST, ".pending");
const BACKUP = join(DIST, ".backup");
/** version d'avant la dernière mise à jour (pour le retour arrière) */
const PREVIOUS = join(DIST, ".previous");
/** posé à chaque mise à jour, retiré quand Discord a bien démarré */
const BOOT_CHECK = join(DIST, ".update-check");
/** version qui empêchait Discord de démarrer : pas réinstallée */
const SKIP_FILE = join(DIST, ".skip-sha");
const MAX_FAILED_BOOTS = 3;
const FILES = ["patcher.js", "preload.js", "renderer.js", "renderer.css"];
const SHA = /^[0-9a-f]{40}$/;
const HEADERS = { "User-Agent": "low-cord", "Accept": "application/vnd.github+json" };
/** Vérification de fond (en plus de celle du lancement et des demandes de la fenêtre). */
const EVERY = 10 * 60_000;

const enabled = () => existsSync(SHA_FILE);
const readText = (file: string) => {
    try { return readFileSync(file, "utf8").trim(); } catch { return null; }
};

async function github(path: string) {
    const res = await net.fetch(`https://api.github.com/repos/${LOWCORD_REPO}${path}`, { headers: HEADERS });
    if (res.status === 403 || res.status === 429) throw new Error("GitHub : trop de demandes, réessai plus tard");
    if (!res.ok) throw new Error(`GitHub : HTTP ${res.status}`);
    return res.json();
}

async function latestSha() {
    const sha = (await github("/commits/builds"))?.sha;
    if (typeof sha !== "string" || !SHA.test(sha)) throw new Error("GitHub : réponse inattendue");
    return sha;
}

/** Télécharge la version `sha` dans un dossier temporaire, puis la met de côté d'un coup. */
async function stage(sha: string) {
    const tmp = join(DIST, `.download-${process.pid}`);
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    try {
        // Les 4 fichiers en même temps : la mise à jour est prête plus vite.
        await Promise.all(FILES.map(async file => {
            const res = await net.fetch(`https://raw.githubusercontent.com/${LOWCORD_REPO}/${sha}/${file}`, { headers: { "User-Agent": "low-cord" } });
            if (!res.ok) throw new Error(`${file} : HTTP ${res.status}`);
            const data = Buffer.from(await res.arrayBuffer());
            if (data.length < 100) throw new Error(`${file} : fichier vide`);
            writeFileSync(join(tmp, file), data);
        }));
        await verifyIntegrity(sha, tmp);
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

/** Empreinte Git d'un fichier (sha1 de « blob <taille>\0 » + contenu). */
const gitBlobSha = (data: Buffer) => createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");

/** Les fichiers téléchargés sont exactement ceux du commit publié. */
async function verifyIntegrity(sha: string, dir: string) {
    const tree: { path: string; sha: string; }[] = (await github(`/git/trees/${sha}`))?.tree ?? [];
    for (const file of FILES) {
        const expected = tree.find(e => e.path === file)?.sha;
        if (!expected) throw new Error(`${file} : absent de la version publiée`);
        if (gitBlobSha(readFileSync(join(dir, file))) !== expected) throw new Error(`${file} : fichier différent de la version publiée (refusé)`);
    }
}

let running: Promise<UpdateStatus> | null = null;
let last: UpdateStatus | null = null;

export function checkForUpdate(): Promise<UpdateStatus> {
    // Plusieurs demandes en même temps (lancement, fenêtres) : une seule vérification.
    return running ??= (async (): Promise<UpdateStatus> => {
        if (!enabled()) return { enabled: false, ready: false };
        const current = readText(SHA_FILE) ?? undefined;
        try {
            const latest = await latestSha();
            if (latest === current) {
                rmSync(PENDING, { recursive: true, force: true });
                return { enabled: true, current, latest, ready: false, checkedAt: Date.now() };
            }
            // Version qui empêchait Discord de démarrer : on attend la suivante.
            const skipped = readText(SKIP_FILE);
            if (skipped === latest) {
                rmSync(PENDING, { recursive: true, force: true });
                return { enabled: true, current, latest, ready: false, checkedAt: Date.now(), skipped };
            }
            if (skipped) rmSync(SKIP_FILE, { force: true });
            if (readText(join(PENDING, ".sha")) !== latest) await stage(latest);
            return { enabled: true, current, latest, ready: true, checkedAt: Date.now() };
        } catch (e: any) {
            const pending = readText(join(PENDING, ".sha"));
            return { enabled: true, current, latest: pending ?? undefined, ready: pending != null, error: String(e?.message ?? e), checkedAt: last?.checkedAt };
        }
    })().then(s => (last = s)).finally(() => { running = null; });
}

/**
 * Remplace la version installée par celle mise de côté. Tout ou rien : les
 * fichiers actuels sont copiés avant, et remis si un remplacement échoue
 * (fichier bloqué par un antivirus…). Renvoie false s'il n'y a rien à installer.
 */
function applyPending() {
    const sha = readText(join(PENDING, ".sha"));
    if (!sha || !SHA.test(sha) || !FILES.every(f => existsSync(join(PENDING, f)))) return false;

    rmSync(BACKUP, { recursive: true, force: true });
    mkdirSync(BACKUP, { recursive: true });
    for (const file of FILES) copyFileSync(join(DIST, file), join(BACKUP, file));
    const backupSha = readText(SHA_FILE);

    try {
        // Renommer remplace le fichier d'un coup (même disque) : jamais de fichier à moitié écrit.
        for (const file of FILES) renameSync(join(PENDING, file), join(DIST, file));
        writeFileSync(SHA_FILE, sha);
    } catch (e) {
        for (const file of FILES) {
            try { copyFileSync(join(BACKUP, file), join(DIST, file)); } catch { }
        }
        if (backupSha) writeFileSync(SHA_FILE, backupSha);
        rmSync(PENDING, { recursive: true, force: true });
        throw e;
    }
    // L'ancienne version reste de côté tant que la nouvelle n'a pas fait ses preuves.
    try {
        rmSync(PREVIOUS, { recursive: true, force: true });
        renameSync(BACKUP, PREVIOUS);
        if (backupSha) {
            writeFileSync(join(PREVIOUS, ".sha"), backupSha);
            writeFileSync(BOOT_CHECK, JSON.stringify({ from: backupSha, to: sha, boots: 0 }));
        }
    } catch (e) {
        console.error("[low-cord] ancienne version non gardée :", e);
        rmSync(BACKUP, { recursive: true, force: true });
    }
    rmSync(PENDING, { recursive: true, force: true });
    return true;
}

// ── Retour arrière automatique ───────────────────────────────────────────────
// Après une mise à jour, chaque lancement compte tant que la fenêtre de
// Discord n'a pas confirmé qu'elle a bien démarré (LOWCORD_UPDATE_BOOT_OK).
// Au 3e lancement sans confirmation, l'ancienne version est remise.
function bootGuard() {
    if (!existsSync(BOOT_CHECK)) return;
    try {
        const check = JSON.parse(readFileSync(BOOT_CHECK, "utf8"));
        const boots = (Number(check?.boots) || 0) + 1;
        if (boots < MAX_FAILED_BOOTS) {
            writeFileSync(BOOT_CHECK, JSON.stringify({ ...check, boots }));
            return;
        }
        const previous = readText(join(PREVIOUS, ".sha"));
        rmSync(BOOT_CHECK, { force: true });
        if (!previous || !SHA.test(previous) || !FILES.every(f => existsSync(join(PREVIOUS, f)))) return;
        console.error(`[low-cord] Discord n'a pas démarré ${boots - 1} fois avec la version ${String(check?.to).slice(0, 7)} : retour à ${previous.slice(0, 7)}`);
        for (const file of FILES) copyFileSync(join(PREVIOUS, file), join(DIST, file));
        writeFileSync(SHA_FILE, previous);
        if (typeof check?.to === "string" && SHA.test(check.to)) writeFileSync(SKIP_FILE, check.to);
        rmSync(PENDING, { recursive: true, force: true });
        // Ce lancement tourne encore avec la version fautive : on repart sur l'ancienne.
        app.whenReady().then(() => {
            app.relaunch();
            app.exit(0);
        });
    } catch (e) {
        console.error("[low-cord] vérification du démarrage impossible :", e);
        rmSync(BOOT_CHECK, { force: true });
    }
}
if (enabled()) bootGuard();

ipcMain.handle(IpcEvents.LOWCORD_UPDATE_BOOT_OK, () => {
    rmSync(BOOT_CHECK, { force: true });
});

/** « Réessayer » dans les réglages : la version mise de côté peut être réinstallée. */
ipcMain.handle(IpcEvents.LOWCORD_UPDATE_RETRY_SKIPPED, () => {
    rmSync(SKIP_FILE, { force: true });
    return checkForUpdate();
});

// ── Quoi de neuf ─────────────────────────────────────────────────────────────
// Chaque version publiée (branche builds) s'appelle « dist: low-cord@<sha> »,
// le commit de main dont elle est faite. Les changements entre deux versions
// = les commits de main entre ces deux sha.
export interface ChangeEntry { sha: string; message: string; date: string; }
export interface Changes {
    /** version installée */
    current?: string;
    /** version dont on montre les changements (installée, ou prête à l'être) */
    to?: string;
    commits: ChangeEntry[];
    /** page GitHub des changements */
    url?: string;
    /** GitHub injoignable : on réessaiera */
    error?: boolean;
}

async function sourceOf(buildSha: string) {
    const message: string = (await github(`/commits/${buildSha}`))?.commit?.message ?? "";
    const sha = /low-cord@([0-9a-f]{7,40})/.exec(message)?.[1];
    if (!sha) throw new Error("version d'origine inconnue");
    return sha;
}

const toEntry = (c: any): ChangeEntry => ({
    sha: String(c.sha).slice(0, 7),
    message: String(c.commit?.message ?? ""),
    date: String(c.commit?.committer?.date ?? ""),
});

/**
 * Changements de `since` à `to` (par défaut : la version installée). Sans
 * `since` (rien à comparer), les derniers changements jusqu'à `to`.
 */
async function changesBetween(since: unknown, to: unknown): Promise<Changes> {
    const current = readText(SHA_FILE) ?? undefined;
    const target = typeof to === "string" && SHA.test(to) ? to : current;
    if (!target) return { current, commits: [] };
    if (typeof since === "string" && SHA.test(since)) {
        if (since === target) return { current, to: target, commits: [] };
        const [from, dest] = await Promise.all([sourceOf(since), sourceOf(target)]);
        const compare = await github(`/compare/${from}...${dest}`);
        return {
            current,
            to: target,
            commits: (compare?.commits ?? []).map(toEntry),
            url: `https://github.com/${LOWCORD_REPO}/compare/${from.slice(0, 12)}...${dest.slice(0, 12)}`,
        };
    }
    const dest = await sourceOf(target);
    const list = await github(`/commits?sha=${dest}&per_page=20`);
    return {
        current,
        to: target,
        // L'API donne le plus récent d'abord ; compare donne l'ordre inverse.
        commits: (Array.isArray(list) ? list : []).map(toEntry).reverse(),
        url: `https://github.com/${LOWCORD_REPO}/commits/${dest.slice(0, 12)}`,
    };
}

ipcMain.handle(IpcEvents.LOWCORD_UPDATE_CHECK, (_, force?: unknown) => {
    // Vérifiée il y a moins d'une minute : l'état connu suffit (GitHub limite
    // les demandes). `force` : bouton « Vérifier » des réglages.
    if (force !== true && !running && last?.checkedAt && Date.now() - last.checkedAt < 60_000) return last;
    return checkForUpdate();
});

ipcMain.handle(IpcEvents.LOWCORD_UPDATE_CHANGES, async (_, since: unknown, to: unknown) => {
    try {
        return await changesBetween(since, to);
    } catch (e) {
        console.error("[low-cord] changements introuvables :", e);
        return { current: readText(SHA_FILE) ?? undefined, commits: [], error: true };
    }
});

ipcMain.handle(IpcEvents.LOWCORD_UPDATE_RESTART, async () => {
    // Une vérification en cours (téléchargement) : on l'attend, sinon la version
    // à moitié téléchargée serait ignorée.
    if (running) await running.catch(() => { });
    try {
        applyPending();
    } catch (e: any) {
        console.error("[low-cord] mise à jour non appliquée :", e);
        return { ok: false, error: String(e?.message ?? e) };
    }
    // Laisse la réponse partir avant de quitter.
    setTimeout(() => {
        app.relaunch();
        app.exit(0);
    }, 150);
    return { ok: true };
});

// Discord quitté sans redémarrer depuis la flèche : la mise à jour s'applique
// quand même, pour le prochain lancement.
app.on("will-quit", () => {
    try {
        applyPending();
    } catch (e) {
        console.error("[low-cord] mise à jour non appliquée :", e);
    }
});

// Première vérification dès le lancement de Discord (pas d'attente) : la
// version est souvent prête avant même que la fenêtre ait fini de charger.
// Puis en fond, régulièrement.
app.whenReady().then(() => {
    if (!enabled()) return;
    checkForUpdate();
    setInterval(checkForUpdate, EVERY).unref?.();
});
