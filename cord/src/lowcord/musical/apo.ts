/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-musical — Mini APO : lecture d'un « set » Equalizer APO (le texte de
// config.txt), traduit en étapes pour le moteur. Mêmes règles qu'APO :
//  - Preamp: -6 dB
//  - Filter: ON PK|PEQ|Modal|LP|LPQ|HP|HPQ|BP|LS|LSC|HS|HSC|NO|AP Fc … Hz [Gain … dB] [Q …|BW Oct …]
//    (LS/HS 6dB/12dB, LSC/HSC « x dB », Filter: ON IIR Order n Coefficients …)
//  - GraphicEQ: f g; f g; …
//  - Channel: L R | 1 2 | all
//  - Copy: L=R R=0.5*L+-6dB*R …
//  - Delay: 10 ms | 480 samples
//  - Convolution: salle.wav  (réponse impulsionnelle importée dans le volet)
// Formules des filtres : celles d'APO (RBJ), valeurs par défaut comprises
// (Q 0,707 ; pente des shelfs 0,9 ; notch Q 30 ; fréquence de coin des LS/HS).
// Les coefficients sont calculés ici pour 48 kHz : la courbe affichée est
// exactement ce que joue le moteur.

export const APO_RATE = 48000;

/** Fréquences de la courbe affichée : 20 Hz → 20 kHz, échelle logarithmique. */
export const APO_FREQS = Array.from({ length: 240 }, (_, i) => 20 * Math.pow(1000, i / 239));

type Ch = [boolean, boolean];

export type ApoStage =
    | { t: "gain"; db: [number, number]; }
    | { t: "iir"; ch: Ch; b: number[]; a: number[]; }
    | { t: "graphic"; ch: Ch; points: [number, number][]; }
    | { t: "copy"; m: [number, number, number, number]; c: [number, number]; }
    | { t: "delay"; ch: Ch; samples: number; }
    | { t: "conv"; ch: Ch; ir: string; name: string; };

/** Réponse impulsionnelle importée : nom d'origine et fichier rangé par low-cord. */
export interface ApoIr { name: string; file: string; }

/** Une ligne lue, pour la liste du panneau. */
export interface ApoLine {
    /** numéro de ligne (1 = première) */
    line: number;
    kind: string;
    summary: string;
    /** filtre présent mais coupé (OFF) */
    off?: boolean;
    /** pourquoi la ligne est ignorée */
    warning?: string;
}

export interface ApoParse {
    stages: ApoStage[];
    lines: ApoLine[];
}

const num = (s: string) => {
    const v = Number(s);
    return Number.isFinite(v) ? v : NaN;
};
const NUM = "([-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?)";
const fmtHz = (f: number) => f >= 1000 ? `${+(f / 1000).toFixed(2)} kHz` : `${+f.toFixed(1)} Hz`;
const fmtDb = (g: number) => `${g > 0 ? "+" : ""}${+g.toFixed(2)} dB`;

/** Canal par nom ou numéro (stéréo : L = 1, R = 2). */
function channelIndex(token: string): number | null {
    const t = token.trim().toUpperCase();
    if (t === "L" || t === "1") return 0;
    if (t === "R" || t === "2") return 1;
    return null;
}

// ── Filtres (mêmes formules qu'APO) ─────────────────────────────────────────

type FilterKind = "PK" | "LP" | "HP" | "BP" | "NO" | "AP" | "LS" | "HS";

const KINDS: Record<string, FilterKind> = {
    PK: "PK", PEQ: "PK", MODAL: "PK",
    LP: "LP", LPQ: "LP", HP: "HP", HPQ: "HP",
    BP: "BP", NO: "NO", AP: "AP",
    LS: "LS", LSC: "LS", HS: "HS", HSC: "HS",
};

