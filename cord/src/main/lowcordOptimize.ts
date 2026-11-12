/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — optimisations du processus principal (section « Optimisation »
// de l'onglet low-cord, voir src/lowcord/optimize.ts pour le côté fenêtre).
//
// Discord désactive TOUT ce que Chromium fait d'habitude pour une fenêtre en
// arrière-plan (backgroundThrottling: false, disable-background-timer-
// throttling, disable-renderer-backgrounding) : réduit dans la barre des
// tâches, il continue de dessiner son interface 60 fois par seconde. Ici :
//
//  - background : fenêtre réduite ou cachée → Chromium arrête de la DESSINER.
//    Les minuteries restent à pleine vitesse (connexion, notifications) et le
//    vocal tourne à part, dans le moteur natif : rien ne se coupe.
//  - quietLogs : Discord recopie toute sa console dans renderer_js.log (des
//    dizaines de lignes par minute en vocal). Seuls les avertissements et
//    les erreurs sont encore écrits.
//  - lightProcess (au démarrage) : pas de processus de rendu « de réserve »
//    gardé en mémoire pour rien, et le ramasse-miettes peut être déclenché
//    quand Discord passe en arrière-plan.

import { app, BrowserWindow } from "electron";

import { RendererSettings } from "./settings";

type Key = "background" | "quietLogs" | "lightProcess";
const isOn = (key: Key) => !!(RendererSettings.store.plugins?.Settings as any)?.lowcordOptimize?.[key];

// ── Options de démarrage de Chromium ─────────────────────────────────────────
// Discord pose ses propres listes après nous : on complète les siennes au
// lieu de les remplacer (appendSwitch écrase la valeur précédente).
if (isOn("lightProcess")) {
    const extra: Record<string, { sep: string; values: string[]; }> = {
        "disable-features": { sep: ",", values: ["SpareRendererForSitePerProcess"] },
        "js-flags": { sep: " ", values: ["--expose-gc"] },
    };
    const merged = (name: string, value?: string) => {
        const { sep, values } = extra[name];
        return [...new Set([...(value ?? "").split(sep), ...values].filter(Boolean))].join(sep);
    };
    const original = app.commandLine.appendSwitch.bind(app.commandLine);
    app.commandLine.appendSwitch = (name: string, value?: string) =>
        (name in extra ? original(name, merged(name, value)) : value === undefined ? original(name) : original(name, value));
    for (const name of Object.keys(extra)) original(name, merged(name, app.commandLine.getSwitchValue(name)));
}

// ── Fenêtres ─────────────────────────────────────────────────────────────────
const isPopout = (win: BrowserWindow) => {
    try { return win.webContents.getURL().includes("/popout"); } catch { return true; }
};

/** Console → fichier : seulement « warning » et « error » (nouveau et ancien format de l'événement). */
function importantOnly(args: any[]) {
    const level = typeof args[0]?.level === "string" ? args[0].level : args[1];
    return level === "warning" || level === "error" || (typeof level === "number" && level >= 2);
}

app.on("browser-window-created", (_, win) => {
    // Posé avant que Discord n'écoute la console de sa fenêtre.
    const wc = win.webContents as any;
    const on = wc.on.bind(wc);
    wc.on = wc.addListener = (event: string, listener: (...args: any[]) => void) =>
        (event === "console-message"
            ? on(event, (...args: any[]) => { if (!isOn("quietLogs") || importantOnly(args)) listener(...args); })
            : on(event, listener));

    // Les fenêtres détachées (panneau low-sound, appel) sont animées par le
    // code de la fenêtre principale : tant qu'une d'elles est ouverte, la
    // fenêtre principale continue de tourner normalement, même réduite.
    const popoutOpen = () => BrowserWindow.getAllWindows().some(w => w !== win && !w.isDestroyed() && w.isVisible() && isPopout(w));
    const isHidden = () => win.isMinimized() || !win.isVisible();

    const update = () => {
        try {
            if (win.isDestroyed() || isPopout(win)) return;
            // Réglage coupé entre-temps : on rend toujours la main à Discord.
            win.webContents.setBackgroundThrottling(isOn("background") && isHidden() && !popoutOpen());
        } catch { }
    };
    for (const event of ["minimize", "hide", "restore", "show"] as const) win.on(event as any, update);
    // Une fenêtre détachée s'ouvre ou se ferme : l'état des autres est revu.
    const refreshOthers = () => setTimeout(() => {
        for (const w of BrowserWindow.getAllWindows()) if (w !== win && !w.isDestroyed()) w.emit("lowcord-optimize-refresh");
    }, 300);
    win.on("lowcord-optimize-refresh" as any, update);
    win.once("ready-to-show", refreshOthers);
    win.once("closed", refreshOthers);
});
