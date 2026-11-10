/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// AutoCorrect — réglages (gardés d'une session à l'autre dans settings.json)
// et état affiché par le bouton (en cours, corrigé, en attente de confirmation).

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";
import { useEffect, useState } from "@webpack/common";

export const settings = definePluginSettings({
    isEnabled: {
        type: OptionType.BOOLEAN,
        description: "Correct messages before sending them",
        default: true,
    },
    mode: {
        type: OptionType.SELECT,
        description: "How corrected messages are sent",
        options: [
            { label: "Send automatically after correcting", value: "auto", default: true },
            { label: "Show the correction, press Enter again to send", value: "confirm" },
        ],
    },
    livePreview: {
        type: OptionType.BOOLEAN,
        description: "Live preview while typing: corrected message above the text box, mistakes underlined in red",
        default: true,
    },
    accents: {
        type: OptionType.BOOLEAN,
        description: "Forgotten accents and apostrophes (daccord → d'accord, c'etait → c'était, deja → déjà)",
        default: true,
    },
    homophones: {
        type: OptionType.BOOLEAN,
        description: "Homophones (son/sont, a/à, ça/sa, et/est…)",
        default: true,
    },
    conjugation: {
        type: OptionType.BOOLEAN,
        description: "Conjugation (tu va → tu vas, il a manger → il a mangé)",
        default: true,
    },
    agreement: {
        type: OptionType.BOOLEAN,
        description: "Agreement in gender and number (les chat → les chats)",
        default: true,
    },
    hyphens: {
        type: OptionType.BOOLEAN,
        description: "Hyphens (dis moi → dis-moi)",
        default: true,
    },
    common: {
        type: OptionType.BOOLEAN,
        description: "Common chat mistakes (sa va → ça va, ont y va → on y va)",
        default: true,
    },
    showToast: {
        type: OptionType.BOOLEAN,
        description: "Show a pop-up with the corrections",
        default: true,
    },
    words: {
        type: OptionType.STRING,
        description: "Words never corrected, separated by commas",
        default: "",
    },
    ignorePrefixes: {
        type: OptionType.STRING,
        description: "Messages starting with one of these are sent as they are (bot commands), separated by spaces",
        default: "! . $ > ;",
    },
    totalFixed: {
        type: OptionType.NUMBER,
        description: "Mistakes corrected so far",
        default: 0,
        hidden: true,
    },
});

/** Familles de règles de Grammalecte pour chaque case des réglages. */
export function activeGroups() {
    const s = settings.store;
    const groups: string[] = [];
    if (s.homophones) groups.push("conf", "loc");
    if (s.conjugation) groups.push("conj", "infi", "imp", "vmode", "inte");
    if (s.agreement) groups.push("ppas", "gn");
    if (s.hyphens) groups.push("tu");
    return groups;
}

export const userWords = () => settings.store.words.split(",").map(w => w.trim().toLowerCase()).filter(Boolean);

export function addWord(word: string) {
    const w = word.trim().toLowerCase().replace(/,/g, "");
    if (!w || userWords().includes(w)) return;
    settings.store.words = [...userWords(), w].join(", ");
}

export function removeWord(word: string) {
    settings.store.words = userWords().filter(w => w !== word).join(", ");
}

// ── État du bouton ───────────────────────────────────────────────────────────
// idle : rien · working : correction en cours · done : corrigé (un instant)
// pending : mode confirmation, corrigé et en attente de la 2ᵉ Entrée.
export type ButtonState = "idle" | "working" | "done" | "pending";

let state: ButtonState = "idle";
let doneTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

export function setButtonState(next: ButtonState) {
    if (doneTimer) clearTimeout(doneTimer);
    doneTimer = null;
    state = next;
    // « Corrigé » s'affiche un instant puis le bouton revient au repos.
    if (next === "done") doneTimer = setTimeout(() => setButtonState("idle"), 1600);
    listeners.forEach(fn => fn());
}

export function useButtonState() {
    const [, tick] = useState(0);
    useEffect(() => {
        const fn = () => tick(n => n + 1);
        listeners.add(fn);
        return () => { listeners.delete(fn); };
    }, []);
    return state;
}

// ── Moteur ───────────────────────────────────────────────────────────────────
export interface EngineState {
    installed: boolean;
    version: string;
    busy: boolean;
    loaded: boolean;
    error?: string;
}

let engine: EngineState | null = null;
const engineListeners = new Set<() => void>();

export function setEngineState(next: EngineState | null) {
    engine = next;
    engineListeners.forEach(fn => fn());
}

export const getEngineState = () => engine;

export function useEngineState() {
    const [, tick] = useState(0);
    useEffect(() => {
        const fn = () => tick(n => n + 1);
        engineListeners.add(fn);
        return () => { engineListeners.delete(fn); };
    }, []);
    return engine;
}
