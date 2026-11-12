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
//   conversations\<pseudo> [<id du salon>]\
//     medias\<auteur> - <id> - <nom>   médias archivés dès réception
//     sauvegardes\<date> <nom>.html    sauvegardes complètes (Message Cleaner)
//                           Un dossier par conversation, nommé d'après la
//                           personne (ou le groupe / salon) pour s'y retrouver
//                           dans l'explorateur ; l'id entre crochets le rend
//                           retrouvable même si le pseudo change.
//
// L'ancien rangement (media\<id du salon>\<id>-<nom>) est converti tout seul.
//
// Les données d'avant la séparation (directement dans messagelogger\) sont
// réparties automatiquement : chaque conversation va au compte qui y a accès
// (voir legacyChannels / claimLegacy).

import { DATA_DIR } from "@main/utils/constants";
import { randomUUID } from "crypto";
import { IpcMainInvokeEvent, shell } from "electron";
import { appendFileSync, closeSync, cpSync, createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "fs";
import { basename, join, resolve, sep } from "path";
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
    /** id du compte (absent pour les anciennes données communes) */
    account?: string;
    root: string;
    journalDir: string;
    /** ancien rangement des médias (media\<salon>\…), converti à la première lecture */
    mediaDir: string;
    /** un dossier par conversation */
    convRoot: string;
    /** id du salon -> nom de son dossier dans convRoot */
    dirs: Map<string, string> | null;
    snapFile: string;
    journal: LogEvent[] | null;
    keys: Set<string>;
    snapshots: Map<string, MessageSnapshot> | null;
    snapLines: number;
    index: Map<string, { rel: string; size: number; }> | null;
}