/** Coefficients [b0 b1 b2], [a0 a1 a2] d'un biquad APO. */
export function biquad(kind: FilterKind, freq: number, gainDb: number, opt: { q?: number; bw?: number; s?: number; corner?: boolean; }) {
    const shelf = kind === "LS" || kind === "HS";
    const A = shelf || kind === "PK" ? Math.pow(10, gainDb / 40) : Math.pow(10, gainDb / 20);
    let { s } = opt;
    if (shelf && s === undefined) {
        // Q donné à un shelf : converti en pente S.
        s = opt.q !== undefined ? 1 / ((1 / (opt.q * opt.q) - 2) / (A + 1 / A) + 1) : 0.9;
    }
    let f = freq;
    if (shelf && opt.corner) {
        // Fréquence de coin → centre (convention DCX2496, comme APO).
        const factor = Math.pow(10, Math.abs(gainDb) / 80 / s!);
        f = kind === "LS" ? freq * factor : freq / factor;
    }
    const w = 2 * Math.PI * f / APO_RATE;
    const sn = Math.sin(w), cs = Math.cos(w);
    let alpha: number;
    if (shelf) alpha = sn / 2 * Math.sqrt((A + 1 / A) * (1 / s! - 1) + 2);
    else if (opt.bw !== undefined) alpha = sn * Math.sinh(Math.LN2 / 2 * opt.bw * w / sn);
    else alpha = sn / (2 * (opt.q ?? Math.SQRT1_2));
    const beta = 2 * Math.sqrt(A) * alpha;
    switch (kind) {
        case "LP": return { b: [(1 - cs) / 2, 1 - cs, (1 - cs) / 2], a: [1 + alpha, -2 * cs, 1 - alpha] };
        case "HP": return { b: [(1 + cs) / 2, -(1 + cs), (1 + cs) / 2], a: [1 + alpha, -2 * cs, 1 - alpha] };
        case "BP": return { b: [alpha, 0, -alpha], a: [1 + alpha, -2 * cs, 1 - alpha] };
        case "NO": return { b: [1, -2 * cs, 1], a: [1 + alpha, -2 * cs, 1 - alpha] };
        case "AP": return { b: [1 - alpha, -2 * cs, 1 + alpha], a: [1 + alpha, -2 * cs, 1 - alpha] };
        case "PK": return { b: [1 + alpha * A, -2 * cs, 1 - alpha * A], a: [1 + alpha / A, -2 * cs, 1 - alpha / A] };
        case "LS": return {
            b: [A * ((A + 1) - (A - 1) * cs + beta), 2 * A * ((A - 1) - (A + 1) * cs), A * ((A + 1) - (A - 1) * cs - beta)],
            a: [(A + 1) + (A - 1) * cs + beta, -2 * ((A - 1) + (A + 1) * cs), (A + 1) + (A - 1) * cs - beta],
        };
        case "HS": return {
            b: [A * ((A + 1) + (A - 1) * cs + beta), -2 * A * ((A - 1) + (A + 1) * cs), A * ((A + 1) + (A - 1) * cs - beta)],
            a: [(A + 1) - (A - 1) * cs + beta, 2 * ((A - 1) - (A + 1) * cs), (A + 1) - (A - 1) * cs - beta],
        };
    }
}

const FILTER_NAMES: Record<FilterKind, string> = {
    PK: "Cloche", LP: "Passe-bas", HP: "Passe-haut", BP: "Passe-bande", NO: "Coupe-bande", AP: "Passe-tout", LS: "Shelf grave", HS: "Shelf aigu",
};

