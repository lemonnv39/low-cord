/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — journal de performances (processus principal).
//
// Un freeze arrive « parfois » et ne se reproduit pas sur commande : ce
// journal garde une trace de chaque blocage pour savoir, après coup, ce qui
// tournait à ce moment-là. Il note :
//  - les blocages du processus principal (toutes les fenêtres de Discord
//    se figent quand il ne répond plus) ;
//  - les blocages de la fenêtre et les plugins low-cord les plus lents
//    (envoyés par le rendu, voir src/lowcord/perf.ts) ;
//  - toutes les minutes : mémoire et processeur de Discord, mémoire libre du PC.
// Fichier : <données low-cord>\perf.log (gardé sous 2 Mo, l'ancien en perf.old.log).

import { IpcEvents } from "@shared/IpcEvents";
import { app, ipcMain } from "electron";
import { appendFileSync, existsSync, renameSync, statSync } from "fs";
import { cpus, freemem, totalmem } from "os";
import { join } from "path";

import { DATA_DIR } from "./utils/constants";

const FILE = join(DATA_DIR, "perf.log");
const OLD = join(DATA_DIR, "perf.old.log");
const MAX_BYTES = 2 * 1024 * 1024;
/** Le processus principal n'a pas répondu pendant au moins ce temps. */
const LAG_MS = 250;
const TICK_MS = 100;

const stamp = () => {
    const d = new Date();
    const p = (n: number, w = 2) => String(n).padStart(w, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};

export function perfLog(kind: string, text: string) {
    try {
        if (existsSync(FILE) && statSync(FILE).size > MAX_BYTES) renameSync(FILE, OLD);
        appendFileSync(FILE, `[${stamp()}] ${kind.padEnd(8)} ${text.replace(/[\r\n]+/g, " ").slice(0, 600)}\n`);
    } catch { /* journal de diagnostic : jamais bloquant */ }
}

/** Ce que faisait le processus principal juste avant (dernier appel reçu de Discord). */
let lastCall = "";
export const noteMainCall = (what: string) => { lastCall = `${what} @${Date.now()}`; };

// ── Blocages du processus principal ─────────────────────────────────────────
let expected = Date.now() + TICK_MS;
setInterval(() => {
    const now = Date.now();
    const lag = now - expected;
    expected = now + TICK_MS;
    if (lag < LAG_MS) return;
    const [what, at] = lastCall.split(" @");
    const recent = at && now - Number(at) < lag + 2000 ? ` · dernier appel : ${what}` : "";
    perfLog("MAIN", `processus principal bloqué ${lag} ms${recent}`);
}, TICK_MS).unref();

// ── État toutes les minutes ─────────────────────────────────────────────────
let lastCpu = 0;
function snapshot() {
    try {
        let memoryKB = 0, cpu = 0;
        const parts: string[] = [];
        for (const m of app.getAppMetrics()) {
            const kb = m.memory.privateBytes ?? m.memory.workingSetSize;
            memoryKB += kb;
            cpu += m.cpu.percentCPUUsage;
            if (kb > 300 * 1024) parts.push(`${m.type} ${Math.round(kb / 1024)} Mo`);
        }
        const share = cpu / Math.max(cpus().length, 1);
        const free = Math.round(freemem() / 1048576), total = Math.round(totalmem() / 1048576);
        // Une ligne par minute seulement si quelque chose sort de l'ordinaire, sinon une toutes les 10 min.
        const unusual = memoryKB > 2.5 * 1024 * 1024 || share > 25 || free < 2048 || Math.abs(share - lastCpu) > 15;
        lastCpu = share;
        if (unusual || new Date().getMinutes() % 10 === 0) {
            perfLog("ETAT", `Discord ${Math.round(memoryKB / 1024)} Mo, ${share.toFixed(1)} % CPU${parts.length ? ` (${parts.join(", ")})` : ""} · PC : ${free} / ${total} Mo libres`);
        }
    } catch { }
}
app.whenReady().then(() => {
    perfLog("START", `Discord ${app.getVersion()} lancé`);
    setInterval(snapshot, 60_000).unref();
});

// ── Événements envoyés par la fenêtre ────────────────────────────────────────
ipcMain.on(IpcEvents.LOWCORD_PERF_LOG, (_, kind: unknown, text: unknown) => {
    if (typeof kind === "string" && typeof text === "string" && /^[A-Z]{2,8}$/.test(kind)) perfLog(kind, text);
});
