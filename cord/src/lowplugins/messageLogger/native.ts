/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// MessageLogger — stockage sur disque (processus principal).
//
// <données low-cord>\messagelogger\
//   journal\AAAA-MM.jsonl   un événement par ligne, uniquement AJOUTÉ (jamais
//                           réécrit, sauf effacement demandé) : un plantage ne
//                           peut abîmer au pire que la dernière ligne, ignorée
//                           à la lecture.
//   dm-snapshots.jsonl      copie des messages privés reçus, pour retrouver le
//                           contenu d'un message supprimé même s'il n'était pas
//                           affiché. Expire après N jours (réglage).
//   media\<salon>\<id>-<nom> médias archivés dès réception.

import { DATA_DIR } from "@main/utils/constants";
import { IpcMainInvokeEvent, shell } from "electron";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join, resolve, sep } from "path";

import type { ConversationSummary, LogEvent, LogQuery, LogQueryResult, LogStats, MediaJob, MessageSnapshot } from "./types";

const ROOT = join(DATA_DIR, "messagelogger");
const JOURNAL_DIR = join(ROOT, "journal");
const MEDIA_DIR = join(ROOT, "media");
const SNAP_FILE = join(ROOT, "dm-snapshots.jsonl");

const ID = /^\d{1,25}$/;
const TYPES = new Set(["delete", "edit", "attachments"]);
const MEDIA_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const MAX_SNAPSHOTS = 100_000;
const MAX_READ_BYTES = 40 * 1024 * 1024;

let snapshotDays = 30;
let maxMediaBytes = 100 * 1024 * 1024;

const log = (...a: any[]) => console.log("[low-cord MessageLogger]", ...a);
const ensure = (dir: string) => mkdirSync(dir, { recursive: true });

/** Écrit un fichier en entier sans jamais laisser une version à moitié écrite. */
function writeAtomic(path: string, data: string) {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, data, "utf-8");
    renameSync(tmp, path);
}

function readJsonl<T>(path: string): T[] {
    if (!existsSync(path)) return [];
    const out: T[] = [];
    for (const line of readFileSync(path, "utf-8").split("\n")) {
        if (!line.trim()) continue;
        try {
            out.push(JSON.parse(line));
        } catch {
            // ligne tronquée (Discord fermé pendant l'écriture) : ignorée
        }
    }
    return out;
}

// ── Journal ──────────────────────────────────────────────────────────────────
let journal: LogEvent[] | null = null;
const journalKeys = new Set<string>();

