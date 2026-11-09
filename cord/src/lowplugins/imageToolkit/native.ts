/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// ImageToolkit (processus principal) — préparer une image pour Pinterest.
// Pinterest ne cherche pas une image à partir de son lien : il faut lui donner
// le fichier. On télécharge donc l'image (ici, sans la sécurité de la page
// Discord qui bloque les sites extérieurs), on l'enregistre dans un dossier
// temporaire de low-cord, on la copie dans le presse-papiers et on l'affiche
// dans l'Explorateur : il ne reste qu'à la glisser (ou la coller) sur Pinterest.

import { clipboard, IpcMainInvokeEvent, nativeImage, net, shell } from "electron";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const DIR = join(tmpdir(), "low-cord-images");
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_AGE = 24 * 60 * 60 * 1000;
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/** Fichiers de plus d'un jour : retirés à chaque nouvelle image. */
function cleanup() {
    try {
        const now = Date.now();
        for (const f of readdirSync(DIR)) {
            const p = join(DIR, f);
            if (now - statSync(p).mtimeMs > MAX_AGE) rmSync(p, { force: true });
        }
    } catch { }
}

export async function prepareForPinterest(_: IpcMainInvokeEvent, url: unknown, name: unknown) {
    if (typeof url !== "string") throw new Error("adresse invalide");
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error("adresse invalide");
    }
    if (parsed.protocol !== "https:") throw new Error("adresse refusée");

    const res = await net.fetch(parsed.href, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const ext = EXT[type];
    if (!ext) throw new Error("ce n'est pas une image");
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_BYTES) throw new Error("image trop lourde");
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > MAX_BYTES) throw new Error("image trop lourde");

    mkdirSync(DIR, { recursive: true });
    cleanup();
    const base = (typeof name === "string" ? name : "image").replace(/[^\w.-]/g, "_").slice(0, 60) || "image";
    const file = join(DIR, `${base}-${Date.now().toString(36)}.${ext}`);
    writeFileSync(file, data);

    // Presse-papiers : seulement PNG / JPEG (ce que Windows sait coller partout).
    let copied = false;
    if (ext === "png" || ext === "jpg") {
        const img = nativeImage.createFromBuffer(data);
        if (!img.isEmpty()) {
            clipboard.writeImage(img);
            copied = true;
        }
    }
    shell.showItemInFolder(file);
    return { copied };
}
