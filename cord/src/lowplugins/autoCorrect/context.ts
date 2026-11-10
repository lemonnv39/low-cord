/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// AutoCorrect — correction par le contexte, comme un clavier de téléphone.
//
// Le modèle (fr-ngrams.bin) contient la fréquence de chaque mot et de chaque
// paire de mots dans un très grand corpus de français parlé (sous-titres,
// OpenSubtitles 2018 / OPUS). Pour chaque mot du message, on compare les
// candidats proches (le mot lui-même, le même aux accents près, ou à une
// lettre près) et on garde le plus probable entre ses deux voisins :
//   score = log P(candidat | mot d'avant) + log P(mot d'après | candidat)
//           − coût du changement
// Le mot n'est remplacé que si un candidat est nettement plus probable.
// « saluts » seul → « salut », « tu va » → « tu vas », « ces bon » → …
//
// Module pur (sans Discord) : testé hors de Discord.

export interface NgramModel {
    words: string[];
    index: Map<string, number>;
    uni: Uint32Array;
    total: number;
    rowStart: Uint32Array;
    cols: Uint32Array;
    cnts: Uint16Array;
    /** forme sans accents → mots du vocabulaire (candidats aux accents près et terminaisons) */
    byBare: Map<string, number[]>;
}

const BOS = 0, EOS = 1;

/** Découpage identique à celui du corpus : minuscules, « c' » « est » séparés. */
export const tokenRe = /\p{L}+['’]?/gu;
export const bare = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[’]/g, "'").toLowerCase();

/** Lit fr-ngrams.bin (voir le script de construction pour le format). */
export function loadModel(buf: Uint8Array): NgramModel {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) !== "LCNG") throw new Error("modèle invalide");
    const V = dv.getUint32(8, true), B = dv.getUint32(12, true);
    const vlen = dv.getUint32(16, true);
    let p = 20;
    const words = new TextDecoder().decode(buf.subarray(p, p + vlen)).split("\n");
    if (words.length !== V) throw new Error("modèle invalide");
    p += vlen + ((4 - (vlen % 4)) % 4);
    // Copies alignées (le tampon reçu peut ne pas l'être).
    const take = <T>(Ctor: { new(b: ArrayBuffer): T; BYTES_PER_ELEMENT: number; }, n: number) => {
        const bytes = n * Ctor.BYTES_PER_ELEMENT;
        // new Uint8Array(…) copie vraiment (Buffer.slice de Node partage le tampon).
        const out = new Ctor(new Uint8Array(buf.subarray(p, p + bytes)).buffer);
        p += bytes;
        return out;
    };
    const uni = take(Uint32Array, V);
    const rowStart = take(Uint32Array, V + 1);
    const cols = take(Uint32Array, B);
    const cnts = take(Uint16Array, B);

    const index = new Map<string, number>();
    words.forEach((w, i) => index.set(w, i));
    let total = 0;
    for (let i = 2; i < V; i++) total += uni[i];

    // Index des candidats : seulement les mots assez fréquents (le reste est du bruit de sous-titres).
    const byBare = new Map<string, number[]>();
    for (let i = 2; i < V; i++) {
        if (uni[i] < 20) continue;
        const b = bare(words[i]);
        const l = byBare.get(b);
        if (l) l.push(i); else byBare.set(b, [i]);
    }
    return { words, index, uni, total, rowStart, cols, cnts, byBare };
}

function pairCount(m: NgramModel, a: number, b: number) {
    let lo = m.rowStart[a], hi = m.rowStart[a + 1] - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1, c = m.cols[mid];
        if (c === b) return Math.exp(m.cnts[mid] / 1000);
        if (c < b) lo = mid + 1; else hi = mid - 1;
    }
    return 0;
}

