/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// AutoCorrect (processus principal) — moteur de correction Grammalecte.
//
// Grammalecte (correcteur français libre, GPL-3, grammalecte.net) n'est pas
// livré avec low-cord : environ 10 Mo de dictionnaires et de règles, utiles
// seulement à ceux qui activent le correcteur. Au premier usage, on
// télécharge son extension Firefox officielle (addons.mozilla.org), à une
// version précise, refusée si son empreinte sha256 diffère ; on n'en garde
// que le moteur, dans %APPDATA%\low-cord\autocorrect\.
//
// Le moteur tourne ici, dans un contexte isolé (module vm) : il ne voit ni
// Discord ni le reste de low-cord, n'a ni réseau ni accès disque (ses
// fichiers lui sont lus par nous), et chaque analyse est coupée au-delà de
// 2 s. Il est chargé au premier caractère tapé et libéré après 15 min sans
// servir.

import { DATA_DIR } from "@main/utils/constants";
import { createHash } from "crypto";
import { IpcMainInvokeEvent, net } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { Context, createContext, runInContext } from "vm";
import { inflateRawSync } from "zlib";

import { correct as runCorrect, CorrectOptions, Fix, GRAMMALECTE_OPTIONS, GrammarError } from "./corrector";

const VERSION = "2.3.0";
const XPI_URL = "https://addons.mozilla.org/firefox/downloads/file/4643560/grammalecte_fr-2.3.0.xpi";
const XPI_SHA256 = "443030004dbf62ecd5fc42f7b96872b96c9e3765f1cba4704a2a4170bb945256";
const XPI_SIZE = 7231947;

const ROOT = join(DATA_DIR, "autocorrect");
const DIR = join(ROOT, `grammalecte-${VERSION}`);
const READY = join(DIR, ".ready");

// Ordre de chargement de l'extension (gce_worker.js) : chaque fichier voit
// ce que les précédents ont déclaré.
const SCRIPTS = [
    "graphspell/helpers.js", "graphspell/str_transform.js", "graphspell/char_player.js", "graphspell/lexgraph_fr.js",
    "graphspell/ibdawg.js", "graphspell/spellchecker.js", "text.js", "graphspell/tokenizer.js", "fr/conj.js",
    "fr/mfsp.js", "fr/phonet.js", "fr/cregex.js", "fr/gc_options.js", "fr/gc_functions.js", "fr/gc_rules.js",
    "fr/gc_rules_graph.js", "fr/gc_engine.js",
];
const DATA = ["fr/conj_data.json", "fr/mfsp_data.json", "fr/phonet_data.json", "graphspell/_dictionaries/fr-allvars.json"];
const FILES = [...SCRIPTS, ...DATA].map(f => `grammalecte/${f}`);

const IDLE = 15 * 60_000;
const PARSE_TIMEOUT = 2000;

let busy: Promise<void> | null = null;
let lastError: string | undefined;
let ctx: Context | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

export interface EngineStatus {
    installed: boolean;
    version: string;
    busy: boolean;
    loaded: boolean;
    error?: string;
}

const installed = () => existsSync(READY);

function status(): EngineStatus {
    return { installed: installed(), version: VERSION, busy: busy != null, loaded: ctx != null, error: lastError };
}

// ── Téléchargement ───────────────────────────────────────────────────────────

/** Lit les fichiers voulus d'une archive zip (l'extension .xpi en est une). */
function unzip(zip: Buffer, wanted: Set<string>) {
    // Fin du répertoire central : signature 0x06054b50, cherchée depuis la fin.
    let eocd = -1;
    for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
        if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("archive illisible");
    const count = zip.readUInt16LE(eocd + 10);
    let p = zip.readUInt32LE(eocd + 16);
    const out = new Map<string, Buffer>();
    for (let n = 0; n < count; n++) {
        if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error("archive illisible");
        const method = zip.readUInt16LE(p + 10);
        const compSize = zip.readUInt32LE(p + 20);
        const nameLen = zip.readUInt16LE(p + 28);
        const extraLen = zip.readUInt16LE(p + 30);
        const commentLen = zip.readUInt16LE(p + 32);
        const local = zip.readUInt32LE(p + 42);
        const name = zip.toString("utf8", p + 46, p + 46 + nameLen);
        p += 46 + nameLen + extraLen + commentLen;
        if (!wanted.has(name)) continue;
        if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error("archive illisible");
        const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
        const raw = zip.subarray(start, start + compSize);
        if (method === 0) out.set(name, Buffer.from(raw));
        else if (method === 8) out.set(name, inflateRawSync(raw));
        else throw new Error(`compression ${method} non gérée`);
    }
    return out;
}

