/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// MessageLogger — stockage sur disque (processus principal).
//
// Le dossier de données low-cord est COMMUN à Discord, Canary et PTB : chaque
// compte Discord a donc son propre espace, sinon les logs de tous les comptes
// se mélangent.
//
// <données low-cord>\messagelogger\comptes\<id du compte>\
//   journal\AAAA-MM.jsonl   un événement par ligne, uniquement AJOUTÉ (jamais
//                           réécrit, sauf effacement demandé) : un plantage ne
//                           peut abîmer au pire que la dernière ligne, ignorée
//                           à la lecture.
//   dm-snapshots.jsonl      copie des messages privés reçus, pour retrouver le
//                           contenu d'un message supprimé même s'il n'était pas
//                           affiché. Expire après N jours (réglage).
//   media\<salon>\<id>-<nom> médias archivés dès réception.
//
// Les données d'avant la séparation (directement dans messagelogger\) sont
// réparties automatiquement : chaque conversation va au compte qui y a accès
// (voir legacyChannels / claimLegacy).

import { DATA_DIR } from "@main/utils/constants";
import { IpcMainInvokeEvent, shell } from "electron";
import { appendFileSync, cpSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join, resolve, sep } from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";

import type { ConversationSummary, LogEvent, LogQuery, LogQueryResult, LogStats, MediaJob, MessageSnapshot } from "./types";

const BASE = join(DATA_DIR, "messagelogger");

const ID = /^\d{1,25}$/;
const TYPES = new Set(["delete", "edit", "attachments"]);
const MEDIA_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const MAX_SNAPSHOTS = 100_000;
const MAX_READ_BYTES = 40 * 1024 * 1024;

let snapshotDays = 30;
let maxMediaBytes = 500 * 1024 * 1024;

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

// ── Un espace de stockage (un compte, ou les anciennes données) ─────────────
interface Store {
    root: string;
    journalDir: string;
    mediaDir: string;
    snapFile: string;
    journal: LogEvent[] | null;
    keys: Set<string>;
    snapshots: Map<string, MessageSnapshot> | null;
    snapLines: number;
    index: Map<string, { rel: string; size: number; }> | null;
}

function makeStore(root: string): Store {
    return {
        root,
        journalDir: join(root, "journal"),
        mediaDir: join(root, "media"),
        snapFile: join(root, "dm-snapshots.jsonl"),
        journal: null,
        keys: new Set(),
        snapshots: null,
        snapLines: 0,
        index: null,
    };
}

const stores = new Map<string, Store>();
const legacy = makeStore(BASE);

/** Espace du compte ; refuse tout identifiant qui n'en est pas un (chemin). */
function storeOf(account: unknown): Store {
    if (typeof account !== "string" || !ID.test(account)) throw new Error("bad-account");
    let st = stores.get(account);
    if (!st) {
        st = makeStore(join(BASE, "comptes", account));
        stores.set(account, st);
    }
    return st;
}