const D = 0.75;
/** log P(b | a), lissé (décompte absolu) : une paire jamais vue retombe sur la fréquence de b. */
function logP(m: NgramModel, a: number, b: number) {
    const pb = b < 0 ? 1e-9 : Math.max((m.uni[b] + 0.5) / m.total, 1e-9);
    if (a < 0) return Math.log(pb);
    const ca = Math.max(m.uni[a], 1);
    const followers = m.rowStart[a + 1] - m.rowStart[a];
    const c = b < 0 ? 0 : pairCount(m, a, b);
    const lambda = Math.min(1, (D * Math.max(followers, 1)) / ca);
    return Math.log(Math.max(c - D, 0) / ca + lambda * pb);
}

// Terminaisons qui se confondent à l'oral (va / vas, peut / peux, salut / saluts…).
const ENDINGS = ["", "s", "t", "x", "d", "e", "es", "ts", "ds", "ent"];

/** Candidats : le même mot aux accents près, ou avec une autre terminaison muette. */
function candidates(m: NgramModel, w: string) {
    const b = bare(w);
    const out = new Set<number>();
    for (let cut = 0; cut <= Math.min(3, b.length - 2); cut++) {
        const stem = b.slice(0, b.length - cut);
        for (const e of ENDINGS) for (const i of m.byBare.get(stem + e) ?? []) out.add(i);
    }
    return [...out];
}

export interface ContextOptions {
    /** mots à ne jamais toucher (argot, mots de l'utilisateur), en minuscules */
    keep: (word: string) => boolean;
    /** zones protégées (liens, code…) */
    spans: [number, number][];
    /** le mot existe-t-il en français (dictionnaire de Grammalecte) ? */
    isValid: (word: string) => boolean;
}

// Homophones courants du chat, au-delà des accents et des terminaisons.
const HOMOPHONES: string[][] = [
    ["sa", "ça"], ["ca", "ça"], ["et", "est"], ["on", "ont"], ["ces", "ses"], ["ce", "se"],
    ["mes", "mais"], ["peu", "peut"], ["quand", "quant"],
];
const HOMOPHONE_OF = new Map<string, string[]>();
for (const group of HOMOPHONES) for (const w of group) HOMOPHONE_OF.set(w, [...(HOMOPHONE_OF.get(w) ?? []), ...group.filter(x => x !== w)]);

/**
 * Un vrai mot ne change qu'en un proche parent : accents (la / là), terminaison
 * (va / vas, peut / peux, salut / saluts, son / sont) ou homophone courant.
 * Jamais au milieu du mot (« ban » ≠ « bon », « daronne » ≠ « baronne »).
 */
function closeRelative(w: string, c: string) {
    const bw = bare(w), bc = bare(c);
    if (bw === bc) return true;
    if (HOMOPHONE_OF.get(w)?.includes(c)) return true;
    let k = 0;
    while (k < bw.length && k < bc.length && bw[k] === bc[k]) k++;
    // Au moins la racine commune, et seulement des lettres de terminaison qui diffèrent.
    if (k < 2 || k < Math.min(bw.length, bc.length) - 1) return false;
    const end = /^[stxde]{0,2}$/;
    return end.test(bw.slice(k)) && end.test(bc.slice(k));
}

export interface ContextFix { from: string; to: string; }

/**
 * Réglages (en log) : coût d'un changement (accents seuls, petit ; terminaison
 * ou homophone, plus cher) et gain de probabilité exigé pour remplacer
 * (log 3 ≈ 20 fois plus probable). Calibrés sur les bases de test.
 */
export const TUNING = { costAccent: 0.5, costEdit: 4.5, costHomophone: 1.5, marginUnknown: 2, marginKnown: 3 };

function keepCase(orig: string, to: string) {
    if (orig.length > 1 && orig === orig.toUpperCase() && orig !== orig.toLowerCase()) return to.toUpperCase();
    if (orig[0] && orig[0] !== orig[0].toLowerCase()) return to[0].toUpperCase() + to.slice(1);
    return to;
}

