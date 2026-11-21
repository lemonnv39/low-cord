/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// PingFilter — journal (gardé d'une session à l'autre) : les applications
// faites (quand, quel choix, serveurs réussis / en échec) et les ghost pings
// repérés (quelqu'un te mentionne puis supprime ou modifie son message).

import * as DataStore from "@api/DataStore";
import { useEffect, useState } from "@webpack/common";

import type { Profile } from "./apply";

export interface RunLog {
    at: number;
    kind: "apply" | "restore";
    profile?: Profile;
    total: number;
    ok: number;
    failed: { name: string; error: string; }[];
    stopped: boolean;
}

export interface GhostLog {
    at: number;
    /** message concerné (absent des anciennes entrées) : un même ghost ping n'est noté qu'une fois */
    messageId?: string;
    /** supprimé, ou mention retirée en modifiant le message */
    kind: "delete" | "edit";
    authorId: string;
    author: string;
    guildId?: string;
    guild?: string;
    channelId: string;
    channel: string;
    content: string;
    /** @everyone / @here, rôle, toi, ou message privé supprimé aussitôt envoyé */
    target: "me" | "everyone" | "role" | "dm";
}

const RUNS_KEY = "pingfilter-runs";
const GHOSTS_KEY = "pingfilter-ghosts";
const MAX_RUNS = 30;
const MAX_GHOSTS = 200;

let runs: RunLog[] = [];
let ghosts: GhostLog[] = [];
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(fn => fn());

/** Lit le journal enregistré, une seule fois. Les ajouts attendent cette lecture. */
export function loadLogs() {
    return loading ??= Promise.all([DataStore.get<RunLog[]>(RUNS_KEY), DataStore.get<GhostLog[]>(GHOSTS_KEY)])
        .then(([r, g]) => {
            runs = Array.isArray(r) ? r : [];
            ghosts = Array.isArray(g) ? g : [];
        })
        // Journal illisible : on repart d'un journal vide plutôt que de ne plus rien noter.
        .catch(() => { })
        .then(emit);
}

// Un ajout fait avant la fin de la lecture écrasait le journal enregistré
// (et l'entrée disparaissait de la liste) : on attend toujours la lecture.
export async function addRun(r: RunLog) {
    await loadLogs();
    runs = [r, ...runs].slice(0, MAX_RUNS);
    emit();
    await DataStore.set(RUNS_KEY, runs).catch(() => { });
}

/** Renvoie false si ce ghost ping était déjà noté. */
export async function addGhost(g: GhostLog) {
    await loadLogs();
    if (g.messageId && ghosts.some(x => x.messageId === g.messageId)) return false;
    ghosts = [g, ...ghosts].slice(0, MAX_GHOSTS);
    emit();
    await DataStore.set(GHOSTS_KEY, ghosts).catch(() => { });
    return true;
}

export function clearLogs(which: "runs" | "ghosts") {
    if (which === "runs") { runs = []; DataStore.del(RUNS_KEY); } else { ghosts = []; DataStore.del(GHOSTS_KEY); }
    emit();
}

export function useLogs() {
    const [, tick] = useState(0);
    useEffect(() => {
        const fn = () => tick(n => n + 1);
        listeners.add(fn);
        loadLogs();
        return () => { listeners.delete(fn); };
    }, []);
    return { runs, ghosts };
}
