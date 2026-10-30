/*
 * low-cord — vérifie les patches des plugins low-cord contre le VRAI code de
 * Discord présent dans le cache HTTP local (aucun Discord à lancer).
 *
 * Pour chaque patch : le module est-il trouvé (find) ? chaque regex
 * accroche-t-elle ? le code patché reste-t-il du JS valide ?
 * Les modules absents du cache (chunks chargés à la demande) sont signalés
 * « invérifiable », pas « cassé ».
 *
 * Usage (depuis cord/) :
 *   node scripts/lowcord/verify-patches.mjs [Discord|DiscordCanary|DiscordPTB] [NomDuPlugin…]
 *
 * Outil de développement uniquement : n'est pas embarqué dans la dist.
 */

// @ts-check

import { createRequire } from "module";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const acorn = require(require.resolve("acorn", { paths: [resolve("node_modules/.pnpm/node_modules")] }));

const [, , branchArg = "Discord", ...onlyPlugins] = process.argv;
const cacheDir = join(process.env.APPDATA ?? "", branchArg.toLowerCase(), "Cache", "Cache_Data");
if (!existsSync(cacheDir)) {
    console.error(`Cache introuvable : ${cacheDir}`);
    process.exit(1);
}

// ── 1. Charger les plugins low-cord avec un runtime simulé ───────────────
const STUB = isTypes => `
const IS_TYPES = ${isTypes};
const handler = {
    get(t, p) {
        if (p === Symbol.toPrimitive) return () => "";
        if (p === "__esModule") return true;
        if (p === "then") return undefined;
        if (p === "definePlugin" || (p === "default" && IS_TYPES)) return x => x;
        if (p === "definePluginSettings") return def => ({ def, store: Object.fromEntries(Object.entries(def).map(([k, v]) => [k, v?.default ?? v?.options?.find?.(o => o.default)?.value])), use: () => ({}) });
        return proxy;
    },
    apply() { return proxy; },
    construct() { return proxy; },
    // esbuild (__toESM) recopie le module dans un objet qui hérite de son prototype :
    // un prototype « attrape-tout » rend n'importe quel export nommé disponible.
    getPrototypeOf() { return catchAll; },
};
const proxy = new Proxy(function () {}, handler);
const catchAll = new Proxy({}, { get: (t, p) => handler.get(t, p) });
module.exports = proxy;
`;

const realFiles = {
    "@utils/patches": resolve("src/utils/patches.ts"),
    "@utils/intlHash": resolve("src/utils/intlHash.ts"),
};

const pluginsDir = resolve("src/lowplugins");
const pluginNames = readdirSync(pluginsDir).filter(n => !n.startsWith("."));
// Plugins du cœur propres à low-cord : leurs patches sont vérifiés aussi.
const CORE_PLUGINS = ["lowcordOptimizer.ts", "lowcordInterface.ts", "lowcordHeaderBar.ts"].map(f => resolve("src/plugins/_core", f).replaceAll("\\", "/"));
const entry = `
export { canonicalizeMatch, canonicalizeReplace } from "@utils/patches";
${pluginNames.map((n, i) => `import p${i} from "@lowplugins/${n}"; export const plugin_${i} = p${i};`).join("\n")}
${CORE_PLUGINS.map((f, i) => `import c${i} from ${JSON.stringify(f)}; export const plugin_core${i} = c${i};`).join("\n")}
`;

const work = mkdtempSync(join(tmpdir(), "lc-verify-"));
const out = join(work, "bundle.cjs");

await esbuild.build({
    stdin: { contents: entry, resolveDir: resolve("."), loader: "ts" },
    bundle: true,
    format: "cjs",
    platform: "node",
    outfile: out,
    jsx: "automatic",
    logLevel: "silent",
    loader: { ".css": "empty" },
    plugins: [{
        name: "lowcord-stubs",
        setup(build) {
            build.onResolve({ filter: /.*/ }, args => {
                const p = args.path;
                if (realFiles[p]) return { path: realFiles[p] };
                if (p.startsWith("@lowplugins/")) return { path: resolveTs(join(pluginsDir, p.slice("@lowplugins/".length))) };
                if (p === "@intrnl/xxhash64") return undefined;
                if (p.startsWith(".") && !p.endsWith(".css")) return undefined;
                if (p.endsWith(".css")) return { path: p, namespace: "empty" };
                if (p.startsWith("@") || p.startsWith("~") || p === "react" || p.startsWith("react/")) {
                    return { path: p, namespace: p === "@utils/types" ? "types-stub" : "stub" };
                }
                return undefined;
            });
            build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: STUB(false), loader: "js" }));
            build.onLoad({ filter: /.*/, namespace: "types-stub" }, () => ({ contents: STUB(true), loader: "js" }));
            build.onLoad({ filter: /.*/, namespace: "empty" }, () => ({ contents: "", loader: "js" }));
        }
    }]
});

