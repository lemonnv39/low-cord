/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// AutoCorrect — choix des corrections à partir des erreurs de Grammalecte.
//
// Grammalecte signale beaucoup de choses ; sur Discord on ne veut corriger
// que la grammaire sûre (son/sont, a/à, accords, conjugaison) et jamais
// l'argot (tkt, slt, mdr…), les liens, mentions, emojis ou blocs de code.
//
//  - Les erreurs d'orthographe (mots inconnus) ne sont jamais corrigées :
//    c'est ce qui laisse passer l'argot.
//  - Une correction à la fois, puis nouvelle analyse : corriger « son » en
//    « sont » fait disparaître l'erreur d'accord qu'il provoquait.
//  - Chaque correction possible est essayée, on garde celle qui laisse le
//    moins d'erreurs (« qui a gagner » → « gagné », pas « à gagner »).
//  - Deux temps : homophones et conjugaison d'abord, accords ensuite (un
//    accord calculé sur un mot encore faux serait faux lui aussi).
//
// Module pur (aucune dépendance) : testé hors de Discord.

export interface GrammarError {
    nStart: number;
    nEnd: number;
    sType: string;
    sRuleId: string;
    aSuggestions: string[];
    sMessage?: string;
}

export interface Fix {
    from: string;
    to: string;
    group: string;
    message?: string;
}

export interface CorrectOptions {
    /** familles de règles actives (voir GROUPS) */
    groups: string[];
    /** accents, apostrophes et traits d'union oubliés (daccord → d'accord) */
    accents: boolean;
    /** mots (en minuscules) à ne jamais toucher */
    whitelist: string[];
    /** petites règles maison pour les fautes que Grammalecte laisse passer */
    custom: boolean;
}

/** Familles de règles de Grammalecte, de la plus sûre à la moins sûre. */
export const GROUPS = ["conf", "conj", "infi", "imp", "vmode", "loc", "tu", "inte", "ppas", "gn"] as const;
const PHASE1 = new Set(["conf", "conj", "infi", "imp", "vmode", "loc", "tu", "inte"]);
const PHASE2 = new Set(["ppas", "gn"]);

/** Options de Grammalecte : la typographie (apostrophes courbes, espaces insécables…) est coupée. */
export const GRAMMALECTE_OPTIONS: Record<string, boolean> = {
    typo: false, apos: false, eepi: false, esp: false, tab: false, nbsp: false, tu: true, maj: false, minis: false,
    num: false, virg: false, poncfin: false, unit: false, nf: false, liga: false, mapos: false, chim: false, ocr: false,
    conf: true, loc: true, gn: true, infi: true, conj: true, ppas: true, imp: true, inte: true, vmode: true,
    bs: false, pleo: false, eleu: false, neg: false, redon1: false, redon2: false, date: false, mc: false,
    idrule: false, html: false, latex: false, md: true,
};

// Règles trop vagues (suggestions au hasard : « ces mon » → « monts ») ou
// piégées par les anglicismes du chat (« mon pc a crash » → « à crash »).
const BAD_RULES = /incohérences_globales|substantif_à_substantif/;
// a / à : souvent en concurrence avec un participe (« qui a gagner ») → second temps.
const RISKY = /conf_à_a|conf_a_à/;
const DETERMINERS = new Set("le la les l' un une des du mon ton son ma ta sa mes tes ses notre votre leur nos vos leurs ce cet cette ces".split(" "));
// Plusieurs suggestions : on ne choisit que parmi ces mots courants.
const PREFERRED = "est sont ai a as à ça c'est s'est ces ses et on ont ou où son sa se ce leur leurs peut peux vas va sais sait fait fais".split(" ");

/** Argot et abréviations laissés tels quels, même si Grammalecte les signale. */
export const SLANG = new Set((
    "tkt tqt slt mdr ptdr xptdr jsp wsh wesh frr frero gg wp ptn nn jpp c chui chuis jsuis j'suis y'a ya bg oklm askip "
    + "wallah mskn pk pq pcq stp svp dsl bjr bsr cc cv mtn tjrs tjs qd qqn qqch osef lol xd ok okay ouais ouai nan ui "
    + "jte jme jle j'te j'me j'le j'vais t'es t'as t'étais t'avais bah ben bon hein euh ah oh wtf gl hf afk brb irl dm mp go "
    + "lag spawn stream ranked tryhard cheh sah wallah frero jvais jsuis"
).split(" "));

