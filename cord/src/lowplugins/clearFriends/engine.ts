/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// ClearFriends — moteur : retire des amis un par un, à un rythme sûr.
// Indépendant de la fenêtre : fermer la fenêtre n'arrête pas le travail
// (le bouton de la barre du haut montre qu'il tourne, « Arrêter » l'arrête).

import { Logger } from "@utils/Logger";
import { RestAPI } from "@webpack/common";

import Plugins from "~plugins";

export const logger = new Logger("ClearFriends");

export interface FriendRef {
    id: string;
    name: string;
}

export const state = {
    running: false,
    queue: [] as FriendRef[],
    current: null as FriendRef | null,
    done: 0,
    total: 0,
    failed: [] as FriendRef[],
    /** retirés pendant cette session (la liste les masque sans attendre Discord) */
    removed: new Set<string>(),
    slowed: false,
};

const listeners = new Set<() => void>();
export const subscribe = (fn: () => void) => (listeners.add(fn), () => { listeners.delete(fn); });
const emit = () => listeners.forEach(fn => fn());

let delay = 1000;
export const setDelay = (ms: number) => { delay = Math.min(5000, Math.max(500, Math.round(ms) || 1000)); };

let stopRequested = false;
let wake: (() => void) | null = null;
function sleep(ms: number) {
    return new Promise<void>(resolve => {
        const timer = setTimeout(done, ms);
        function done() {
            clearTimeout(timer);
            if (wake === done) wake = null;
            resolve();
        }
        wake = done;
    });
}

export function stop() {
    stopRequested = true;
    state.queue = [];
    wake?.();
    emit();
}

/**
 * Retire un ami. Prévient RelationshipNotifier (s'il est activé) que c'est
 * TOI qui retires cette personne : sinon il afficherait « X t'a retiré ».
 */
async function removeOne(f: FriendRef): Promise<boolean> {
    (Plugins.RelationshipNotifier as any)?.removeFriend?.(f.id);
    for (let attempt = 0; attempt < 8; attempt++) {
        if (stopRequested) return false;
        try {
            await RestAPI.del({ url: `/users/@me/relationships/${f.id}` });
            return true;
        } catch (e: any) {
            if (e?.status === 404) return true; // déjà plus ami
            if (e?.status === 429) {
                state.slowed = true;
                emit();
                await sleep(Math.ceil((e?.body?.retry_after ?? 5) * 1000) + 300);
                continue;
            }
            if ((e?.status == null || e.status >= 500) && attempt < 2) {
                await sleep(2000);
                continue;
            }
            logger.error(`Impossible de retirer ${f.name}`, e?.status, e?.body?.message ?? e);
            return false;
        }
    }
    return false;
}

export function enqueue(friends: FriendRef[]) {
    const fresh = friends.filter(f => !state.queue.some(q => q.id === f.id) && state.current?.id !== f.id);
    if (!fresh.length) return;
    if (!state.running) {
        state.done = 0;
        state.total = 0;
        state.failed = [];
    }
    state.queue.push(...fresh);
    state.total += fresh.length;
    emit();
    void run();
}

async function run() {
    if (state.running) return;
    state.running = true;
    stopRequested = false;
    emit();
    try {
        while (state.queue.length && !stopRequested) {
            const f = state.queue.shift()!;
            state.current = f;
            emit();
            const ok = await removeOne(f);
            state.current = null;
            if (ok) {
                state.removed.add(f.id);
                state.done++;
            } else if (!stopRequested) {
                state.failed.push(f);
                state.done++;
            }
            emit();
            if (stopRequested) break;
            if (state.queue.length) {
                // Petite variation : un rythme parfaitement régulier est plus repérable.
                await sleep(delay * (0.85 + Math.random() * 0.3) * (state.slowed ? 2 : 1));
                state.slowed = false;
            }
        }
    } finally {
        state.running = false;
        state.current = null;
        stopRequested = false;
        emit();
        if (state.queue.length) void run();
    }
}
