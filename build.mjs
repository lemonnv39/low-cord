// Construit fr-ngrams.bin (fréquences des mots et des paires de mots du
// français parlé) à partir du corpus OpenSubtitles 2018 (OPUS), lu en flux.
//
// Format (petit-boutiste) :
//   "LCNG" | version u32 | V u32 | B u32
//   longueur u32 + vocabulaire utf8 (mots séparés par \n ; 0 = <s>, 1 = </s>)
//   unigrammes : V × u32 (comptes)
//   lignes CSR : (V+1) × u32 (début des paires de chaque mot)
//   colonnes   : B × u32 (2ᵉ mot)
//   comptes    : B × u16 (round(ln(compte) × 1000))
import https from "https";
import zlib from "zlib";
import fs from "fs";
import readline from "readline";

const URL = "https://object.pouta.csc.fi/OPUS-OpenSubtitles/v2018/mono/fr.txt.gz";
const MAX_LINES = Number(process.env.MAX_LINES ?? 45_000_000);
const OUT = process.argv[2] ?? "fr-ngrams.bin";
const VOCAB = 150_000;
const MIN_UNI = 3;
const MIN_BI = 2;

export const tokenize = s => s.toLowerCase().replace(/[’`´]/g, "'").match(/\p{L}+'?/gu) ?? [];

const ids = new Map([["<s>", 0], ["</s>", 1]]);
const words = ["<s>", "</s>"];
let uni = new Float64Array(1 << 20);
const id = w => {
    let i = ids.get(w);
    if (i === undefined) {
        i = words.length;
        ids.set(w, i);
        words.push(w);
        if (i >= uni.length) { const n = new Float64Array(uni.length * 2); n.set(uni); uni = n; }
    }
    return i;
};
let bi = new Map();
const SHIFT = 2 ** 23;
let lines = 0, tokens = 0, prunes = 0;

function addSentence(toks) {
    if (!toks.length) return;
    let prev = 0;
    uni[0]++;
    for (const t of toks) {
        const i = id(t);
        uni[i]++;
        const k = prev * SHIFT + i;
        bi.set(k, (bi.get(k) ?? 0) + 1);
        prev = i;
        tokens++;
    }
    const k = prev * SHIFT + 1;
    bi.set(k, (bi.get(k) ?? 0) + 1);
    uni[1]++;
}

// Élagage au fil de l'eau : les paires vues une seule fois disparaissent (comptage « avec pertes »).
function prune() {
    for (const [k, v] of bi) if (v <= 1) bi.delete(k);
    prunes++;
}

const started = Date.now();
await new Promise((resolve, reject) => {
    const req = https.get(URL, res => {
        const gz = res.pipe(zlib.createGunzip());
        const rl = readline.createInterface({ input: gz, crlfDelay: Infinity });
        rl.on("line", line => {
            lines++;
            // Une ligne de sous-titre peut contenir plusieurs phrases.
            for (const part of line.split(/(?<=[.!?…])\s+/)) addSentence(tokenize(part.replace(/^[-–—\s]+/, "")));
            if (bi.size > 22_000_000) prune();
            if (lines % 2_000_000 === 0) console.log(`${lines / 1e6}M lignes, ${(tokens / 1e6).toFixed(0)}M mots, ${(bi.size / 1e6).toFixed(1)}M paires, ${((Date.now() - started) / 60000).toFixed(1)} min`);
            if (lines >= MAX_LINES) { rl.close(); req.destroy(); resolve(); }
        });
        rl.on("close", resolve);
        gz.on("error", e => (lines >= MAX_LINES ? resolve() : reject(e)));
    });
    req.on("error", e => (lines >= MAX_LINES ? resolve() : reject(e)));
});
console.log(`lecture terminée : ${lines} lignes, ${tokens} mots, ${words.length} mots distincts`);

// Vocabulaire : <s>, </s>, puis les mots les plus fréquents.
const order = [];
for (let i = 2; i < words.length; i++) if (uni[i] >= MIN_UNI) order.push(i);
order.sort((a, b) => uni[b] - uni[a]);
const kept = [0, 1, ...order.slice(0, VOCAB)];
const newId = new Map(kept.map((old, n) => [old, n]));
const V = kept.length;

// Paires gardées : les deux mots dans le vocabulaire, vues au moins MIN_BI fois.
const rows = Array.from({ length: V }, () => []);
for (const [k, c] of bi) {
    if (c < MIN_BI) continue;
    const a = newId.get(Math.floor(k / SHIFT)), b = newId.get(k % SHIFT);
    if (a === undefined || b === undefined) continue;
    rows[a].push([b, c]);
}
let B = 0;
for (const r of rows) { r.sort((x, y) => x[0] - y[0]); B += r.length; }

const vocabBuf = Buffer.from(kept.map(o => words[o]).join("\n"), "utf8");
const head = Buffer.alloc(16);
head.write("LCNG", 0, "ascii");
head.writeUInt32LE(1, 4);
head.writeUInt32LE(V, 8);
head.writeUInt32LE(B, 12);
const vlen = Buffer.alloc(4); vlen.writeUInt32LE(vocabBuf.length);
const uniArr = new Uint32Array(V);
kept.forEach((o, n) => { uniArr[n] = Math.min(uni[o], 0xffffffff); });
const rowStart = new Uint32Array(V + 1), cols = new Uint32Array(B), cnts = new Uint16Array(B);
let p = 0;
rows.forEach((r, a) => {
    rowStart[a] = p;
    for (const [b, c] of r) { cols[p] = b; cnts[p] = Math.min(65535, Math.round(Math.log(c) * 1000)); p++; }
});
rowStart[V] = p;
const pad = n => Buffer.alloc((4 - (n % 4)) % 4);
const parts = [head, vlen, vocabBuf, pad(vocabBuf.length), Buffer.from(uniArr.buffer), Buffer.from(rowStart.buffer), Buffer.from(cols.buffer), Buffer.from(cnts.buffer)];
fs.writeFileSync(OUT, Buffer.concat(parts));
console.log(`écrit ${OUT} : V=${V}, B=${B}, ${(fs.statSync(OUT).size / 1e6).toFixed(1)} Mo, élagages=${prunes}, ${((Date.now() - started) / 60000).toFixed(1)} min`);
