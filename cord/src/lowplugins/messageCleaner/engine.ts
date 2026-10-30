/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Message Cleaner — moteur. Supprime UNIQUEMENT tes propres messages, via les
// routes officielles de Discord (lecture de l'historique, recherche,
// suppression). Il n'envoie JAMAIS de message : l'ancienne méthode « silent »
// postait un « ** ** » (invisible) puis tentait de l'effacer ; quand Discord
// limitait le débit, l'effacement échouait en silence et ces messages
// invisibles restaient dans la conversation.

import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";
import { RestAPI, UserStore } from "@webpack/common";

export const logger = new Logger("MessageCleaner");

export type TargetKind = "dm" | "group" | "user" | "channel" | "server";

export interface Target {
    kind: TargetKind;
    /** salon (dm / group / channel), serveur (server) ou utilisateur (user : MP créé au besoin) */
    id: string;
    name: string;
    icon?: string;
}

export interface RunRecord {
    key: string;
    target: Target;
    startedAt: number;
    endedAt?: number;
    /** estimation (recherche Discord) quand elle est disponible */
    total?: number;
    deleted: number;
    /** déjà supprimés ailleurs / introuvables */
    gone: number;
    /** impossibles à supprimer (message système, accès retiré) */
    skipped: number;
    failed: number;
    status: "running" | "done" | "stopped" | "error";
    error?: string;
}

// ── Réglage de vitesse (mis à jour depuis les réglages du plugin) ────────────
let baseDelay = 700;
export function setBaseDelay(ms: number) {
    baseDelay = Math.min(5000, Math.max(250, Math.round(ms) || 700));
}

// ── État partagé avec l'interface ────────────────────────────────────────────
export const state = {
    queue: [] as Target[],
    current: null as RunRecord | null,
    history: [] as RunRecord[],
    running: false,
    /** ralentissement en cours (x1 = normal), après une limite de débit */
    penalty: 1,
    /** contenu supprimé pendant la session (pour l'export), par run */
    contents: new Map<string, string[]>(),
};

const listeners = new Set<() => void>();
export const subscribe = (fn: () => void) => (listeners.add(fn), () => { listeners.delete(fn); });
const emit = () => listeners.forEach(fn => fn());

// Un historique par compte (plusieurs comptes peuvent partager le même Discord).
let historyAccount: string | null = null;
const historyKey = (account: string) => `lowcord-cleaner-history-${account}`;
const MAX_HISTORY = 100;

export async function loadHistory() {
    const account = UserStore.getCurrentUser()?.id;
    if (!account || account === historyAccount) return;
    historyAccount = account;
    try {
        const saved = await DataStore.get<RunRecord[]>(historyKey(account));
        // Compte changé : on ne garde que le nettoyage en cours éventuel.
        state.history = state.history.filter(r => r.status === "running");
        if (Array.isArray(saved)) {
            // Un nettoyage resté « en cours » vient d'une fermeture de Discord.
            state.history.push(...saved.map(r => (r.status === "running" ? { ...r, status: "stopped" as const } : r)));
        }
        emit();
    } catch (e) {
        logger.error("Historique illisible", e);
    }
}

function saveHistory() {
    if (!historyAccount) return;
    DataStore.set(historyKey(historyAccount), state.history.slice(0, MAX_HISTORY)).catch(e => logger.error(e));
}

export function clearHistory() {
    state.history = state.history.filter(r => r.status === "running");
    state.contents.clear();
    saveHistory();
    emit();
}

// ── Arrêt et attente interruptible ───────────────────────────────────────────
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

// ── Appels à Discord ─────────────────────────────────────────────────────────
class StopError extends Error { }

const retryAfterMs = (e: any) => Math.ceil(((e?.body?.retry_after ?? e?.retry_after ?? 5) as number) * 1000) + 250;