function parseFilter(params: string, sel: Ch): { stage?: ApoStage; summary: string; off?: boolean; warning?: string; } {
    const p = params.replace(/,/g, ".");
    const head = /^\s*(ON|OFF)\s+([A-Za-z]+)(.*)$/i.exec(p);
    if (!head) return { summary: params.trim(), warning: "filtre illisible" };
    const off = head[1].toUpperCase() === "OFF";
    const name = head[2].toUpperCase();
    const rest = head[3];

    if (name === "NONE") return { summary: "aucun", off: true };
    if (name === "IIR") {
        const m = new RegExp("Order\\s+(\\d+)\\s+Coefficients\\s+(.*)$", "i").exec(rest);
        if (!m) return { summary: "IIR", warning: "IIR : « Order n Coefficients … » attendu" };
        const order = Number(m[1]);
        const c = (m[2].match(new RegExp(NUM, "g")) ?? []).map(num);
        if (order < 1 || order > 8 || c.length !== 2 * (order + 1) || c.some(Number.isNaN)) {
            return { summary: `IIR ordre ${order}`, warning: `IIR : ${2 * (order + 1)} coefficients attendus (ordre 1 à 8)` };
        }
        return {
            summary: `IIR ordre ${order}`, off,
            stage: off ? undefined : { t: "iir", ch: [...sel], b: c.slice(0, order + 1), a: c.slice(order + 1) },
        };
    }

    const kind = KINDS[name];
    if (!kind) return { summary: name, warning: `type de filtre inconnu « ${name} »` };
    const shelf = kind === "LS" || kind === "HS";
    const get = (re: string) => {
        const m = new RegExp(re, "i").exec(rest);
        return m ? num(m[1]) : undefined;
    };
    // Pente juste après le type : « LS 6dB », « LSC 12 dB ».
    const slope = shelf ? new RegExp(`^\\s*${NUM}\\s*dB`, "i").exec(rest) : null;
    const fc = get(`Fc\\s*${NUM}`);
    const gain = get(`Gain\\s*${NUM}`);
    const q = get(`\\bQ\\s*${NUM}`);
    const bw = get(`BW\\s*Oct\\s*${NUM}`);

    if (fc === undefined || Number.isNaN(fc) || fc <= 0) return { summary: FILTER_NAMES[kind], warning: "fréquence (Fc) manquante" };
    if (fc >= APO_RATE * 0.49) return { summary: `${FILTER_NAMES[kind]} ${fmtHz(fc)}`, warning: "fréquence trop haute pour 48 kHz" };
    const needsGain = kind === "PK" || shelf;
    if (needsGain && (gain === undefined || Number.isNaN(gain))) return { summary: `${FILTER_NAMES[kind]} ${fmtHz(fc)}`, warning: "gain manquant" };
    if ((kind === "PK" || kind === "AP") && q === undefined && bw === undefined) {
        return { summary: `${FILTER_NAMES[kind]} ${fmtHz(fc)}`, warning: "Q ou BW manquant" };
    }

    const opt: { q?: number; bw?: number; s?: number; corner?: boolean; } = {};
    if (shelf) {
        if (slope) opt.s = num(slope[1]) / 12;
        else if (q !== undefined) opt.q = q;
        // LS / HS (sans « C ») : Fc est une fréquence de coin si une valeur est donnée.
        opt.corner = !name.endsWith("C") && (slope !== null || q !== undefined || bw !== undefined);
    } else {
        if (bw !== undefined) opt.bw = bw;
        else if (q !== undefined) opt.q = q;
        else if (kind === "NO") opt.q = 30;
    }
    if ((opt.q !== undefined && !(opt.q > 0)) || (opt.bw !== undefined && !(opt.bw > 0)) || (opt.s !== undefined && !(opt.s > 0))) {
        return { summary: `${FILTER_NAMES[kind]} ${fmtHz(fc)}`, warning: "Q, BW ou pente invalide" };
    }
    const g = needsGain ? gain! : 0;
    const { b, a } = biquad(kind, fc, g, opt);
    const detail = [fmtHz(fc), needsGain ? fmtDb(g) : "", opt.q !== undefined ? `Q ${+opt.q.toFixed(3)}` : opt.bw !== undefined ? `BW ${opt.bw} oct` : slope ? `${num(slope[1])} dB/oct` : ""]
        .filter(Boolean).join(" · ");
    return { summary: `${FILTER_NAMES[kind]} ${detail}`, off, stage: off ? undefined : { t: "iir", ch: [...sel], b, a } };
}

/** GraphicEQ : paires fréquence / gain (virgules décimales acceptées comme APO). */
function parseGraphic(params: string) {
    const text = params.includes(".") ? params : params.replace(/,/g, ".");
    const n = (text.match(/[-+0-9.eE]+/g) ?? []).map(num);
    const points: [number, number][] = [];
    for (let i = 0; i + 1 < n.length; i += 2) {
        if (n[i] > 0 && Number.isFinite(n[i + 1])) points.push([n[i], Math.max(-200, Math.min(200, n[i + 1]))]);
    }
    return points.sort((x, y) => x[0] - y[0]);
}

