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
    /** supprimé, ou mention retirée en modifiant le message */
    kind: "delete" | "edit";
    authorId: string;
    author: string;
    guildId?: string;
    guild?: string;
    channelId: string;
    channel: string;
    content: string;
    /** @everyone / @here, rôle, ou toi */
    target: "me" | "everyone" | "role";
}

const RUNS_KEY = "pingfilter-runs";
const GHOSTS_KEY = "pingfilter-ghosts";
const MAX_RUNS = 30;
const MAX_GHOSTS = 200;

let runs: RunLog[] = [];
let ghosts: GhostLog[] = [];
let loaded = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(fn => fn());

export async function loadLogs() {
    if (loaded) return;
    [runs, ghosts] = await Promise.all([DataStore.get<RunLog[]>(RUNS_KEY), DataStore.get<GhostLog[]>(GHOSTS_KEY)]).then(([r, g]) => [r ?? [], g ?? []]);
    loaded = true;
    emit();
}

export function addRun(r: RunLog) {
    runs = [r, ...runs].slice(0, MAX_RUNS);
    emit();
    DataStore.set(RUNS_KEY, runs);
}

export function addGhost(g: GhostLog) {
    ghosts = [g, ...ghosts].slice(0, MAX_GHOSTS);
    emit();
    DataStore.set(GHOSTS_KEY, ghosts);
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
