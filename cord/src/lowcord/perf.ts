/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — journal de performances (côté fenêtre). Voir src/main/lowcordPerf.ts.
//  - blocages de la fenêtre (tâches de plus de 400 ms), avec l'événement de
//    Discord en cours de traitement ;
//  - temps passé par chaque plugin low-cord dans les événements de Discord :
//    un plugin qui dépasse 50 ms d'un coup est noté (nom + événement).

import { FluxDispatcher } from "@webpack/common";

const LONG_TASK_MS = 400;
const SLOW_HANDLER_MS = 50;

const send = (kind: string, text: string) => {
    try { VencordNative.lowcordPerf?.log(kind, text); } catch { }
};

/** Mesure un gestionnaire d'événement d'un plugin (appelé par PluginManager). */
export function timePluginHandler<T>(plugin: string, event: string, run: () => T): T {
    const start = performance.now();
    try {
        return run();
    } finally {
        const ms = performance.now() - start;
        if (ms > SLOW_HANDLER_MS) send("PLUGIN", `${plugin} a pris ${Math.round(ms)} ms sur ${event}`);
    }
}

let started = false;

export function startPerfWatch() {
    if (started || IS_WEB || typeof PerformanceObserver === "undefined") return;
    started = true;
    try {
        new PerformanceObserver(list => {
            for (const e of list.getEntries()) {
                if (e.duration < LONG_TASK_MS) continue;
                const action = (FluxDispatcher as any)?._currentDispatchActionType ?? (FluxDispatcher as any)?._dispatchingActionType;
                const hidden = document.hidden ? " · fenêtre cachée" : "";
                send("FENETRE", `fenêtre bloquée ${Math.round(e.duration)} ms${action ? ` · événement Discord : ${action}` : ""}${hidden}`);
            }
        }).observe({ type: "longtask", buffered: false });
    } catch { }

    // Mémoire de la fenêtre (Chromium) : une montée continue trahit une fuite.
    const mem = (performance as any).memory;
    if (mem) {
        let last = 0;
        setInterval(() => {
            const mb = Math.round(mem.usedJSHeapSize / 1048576);
            if (mb > 900 && mb - last > 150) send("MEMOIRE", `mémoire JavaScript de la fenêtre : ${mb} Mo (limite ${Math.round(mem.jsHeapSizeLimit / 1048576)} Mo)`);
            last = mb;
        }, 120_000);
    }
}
