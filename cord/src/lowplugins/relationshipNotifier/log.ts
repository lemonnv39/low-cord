/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Journal des suppressions, sauvegardé par compte (un journal par compte
// Discord connecté). Les entrées les plus récentes sont en tête.

import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";
import { useEffect, UserStore, useState } from "@webpack/common";

import { LogEntry } from "./types";

const logger = new Logger("RelationshipNotifier");
const MAX_ENTRIES = 2000;

let entries: LogEntry[] = [];
let loadedFor: string | null = null;

const listeners = new Set<() => void>();
const emit = () => listeners.forEach(fn => fn());

const keyFor = (userId: string) => `relationship-notifier-log-${userId}`;

let loading: Promise<void> | null = null;

// Un seul chargement à la fois : deux lectures parallèles écraseraient une
// entrée ajoutée entre les deux.
export function loadLog() {
    loading ??= readLog().finally(() => { loading = null; });
    return loading;
}

async function readLog() {
    const me = UserStore.getCurrentUser()?.id;
    if (!me || loadedFor === me) return;
    try {
        const saved = await DataStore.get<LogEntry[]>(keyFor(me));
        entries = Array.isArray(saved) ? saved : [];
    } catch (e) {
        logger.error("Lecture du journal impossible", e);
        entries = [];
    }
    loadedFor = me;
    emit();
}

function save() {
    if (!loadedFor) return;
    DataStore.set(keyFor(loadedFor), entries).catch(e => logger.error("Sauvegarde du journal impossible", e));
}

export async function addLogEntry(entry: Omit<LogEntry, "key" | "ts"> & { ts?: number; }) {
    // Événement arrivé avant le chargement : on charge d'abord, sinon il
    // serait écrasé par la lecture du journal sauvegardé.
    if (loadedFor !== UserStore.getCurrentUser()?.id) await loadLog();
    if (!loadedFor) return;
    const ts = entry.ts ?? Date.now();
    entries = [{ ...entry, ts, key: `${ts}-${entry.kind}-${entry.targetId}` }, ...entries].slice(0, MAX_ENTRIES);
    save();
    emit();
}

export function clearLog() {
    entries = [];
    save();
    emit();
}

export function useLogEntries() {
    const [, tick] = useState(0);
    useEffect(() => {
        const fn = () => tick(n => n + 1);
        listeners.add(fn);
        // le compte a pu changer depuis le dernier chargement
        loadLog();
        return () => { listeners.delete(fn); };
    }, []);
    return entries;
}