function makeStore(root: string, account?: string): Store {
    return {
        account,
        root,
        journalDir: join(root, "journal"),
        mediaDir: join(root, "media"),
        convRoot: join(root, "conversations"),
        dirs: null,
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
        st = makeStore(join(BASE, "comptes", account), account);
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
        && typeof ev.key === "string" && ev.key.length < 600
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

// ── Dossiers des conversations ───────────────────────────────────────────────
const CONV_DIR = /^(?:(.*) )?\[(\d{1,25})\]$/;
const MEDIA_SUB = "medias";
const BACKUP_SUB = "sauvegardes";

function safeName(name: string, max = 120) {
    // Pas de point ni d'espace en fin de nom : Windows les refuse.
    const clean = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim().slice(0, max).replace(/[. ]+$/, "");
    return clean || "fichier";
}

const dirNameFor = (channelId: string, label?: string) => {
    const clean = typeof label === "string" ? safeName(label, 60) : "";
    return clean && clean !== "fichier" && clean !== channelId ? `${clean} [${channelId}]` : `[${channelId}]`;
};

/** Id d'une pièce jointe d'après son nom de fichier (nouveau format « auteur - id - nom », ancien « id-nom »). */
const attachmentIdOf = (file: string) => /^(?:.*? - )?(\d{10,25}) - /.exec(file)?.[1] ?? /^(\d{10,25})-/.exec(file)?.[1];

const mediaFileName = (id: string, filename: string, author?: string) => {
    const who = typeof author === "string" && author.trim() ? `${safeName(author, 40)} - ` : "";
    return `${who}${id} - ${safeName(filename)}`;
};

/** Ce que le journal et les copies savent déjà : nom des conversations, auteur de chaque pièce jointe. */
function knownNames(st: Store) {
    const labels = new Map<string, string>();
    const authors = new Map<string, string>();
    const note = (list: { id: string; }[] | undefined, author?: { username?: string; name?: string; }) => {
        const who = author?.username || author?.name;
        if (who) for (const a of list ?? []) authors.set(a.id, who);
    };
    for (const s of loadSnapshots(st).values()) note(s.attachments, s.author);
    for (const ev of loadJournal(st)) {
        note(ev.attachments, ev.author);
        if (ev.channelKind === "guild") labels.set(ev.channelId, `${ev.guildName ?? ""} ${ev.channelName}`.trim());
        else if (ev.channelKind === "group") labels.set(ev.channelId, ev.channelName);
        // MP : le pseudo de l'autre personne.
        else if (ev.author && ev.author.id !== st.account) labels.set(ev.channelId, ev.author.username || ev.author.name);
        else if (!labels.has(ev.channelId) && ev.channelName && ev.channelName !== ev.channelId) labels.set(ev.channelId, ev.channelName);
    }
    return { labels, authors };
}

/** Ancien rangement media\<salon>\<id>-<nom> → conversations\<pseudo> [<salon>]\medias\<auteur> - <id> - <nom>. */
function migrateMedia(st: Store) {
    if (!existsSync(st.mediaDir)) return;
    try {
        const { labels, authors } = knownNames(st);
        ensure(st.convRoot);
        const existing = new Map<string, string>();
        for (const d of readdirSync(st.convRoot)) {
            const m = CONV_DIR.exec(d);
            if (m) existing.set(m[2], d);
        }
        for (const channel of readdirSync(st.mediaDir)) {
            const from = join(st.mediaDir, channel);
            if (!ID.test(channel) || !statSync(from).isDirectory()) continue;
            const to = join(st.convRoot, existing.get(channel) ?? dirNameFor(channel, labels.get(channel)), MEDIA_SUB);
            ensure(to);
            for (const file of readdirSync(from)) {
                if (file.endsWith(".part")) { unlinkSync(join(from, file)); continue; }
                const id = attachmentIdOf(file);
                const name = id && file.startsWith(`${id}-`) ? mediaFileName(id, file.slice(id.length + 1), authors.get(id)) : file;
                const dest = join(to, name);
                if (existsSync(dest)) unlinkSync(join(from, file));
                else renameSync(join(from, file), dest);
            }
            rmSync(from, { recursive: true, force: true });
        }
        if (!readdirSync(st.mediaDir).length) rmSync(st.mediaDir, { recursive: true, force: true });
        log("médias rangés par conversation :", st.convRoot);
    } catch (e) {
        log("rangement des anciens médias impossible :", String(e));
    }
}

function convDirs(st: Store) {
    if (st.dirs) return st.dirs;
    const dirs = st.dirs = new Map<string, string>();
    migrateMedia(st);
    if (existsSync(st.convRoot)) {
        for (const d of readdirSync(st.convRoot)) {
            const m = CONV_DIR.exec(d);
            if (m) dirs.set(m[2], d);
        }
    }
    return dirs;
}

/** Dossier d'une conversation ; renommé si le nom affiché a changé. */
function convDir(st: Store, channelId: string, label?: string) {
    const dirs = convDirs(st);
    let name = dirs.get(channelId);
    const wanted = dirNameFor(channelId, label);
    if (name && label && wanted !== name && wanted !== `[${channelId}]`) {
        try {
            if (existsSync(join(st.convRoot, name))) renameSync(join(st.convRoot, name), join(st.convRoot, wanted));
            name = wanted;
            st.index = null;
        } catch {
            // Fichier en cours d'écriture dans le dossier : on renommera plus tard.
        }
    }
    name ??= wanted;
    dirs.set(channelId, name);
    return join(st.convRoot, name);
}

/** Noms à jour des conversations (pseudo changé, groupe renommé) : seuls les dossiers existants sont renommés. */
export function setLabels(_: IpcMainInvokeEvent, account: unknown, labels: unknown) {
    if (!labels || typeof labels !== "object") return;
    const st = storeOf(account);
    const dirs = convDirs(st);
    for (const [channelId, label] of Object.entries(labels as Record<string, unknown>)) {
        if (ID.test(channelId) && typeof label === "string" && dirs.has(channelId)) convDir(st, channelId, label);
    }
}

// ── Médias ───────────────────────────────────────────────────────────────────
function mediaIndex(st: Store) {
    if (st.index) return st.index;
    const index = new Map<string, { rel: string; size: number; }>();
    for (const dir of convDirs(st).values()) {
        const folder = join(st.convRoot, dir, MEDIA_SUB);
        if (!existsSync(folder)) continue;
        for (const file of readdirSync(folder)) {
            if (file.endsWith(".part")) continue;
            const id = attachmentIdOf(file);
            if (!id) continue;
            try {
                index.set(id, { rel: `${dir}/${MEDIA_SUB}/${file}`, size: statSync(join(folder, file)).size });
            } catch { /* fichier supprimé entre-temps */ }
        }
    }
    st.index = index;
    return index;
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

    const dir = join(convDir(st, channelId, job.channelName), MEDIA_SUB);
    const fileName = mediaFileName(a.id, a.filename, job.authorName);
    const final = join(dir, fileName);
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
        mediaIndex(st).set(a.id, { rel: `${basename(resolve(dir, ".."))}/${MEDIA_SUB}/${fileName}`, size: bytes });
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

/** Chemin absolu d'un média, seulement s'il est bien dans le dossier des conversations du compte. */
function mediaPath(account: unknown, rel: unknown) {
    if (typeof rel !== "string") return null;
    const dir = storeOf(account).convRoot;
    const full = resolve(dir, rel);
    return full.startsWith(resolve(dir) + sep) && existsSync(full) ? full : null;
}

export function readMedia(_: IpcMainInvokeEvent, account: unknown, rel: unknown) {
    const path = mediaPath(account, rel);
    if (!path || statSync(path).size > MAX_READ_BYTES) return null;
    return readFileSync(path);
}

// « Ouvrir » lance le fichier avec le programme par défaut de Windows : pour
// un .exe, .bat, .lnk… reçu en pièce jointe, ce serait l'exécuter. Seuls les
// vrais médias et documents s'ouvrent ; le reste est montré dans son dossier.
const OPENABLE = /\.(png|jpe?g|gif|webp|avif|bmp|tiff?|heic|mp4|webm|mov|mkv|avi|m4v|mp3|ogg|oga|opus|wav|flac|m4a|aac|pdf|txt|log|md|json|csv)$/i;

export function openMedia(_: IpcMainInvokeEvent, account: unknown, rel: unknown) {
    const path = mediaPath(account, rel);
    if (!path) return;
    if (OPENABLE.test(path)) shell.openPath(path);
    else shell.showItemInFolder(path);
}

export function showMedia(_: IpcMainInvokeEvent, account: unknown, rel: unknown) {
    const path = mediaPath(account, rel);
    if (path) shell.showItemInFolder(path);
}

// ── Sauvegardes de conversation (.html) ──────────────────────────────────────
// Écrites par morceaux : un export avec ses médias peut peser des centaines de Mo.
const MAX_BACKUP_BYTES = 2 * 1024 ** 3;
const backupsOpen = new Map<string, { fd: number; part: string; final: string; bytes: number; }>();

const backupDir = (st: Store, channelId: string, label?: string) => join(convDir(st, channelId, label), BACKUP_SUB);

export function backupBegin(_: IpcMainInvokeEvent, account: unknown, channelId: unknown, label: unknown, fileName: unknown) {
    if (typeof channelId !== "string" || !ID.test(channelId) || typeof fileName !== "string") throw new Error("bad-backup");
    const st = storeOf(account);
    const dir = backupDir(st, channelId, typeof label === "string" ? label : undefined);
    ensure(dir);
    const base = safeName(fileName.replace(/\.html?$/i, ""), 100);
    let final = join(dir, `${base}.html`);
    for (let n = 2; existsSync(final); n++) final = join(dir, `${base} (${n}).html`);
    const part = `${final}.part`;
    const token = randomUUID();
    backupsOpen.set(token, { fd: openSync(part, "w"), part, final, bytes: 0 });
    return token;
}

export function backupChunk(_: IpcMainInvokeEvent, token: unknown, data: unknown) {
    const b = backupsOpen.get(String(token));
    if (!b || !(data instanceof Uint8Array)) throw new Error("bad-backup");
    b.bytes += data.length;
    if (b.bytes > MAX_BACKUP_BYTES) throw new Error("too-big");
    writeSync(b.fd, data);
}

/** Termine (ou abandonne) une sauvegarde ; renvoie le nom du fichier. */
export function backupEnd(_: IpcMainInvokeEvent, token: unknown, keep: unknown) {
    const b = backupsOpen.get(String(token));
    if (!b) return null;
    backupsOpen.delete(String(token));
    closeSync(b.fd);
    if (keep !== true) {
        try { unlinkSync(b.part); } catch { /* rien */ }
        return null;
    }
    renameSync(b.part, b.final);
    return basename(b.final);
}

export function listBackups(_: IpcMainInvokeEvent, account: unknown, channelId: unknown) {
    if (typeof channelId !== "string" || !ID.test(channelId)) return [];
    const st = storeOf(account);
    if (!convDirs(st).has(channelId)) return [];
    const dir = backupDir(st, channelId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
        .filter(f => f.endsWith(".html"))
        .map(name => {
            const s = statSync(join(dir, name));
            return { name, size: s.size, at: s.mtimeMs };
        })
        .sort((a, b) => b.at - a.at);
}

function backupPath(account: unknown, channelId: unknown, name: unknown) {
    if (typeof channelId !== "string" || !ID.test(channelId) || typeof name !== "string" || name !== basename(name) || !name.endsWith(".html")) return null;
    const st = storeOf(account);
    if (!convDirs(st).has(channelId)) return null;
    const full = join(backupDir(st, channelId), name);
    return existsSync(full) ? full : null;
}

export function openBackup(_: IpcMainInvokeEvent, account: unknown, channelId: unknown, name: unknown) {
    const path = backupPath(account, channelId, name);
    if (path) shell.openPath(path);
}

export function showBackup(_: IpcMainInvokeEvent, account: unknown, channelId: unknown, name: unknown) {
    const path = backupPath(account, channelId, name);
    if (path) shell.showItemInFolder(path);
}

/** Dossier du compte, ou celui d'une conversation s'il existe. */
export function openFolder(_: IpcMainInvokeEvent, account: unknown, channelId?: unknown) {
    const st = storeOf(account);
    const { root } = st;
    if (typeof channelId === "string" && ID.test(channelId) && convDirs(st).has(channelId)) {
        const dir = convDir(st, channelId);
        if (existsSync(dir)) return void shell.openPath(dir);
    }
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
        // Repris à l'ancien format : rangés par conversation à la prochaine lecture.
        st.index = null;
        st.dirs = null;
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

    // Médias effacés ; les sauvegardes .html de la conversation sont gardées.
    if (convDirs(st).has(channelId)) {
        const dir = convDir(st, channelId);
        rmSync(join(dir, MEDIA_SUB), { recursive: true, force: true });
        if (existsSync(dir) && !readdirSync(dir).length) {
            rmSync(dir, { recursive: true, force: true });
            st.dirs?.delete(channelId);
        }
    }
    st.index = null;
}

/** Efface tout ce qui appartient au compte (pas les autres comptes). */
export function clearAll(_: IpcMainInvokeEvent, account: unknown) {
    const st = storeOf(account);
    if (existsSync(st.root)) rmSync(st.root, { recursive: true, force: true });
    stores.delete(account as string);
}
