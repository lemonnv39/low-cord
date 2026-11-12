/*
 * low-cord — télécharge le build web actuel de Discord (les scripts de la
 * page + tous les morceaux chargés à la demande) dans un dossier, en simple
 * texte : rien n'est exécuté.
 *
 * Sert à verify-patches.mjs : le cache HTTP local ne contient que les modules
 * déjà chargés par TON Discord, alors qu'un patch peut viser un module chargé
 * à la demande. Avec le build complet, chaque patch est vérifiable.
 *
 * Usage (depuis cord/) :
 *   node scripts/lowcord/fetch-discord-build.mjs <dossier> [stable|canary|ptb]
 *   LC_CODE_DIR=<dossier> node scripts/lowcord/verify-patches.mjs
 *
 * Outil de développement uniquement : n'est pas embarqué dans la dist.
 */

// @ts-check

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const [, , out, channel = "stable"] = process.argv;
if (!out) {
    console.error("Usage : node scripts/lowcord/fetch-discord-build.mjs <dossier> [stable|canary|ptb]");
    process.exit(1);
}
const host = { stable: "discord.com", canary: "canary.discord.com", ptb: "ptb.discord.com" }[channel];
if (!host) {
    console.error(`Canal inconnu : ${channel}`);
    process.exit(1);
}
mkdirSync(out, { recursive: true });

const HEADERS = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" };

/** Texte d'un fichier du build (repris du dossier s'il y est déjà). */
async function get(name) {
    const path = join(out, name);
    if (existsSync(path)) return readFileSync(path, "utf8");
    for (let attempt = 0; ; attempt++) {
        try {
            const res = await fetch(`https://${host}/assets/${name}`, { headers: HEADERS });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const text = await res.text();
            writeFileSync(path, text);
            return text;
        } catch (e) {
            if (attempt >= 3) throw new Error(`${name} : ${e instanceof Error ? e.message : e}`);
            await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        }
    }
}

const html = await (await fetch(`https://${host}/app`, { headers: HEADERS })).text();
const entries = [...new Set([...html.matchAll(/(?:src|href)="\/assets\/([\w.-]+\.js)"/g)].map(m => m[1]))];
if (!entries.length) {
    console.error("Aucun script trouvé dans la page de Discord.");
    process.exit(1);
}

// La table des morceaux est dans le script qui porte le chargeur webpack :
//   if(123===e)return""+e+".<hash>.js"   (morceaux nommés)
//   ({123:"<hash>",…})[e]+".js"           (tous les autres)
const chunks = new Set();
for (const entry of entries) {
    const src = await get(entry);
    const start = src.indexOf(".u=e=>");
    if (start < 0) continue;
    for (const m of src.slice(start, start + 3_000_000).matchAll(/if\((\d+)===e\)return""\+e\+"\.([0-9a-f]+)\.js"/g)) chunks.add(`${m[1]}.${m[2]}.js`);
    let last = start;
    for (; ;) {
        const next = src.indexOf('.js";', last + 1);
        if (next < 0 || next - last > 400) break;
        last = next;
    }
    const open = src.indexOf("{", last), close = src.indexOf("}", open);
    for (const m of src.slice(open, close).matchAll(/(\d+):"([0-9a-f]+)"/g)) chunks.add(`${m[2]}.js`);
}

const queue = [...chunks];
let failed = 0;
await Promise.all(Array.from({ length: 24 }, async () => {
    while (queue.length) {
        try {
            await get(/** @type {string} */(queue.shift()));
        } catch {
            failed++;
        }
    }
}));

console.log(`Build Discord (${channel}) : ${entries.length} scripts d'entrée, ${chunks.size} morceaux${failed ? `, ${failed} échec(s)` : ""} → ${out}`);
// Quelques morceaux manquants n'empêchent pas la vérification ; beaucoup, si.
if (failed > chunks.size * 0.02) process.exit(1);