function monthFile(at: number) {
    const d = new Date(at);
    return join(JOURNAL_DIR, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}.jsonl`);
}

function loadJournal(): LogEvent[] {
    if (journal) return journal;
    journal = [];
    journalKeys.clear();
    if (existsSync(JOURNAL_DIR)) {
        for (const f of readdirSync(JOURNAL_DIR).filter(f => f.endsWith(".jsonl")).sort()) {
            for (const ev of readJsonl<LogEvent>(join(JOURNAL_DIR, f))) {
                if (!ev?.key || journalKeys.has(ev.key)) continue;
                journalKeys.add(ev.key);
                journal.push(ev);
            }
        }
    }
    journal.sort((a, b) => a.at - b.at);
    return journal;
}

function isValidEvent(ev: any): ev is LogEvent {
    return ev && typeof ev === "object"
        && typeof ev.key === "string" && ev.key.length < 200
        && TYPES.has(ev.type)
        && typeof ev.at === "number"
        && ID.test(ev.channelId) && ID.test(ev.messageId)
        && typeof ev.content === "string"
        && Array.isArray(ev.attachments);
}

export function appendEvents(_: IpcMainInvokeEvent, events: unknown) {
    if (!Array.isArray(events)) return 0;
    const list = loadJournal();
    const byFile = new Map<string, string[]>();
    let added = 0;

    for (const ev of events) {
        if (!isValidEvent(ev) || journalKeys.has(ev.key)) continue;
        journalKeys.add(ev.key);
        list.push(ev);
        const file = monthFile(ev.at);
        if (!byFile.has(file)) byFile.set(file, []);
        byFile.get(file)!.push(JSON.stringify(ev));
        added++;
    }

    if (added) {
        ensure(JOURNAL_DIR);
        for (const [file, lines] of byFile) appendFileSync(file, lines.join("\n") + "\n", "utf-8");
    }
    return added;
}

function matches(ev: LogEvent, q: LogQuery, search: string) {
    if (q.channelId && ev.channelId !== q.channelId) return false;
    if (q.authorId && ev.author?.id !== q.authorId) return false;
    if (q.type && ev.type !== q.type) return false;
    if (q.kind === "dm" && ev.channelKind === "guild") return false;
    if (q.kind === "guild" && ev.channelKind !== "guild") return false;
    if (!search) return true;
    return [ev.content, ev.newContent, ev.author?.name, ev.author?.username, ev.author?.id, ev.channelName, ev.guildName, ev.messageId,
        ...ev.attachments.map(a => a.filename)]
        .some(v => v?.toLowerCase().includes(search));
}

export function query(_: IpcMainInvokeEvent, q: LogQuery = {}): LogQueryResult {
    const list = loadJournal();
    const search = (q.search ?? "").trim().toLowerCase();
    const offset = Math.max(0, q.offset ?? 0);
    const limit = Math.min(200, Math.max(1, q.limit ?? 60));

    const found: LogEvent[] = [];
    for (let i = list.length - 1; i >= 0; i--) {
        if (matches(list[i], q, search)) found.push(list[i]);
    }
    const items = found.slice(offset, offset + limit);

    const index = mediaIndex();
    const media: Record<string, string> = {};
    for (const ev of items) {
        for (const a of ev.attachments) {
            const m = index.get(a.id);
            if (m) media[a.id] = m.rel;
        }
    }
    return { items, total: found.length, media };
}

export function conversations(_: IpcMainInvokeEvent, selfId?: string): ConversationSummary[] {
    const map = new Map<string, ConversationSummary>();
    for (const ev of loadJournal()) {
        let c = map.get(ev.channelId);
        if (!c) {
            c = { channelId: ev.channelId, channelKind: ev.channelKind, channelName: ev.channelName, guildId: ev.guildId, guildName: ev.guildName, deletes: 0, edits: 0, last: 0 };
            map.set(ev.channelId, c);
        }
        // Les noms les plus récents l'emportent (renommages).
        if (ev.channelName) c.channelName = ev.channelName;
        if (ev.guildName) c.guildName = ev.guildName;
        if (ev.channelKind === "dm" && ev.author && ev.author.id !== selfId) c.peer = ev.author;
        if (ev.type === "edit") c.edits++;
        else c.deletes++;
        c.last = Math.max(c.last, ev.at);
    }
    return [...map.values()].sort((a, b) => b.last - a.last);
}

// ── Copies des messages privés ───────────────────────────────────────────────
let snapshots: Map<string, MessageSnapshot> | null = null;
let snapshotLines = 0;

function loadSnapshots() {
    if (snapshots) return snapshots;
    snapshots = new Map();
    const limit = Date.now() - snapshotDays * 86_400_000;
    const all = readJsonl<MessageSnapshot>(SNAP_FILE);
    snapshotLines = all.length;
    for (const s of all) {
        if (!s?.messageId || s.seen < limit) continue;
        snapshots.set(s.messageId, s);
    }
    trimSnapshots();
    // Fichier bien plus long que ce qu'on garde : on le réécrit (expirés retirés).
    if (snapshotLines > snapshots.size * 1.5 + 500) compactSnapshots();
    return snapshots;
}

function trimSnapshots() {
    // Marge de 1000 : on ne trie pas tout à chaque nouveau message une fois la limite atteinte.
    if (!snapshots || snapshots.size <= MAX_SNAPSHOTS + 1000) return;
    const sorted = [...snapshots.values()].sort((a, b) => a.seen - b.seen);
    for (const s of sorted.slice(0, snapshots.size - MAX_SNAPSHOTS)) snapshots.delete(s.messageId);
}

function compactSnapshots() {
    if (!snapshots) return;
    ensure(ROOT);
    const lines = [...snapshots.values()].map(s => JSON.stringify(s));
    writeAtomic(SNAP_FILE, lines.length ? lines.join("\n") + "\n" : "");
    snapshotLines = lines.length;
    log(`copies des MP compactées : ${lines.length}`);
}

export function saveSnapshots(_: IpcMainInvokeEvent, list: unknown) {
    if (!Array.isArray(list)) return;
    const map = loadSnapshots();
    const lines: string[] = [];
    for (const s of list as MessageSnapshot[]) {
        if (!s || !ID.test(s.messageId) || !ID.test(s.channelId) || typeof s.content !== "string") continue;
        const prev = map.get(s.messageId);
        // Rien de neuf : pas d'écriture inutile.
        if (prev && prev.content === s.content && prev.attachments.length === s.attachments.length && prev.editedAt === s.editedAt) continue;
        map.set(s.messageId, s);
        lines.push(JSON.stringify(s));
    }
    if (!lines.length) return;
    ensure(ROOT);
    appendFileSync(SNAP_FILE, lines.join("\n") + "\n", "utf-8");
    snapshotLines += lines.length;
    trimSnapshots();
}

export function getSnapshots(_: IpcMainInvokeEvent, ids: unknown): MessageSnapshot[] {
    if (!Array.isArray(ids)) return [];
    const map = loadSnapshots();
    return ids.map(id => map.get(String(id))).filter(Boolean) as MessageSnapshot[];
}

// ── Médias ───────────────────────────────────────────────────────────────────
let index: Map<string, { rel: string; size: number; }> | null = null;

function mediaIndex() {
    if (index) return index;
    index = new Map();
    if (!existsSync(MEDIA_DIR)) return index;
    for (const channel of readdirSync(MEDIA_DIR)) {
        if (!ID.test(channel)) continue;
        for (const file of readdirSync(join(MEDIA_DIR, channel))) {
            if (file.endsWith(".part")) continue;
            const id = file.split("-")[0];
            if (!ID.test(id)) continue;
            try {
                index.set(id, { rel: `${channel}/${file}`, size: statSync(join(MEDIA_DIR, channel, file)).size });
            } catch { /* fichier supprimé entre-temps */ }
        }
    }
    return index;
}

function safeName(name: string) {
    const clean = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120);
    return clean || "fichier";
}

const queue: MediaJob[] = [];
const queued = new Set<string>();
let active = 0;
const MAX_ACTIVE = 2;

async function download(job: MediaJob, attempt = 0): Promise<void> {
    const { attachment: a, channelId } = job;
    const url = new URL(a.url);
    if (url.protocol !== "https:" || !MEDIA_HOSTS.has(url.hostname)) return;

    const dir = join(MEDIA_DIR, channelId);
    const final = join(dir, `${a.id}-${safeName(a.filename)}`);
    const part = `${final}.part`;

    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const length = Number(res.headers.get("content-length") ?? 0);
        if (length > maxMediaBytes) return;
        const data = Buffer.from(await res.arrayBuffer());
        if (data.length > maxMediaBytes) return;
        ensure(dir);
        writeFileSync(part, data);
        renameSync(part, final);
        mediaIndex().set(a.id, { rel: `${channelId}/${a.id}-${safeName(a.filename)}`, size: data.length });
    } catch (e) {
        try { if (existsSync(part)) unlinkSync(part); } catch { /* rien */ }
        // 404 / 403 : le fichier n'existe plus, inutile d'insister.
        const status = /HTTP (\d+)/.exec(String(e))?.[1];
        if (attempt < 2 && status !== "404" && status !== "403") {
            await new Promise(r => setTimeout(r, 4000 * (attempt + 1)));
            return download(job, attempt + 1);
        }
        log(`média non archivé (${a.filename}) :`, String(e));
    }
}

function pump() {
    while (active < MAX_ACTIVE && queue.length) {
        const job = queue.shift()!;
        active++;
        download(job).finally(() => {
            active--;
            queued.delete(job.attachment.id);
            pump();
        });
    }
}

export function archiveMedia(_: IpcMainInvokeEvent, jobs: unknown) {
    if (!Array.isArray(jobs)) return;
    const idx = mediaIndex();
    for (const job of jobs as MediaJob[]) {
        const a = job?.attachment;
        if (!a || !ID.test(a.id) || !ID.test(job.channelId) || typeof a.url !== "string") continue;
        if (idx.has(a.id) || queued.has(a.id)) continue;
        if (typeof a.size === "number" && a.size > maxMediaBytes) continue;
        queued.add(a.id);
        queue.push(job);
    }
    pump();
}

/** Chemin absolu d'un média, seulement s'il est bien dans le dossier des médias. */
function mediaPath(rel: unknown) {
    if (typeof rel !== "string") return null;
    const full = resolve(MEDIA_DIR, rel);
    return full.startsWith(resolve(MEDIA_DIR) + sep) && existsSync(full) ? full : null;
}

export function readMedia(_: IpcMainInvokeEvent, rel: unknown) {
    const path = mediaPath(rel);
    if (!path || statSync(path).size > MAX_READ_BYTES) return null;
    return readFileSync(path);
}

export function openMedia(_: IpcMainInvokeEvent, rel: unknown) {
    const path = mediaPath(rel);
    if (path) shell.openPath(path);
}

export function showMedia(_: IpcMainInvokeEvent, rel: unknown) {
    const path = mediaPath(rel);
    if (path) shell.showItemInFolder(path);
}

export function openFolder() {
    ensure(ROOT);
    shell.openPath(ROOT);
}

// ── Réglages, stats, effacement ──────────────────────────────────────────────
export function configure(_: IpcMainInvokeEvent, opts: { snapshotDays?: number; maxMediaMB?: number; }) {
    if (typeof opts?.snapshotDays === "number" && opts.snapshotDays >= 1) snapshotDays = Math.min(365, opts.snapshotDays);
    if (typeof opts?.maxMediaMB === "number" && opts.maxMediaMB >= 1) maxMediaBytes = Math.min(2048, opts.maxMediaMB) * 1024 * 1024;
}

export function stats(): LogStats {
    let mediaBytes = 0;
    const idx = mediaIndex();
    for (const m of idx.values()) mediaBytes += m.size;
    return {
        events: loadJournal().length,
        snapshots: loadSnapshots().size,
        mediaFiles: idx.size,
        mediaBytes,
        queue: queue.length + active,
        dir: ROOT,
    };
}

export function clearConversation(_: IpcMainInvokeEvent, channelId: unknown) {
    if (typeof channelId !== "string" || !ID.test(channelId)) return;
    const list = loadJournal();
    const kept = list.filter(ev => ev.channelId !== channelId);
    if (kept.length !== list.length) {
        journal = kept;
        journalKeys.clear();
        kept.forEach(ev => journalKeys.add(ev.key));
        // Réécrit chaque fichier de mois concerné, de façon atomique.
        const byFile = new Map<string, string[]>();
        for (const ev of kept) {
            const f = monthFile(ev.at);
            if (!byFile.has(f)) byFile.set(f, []);
            byFile.get(f)!.push(JSON.stringify(ev));
        }
        if (existsSync(JOURNAL_DIR)) {
            for (const f of readdirSync(JOURNAL_DIR).filter(f => f.endsWith(".jsonl"))) {
                const path = join(JOURNAL_DIR, f);
                const lines = byFile.get(path);
                if (lines?.length) writeAtomic(path, lines.join("\n") + "\n");
                else unlinkSync(path);
            }
        }
    }

    const map = loadSnapshots();
    let removed = false;
    for (const [id, s] of map) if (s.channelId === channelId) { map.delete(id); removed = true; }
    if (removed) compactSnapshots();

    const dir = join(MEDIA_DIR, channelId);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    index = null;
}

export function clearAll() {
    for (const dir of [JOURNAL_DIR, MEDIA_DIR]) if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    if (existsSync(SNAP_FILE)) unlinkSync(SNAP_FILE);
    journal = null;
    journalKeys.clear();
    snapshots = null;
    index = null;
}