// Fautes très courantes sur Discord que Grammalecte laisse passer
// (« sa fait » est ambigu pour lui : « fait » est aussi un nom).
const SA_VERBS = "va|vas|fait|fais|marche|passe|me|te|se|m'|t'|s'|m’|t’|s’|dépend|suffit|craint|arrive|sert|change|commence|devient|peut|doit|dit|parait|paraît|veut|vaut|existe|compte|reste|tombe|casse|part|bug|lag|beug";
const CUSTOM: [RegExp, (m: string, before: string, letter: string) => string][] = [
    [new RegExp(`(^|[\\s(«"])([Ss])a (?=(?:${SA_VERBS})(?![\\p{L}]))`, "gu"), (_, p, s) => `${p}${s === "S" ? "Ç" : "ç"}a `],
    // « ont y va » : seulement en début de phrase (« ceux qui ont fait » est correct).
    [/(^|[.!?]\s+)([Oo])nt (?=(?:y|va|vas|est|a|peut|doit|fait|se|s'|s’|verra|voit|part|dit|sait)(?![\p{L}]))/gu, (_, p, o) => `${p}${o}n `],
];

// Ce qui ne doit jamais être analysé : remplacé par des espaces de même
// longueur (les positions des erreurs restent justes).
const PROTECTED = [
    /```[\s\S]*?```/g, /`[^`\n]*`/g, /https?:\/\/\S+/g, /<a?:\w+:\d+>/g, /<[@#][!&]?\d+>/g, /<\/[\w -]+:\d+>/g,
    /<t:\d+(?::\w)?>/g, /:[\w~-]+:/g, /@(?:everyone|here)\b/g,
];

function protect(text: string) {
    const spans: [number, number][] = [];
    let masked = text;
    for (const re of PROTECTED) {
        masked = masked.replace(re, (m: string, ...rest) => {
            const at = rest[rest.length - 2] as number;
            spans.push([at, at + m.length]);
            return " ".repeat(m.length);
        });
    }
    return { masked, spans };
}

const overlaps = (start: number, end: number, spans: [number, number][]) => spans.some(([a, b]) => start < b && end > a);

/** Garde la casse du mot d'origine (« Sa » → « Ça », « SA » → « ÇA »). */
function keepCase(orig: string, sugg: string) {
    if (orig.length > 1 && orig === orig.toUpperCase() && orig !== orig.toLowerCase()) return sugg.toUpperCase();
    if (orig[0] && orig[0] !== orig[0].toLowerCase()) return sugg[0].toUpperCase() + sugg.slice(1);
    return sugg;
}

/** Famille d'une erreur : dans l'identifiant de la règle (« g2__conf_… »), sinon son type. */
export const groupOf = (e: GrammarError) => /__([a-zà-ü]+)_/.exec(e.sRuleId)?.[1] ?? e.sType;

// « trompé / trompée » : même mot à l'accord près → le premier (masculin).
const stem = (s: string) => s.replace(/e?s?$/, "");
const sameStem = (list: string[]) => list.every(s => stem(s) === stem(list[0]));

// ── Accents, apostrophes, traits d'union oubliés ─────────────────────────────
// Un mot inconnu n'est corrigé que si la suggestion est LE MÊME mot à des
// accents, une apostrophe ou un trait d'union près (daccord → d'accord,
// c'etait → c'était, deja → déjà). L'argot (tkt, mdr…) n'a jamais de tel
// équivalent : il passe.

export interface Speller {
    isValid(word: string): boolean;
    suggest(word: string): string[];
}

const bare = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[-'’]/g, "").toLowerCase();
// Après une apostrophe ajoutée, il faut un vrai mot (« lag » ≠ « l'ag »).
const SHORT_AFTER_APOS = new Set(["ai", "as", "a", "en", "es", "est", "il", "on", "y", "un", "une", "ils", "elle", "elles", "eux"]);
const WORD = /\p{L}[\p{L}'’-]*/gu;
const NOT_WORD = /[\p{L}\d_]/u;

function fixAccents(text: string, spans: [number, number][], speller: Speller, whitelist: Set<string>, curly: boolean, fixes: Fix[]) {
    let out = "";
    let last = 0;
    for (const m of text.matchAll(WORD)) {
        const word = m[0].replace(/[-'’]+$/, "");
        const at = m.index!;
        const low = word.toLowerCase();
        if (word.length < 2 || overlaps(at, at + word.length, spans)) continue;
        if (whitelist.has(low) || SLANG.has(low)) continue;
        // Collé à un chiffre ou un « _ » : pseudo, code, pas un mot.
        if (NOT_WORD.test(text[at - 1] ?? "") || /[\d_]/.test(text[at + word.length] ?? "")) continue;
        // Majuscule en milieu de phrase (nom propre) ou mot tout en capitales : on n'y touche pas.
        const startOfSentence = /(^|[.!?\n]\s*)$/.test(text.slice(0, at));
        if (word !== low && (!startOfSentence || word === word.toUpperCase())) continue;
        // Le dictionnaire écrit « c’est » : l'apostrophe droite du clavier ne rend pas un mot inconnu.
        const probe = word.replace(/'/g, "’");
        if (speller.isValid(probe)) continue;
        // Élision (t'inquiète, qu'elle, jusqu'ici) : le mot après l'apostrophe compte.
        const elided = /^(?:[cdjlmnst]|qu|jusqu|lorsqu|puisqu|quoiqu)’(.+)$/i.exec(probe);
        if (elided && speller.isValid(elided[1])) continue;
        const target = bare(word);
        const pick = speller.suggest(probe).find(sugg => {
            if (bare(sugg) !== target) return false;
            // Pas de sigle ni de nom propre (« fai » ≠ « FAI ») : seule la 1ʳᵉ lettre peut changer de casse.
            if (sugg.slice(1) !== sugg.slice(1).toLowerCase() || (sugg[0] !== sugg[0].toLowerCase() && word[0] === word[0].toLowerCase())) return false;
            const apos = sugg.split(/['’]/);
            return apos.length === 1 || apos.slice(1).every(part => part.length >= 3 || SHORT_AFTER_APOS.has(part.toLowerCase()));
        });
        if (!pick) continue;
        const to = keepCase(word, curly ? pick : pick.replace(/’/g, "'"));
        if (to === word) continue;
        out += text.slice(last, at) + to;
        last = at + word.length;
        fixes.push({ from: word, to, group: "accents" });
    }
    return out + text.slice(last);
}

interface Candidate {
    error: GrammarError;
    orig: string;
    to: string;
    group: string;
    score: number[];
    next: string;
    after: GrammarError[];
}

const lessThan = (a: number[], b: number[]) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
    return false;
};

/**
 * Corrige `text`. `parse` renvoie les erreurs de Grammalecte pour un texte.
 * Ne lève jamais d'erreur sur un texte normal ; au pire, rien n'est corrigé.
 */
export function correct(text: string, parse: (text: string) => GrammarError[], options: CorrectOptions, speller?: Speller) {
    const groups = new Set(options.groups);
    const whitelist = new Set(options.whitelist.map(w => w.toLowerCase()));
    // Apostrophes courbes seulement si le message en contient déjà.
    const curly = text.includes("’");
    const fixes: Fix[] = [];
    let cur = text;

    // D'abord l'orthographe sûre : la grammaire travaille ensuite sur des mots connus.
    if (options.accents && speller) {
        const { spans } = protect(cur);
        cur = fixAccents(cur, spans, speller, whitelist, curly, fixes);
    }

    if (options.custom) {
        const { spans } = protect(cur);
        for (const [re, fn] of CUSTOM) {
            cur = cur.replace(re, (m: string, before: string, letter: string, at: number) => {
                if (overlaps(at, at + m.length, spans)) return m;
                const word = m.slice(before.length).trim();
                if (whitelist.has(word.toLowerCase())) return m;
                const out = fn(m, before, letter);
                fixes.push({ from: word, to: out.slice(before.length).trim(), group: "custom" });
                return out;
            });
        }
    }

    const errorsOf = (s: string, phase: Set<string>, second: boolean) => {
        const { masked, spans } = protect(s);
        return parse(masked).filter(e => {
            if (BAD_RULES.test(e.sRuleId) || overlaps(e.nStart, e.nEnd, spans)) return false;
            const g = groupOf(e);
            if (!groups.has(g)) return false;
            return RISKY.test(e.sRuleId) ? second : phase.has(g);
        });
    };

    const seen = new Set([cur]);
    for (const [phase, second] of [[PHASE1, false], [PHASE2, true]] as const) {
        let errors = errorsOf(cur, phase, second);
        for (let pass = 0; pass < 12 && errors.length; pass++) {
            const candidates: Candidate[] = [];
            for (const error of errors) {
                const orig = cur.slice(error.nStart, error.nEnd);
                const low = orig.toLowerCase();
                if (whitelist.has(low) || SLANG.has(low)) continue;
                const group = groupOf(error);
                // Un accord ne change jamais le déterminant (« sa fait » ≠ « son fait »).
                if (group === "gn" && DETERMINERS.has(low)) continue;
                const suggestions = error.aSuggestions
                    .map(s => curly ? s : s.replace(/’/g, "'"))
                    .filter(s => s && s.toLowerCase() !== low);
                if (!suggestions.length) continue;
                const pool = suggestions.length === 1 || sameStem(suggestions)
                    ? [suggestions[0]]
                    : suggestions.filter(s => PREFERRED.includes(s.toLowerCase()));
                for (const pick of pool.slice(0, 3)) {
                    const to = keepCase(orig, pick);
                    const rank = RISKY.test(error.sRuleId) ? GROUPS.length : GROUPS.indexOf(group as any);
                    const pref = PREFERRED.indexOf(pick.toLowerCase());
                    candidates.push({ error, orig, to, group, score: [0, rank, pref < 0 ? 99 : pref, error.nStart], next: "", after: [] });
                }
            }

            // Chaque correction possible est essayée : on garde celle qui laisse le moins d'erreurs.
            let best: Candidate | null = null;
            for (const c of candidates.slice(0, 8)) {
                c.next = cur.slice(0, c.error.nStart) + c.to + cur.slice(c.error.nEnd);
                if (seen.has(c.next)) continue;
                c.after = errorsOf(c.next, phase, second);
                c.score[0] = c.after.length;
                if (!best || lessThan(c.score, best.score)) best = c;
            }
            // Une correction qui ajoute des erreurs n'en est pas une.
            if (!best || best.after.length > errors.length) break;
            seen.add(best.next);
            fixes.push({ from: best.orig, to: best.to, group: best.group, message: best.error.sMessage });
            cur = best.next;
            errors = best.after;
        }
    }
    return { text: cur, fixes };
}