/**
 * Corrige les mots d'après leurs voisins. Une phrase à la fois ; chaque mot
 * est jugé avec ses voisins tels qu'ils sont déjà corrigés à gauche.
 */
export function contextFix(text: string, m: NgramModel, opts: ContextOptions) {
    const fixes: ContextFix[] = [];
    const tokens = [...text.matchAll(tokenRe)].map(t => ({ text: t[0], at: t.index!, end: t.index! + t[0].length }));
    if (!tokens.length) return { text, fixes };
    const isProtected = (a: number, b: number) => opts.spans.some(([x, y]) => a < y && b > x);

    // Fin de phrase entre deux mots : ponctuation forte ou retour à la ligne.
    const boundary = (i: number) => i < 0 || i >= tokens.length - 1 || /[.!?…\n]/.test(text.slice(tokens[i].end, tokens[i + 1].at));
    const idOf = (w: string) => m.index.get(w.toLowerCase().replace(/’/g, "'")) ?? -1;

    const out = tokens.map(t => t.text);
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        const w = t.text;
        const low = w.toLowerCase().replace(/’/g, "'");
        if (isProtected(t.at, t.end) || opts.keep(low) || /^\p{L}['’]$/u.test(w)) continue;
        // Collé à un chiffre ou un « _ » (pseudo, code), nom propre en milieu de phrase, mot en capitales.
        if (/[\d_@#]/.test(text[t.at - 1] ?? "") || /[\d_]/.test(text[t.end] ?? "")) continue;
        const startOfSentence = i === 0 || boundary(i - 1);
        if (w !== low && (!startOfSentence || (w.length > 1 && w === w.toUpperCase()))) continue;

        const prev = boundary(i - 1) ? BOS : idOf(out[i - 1]);
        const next = boundary(i) ? EOS : idOf(out[i + 1]);
        const self = m.index.get(low) ?? -1;
        const score = (c: number) => logP(m, prev, c) + logP(m, c, next);
        const own = score(self);

        let best = -1, bestScore = -Infinity;
        // Mot inconnu du dictionnaire (argot, prénom, faute de frappe) : seulement les accents ;
        // les fautes de frappe sont l'affaire des couches d'orthographe, qui ont leurs garde-fous.
        const valid = opts.isValid(low);
        const pool = new Set(candidates(m, low));
        for (const h of HOMOPHONE_OF.get(low) ?? []) {
            const i = m.index.get(h);
            if (i !== undefined) pool.add(i);
        }
        for (const c of pool) {
            if (c === self) continue;
            const cw = m.words[c];
            // Pas d'apostrophe ni de mot coupé : le découpage les sépare déjà.
            if (/['’]/.test(cw) !== /['’]/.test(low)) continue;
            const accentOnly = bare(cw) === bare(low);
            if (!valid && !accentOnly) continue;
            if (valid && !closeRelative(low, cw)) continue;
            // Le candidat doit lui-même être un vrai mot (pas un nom propre en minuscules du corpus).
            if (!opts.isValid(cw)) continue;
            const cost = accentOnly ? TUNING.costAccent : HOMOPHONE_OF.get(low)?.includes(cw) ? TUNING.costHomophone : TUNING.costEdit;
            const s = score(c) - cost;
            if (s > bestScore) { bestScore = s; best = c; }
        }
        if (best < 0) continue;
        // Mot connu (fréquent dans le corpus) : il faut une preuve plus forte pour le changer.
        const known = self >= 0 && m.uni[self] >= 50;
        if (bestScore - own < (known ? TUNING.marginKnown : TUNING.marginUnknown)) continue;
        const to = keepCase(w, m.words[best]);
        out[i] = to;
        fixes.push({ from: w, to });
    }

    let result = "", last = 0;
    tokens.forEach((t, i) => {
        result += text.slice(last, t.at) + out[i];
        last = t.end;
    });
    return { text: result + text.slice(last), fixes };
}