async function download() {
    const res = await net.fetch(XPI_URL, { headers: { "User-Agent": "low-cord" } });
    if (!res.ok) throw new Error(`téléchargement : HTTP ${res.status}`);
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length !== XPI_SIZE) throw new Error("fichier incomplet");
    if (createHash("sha256").update(data).digest("hex") !== XPI_SHA256) throw new Error("empreinte incorrecte : fichier refusé");

    const files = unzip(data, new Set(FILES));
    const missing = FILES.filter(f => !files.has(f));
    if (missing.length) throw new Error(`fichiers manquants : ${missing.join(", ")}`);

    // Écrit à côté puis renommé d'un coup : jamais de moteur à moitié installé.
    const tmp = join(ROOT, `download-${process.pid}`);
    rmSync(tmp, { recursive: true, force: true });
    try {
        for (const [name, content] of files) {
            const file = join(tmp, name);
            mkdirSync(join(file, ".."), { recursive: true });
            writeFileSync(file, content);
        }
        writeFileSync(join(tmp, ".ready"), VERSION);
        rmSync(DIR, { recursive: true, force: true });
        renameSync(tmp, DIR);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}

/** Installe le moteur s'il ne l'est pas (un seul téléchargement à la fois). */
export async function install(_?: IpcMainInvokeEvent) {
    if (installed()) return status();
    busy ??= (async () => {
        try {
            mkdirSync(ROOT, { recursive: true });
            await download();
            lastError = undefined;
        } catch (e: any) {
            lastError = String(e?.message ?? e);
            throw e;
        } finally {
            busy = null;
        }
    })();
    await busy;
    return status();
}

export function uninstall(_?: IpcMainInvokeEvent) {
    unload();
    rmSync(ROOT, { recursive: true, force: true });
    return status();
}

// ── Moteur ───────────────────────────────────────────────────────────────────

function load() {
    if (ctx) return ctx;
    if (!installed()) throw new Error("correcteur pas installé");
    const base = join(DIR, "grammalecte");
    // Grammalecte lit ses données avec XMLHttpRequest et browser.runtime.getURL
    // (comme dans Firefox) : on lui donne une version qui lit seulement son dossier.
    const readOwn = (url: string) => {
        const rel = String(url).replace(/^lc:\/\/grammalecte\//, "");
        if (!DATA.includes(rel)) throw new Error(`fichier refusé : ${rel}`);
        return readFileSync(join(base, rel), "utf8");
    };
    class XMLHttpRequest {
        url = "";
        status = 0;
        responseText = "";
        open(_method: string, url: string) { this.url = url; }
        overrideMimeType() { }
        send() { this.responseText = readOwn(this.url); this.status = 200; }
    }
    const quiet = { log() { }, info() { }, warn() { }, error: (...a: any[]) => console.error("[AutoCorrect]", ...a) };
    const sandbox: any = { console: quiet, XMLHttpRequest, browser: { runtime: { getURL: (p: string) => `lc://${p}` } } };
    sandbox.self = sandbox;
    const context = createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
    for (const f of SCRIPTS) runInContext(readFileSync(join(base, f), "utf8"), context, { filename: f });
    runInContext("gc_engine.load(\"JavaScript\", \"aHSL\", \"lc://grammalecte/graphspell/_dictionaries\")", context);
    if (!runInContext("gc_engine.getSpellChecker() != null", context)) throw new Error("dictionnaire non chargé");
    context.__options = GRAMMALECTE_OPTIONS;
    runInContext("gc_engine.setOptions(new Map(Object.entries(__options)))", context);
    ctx = context;
    return ctx;
}

function unload() {
    ctx = null;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
}

function touch() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(unload, IDLE);
    idleTimer.unref?.();
}

function parse(text: string): GrammarError[] {
    const context = load();
    context.__text = text;
    const errors = runInContext("Array.from(gc_engine.parse(__text, \"FR\", false, null, false) || [])", context, { timeout: PARSE_TIMEOUT });
    // Copie simple : rien de l'objet du contexte isolé ne sort tel quel.
    return (errors as any[]).map(e => ({
        nStart: Number(e.nStart), nEnd: Number(e.nEnd), sType: String(e.sType), sRuleId: String(e.sRuleId),
        aSuggestions: Array.isArray(e.aSuggestions) ? e.aSuggestions.map(String) : [], sMessage: String(e.sMessage ?? ""),
    }));
}

/** Charge le moteur à l'avance (premier caractère tapé) : la correction est prête à l'envoi. */
export function warmup(_?: IpcMainInvokeEvent) {
    if (!installed()) return false;
    try {
        load();
        touch();
        return true;
    } catch (e: any) {
        lastError = String(e?.message ?? e);
        unload();
        return false;
    }
}

const MAX_LENGTH = 4000;

export function correct(_: IpcMainInvokeEvent, text: unknown, options: unknown): { text: string; fixes: Fix[]; } {
    if (typeof text !== "string") return { text: "", fixes: [] };
    if (!text.trim() || text.length > MAX_LENGTH) return { text, fixes: [] };
    const o = (options ?? {}) as Partial<CorrectOptions>;
    const opts: CorrectOptions = {
        groups: Array.isArray(o.groups) ? o.groups.map(String) : [],
        whitelist: Array.isArray(o.whitelist) ? o.whitelist.map(String).slice(0, 2000) : [],
        custom: o.custom !== false,
    };
    touch();
    try {
        return runCorrect(text, parse, opts);
    } catch (e: any) {
        // Analyse trop longue ou moteur en erreur : on repart d'un moteur neuf la prochaine fois.
        lastError = String(e?.message ?? e);
        unload();
        throw e;
    }
}

export function getStatus(_?: IpcMainInvokeEvent) {
    return status();
}
