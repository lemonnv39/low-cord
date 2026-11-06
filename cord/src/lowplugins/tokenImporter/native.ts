/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { spawn } from "child_process";
import { BrowserWindow, dialog, IpcMainInvokeEvent, net, safeStorage } from "electron";
import { existsSync, writeFileSync } from "fs";
import { join } from "path";

const CHECK_TIMEOUT_MS = 10_000;
// Un token Discord : trois parties base64url séparées par des points. Tout le
// reste (retour à la ligne, espaces…) est refusé avant d'être mis dans un
// en-tête HTTP.
const TOKEN_SHAPE = /^[\w-]+\.[\w-]+\.[\w-]+$|^mfa\.[\w-]+$/;

// Vérifie un token en interrogeant l'API officielle Discord (lecture seule,
// /users/@me). N'écrit rien, ne touche à aucun autre compte.
export async function checkToken(_: IpcMainInvokeEvent, token: string): Promise<{ valid: boolean; user?: any; error?: string; }> {
    if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) return { valid: false, error: "malformed" };

    return new Promise(resolve => {
        let done = false;
        const finish = (r: { valid: boolean; user?: any; error?: string; }) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(r);
        };

        let req: Electron.ClientRequest;
        // Sans réponse de Discord, on ne laisse pas l'interface sur
        // « Vérification... » indéfiniment.
        const timer = setTimeout(() => {
            try { req?.abort(); } catch { }
            finish({ valid: false, error: "timeout" });
        }, CHECK_TIMEOUT_MS);

        try {
            req = net.request({
                method: "GET",
                url: "https://discord.com/api/v9/users/@me",
            });
            req.setHeader("Authorization", token);

            req.on("response", res => {
                let data = "";
                res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
                res.on("end", () => {
                    if (res.statusCode === 200) {
                        try { finish({ valid: true, user: JSON.parse(data) }); }
                        catch { finish({ valid: false, error: "parse_error" }); }
                    } else if (res.statusCode === 401 || res.statusCode === 403) {
                        finish({ valid: false, error: "unauthorized" });
                    } else if (res.statusCode === 429) {
                        finish({ valid: false, error: "rate_limited" });
                    } else {
                        finish({ valid: false, error: `http_${res.statusCode}` });
                    }
                });
            });

            req.on("error", () => finish({ valid: false, error: "network_error" }));
            req.end();
        } catch {
            finish({ valid: false, error: "exception" });
        }
    });
}

/** Le chiffrement du système (DPAPI sous Windows) est-il disponible ? */
export function isEncryptionAvailable(_: IpcMainInvokeEvent): boolean {
    try {
        return safeStorage.isEncryptionAvailable();
    } catch {
        return false;
    }
}

// Chiffrement local via Electron safeStorage — lié à cette session utilisateur
// uniquement. Pas de déchiffrement de clés d'autres applications, pas de scan
// disque : ce module ne lit/écrit que ce que CE plugin a lui-même stocké.
export async function encryptToken(_: any, token: string): Promise<string | null> {
    try {
        if (!safeStorage.isEncryptionAvailable()) return null;
        return safeStorage.encryptString(token).toString("base64");
    } catch {
        return null;
    }
}

export async function decryptToken(_: any, encryptedBase64: string): Promise<string | null> {
    try {
        if (!safeStorage.isEncryptionAvailable()) return null;
        return safeStorage.decryptString(Buffer.from(encryptedBase64, "base64"));
    } catch {
        return null;
    }
}

// Recharge la fenêtre au niveau du process principal — c'est ce que fait
// réellement Ctrl+R. Un simple `location.reload()` côté renderer ne relance
// pas proprement l'état interne de Discord après un changement de token.
// On recharge la fenêtre qui a fait la demande : la fenêtre « au premier
// plan » peut être une autre (ou aucune, si Discord n'a pas le focus), et le
// basculement ne se ferait alors jamais.
export function reload(event: IpcMainInvokeEvent): void {
    event.sender.reload();
}

// ── Export des tokens vers des .txt (un fichier par dossier) ────────────────────
// Écrit des fichiers en CLAIR à la demande explicite de l'utilisateur, dans un
// dossier qu'il choisit lui-même via le sélecteur natif — on n'écrit jamais à
// un emplacement en dur ni sans dialogue. Ce sont ses propres tokens, déjà
// déchiffrés côté renderer ; ce module ne fait que les poser sur le disque.
// Nom de fichier = nom du dossier, nettoyé des caractères interdits Windows.
function sanitizeFileName(name: string): string {
    return (name || "export").replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim() || "export";
}

