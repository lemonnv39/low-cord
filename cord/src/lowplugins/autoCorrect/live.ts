/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// AutoCorrect — analyse en direct pendant la frappe.
//
// Discord émet DRAFT_CHANGE à chaque touche (texte du brouillon du salon).
// Après une courte pause, le texte est corrigé par le moteur ; le résultat
// alimente l'aperçu au-dessus de la zone de texte et le soulignement des
// fautes, et il est gardé : à l'Entrée, la correction est déjà prête.

import { FluxDispatcher, SelectedChannelStore, useEffect, useState } from "@webpack/common";

import { Native } from "./engine";
import { activeGroups, getEngineState, settings, userWords } from "./settings";

export interface Result {
    text: string;
    fixes: { from: string; to: string; group: string; }[];
}

const DELAY = 300;
const CACHE_SIZE = 20;

/** Options envoyées au moteur (les mêmes pour l'aperçu et l'envoi). */
export const engineOptions = () => {
    const s = settings.store;
    return { groups: activeGroups(), whitelist: userWords(), custom: s.common, accents: s.accents };
};

// ── Cache : texte → correction (pour des réglages donnés) ───────────────────
const cache = new Map<string, Result>();
const key = (text: string) => JSON.stringify(engineOptions()) + "\u0000" + text;

export function cached(text: string) {
    return cache.get(key(text));
}

function remember(text: string, result: Result) {
    const k = key(text);
    cache.delete(k);
    cache.set(k, result);
    while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
}

/** Corrige `text` (depuis le cache si possible). */
export async function correctText(text: string): Promise<Result> {
    const hit = cached(text);
    if (hit) return hit;
    const result = await Native.correct(text, engineOptions()) as Result;
    remember(text, result);
    return result;
}

// ── État de l'aperçu ─────────────────────────────────────────────────────────
export interface LiveState {
    channelId: string | null;
    /** texte tapé */
    text: string;
    /** correction du texte tapé (ou du précédent, pendant l'analyse) */
    result: Result | null;
    /** `result` correspond-il exactement à `text` ? */
    fresh: boolean;
    analyzing: boolean;
}

let state: LiveState = { channelId: null, text: "", result: null, fresh: false, analyzing: false };
const listeners = new Set<() => void>();

function set(patch: Partial<LiveState>) {
    state = { ...state, ...patch };
    listeners.forEach(fn => fn());
}

export const getLive = () => state;

export function useLive() {
    const [, tick] = useState(0);
    useEffect(() => {
        const fn = () => tick(n => n + 1);
        listeners.add(fn);
        return () => { listeners.delete(fn); };
    }, []);
    return state;
}

/** Après l'envoi (ou en changeant de salon) : plus rien à montrer. */
export function resetLive() {
    if (timer) clearTimeout(timer);
    timer = null;
    set({ text: "", result: null, fresh: false, analyzing: false });
}

let timer: ReturnType<typeof setTimeout> | null = null;
let seq = 0;

function schedule(channelId: string, text: string) {
    if (timer) clearTimeout(timer);
    timer = null;
    const s = settings.store;
    // Un ou deux caractères, commande de bot, correcteur coupé : pas d'aperçu.
    const prefixes = s.ignorePrefixes.split(/\s+/).filter(Boolean);
    if (!s.isEnabled || !s.livePreview || !getEngineState()?.installed || text.trim().length < 3 || prefixes.some(p => text.startsWith(p))) {
        set({ channelId, text, result: null, fresh: false, analyzing: false });
        return;
    }
    const hit = cached(text);
    if (hit) {
        set({ channelId, text, result: hit, fresh: true, analyzing: false });
        return;
    }
    set({ channelId, text, fresh: false, analyzing: true });
    const id = ++seq;
    timer = setTimeout(async () => {
        timer = null;
        try {
            const result = await correctText(text);
            // Une frappe plus récente a déjà relancé l'analyse : ce résultat est périmé.
            if (id === seq) set({ result, fresh: true, analyzing: false });
        } catch {
            if (id === seq) set({ result: null, fresh: false, analyzing: false });
        }
    }, DELAY);
}

function onDraft(e: { channelId: string; draft: string; draftType: number; }) {
    // 0 = message du salon (pas une réponse à un fil, une commande…).
    if (e.draftType !== 0 || e.channelId !== SelectedChannelStore.getChannelId()) return;
    schedule(e.channelId, e.draft ?? "");
}

function onClear(e: { channelId: string; draftType: number; }) {
    if (e.draftType === 0 && e.channelId === state.channelId) resetLive();
}

function onChannel() {
    resetLive();
}

export function startLive() {
    FluxDispatcher.subscribe("DRAFT_CHANGE", onDraft);
    FluxDispatcher.subscribe("DRAFT_SAVE", onDraft);
    FluxDispatcher.subscribe("DRAFT_CLEAR", onClear);
    FluxDispatcher.subscribe("CHANNEL_SELECT", onChannel);
}

export function stopLive() {
    FluxDispatcher.unsubscribe("DRAFT_CHANGE", onDraft);
    FluxDispatcher.unsubscribe("DRAFT_SAVE", onDraft);
    FluxDispatcher.unsubscribe("DRAFT_CLEAR", onClear);
    FluxDispatcher.unsubscribe("CHANNEL_SELECT", onChannel);
    resetLive();
    cache.clear();
}

// ── Différences mot à mot ────────────────────────────────────────────────────
export interface Piece {
    text: string;
    changed: boolean;
    /** position dans le texte (début) */
    at: number;
}

const split = (text: string) => text.split(/(\s+)/).filter(Boolean);

/**
 * Compare deux textes mot à mot : ce qui a changé dans `before` (fautes) et
 * dans `after` (corrections). Plus longue sous-suite commune, sur des
 * messages courts.
 */
export function diff(before: string, after: string) {
    const a = split(before), b = split(after);
    if (a.length * b.length > 250_000) return { before: [{ text: before, changed: false, at: 0 }], after: [{ text: after, changed: false, at: 0 }] };
    const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        }
    }
    const outA: Piece[] = [], outB: Piece[] = [];
    let i = 0, j = 0, posA = 0, posB = 0;
    const push = (out: Piece[], text: string, changed: boolean, at: number) => out.push({ text, changed, at });
    while (i < a.length || j < b.length) {
        if (i < a.length && j < b.length && a[i] === b[j]) {
            push(outA, a[i], false, posA); push(outB, b[j], false, posB);
            posA += a[i++].length; posB += b[j++].length;
        } else if (j < b.length && (i >= a.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
            push(outB, b[j], !/^\s+$/.test(b[j]), posB);
            posB += b[j++].length;
        } else {
            push(outA, a[i], !/^\s+$/.test(a[i]), posA);
            posA += a[i++].length;
        }
    }
    return { before: outA, after: outB };
}