/** Requête avec gestion des limites de débit (429) : on attend et on réessaie. */
async function request<T>(fn: () => Promise<T>, label: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        if (stopRequested) throw new StopError();
        try {
            return await fn();
        } catch (e: any) {
            if (e?.status === 429 && attempt < 12) {
                state.penalty = Math.min(6, state.penalty * 1.6);
                emit();
                await sleep(retryAfterMs(e));
                continue;
            }
            // Erreur réseau passagère : quelques nouvelles tentatives.
            if ((e?.status == null || e.status >= 500) && attempt < 3) {
                await sleep(2000 * (attempt + 1));
                continue;
            }
            logger.error(`${label} :`, e?.status, e?.body?.message ?? e);
            throw e;
        }
    }
}

const SYSTEM_MESSAGE = 50021;
const DELETABLE_TYPES = new Set([0, 19, 3]); // message, réponse, appel

type DeleteResult = "deleted" | "gone" | "skipped" | "failed";

async function deleteOne(channelId: string, messageId: string): Promise<DeleteResult> {
    try {
        await request(() => RestAPI.del({ url: `/channels/${channelId}/messages/${messageId}` }), "Suppression");
        return "deleted";
    } catch (e: any) {
        if (e instanceof StopError) throw e;
        if (e?.status === 404) return "gone";
        if (e?.status === 403 || e?.body?.code === SYSTEM_MESSAGE) return "skipped";
        return "failed";
    }
}

/** Pause entre deux suppressions : réglage + ralentissement après limite de débit. */
let successStreak = 0;
async function pace(result: DeleteResult) {
    if (result === "deleted" && ++successStreak >= 15 && state.penalty > 1) {
        state.penalty = Math.max(1, state.penalty * 0.85);
        successStreak = 0;
    }
    // Petite variation aléatoire : un rythme parfaitement régulier est plus repérable.
    const jitter = 0.85 + Math.random() * 0.3;
    await sleep(baseDelay * state.penalty * jitter);
}

async function openDm(userId: string): Promise<string> {
    const res: any = await request(() => RestAPI.post({ url: "/users/@me/channels", body: { recipient_id: userId } }), "Ouverture du MP");
    if (!res?.body?.id) throw new Error("dm-unavailable");
    return res.body.id;
}

/** Estimation du nombre de messages (recherche Discord), sans bloquer si elle échoue. */
async function estimate(target: Target, channelId: string | null, me: string): Promise<number | undefined> {
    try {
        const base = target.kind === "server"
            ? `/guilds/${target.id}/messages/search`
            : `/channels/${channelId}/messages/search`;
        const res: any = await request(() => RestAPI.get({ url: `${base}?author_id=${me}&include_nsfw=true` }), "Estimation");
        return typeof res?.body?.total_results === "number" ? res.body.total_results : undefined;
    } catch (e) {
        if (e instanceof StopError) throw e;
        return undefined;
    }
}

function record(run: RunRecord, result: DeleteResult, msg: any) {
    run[result === "deleted" ? "deleted" : result]++;
    if (result === "deleted") {
        const lines = state.contents.get(run.key) ?? [];
        if (lines.length < 20_000) lines.push(`[${msg.timestamp ?? ""}] ${msg.content || "<pièce jointe / intégration>"}`);
        state.contents.set(run.key, lines);
    }
    emit();
}

/** MP, groupe ou salon : lecture complète de l'historique (fiable, rien n'est oublié). */
async function cleanChannel(channelId: string, run: RunRecord, me: string) {
    let before: string | undefined;
    for (;;) {
        const url = `/channels/${channelId}/messages?limit=100${before ? `&before=${before}` : ""}`;
        const res: any = await request(() => RestAPI.get({ url }), "Lecture de l'historique");
        const page: any[] = Array.isArray(res?.body) ? res.body : [];
        if (!page.length) return;

        for (const msg of page) {
            if (stopRequested) throw new StopError();
            if (msg?.author?.id !== me) continue;
            if (!DELETABLE_TYPES.has(msg.type)) {
                run.skipped++;
                continue;
            }
            const result = await deleteOne(channelId, msg.id);
            record(run, result, msg);
            await pace(result);
        }

        before = page[page.length - 1].id;
        if (page.length < 100) return;
    }
}