// ── Journal ──────────────────────────────────────────────────────────────────
function monthFile(st: Store, at: number) {
    const d = new Date(at);
    return join(st.journalDir, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}.jsonl`);
}

function loadJournal(st: Store): LogEvent[] {
    if (st.journal) return st.journal;
    const list: LogEvent[] = [];
    st.keys.clear();
    if (existsSync(st.journalDir)) {
        for (const f of readdirSync(st.journalDir).filter(f => f.endsWith(".jsonl")).sort()) {
            for (const ev of readJsonl<LogEvent>(join(st.journalDir, f))) {
                if (!ev?.key || st.keys.has(ev.key)) continue;
                st.keys.add(ev.key);
                list.push(ev);
            }
        }
    }
    list.sort((a, b) => a.at - b.at);
    st.journal = list;
    return list;
}

/** Réécrit tout le journal d'un espace (effacement / répartition), fichier par fichier. */
function rewriteJournal(st: Store, kept: LogEvent[]) {
    st.journal = kept;
    st.keys.clear();
    kept.forEach(ev => st.keys.add(ev.key));
    const byFile = new Map<string, string[]>();
    for (const ev of kept) {
        const f = monthFile(st, ev.at);
        if (!byFile.has(f)) byFile.set(f, []);
        byFile.get(f)!.push(JSON.stringify(ev));
    }
    if (!existsSync(st.journalDir)) return;
    for (const f of readdirSync(st.journalDir).filter(f => f.endsWith(".jsonl"))) {
        const path = join(st.journalDir, f);
        const lines = byFile.get(path);
        if (lines?.length) writeAtomic(path, lines.join("\n") + "\n");
        else unlinkSync(path);
    }
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

function addEvents(st: Store, events: unknown[]) {
    const list = loadJournal(st);
    const byFile = new Map<string, string[]>();
    let added = 0;
    for (const ev of events) {
        if (!isValidEvent(ev) || st.keys.has(ev.key)) continue;
        st.keys.add(ev.key);
        list.push(ev);
        const file = monthFile(st, ev.at);
        if (!byFile.has(file)) byFile.set(file, []);
        byFile.get(file)!.push(JSON.stringify(ev));
        added++;
    }
    if (added) {
        ensure(st.journalDir);
        for (const [file, lines] of byFile) appendFileSync(file, lines.join("\n") + "\n", "utf-8");
        list.sort((a, b) => a.at - b.at);
    }
    return added;
}

export function appendEvents(_: IpcMainInvokeEvent, account: unknown, events: unknown) {
    if (!Array.isArray(events)) return 0;
    return addEvents(storeOf(account), events);
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

export function query(_: IpcMainInvokeEvent, account: unknown, q: LogQuery = {}): LogQueryResult {
    const st = storeOf(account);
    const list = loadJournal(st);
    const search = (q.search ?? "").trim().toLowerCase();
    const offset = Math.max(0, q.offset ?? 0);
    const limit = Math.min(200, Math.max(1, q.limit ?? 60));

    const found: LogEvent[] = [];
    for (let i = list.length - 1; i >= 0; i--) {
        if (matches(list[i], q, search)) found.push(list[i]);
    }
    const items = found.slice(offset, offset + limit);

    const index = mediaIndex(st);
    const media: Record<string, string> = {};
    for (const ev of items) {
        for (const a of ev.attachments) {
            const m = index.get(a.id);
            if (m) media[a.id] = m.rel;
        }
    }
    return { items, total: found.length, media };
}

export function conversations(_: IpcMainInvokeEvent, account: unknown): ConversationSummary[] {
    const map = new Map<string, ConversationSummary>();
    for (const ev of loadJournal(storeOf(account))) {
        let c = map.get(ev.channelId);
        if (!c) {
            c = { channelId: ev.channelId, channelKind: ev.channelKind, channelName: ev.channelName, guildId: ev.guildId, guildName: ev.guildName, deletes: 0, edits: 0, last: 0 };
            map.set(ev.channelId, c);
        }
        // Les noms les plus récents l'emportent (renommages).
        if (ev.channelName) c.channelName = ev.channelName;
        if (ev.guildName) c.guildName = ev.guildName;
        if (ev.channelKind === "dm" && ev.author && ev.author.id !== account) c.peer = ev.author;
        if (ev.type === "edit") c.edits++;
        else c.deletes++;
        c.last = Math.max(c.last, ev.at);
    }
    return [...map.values()].sort((a, b) => b.last - a.last);
}

// ── Copies des messages privés ───────────────────────────────────────────────
function loadSnapshots(st: Store) {
    if (st.snapshots) return st.snapshots;
    const map = new Map<string, MessageSnapshot>();
    const limit = Date.now() - snapshotDays * 86_400_000;
    const all = readJsonl<MessageSnapshot>(st.snapFile);
    st.snapLines = all.length;
    for (const s of all) {
        if (!s?.messageId || s.seen < limit) continue;
        map.set(s.messageId, s);
    }
    st.snapshots = map;
    trimSnapshots(st);
    // Fichier bien plus long que ce qu'on garde : on le réécrit (expirés retirés).
    if (st.snapLines > map.size * 1.5 + 500) compactSnapshots(st);
    return map;
}

function trimSnapshots(st: Store) {
    // Marge de 1000 : on ne trie pas tout à chaque nouveau message une fois la limite atteinte.
    const map = st.snapshots;
    if (!map || map.size <= MAX_SNAPSHOTS + 1000) return;
    const sorted = [...map.values()].sort((a, b) => a.seen - b.seen);
    for (const s of sorted.slice(0, map.size - MAX_SNAPSHOTS)) map.delete(s.messageId);
}

function compactSnapshots(st: Store) {
    if (!st.snapshots) return;
    const lines = [...st.snapshots.values()].map(s => JSON.stringify(s));
    if (!lines.length) {
        if (existsSync(st.snapFile)) unlinkSync(st.snapFile);
    } else {
        ensure(st.root);
        writeAtomic(st.snapFile, lines.join("\n") + "\n");
    }
    st.snapLines = lines.length;
}

function addSnapshots(st: Store, list: MessageSnapshot[]) {
    const map = loadSnapshots(st);
    const lines: string[] = [];
    for (const s of list) {
        if (!s || !ID.test(s.messageId) || !ID.test(s.channelId) || typeof s.content !== "string") continue;
        const prev = map.get(s.messageId);
        // Rien de neuf : pas d'écriture inutile.
        if (prev && prev.content === s.content && prev.attachments.length === s.attachments.length && prev.editedAt === s.editedAt) continue;
        map.set(s.messageId, s);
        lines.push(JSON.stringify(s));
    }
    if (!lines.length) return;
    ensure(st.root);
    appendFileSync(st.snapFile, lines.join("\n") + "\n", "utf-8");
    st.snapLines += lines.length;
    trimSnapshots(st);
}

export function saveSnapshots(_: IpcMainInvokeEvent, account: unknown, list: unknown) {
    if (Array.isArray(list)) addSnapshots(storeOf(account), list as MessageSnapshot[]);
}

export function getSnapshots(_: IpcMainInvokeEvent, account: unknown, ids: unknown): MessageSnapshot[] {
    if (!Array.isArray(ids)) return [];
    const map = loadSnapshots(storeOf(account));
    return ids.map(id => map.get(String(id))).filter(Boolean) as MessageSnapshot[];
}

// ── Médias ───────────────────────────────────────────────────────────────────
function mediaIndex(st: Store) {
    if (st.index) return st.index;
    const index = new Map<string, { rel: string; size: number; }>();
    st.index = index;
    if (!existsSync(st.mediaDir)) return index;
    for (const channel of readdirSync(st.mediaDir)) {
        if (!ID.test(channel)) continue;
        for (const file of readdirSync(join(st.mediaDir, channel))) {
            if (file.endsWith(".part")) continue;
            const id = file.split("-")[0];
            if (!ID.test(id)) continue;
            try {
                index.set(id, { rel: `${channel}/${file}`, size: statSync(join(st.mediaDir, channel, file)).size });
            } catch { /* fichier supprimé entre-temps */ }
        }
    }
    return index;
}

function safeName(name: string) {
    const clean = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120);
    return clean || "fichier";
}

interface QueuedJob extends MediaJob {
    /** espace du compte qui a demandé le téléchargement */
    store: Store;
}

const queue: QueuedJob[] = [];
const queued = new Set<string>();
let active = 0;
const MAX_ACTIVE = 2;

async function download(job: QueuedJob, attempt = 0): Promise<void> {
    const { attachment: a, channelId, store: st } = job;
    const url = new URL(a.url);
    if (url.protocol !== "https:" || !MEDIA_HOSTS.has(url.hostname)) return;

    const dir = join(st.mediaDir, channelId);
    const final = join(dir, `${a.id}-${safeName(a.filename)}`);
    const part = `${final}.part`;

    try {
        // Gros fichiers (vidéos jusqu'à 500 Mo) : écrits sur le disque au fil
        // du téléchargement, jamais gardés en entier en mémoire.
        const res = await fetch(url, { signal: AbortSignal.timeout(30 * 60_000) });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const length = Number(res.headers.get("content-length") ?? 0);
        if (length > maxMediaBytes) return;

        let bytes = 0;
        const limit = new Transform({
            transform(chunk, _enc, done) {
                bytes += chunk.length;
                done(bytes > maxMediaBytes ? new Error("too-big") : null, chunk);
            }
        });
        ensure(dir);
        await pipeline(Readable.fromWeb(res.body as any), limit, createWriteStream(part));
        renameSync(part, final);
        mediaIndex(st).set(a.id, { rel: `${channelId}/${a.id}-${safeName(a.filename)}`, size: bytes });
    } catch (e) {
        try { if (existsSync(part)) unlinkSync(part); } catch { /* rien */ }
        // 404 / 403 : le fichier n'existe plus ; trop gros : inutile d'insister.
        const status = /HTTP (\d+)/.exec(String(e))?.[1];
        const tooBig = String(e).includes("too-big");
        if (attempt < 2 && !tooBig && status !== "404" && status !== "403") {
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
            queued.delete(`${job.store.root}|${job.attachment.id}`);
            pump();
        });
    }
}

export function archiveMedia(_: IpcMainInvokeEvent, account: unknown, jobs: unknown) {
    if (!Array.isArray(jobs)) return;
    const st = storeOf(account);
    const idx = mediaIndex(st);
    for (const job of jobs as MediaJob[]) {
        const a = job?.attachment;
        if (!a || !ID.test(a.id) || !ID.test(job.channelId) || typeof a.url !== "string") continue;
        const key = `${st.root}|${a.id}`;
        if (idx.has(a.id) || queued.has(key)) continue;
        if (typeof a.size === "number" && a.size > maxMediaBytes) continue;
        queued.add(key);
        queue.push({ ...job, store: st });
    }
    pump();
}

/** Chemin absolu d'un média, seulement s'il est bien dans le dossier des médias du compte. */
function mediaPath(account: unknown, rel: unknown) {
    if (typeof rel !== "string") return null;
    const dir = storeOf(account).mediaDir;
    const full = resolve(dir, rel);
    return full.startsWith(resolve(dir) + sep) && existsSync(full) ? full : null;
}

export function readMedia(_: IpcMainInvokeEvent, account: unknown, rel: unknown) {
    const path = mediaPath(account, rel);
    if (!path || statSync(path).size > MAX_READ_BYTES) return null;
    return readFileSync(path);
}

export function openMedia(_: IpcMainInvokeEvent, account: unknown, rel: unknown) {
    const path = mediaPath(account, rel);
    if (path) shell.openPath(path);
}

export function showMedia(_: IpcMainInvokeEvent, account: unknown, rel: unknown) {
    const path = mediaPath(account, rel);
    if (path) shell.showItemInFolder(path);
}

export function openFolder(_: IpcMainInvokeEvent, account: unknown) {
    const { root } = storeOf(account);
    ensure(root);
    shell.openPath(root);
}

// ── Anciennes données (avant la séparation par compte) ──────────────────────
/** Salons présents dans les anciennes données, pour que chaque compte reprenne les siens. */
export function legacyChannels(): string[] {
    const ids = new Set<string>();
    for (const ev of loadJournal(legacy)) ids.add(ev.channelId);
    for (const s of loadSnapshots(legacy).values()) ids.add(s.channelId);
    if (existsSync(legacy.mediaDir)) for (const d of readdirSync(legacy.mediaDir)) if (ID.test(d)) ids.add(d);
    return [...ids];
}

/** Déplace vers le compte tout ce qui concerne les salons auxquels il a accès. */
export function claimLegacy(_: IpcMainInvokeEvent, account: unknown, channelIds: unknown) {
    if (!Array.isArray(channelIds)) return 0;
    const st = storeOf(account);
    const wanted = new Set(channelIds.filter(id => typeof id === "string" && ID.test(id)));
    if (!wanted.size) return 0;

    // Journal
    const all = loadJournal(legacy);
    const mine = all.filter(ev => wanted.has(ev.channelId));
    if (mine.length) {
        addEvents(st, mine);
        rewriteJournal(legacy, all.filter(ev => !wanted.has(ev.channelId)));
    }

    // Copies des MP
    const snaps = loadSnapshots(legacy);
    const mySnaps = [...snaps.values()].filter(s => wanted.has(s.channelId));
    if (mySnaps.length) {
        addSnapshots(st, mySnaps);
        mySnaps.forEach(s => snaps.delete(s.messageId));
        compactSnapshots(legacy);
    }

    // Médias : un dossier par salon
    let movedMedia = 0;
    if (existsSync(legacy.mediaDir)) {
        for (const channel of readdirSync(legacy.mediaDir)) {
            if (!wanted.has(channel)) continue;
            const from = join(legacy.mediaDir, channel);
            const to = join(st.mediaDir, channel);
            ensure(st.mediaDir);
            if (existsSync(to)) {
                cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
                rmSync(from, { recursive: true, force: true });
            } else {
                renameSync(from, to);
            }
            movedMedia++;
        }
        st.index = null;
        legacy.index = null;
    }

    // Plus rien d'ancien : on fait le ménage.
    if (!loadJournal(legacy).length && !loadSnapshots(legacy).size) {
        if (existsSync(legacy.journalDir)) rmSync(legacy.journalDir, { recursive: true, force: true });
        if (existsSync(legacy.snapFile)) unlinkSync(legacy.snapFile);
        if (existsSync(legacy.mediaDir) && !readdirSync(legacy.mediaDir).length) rmSync(legacy.mediaDir, { recursive: true, force: true });
    }

    const moved = mine.length + mySnaps.length + movedMedia;
    if (moved) log(`anciens logs répartis vers le compte ${account} : ${mine.length} entrée(s), ${mySnaps.length} copie(s), ${movedMedia} dossier(s) de médias`);
    return moved;
}

// ── Réglages, stats, effacement ──────────────────────────────────────────────
export function configure(_: IpcMainInvokeEvent, opts: { snapshotDays?: number; maxMediaMB?: number; }) {
    if (typeof opts?.snapshotDays === "number" && opts.snapshotDays >= 1) snapshotDays = Math.min(365, opts.snapshotDays);
    if (typeof opts?.maxMediaMB === "number" && opts.maxMediaMB >= 1) maxMediaBytes = Math.min(2048, opts.maxMediaMB) * 1024 * 1024;
}

export function stats(_: IpcMainInvokeEvent, account: unknown): LogStats {
    const st = storeOf(account);
    let mediaBytes = 0;
    const idx = mediaIndex(st);
    for (const m of idx.values()) mediaBytes += m.size;
    return {
        events: loadJournal(st).length,
        snapshots: loadSnapshots(st).size,
        mediaFiles: idx.size,
        mediaBytes,
        queue: queue.filter(j => j.store === st).length + active,
        dir: st.root,
    };
}

export function clearConversation(_: IpcMainInvokeEvent, account: unknown, channelId: unknown) {
    if (typeof channelId !== "string" || !ID.test(channelId)) return;
    const st = storeOf(account);
    const list = loadJournal(st);
    const kept = list.filter(ev => ev.channelId !== channelId);
    if (kept.length !== list.length) rewriteJournal(st, kept);

    const map = loadSnapshots(st);
    let removed = false;
    for (const [id, s] of map) if (s.channelId === channelId) { map.delete(id); removed = true; }
    if (removed) compactSnapshots(st);

    const dir = join(st.mediaDir, channelId);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    st.index = null;
}

/** Efface tout ce qui appartient au compte (pas les autres comptes). */
export function clearAll(_: IpcMainInvokeEvent, account: unknown) {
    const st = storeOf(account);
    if (existsSync(st.root)) rmSync(st.root, { recursive: true, force: true });
    stores.delete(account as string);
}