export async function exportTokens(
    event: IpcMainInvokeEvent,
    groups: { name: string; accounts: { username: string; token: string; }[]; }[],
): Promise<{ ok: boolean; count?: number; dir?: string; error?: string; }> {
    try {
        if (!Array.isArray(groups)) return { ok: false, error: "invalid" };
        const win = BrowserWindow.fromWebContents(event.sender);
        const opts = {
            title: "low-cord — export des tokens / token export",
            properties: ["openDirectory", "createDirectory"] as any,
        };
        const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
        if (result.canceled || !result.filePaths.length) return { ok: false, error: "canceled" };

        const dir = result.filePaths[0];
        const used = new Set<string>();
        let count = 0;
        for (const group of groups) {
            if (!group?.accounts?.length) continue;
            // Deux dossiers du même nom (ou « Non classés ») : le second
            // fichier n'écrase pas le premier.
            const base = sanitizeFileName(group.name);
            let name = base;
            for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n})`;
            used.add(name.toLowerCase());

            // Une ligne par compte : on retire les retours à la ligne d'un pseudo.
            const lines = group.accounts.map(a => `account name: ${String(a.username).replace(/[\r\n]+/g, " ")} | token -> ${a.token}`);
            // CRLF pour une lecture propre dans le Bloc-notes Windows.
            writeFileSync(join(dir, `${name}.txt`), lines.join("\r\n") + "\r\n", "utf8");
            count++;
        }
        return { ok: true, count, dir };
    } catch (e: any) {
        return { ok: false, error: e?.message ?? "exception" };
    }
}

// ── Lancer une autre install Discord locale (onglet "Comptes locaux") ──────────
// `window.open("discord://")` côté renderer ne fait rien de fiable : Electron
// ne shell-out pas vers le protocole OS pour un simple window.open, et même si
// le protocole était enregistré, il ne cible que l'install par défaut — pas
// forcément celle réellement présente sur cette machine (ex: installs dans
// C:\ProgramData\<user>\ plutôt que %LOCALAPPDATA%, comme c'est le cas ici).
// On retrouve donc directement l'exécutable réel et on le lance via son propre
// Update.exe (le lanceur Squirrel que Discord utilise lui-même), qui focus la
// fenêtre existante si l'app tourne déjà au lieu d'en ouvrir une deuxième.
const BRANCH_DIRS: Record<string, string> = {
    stable: "Discord",
    canary: "DiscordCanary",
    ptb: "DiscordPTB",
};

const BRANCH_EXE: Record<string, string> = {
    stable: "Discord.exe",
    canary: "DiscordCanary.exe",
    ptb: "DiscordPTB.exe",
};

function candidateBases(): string[] {
    const bases: string[] = [];
    if (process.env.LOCALAPPDATA) bases.push(process.env.LOCALAPPDATA);
    if (process.env.PROGRAMDATA) {
        if (process.env.USERNAME) bases.push(join(process.env.PROGRAMDATA, process.env.USERNAME));
        bases.push(process.env.PROGRAMDATA);
    }
    return bases;
}

function findInstallBase(branch: string): string | null {
    const dirName = BRANCH_DIRS[branch];
    if (!dirName) return null;
    for (const base of candidateBases()) {
        const installDir = join(base, dirName);
        if (existsSync(join(installDir, "Update.exe"))) return installDir;
    }
    return null;
}

export async function launchLocalInstall(_: any, branch: string): Promise<{ ok: boolean; error?: string; }> {
    if (process.platform !== "win32") return { ok: false, error: "unsupported_platform" };

    const exe = BRANCH_EXE[branch];
    if (!exe) return { ok: false, error: "unknown_branch" };

    const installDir = findInstallBase(branch);
    if (!installDir) return { ok: false, error: "not_found" };

    try {
        const child = spawn(join(installDir, "Update.exe"), ["--processStart", exe], {
            detached: true,
            stdio: "ignore",
        });
        // Une erreur de lancement arrive en évènement, pas en exception : sans
        // écouteur, elle ferait planter le processus principal de Discord.
        child.on("error", e => console.error("[TokenImporter] launch failed:", e));
        child.unref();
        return { ok: true };
    } catch (e: any) {
        return { ok: false, error: e?.message ?? "spawn_failed" };
    }
}
