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

import { Settings, useSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import { findByCodeLazy, findByPropsLazy, findStoreLazy } from "@webpack";
import { FluxDispatcher } from "@webpack/common";

const logger = new Logger("low-cord", "#d0d0d0");

export type OptimizeKey = "animations" | "gameMode" | "reducedMotion";
type OptimizeState = Partial<Record<OptimizeKey, boolean>> & {
    /** valeur de « Animations réduites » avant qu'on l'active, pour la rendre */
    previousReducedMotion?: string;
};

/** Réglages activés par l'interrupteur « Mode optimisé ». */
export const MODE_KEYS: OptimizeKey[] = ["animations", "gameMode"];

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

export function setOptimize(key: OptimizeKey, on: boolean) {
    state()[key] = on;
    if (key === "animations") applyAnimations();
    else if (key === "gameMode") applyGameMode();
    else applyReducedMotion(on);
}

export function setMode(on: boolean) {
    for (const key of MODE_KEYS) setOptimize(key, on);
}

/** Au démarrage / à la reconnexion : réapplique ce qui est activé. */
export function applyAll() {
    if (isOn("animations")) applyAnimations();
    if (isOn("gameMode")) applyGameMode();
}