/** Serveur : la recherche Discord trouve tes messages dans tous les salons. */
async function cleanServer(guildId: string, run: RunRecord, me: string) {
    const seen = new Set<string>();
    let maxId: string | undefined;
    let emptyPages = 0;

    for (;;) {
        const url = `/guilds/${guildId}/messages/search?author_id=${me}&include_nsfw=true${maxId ? `&max_id=${maxId}` : ""}`;
        const res: any = await request(() => RestAPI.get({ url }), "Recherche");

        // 202 : Discord est encore en train d'indexer le serveur. On patiente.
        if (res?.status === 202 || res?.body?.retry_after) {
            await sleep(retryAfterMs(res));
            continue;
        }

        const groups: any[][] = Array.isArray(res?.body?.messages) ? res.body.messages : [];
        const hits = groups.flat().filter(m => m?.author?.id === me && (m.hit ?? true) && !seen.has(m.id));
        if (!hits.length) {
            // La recherche peut renvoyer une page vide en plein milieu : on vérifie deux fois.
            if (!groups.length || ++emptyPages >= 2) return;
            await sleep(1500);
            continue;
        }
        emptyPages = 0;

        for (const msg of hits) {
            if (stopRequested) throw new StopError();
            seen.add(msg.id);
            if (!DELETABLE_TYPES.has(msg.type)) {
                run.skipped++;
                continue;
            }
            const result = await deleteOne(msg.channel_id, msg.id);
            record(run, result, msg);
            await pace(result);
        }

        // Page suivante : plus ancienne que le plus vieux message traité.
        const oldest = hits.reduce((a, b) => (BigInt(a.id) < BigInt(b.id) ? a : b));
        maxId = (BigInt(oldest.id) - 1n).toString();
        // Laisse respirer la recherche (limite de débit plus stricte).
        await sleep(1000);
    }
}

async function runTarget(target: Target) {
    const me = UserStore.getCurrentUser()?.id;
    const run: RunRecord = {
        key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        target,
        startedAt: Date.now(),
        deleted: 0, gone: 0, skipped: 0, failed: 0,
        status: "running",
    };
    state.current = run;
    state.history.unshift(run);
    emit();

    try {
        if (!me) throw new Error("not-logged-in");
        const channelId = target.kind === "server" ? null : target.kind === "user" ? await openDm(target.id) : target.id;
        run.total = await estimate(target, channelId, me);
        emit();

        if (target.kind === "server") await cleanServer(target.id, run, me);
        else await cleanChannel(channelId!, run, me);
        run.status = "done";
    } catch (e: any) {
        if (e instanceof StopError) run.status = "stopped";
        else {
            run.status = "error";
            run.error = e?.body?.message ?? e?.message ?? String(e?.status ?? e);
        }
    } finally {
        run.endedAt = Date.now();
        state.current = null;
        saveHistory();
        emit();
    }
    return run;
}

export function enqueue(targets: Target[]) {
    for (const target of targets) {
        if (!state.queue.some(t => t.kind === target.kind && t.id === target.id)) state.queue.push(target);
    }
    emit();
    void processQueue();
}

async function processQueue() {
    if (state.running) return;
    state.running = true;
    stopRequested = false;
    emit();
    try {
        while (state.queue.length && !stopRequested) {
            const target = state.queue.shift()!;
            emit();
            await runTarget(target);
        }
    } finally {
        state.running = false;
        state.penalty = 1;
        stopRequested = false;
        emit();
        // Ajouté pendant l'arrêt du précédent : on repart au lieu de rester bloqué.
        if (state.queue.length) void processQueue();
    }
}

export function exportHistory() {
    const lines = ["low-cord — Message Cleaner", "=".repeat(40), ""];
    for (const r of state.history) {
        lines.push(`[${new Date(r.startedAt).toLocaleString()}] ${r.target.name} (${r.target.kind} ${r.target.id}) — ${r.status}`);
        lines.push(`supprimés ${r.deleted} · déjà partis ${r.gone} · ignorés ${r.skipped} · échecs ${r.failed}`);
        const contents = state.contents.get(r.key);
        if (contents?.length) lines.push("", ...contents);
        lines.push("", "-".repeat(40), "");
    }
    return lines.join("\n");
}
