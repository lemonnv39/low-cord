/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — état des mises à jour côté Discord, partagé entre la flèche verte
// (plugin LowCordUpdater), la carte « Mises à jour » des réglages et la
// fenêtre « Quoi de neuf ». Le travail (vérifier, télécharger, installer) est
// fait par le processus principal : src/main/lowcordUpdater.ts.

import type { UpdateStatus } from "@main/lowcordUpdater";
import { Logger } from "@utils/Logger";
import { showToast, useEffect, useState } from "@webpack/common";

import { t } from "./i18n";

const logger = new Logger("LowCordUpdate");

export interface UpdateState {
    status: UpdateStatus | null;
    checking: boolean;
    installing: boolean;
}

let state: UpdateState = { status: null, checking: false, installing: false };
const listeners = new Set<() => void>();

function set(patch: Partial<UpdateState>) {
    state = { ...state, ...patch };
    listeners.forEach(fn => fn());
}

export const getUpdateState = () => state;

/** Abonnement d'un composant à l'état des mises à jour. */
export function useUpdateState() {
    const [, tick] = useState(0);
    useEffect(() => {
        const fn = () => tick(n => n + 1);
        listeners.add(fn);
        return () => { listeners.delete(fn); };
    }, []);
    return state;
}

/** Version installée la dernière fois que Discord a démarré (pour « Quoi de neuf »). */
export const SEEN_KEY = "lowcord-last-seen-build";
/** Version d'avant la dernière mise à jour : « Nouveautés de cette version » des réglages. */
export const PREV_KEY = "lowcord-previous-build";

let checking: Promise<UpdateStatus | null> | null = null;

/** Demande l'état au processus principal (qui vérifie GitHub si besoin). */
export function checkForUpdates(force = false) {
    return checking ??= (async () => {
        set({ checking: true });
        try {
            const status = await VencordNative.lowcordUpdate.check(force);
            set({ status });
            if (status.error) logger.warn("Vérification :", status.error);
            return status;
        } catch (e) {
            logger.error("Vérification impossible", e);
            return null;
        } finally {
            set({ checking: false });
            checking = null;
        }
    })();
}

/** Installe la version prête et redémarre Discord. */
export async function installAndRestart() {
    if (state.installing) return;
    set({ installing: true });
    showToast({ text: t("upd.restarting") });
    try {
        const res = await VencordNative.lowcordUpdate.restart();
        // ok : Discord redémarre dans un instant, on garde l'état « installation ».
        if (res?.ok) return;
        logger.error("Installation impossible", res?.error);
        showToast({ text: t("upd.installFailed", { error: res?.error ?? "?" }), variant: "critical" });
    } catch (e) {
        logger.error("Redémarrage impossible", e);
        showToast({ text: t("upd.failed"), variant: "critical" });
    }
    set({ installing: false });
    // L'installation ratée a retiré la version téléchargée : on la reprend.
    checkForUpdates(true);
}

/** « il y a 3 min » à partir d'une date (ms). */
export function timeAgo(ms: number) {
    const min = Math.round((Date.now() - ms) / 60_000);
    if (min < 1) return t("upd.justNow");
    if (min < 60) return t("upd.minutesAgo", { n: min });
    return t("upd.hoursAgo", { n: Math.round(min / 60) });
}
