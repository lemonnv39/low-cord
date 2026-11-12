/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — optimisations de Discord (section « Optimisation » de l'onglet
// low-cord). Uniquement des mécanismes que Discord possède déjà, vérifiés dans
// son code : rien ne touche aux appels, au son, à la vidéo ni aux messages.
//
//  - animations : GIF, emojis et stickers animés seulement au survol. Même
//    surcouche LOCALE que les « animations réduites » de Discord : les
//    réglages du compte ne changent pas (rien ne bouge sur le téléphone).
//  - gameMode   : le « Mode jeu » que Discord prépare (encore réservé à un
//    test) : pendant qu'un jeu tourne et que Discord est en arrière-plan, il
//    coupe ses animations et dessine 10 images/s au lieu de 60.
//  - reducedMotion : le réglage « Animations réduites » de Discord (fondus et
//    glissements de l'interface).
//
// Et le fonctionnement interne de Discord, modifié par low-cord :
//
//  - background : Discord hors de vue ne travaille plus pour rien. Fenêtre
//    réduite → Chromium arrête de la dessiner (src/main/lowcordOptimize.ts).
//    Fenêtre sans le focus → toutes les animations CSS sont mises en pause.
//    Après une minute en arrière-plan → la mémoire inutile est rendue
//    (images décodées, ramasse-miettes).
//  - quietLogs : le journal interne de Discord (console recopiée dans un
//    fichier) ne garde que les avertissements et les erreurs.
//  - cacheTrim : les messages des salons que tu n'as pas ouverts depuis 20 min
//    sortent de la mémoire (Discord les recharge à la prochaine visite).
//  - lightProcess : options de démarrage de Chromium (au redémarrage).

import { Settings, useSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import { findByCodeLazy, findByPropsLazy, findLazy, findStoreLazy } from "@webpack";
import { FluxDispatcher, SelectedChannelStore } from "@webpack/common";

const logger = new Logger("low-cord", "#d0d0d0");

export type OptimizeKey = "animations" | "gameMode" | "reducedMotion" | "background" | "quietLogs" | "cacheTrim" | "lightProcess";
type OptimizeState = Partial<Record<OptimizeKey, boolean>> & {
    /** valeur de « Animations réduites » avant qu'on l'active, pour la rendre */
    previousReducedMotion?: string;
};

/** Réglages activés par l'interrupteur « Mode optimisé ». */
export const MODE_KEYS: OptimizeKey[] = ["animations", "gameMode", "background", "quietLogs", "cacheTrim", "lightProcess"];
/** Réglages lus au lancement de Discord : un changement compte au prochain redémarrage. */
export const RESTART_KEYS: OptimizeKey[] = ["lightProcess"];

const STORE_PATH = "plugins.Settings.lowcordOptimize";

const SettingsActions = findByPropsLazy("applySettingsOverride", "clearSettingsOverride");
const AccessibilityStore = findStoreLazy("AccessibilityStore") as { prefersReducedMotion: string; useReducedMotion: boolean; };
const setPrefersReducedMotion: (value: string) => void = findByCodeLazy('type:"ACCESSIBILITY_SET_PREFERS_REDUCED_MOTION",prefersReducedMotion');

function state(): OptimizeState {
    const s = Settings.plugins.Settings as any;
    s.lowcordOptimize ??= {};
    return s.lowcordOptimize;
}

export function isOn(key: OptimizeKey) {
    return !!(Settings.plugins.Settings as any)?.lowcordOptimize?.[key];
}

export function useOptimize() {
    useSettings([`${STORE_PATH}.*` as never]);
    return {
        animations: isOn("animations"),
        gameMode: isOn("gameMode"),
        reducedMotion: isOn("reducedMotion"),
        background: isOn("background"),
        quietLogs: isOn("quietLogs"),
        cacheTrim: isOn("cacheTrim"),
        lightProcess: isOn("lightProcess"),
    };
}

// ── Application de chaque réglage ────────────────────────────────────────────
// Clés de « raison » déjà connues de Discord : une clé inventée risquerait de
// casser l'affichage de ses propres réglages.
const OVERRIDES = {
    gifAutoPlay: { value: false, reasonKey: "REDUCED_MOTION" },
    animateEmoji: { value: false, reasonKey: "REDUCED_MOTION" },
    animateStickers: { value: 1 /* ANIMATE_ON_INTERACTION */, reasonKey: "REDUCED_MOTION_STICKERS" },
};

export function applyAnimations() {
    try {
        if (isOn("animations")) SettingsActions.applySettingsOverride(OVERRIDES);
        // Si les « Animations réduites » de Discord sont actives, ces mêmes
        // surcouches lui appartiennent aussi : on ne les retire pas.
        else if (!AccessibilityStore.useReducedMotion) SettingsActions.clearSettingsOverride(...Object.keys(OVERRIDES));
    } catch (e) {
        logger.error("Optimisation des animations impossible", e);
    }
}

export function applyGameMode() {
    try {
        // « enabled: undefined » rend la main au choix par défaut de Discord.
        FluxDispatcher.dispatch({ type: "GAME_MODE_SET_ENABLED", enabled: isOn("gameMode") ? true : undefined } as any);
    } catch (e) {
        logger.error("Mode jeu impossible", e);
    }
}

function applyReducedMotion(on: boolean) {
    try {
        const s = state();
        if (on) {
            s.previousReducedMotion ??= AccessibilityStore.prefersReducedMotion;
            setPrefersReducedMotion("reduce");
        } else {
            setPrefersReducedMotion(s.previousReducedMotion ?? "auto");
            delete s.previousReducedMotion;
            // Discord retire aussi ses surcouches d'animations au passage :
            // on remet les nôtres si l'optimisation des animations est active.
            applyAnimations();
        }
    } catch (e) {
        logger.error("Animations réduites impossibles", e);
    }
}

// ── Arrière-plan économe ─────────────────────────────────────────────────────
const PAUSED_CLASS = "lc-opt-paused";
/** Sans le focus depuis ce délai : animations en pause. */
const PAUSE_AFTER = 4000;
/** En arrière-plan depuis ce délai : mémoire rendue. */
const TRIM_AFTER = 60_000;
let pauseTimer: ReturnType<typeof setTimeout> | null = null;
let trimTimer: ReturnType<typeof setTimeout> | null = null;

/** Rend la mémoire que Discord garde sans s'en servir. */
export function trimMemory() {
    try {
        VencordNative.native.clearCache?.();
        // Disponible quand « Processus allégés » est actif (option de démarrage de Chromium).
        (window as any).gc?.();
    } catch (e) {
        logger.error("Libération de mémoire impossible", e);
    }
}

function onBackground() {
    if (!isOn("background")) return;
    pauseTimer ??= setTimeout(() => document.documentElement.classList.add(PAUSED_CLASS), document.hidden ? 0 : PAUSE_AFTER);
    trimTimer ??= setTimeout(() => {
        trimTimer = null;
        if (isOn("cacheTrim")) trimMessageCache();
        trimMemory();
    }, TRIM_AFTER);
}

function onForeground() {
    if (pauseTimer) clearTimeout(pauseTimer);
    if (trimTimer) clearTimeout(trimTimer);
    pauseTimer = trimTimer = null;
    document.documentElement.classList.remove(PAUSED_CLASS);
}

const onVisibility = () => (document.hidden ? onBackground() : document.hasFocus() && onForeground());
let backgroundHooked = false;

function applyBackground() {
    const on = isOn("background");
    if (on && !backgroundHooked) {
        window.addEventListener("blur", onBackground);
        window.addEventListener("focus", onForeground);
        document.addEventListener("visibilitychange", onVisibility);
        if (!document.hasFocus()) onBackground();
    } else if (!on && backgroundHooked) {
        window.removeEventListener("blur", onBackground);
        window.removeEventListener("focus", onForeground);
        document.removeEventListener("visibilitychange", onVisibility);
        onForeground();
    }
    backgroundHooked = on;
}

// ── Mémoire des conversations ────────────────────────────────────────────────
// Discord garde en mémoire les messages de chaque salon ouvert depuis le
// lancement. Ceux qu'on n'a pas rouverts depuis 20 min sont retirés : il les
// recharge tout seul à la prochaine visite.
const ChannelMessages: { forEach(fn: (cache: any) => void): void; clear(channelId: string): void; } = findLazy(m => m?._channelMessages && m.getOrCreate && m.clear);
const KEEP_FOR = 20 * 60_000;
const TRIM_EVERY = 5 * 60_000;
const lastUsed = new Map<string, number>();
let trimInterval: ReturnType<typeof setInterval> | null = null;

/** Un salon vient d'être ouvert ou rechargé (appelé par le plugin LowCordOptimizer). */
export function touchChannel(channelId?: string | null) {
    if (channelId) lastUsed.set(channelId, Date.now());
}

/** Salons dont des messages sont affichés en ce moment (salon ouvert, fil sur le côté, fenêtre détachée). */
function displayedChannels() {
    const ids = new Set<string>();
    for (const el of document.querySelectorAll("[id^=\"chat-messages-\"]")) {
        const id = /^chat-messages-(\d+)-/.exec(el.id)?.[1];
        if (id) ids.add(id);
    }
    const selected = SelectedChannelStore.getChannelId();
    if (selected) ids.add(selected);
    const voice = SelectedChannelStore.getVoiceChannelId();
    if (voice) ids.add(voice);
    return ids;
}

export function trimMessageCache() {
    try {
        const keep = displayedChannels();
        const now = Date.now();
        const drop: string[] = [];
        ChannelMessages.forEach(cache => {
            const id = cache?.channelId;
            if (!id || keep.has(id)) return;
            // Jamais vu passer : compté à partir de maintenant.
            if (!lastUsed.has(id)) lastUsed.set(id, now);
            // Un chargement en cours ou un saut vers un message : pas touché.
            else if (now - lastUsed.get(id)! > KEEP_FOR && !cache.loadingMore && cache.jumpTargetId == null) drop.push(id);
        });
        for (const id of drop) {
            ChannelMessages.clear(id);
            lastUsed.delete(id);
        }
        if (drop.length) logger.info(`Mémoire : ${drop.length} conversation(s) non ouvertes depuis 20 min retirées`);
        return drop.length;
    } catch (e) {
        logger.error("Nettoyage des conversations impossible", e);
        return 0;
    }
}

function applyCacheTrim() {
    if (trimInterval) clearInterval(trimInterval);
    trimInterval = isOn("cacheTrim") ? setInterval(trimMessageCache, TRIM_EVERY) : null;
}

export function setOptimize(key: OptimizeKey, on: boolean) {
    state()[key] = on;
    if (key === "animations") applyAnimations();
    else if (key === "gameMode") applyGameMode();
    else if (key === "reducedMotion") applyReducedMotion(on);
    else if (key === "background") applyBackground();
    else if (key === "cacheTrim") applyCacheTrim();
    // quietLogs : lu à chaque ligne de journal ; lightProcess : au prochain lancement.
}

export function setMode(on: boolean) {
    for (const key of MODE_KEYS) setOptimize(key, on);
}

/** Au démarrage / à la reconnexion : réapplique ce qui est activé. */
export function applyAll() {
    if (isOn("animations")) applyAnimations();
    if (isOn("gameMode")) applyGameMode();
    applyBackground();
    applyCacheTrim();
}