function resolveTs(base) {
    for (const ext of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
        if (existsSync(base + ext) && (ext || !existsSync(join(base, "index.ts")) && !existsSync(join(base, "index.tsx")))) {
            if (ext === "" && existsSync(join(base, "index.tsx"))) return join(base, "index.tsx");
            if (ext === "" && existsSync(join(base, "index.ts"))) return join(base, "index.ts");
            if (ext !== "") return base + ext;
        }
    }
    return base;
}

// Les plugins avec une partie native lisent VencordNative au chargement.
globalThis.VencordNative ??= /** @type {any} */ ({ pluginHelpers: {} });
const bundle = require(out);
const { canonicalizeMatch, canonicalizeReplace } = bundle;
const plugins = Object.keys(bundle).filter(k => k.startsWith("plugin_")).map(k => bundle[k])
    .filter(p => p?.patches?.length && (!onlyPlugins.length || onlyPlugins.includes(p.name)));

// ── 2. Extraire les modules webpack réels du cache ───────────────────────
const modules = new Map();
for (const f of readdirSync(cacheDir)) {
    if (!f.startsWith("f_")) continue;
    let src;
    try {
        src = readFileSync(join(cacheDir, f)).toString("utf8");
    } catch {
        continue; // fichier supprimé par Discord pendant la lecture
    }
    if (!src.includes("(e,t,n){") || src.length < 100_000) continue;
    let ast;
    try {
        ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "script" });
    } catch {
        continue;
    }
    collectModules(ast, src);
}

function collectModules(node, src) {
    const stack = [node];
    while (stack.length) {
        const n = stack.pop();
        if (!n || typeof n.type !== "string") continue;
        if (n.type === "ObjectExpression" && n.properties.length > 20 &&
            n.properties.every(p => p.type === "Property" && p.key && (p.key.type === "Literal" ? typeof p.key.value === "number" : /^\d+$/.test(p.key.name ?? "")))) {
            for (const p of n.properties) {
                const id = String(p.key.value ?? p.key.name);
                // String(factory) côté Discord = texte de la méthode / fonction.
                const code = p.method ? src.slice(p.start, p.end) : src.slice(p.value.start, p.value.end);
                modules.set(id, code);
            }
            continue;
        }
        for (const key in n) {
            const v = n[key];
            if (Array.isArray(v)) for (const c of v) stack.push(c);
            else if (v && typeof v === "object" && typeof v.type === "string") stack.push(v);
        }
    }
}

function parses(code) {
    try {
        acorn.parse(`(${/^\d/.test(code) ? `{${code}}` : code})`, { ecmaVersion: "latest" });
        return true;
    } catch {
        return false;
    }
}

// ── 3. Appliquer ─────────────────────────────────────────────────────────
console.log(`Cache ${branchArg} : ${modules.size} modules\n`);
let ok = 0, broken = 0, unknown = 0;

for (const plugin of plugins) {
    console.log(`■ ${plugin.name}`);
    plugin.patches.forEach((patch, i) => {
        const find = canonicalizeMatch(patch.find);
        const matchesFind = code => (typeof find === "string" ? code.includes(find) : find.test(code));
        const found = [...modules].filter(([, code]) => matchesFind(code));
        const label = `  #${i + 1} find ${String(patch.find).slice(0, 60)}`;

        if (!found.length) {
            unknown++;
            console.log(`${label}\n     ? module absent du cache (invérifiable)`);
            return;
        }

        const targets = patch.all ? found : found.slice(0, 1);
        const replacements = Array.isArray(patch.replacement) ? patch.replacement : [patch.replacement];
        const notes = [];
        let patchOk = true;

        for (const [id, original] of targets) {
            let code = original;
            const before = parses(code);
            replacements.forEach((r, j) => {
                const match = canonicalizeMatch(r.match);
                const replace = canonicalizeReplace(r.replace, `Vencord.Plugins.plugins[${JSON.stringify(plugin.name)}]`);
                const count = typeof match === "string" ? (code.includes(match) ? 1 : 0) : (code.match(new RegExp(match.source, match.flags.includes("g") ? match.flags : match.flags + "g")) ?? []).length;
                let next = code;
                try {
                    next = code.replace(match, replace);
                } catch (e) {
                    notes.push(`r${j + 1} ERREUR replace: ${e instanceof Error ? e.message : String(e)}`);
                    patchOk = false;
                    return;
                }
                if (next === code) {
                    notes.push(`r${j + 1} ✗ ne matche pas`);
                    patchOk = false;
                } else {
                    notes.push(`r${j + 1} ✓ ${count} match${count > 1 ? "es" : ""}`);
                    code = next;
                }
            });
            if (before && !parses(code)) {
                notes.push(`module ${id} : ✗ JS INVALIDE après patch`);
                patchOk = false;
            }
        }

        if (found.length > 1 && !patch.all) notes.push(`(find trouvé dans ${found.length} modules, seul le 1er est patché)`);
        if (patchOk) ok++; else broken++;
        console.log(`${label}\n     ${patchOk ? "OK" : "CASSÉ"} — ${notes.join(" · ")}`);
    });
    console.log("");
}

console.log(`Résultat : ${ok} OK · ${broken} cassé(s) · ${unknown} invérifiable(s)`);
writeFileSync(join(work, "done"), "");