/** Copy : chaque « cible=terme+terme… », calculé à partir des anciennes valeurs. */
function parseCopy(params: string): { m: [number, number, number, number]; c: [number, number]; warning?: string; } {
    const m: [number, number, number, number] = [1, 0, 0, 1];
    const c: [number, number] = [0, 0];
    const warnings: string[] = [];
    for (const assignment of params.trim().split(/\s+/).filter(Boolean)) {
        const eq = assignment.indexOf("=");
        const target = eq > 0 ? channelIndex(assignment.slice(0, eq)) : null;
        if (target === null) {
            warnings.push(`« ${assignment} » : seuls L et R existent ici`);
            continue;
        }
        const row = [0, 0];
        let constant = 0;
        // Découpe sur « + » (sauf l'exposant « e+ »).
        for (const term of assignment.slice(eq + 1).split(/(?<![eE])\+/).filter(Boolean)) {
            const star = term.lastIndexOf("*");
            if (star < 0) {
                if (term.includes(".")) constant += num(term) || 0;
                else {
                    const src = channelIndex(term);
                    if (src === null) warnings.push(`canal « ${term} » absent`);
                    else row[src] += 1;
                }
                continue;
            }
            const fac = term.slice(0, star), src = channelIndex(term.slice(star + 1));
            const db = /^(.*?)\s*dB$/i.exec(fac);
            const factor = db ? Math.pow(10, num(db[1]) / 20) : num(fac);
            if (src === null || !Number.isFinite(factor)) {
                warnings.push(`terme « ${term} » ignoré`);
                continue;
            }
            row[src] += factor;
        }
        m[target * 2] = row[0];
        m[target * 2 + 1] = row[1];
        c[target] = constant;
    }
    return { m, c, warning: warnings.length ? warnings.join(" ; ") : undefined };
}

const IGNORED: Record<string, string> = {
    INCLUDE: "Include : colle directement le contenu du fichier",
    DEVICE: "Device : inutile ici (low-musical a sa propre sortie)",
    STAGE: "Stage : inutile ici",
    IF: "conditions (If) : non prises en charge",
    ELSEIF: "conditions : non prises en charge",
    ELSE: "conditions : non prises en charge",
    ENDIF: "conditions : non prises en charge",
    EVAL: "expressions (Eval) : non prises en charge",
    VSTPLUGIN: "plugins VST : pas encore",
    LOUDNESSCORRECTION: "Loudness correction : pas encore",
};

/** Lit un set Equalizer APO. */
export function parseApo(text: string, irs: ApoIr[] = []): ApoParse {
    const stages: ApoStage[] = [];
    const lines: ApoLine[] = [];
    let sel: Ch = [true, true];

    text.split(/\r?\n/).forEach((raw, i) => {
        const line = raw.trim();
        if (!line || line.startsWith("#")) return;
        const colon = line.indexOf(":");
        if (colon < 0) return;
        const command = line.slice(0, colon).trim().replace(/\s+\d+$/, "").toUpperCase();
        const params = line.slice(colon + 1);
        const at = i + 1;
        if (params.includes("`")) {
            lines.push({ line: at, kind: command, summary: params.trim(), warning: "expressions entre ` ` : non prises en charge" });
            return;
        }

        switch (command) {
            case "PREAMP": {
                const m = new RegExp(`^\\s*${NUM}\\s*dB`, "i").exec(params.replace(/,/g, "."));
                if (!m) {
                    lines.push({ line: at, kind: "Preamp", summary: params.trim(), warning: "« -6 dB » attendu" });
                    return;
                }
                const g = Math.max(-200, Math.min(200, num(m[1])));
                stages.push({ t: "gain", db: [sel[0] ? g : 0, sel[1] ? g : 0] });
                lines.push({ line: at, kind: "Preamp", summary: fmtDb(g) });
                return;
            }
            case "FILTER": {
                const f = parseFilter(params, sel);
                if (f.stage) stages.push(f.stage);
                lines.push({ line: at, kind: "Filter", summary: f.summary, off: f.off, warning: f.warning });
                return;
            }
            case "GRAPHICEQ": {
                const points = parseGraphic(params);
                if (!points.length) {
                    lines.push({ line: at, kind: "GraphicEQ", summary: "vide", warning: "aucun point" });
                    return;
                }
                stages.push({ t: "graphic", ch: [...sel], points });
                lines.push({ line: at, kind: "GraphicEQ", summary: `${points.length} points · ${fmtHz(points[0][0])} → ${fmtHz(points[points.length - 1][0])}` });
                return;
            }
            case "CHANNEL": {
                const tokens = params.trim().split(/\s+/).filter(Boolean);
                if (tokens.some(t => t.toLowerCase() === "all")) sel = [true, true];
                else {
                    const next: Ch = [false, false];
                    for (const t of tokens) {
                        const c = channelIndex(t);
                        if (c !== null) next[c] = true;
                    }
                    sel = next;
                }
                const names = sel[0] && sel[1] ? "L R" : sel[0] ? "L" : sel[1] ? "R" : "aucun";
                lines.push({
                    line: at, kind: "Channel", summary: names,
                    warning: !sel[0] && !sel[1] ? "aucun canal stéréo (L, R) choisi : les lignes suivantes ne font rien" : undefined,
                });
                return;
            }
            case "COPY": {
                const { m, c, warning } = parseCopy(params);
                stages.push({ t: "copy", m, c });
                lines.push({ line: at, kind: "Copy", summary: params.trim(), warning });
                return;
            }
            case "DELAY": {
                const p = params.replace(/,/g, ".");
                const m = new RegExp(`^\\s*${NUM}\\s*(ms|samples?)`, "i").exec(p);
                if (!m) {
                    lines.push({ line: at, kind: "Delay", summary: params.trim(), warning: "« 10 ms » ou « 480 samples » attendu" });
                    return;
                }
                const samples = m[2].toLowerCase() === "ms" ? num(m[1]) * APO_RATE / 1000 : num(m[1]);
                if (!(samples >= 0) || samples > APO_RATE * 2) {
                    lines.push({ line: at, kind: "Delay", summary: params.trim(), warning: "retard entre 0 et 2 s" });
                    return;
                }
                stages.push({ t: "delay", ch: [...sel], samples: Math.round(samples) });
                lines.push({ line: at, kind: "Delay", summary: `${+(samples / APO_RATE * 1000).toFixed(2)} ms` });
                return;
            }
            case "CONVOLUTION": {
                // Nom du fichier seul (APO accepte un chemin relatif ou absolu).
                const wanted = params.trim().replace(/^["']|["']$/g, "");
                const base = wanted.split(/[\\/]/).pop()!.toLowerCase();
                const ir = irs.find(i => i.name.toLowerCase() === base);
                if (!ir) {
                    lines.push({ line: at, kind: "Convolution", summary: wanted, warning: `importe « ${base} » dans « Réponses impulsionnelles »` });
                    return;
                }
                stages.push({ t: "conv", ch: [...sel], ir: ir.file, name: ir.name });
                lines.push({ line: at, kind: "Convolution", summary: ir.name });
                return;
            }
            default: {
                const name = line.slice(0, colon).trim();
                lines.push({ line: at, kind: name, summary: params.trim(), warning: IGNORED[command] ?? "commande inconnue : ignorée" });
            }
        }
    });
    return { stages, lines };
}

// ── Courbe de réponse (pour l'affichage) ────────────────────────────────────

/** Module (dB) d'un filtre IIR à la fréquence f. */
function iirDb(b: number[], a: number[], f: number) {
    const w = 2 * Math.PI * f / APO_RATE;
    let nr = 0, ni = 0, dr = 0, di = 0;
    for (let k = 0; k < b.length; k++) {
        nr += b[k] * Math.cos(k * w);
        ni -= b[k] * Math.sin(k * w);
    }
    for (let k = 0; k < a.length; k++) {
        dr += a[k] * Math.cos(k * w);
        di -= a[k] * Math.sin(k * w);
    }
    return 10 * Math.log10((nr * nr + ni * ni) / Math.max(1e-30, dr * dr + di * di));
}

/** Gain du GraphicEQ à f (linéaire en dB sur échelle log, bords gardés). */
export function graphicDb(points: [number, number][], f: number) {
    if (!points.length) return 0;
    if (f <= points[0][0]) return points[0][1];
    const last = points[points.length - 1];
    if (f >= last[0]) return last[1];
    let i = 1;
    while (i < points.length && points[i][0] <= f) i++;
    const [fa, ga] = points[i - 1], [fb, gb] = points[i];
    if (ga === gb || fb <= fa) return ga;
    return ga + (gb - ga) * (Math.log(f / fa) / Math.log(fb / fa));
}

/**
 * Réponse de chaque canal (dB) aux fréquences données. Les mélanges (Copy)
 * sont suivis en supposant un signal identique sur L et R (mono).
 */
export function apoResponse(stages: ApoStage[], freqs: number[], irResponse?: (file: string) => [number[], number[]] | undefined): [number[], number[]] {
    const out: [number[], number[]] = [[], []];
    for (const [fi, f] of freqs.entries()) {
        // Amplitudes (linéaires) de L et R pour une entrée mono de 1.
        let amp: [number, number] = [1, 1];
        for (const s of stages) {
            switch (s.t) {
                case "gain":
                    amp = [amp[0] * Math.pow(10, s.db[0] / 20), amp[1] * Math.pow(10, s.db[1] / 20)];
                    break;
                case "iir": {
                    const g = Math.pow(10, iirDb(s.b, s.a, f) / 20);
                    amp = [s.ch[0] ? amp[0] * g : amp[0], s.ch[1] ? amp[1] * g : amp[1]];
                    break;
                }
                case "graphic": {
                    const g = Math.pow(10, graphicDb(s.points, f) / 20);
                    amp = [s.ch[0] ? amp[0] * g : amp[0], s.ch[1] ? amp[1] * g : amp[1]];
                    break;
                }
                case "copy":
                    amp = [Math.abs(s.m[0] * amp[0] + s.m[1] * amp[1]), Math.abs(s.m[2] * amp[0] + s.m[3] * amp[1])];
                    break;
                case "delay":
                    break;
                case "conv": {
                    // Module de l'IR (calculé à part), s'il est déjà connu.
                    const resp = irResponse?.(s.ir);
                    if (!resp) break;
                    amp = [
                        s.ch[0] ? amp[0] * Math.pow(10, resp[0][fi] / 20) : amp[0],
                        s.ch[1] ? amp[1] * Math.pow(10, resp[1][fi] / 20) : amp[1],
                    ];
                    break;
                }
            }
        }
        out[0].push(20 * Math.log10(Math.max(1e-6, amp[0])));
        out[1].push(20 * Math.log10(Math.max(1e-6, amp[1])));
    }
    return out;
}

/** Bascule ON ↔ OFF un filtre (numéro de ligne, 1 = première). */
export function toggleFilterLine(text: string, line: number) {
    const rows = text.split(/\r?\n/);
    const row = rows[line - 1];
    if (row === undefined) return text;
    rows[line - 1] = /:\s*ON\b/i.test(row) ? row.replace(/(:\s*)ON\b/i, "$1OFF") : row.replace(/(:\s*)OFF\b/i, "$1ON");
    return rows.join("\n");
}

/** Supprime une ligne (numéro de ligne, 1 = première). */
export function removeLine(text: string, line: number) {
    const rows = text.split(/\r?\n/);
    rows.splice(line - 1, 1);
    return rows.join("\n");
}

export const APO_EXAMPLE = `# Mini APO — même format qu'Equalizer APO (config.txt)
Preamp: -4 dB
Filter 1: ON LSC Fc 105 Hz Gain 4.0 dB Q 0.70
Filter 2: ON PK Fc 2500 Hz Gain -2.5 dB Q 1.40
Filter 3: ON HSC Fc 10000 Hz Gain 3.0 dB Q 0.70
`;

// ── Réponse d'une IR (pour la courbe) ───────────────────────────────────────

/** FFT en place (radix 2), taille puissance de 2. */
function fft(re: Float64Array, im: Float64Array) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            [re[i], re[j]] = [re[j], re[i]];
            [im[i], im[j]] = [im[j], im[i]];
        }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const ang = -2 * Math.PI / len;
        const wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
            let cr = 1, ci = 0;
            for (let k = 0; k < len / 2; k++) {
                const a = i + k, b = a + len / 2;
                const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
                const nr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = nr;
            }
        }
    }
}

/** Module (dB) d'une IR aux fréquences APO_FREQS, lissé au 1/12 d'octave. */
export function irMagnitude(samples: Float32Array): number[] {
    let n = 1;
    while (n < samples.length) n <<= 1;
    n = Math.max(n, 4096);
    const re = new Float64Array(n), im = new Float64Array(n);
    re.set(samples);
    fft(re, im);
    const power = new Float64Array(n / 2 + 1);
    for (let k = 0; k <= n / 2; k++) power[k] = re[k] * re[k] + im[k] * im[k];
    const bin = (f: number) => f * n / APO_RATE;
    return APO_FREQS.map(f => {
        const lo = Math.max(0, Math.floor(bin(f * Math.pow(2, -1 / 24))));
        const hi = Math.min(n / 2, Math.max(lo, Math.ceil(bin(f * Math.pow(2, 1 / 24)))));
        let sum = 0;
        for (let k = lo; k <= hi; k++) sum += power[k];
        return 10 * Math.log10(Math.max(1e-12, sum / (hi - lo + 1)));
    });
}
