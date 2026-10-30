/*
 * low-cord — vérifie qu'aucun plugin low-cord ne plante AU CHARGEMENT.
 *
 * Au démarrage de Discord, low-cord est chargé avant le code de Discord :
 * React, les stores (UserStore…) et les composants de @webpack/common
 * n'existent pas encore (undefined). Un plugin qui s'en sert dès le
 * chargement de son fichier (et non dans une fonction) fait planter TOUT
 * low-cord. Ce script reproduit ces conditions et charge chaque plugin.
 *
 * Usage (depuis cord/) : node scripts/lowcord/check-startup.mjs
 */

// @ts-check

import { createRequire } from "module";
import { mkdtempSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");

// @webpack/common au démarrage : tout est encore undefined.
const COMMON_AT_STARTUP = `module.exports = new Proxy({}, { get: (t, p) => p === "__esModule" ? true : undefined });`;

// Le reste (API low-cord / Vencord) : objets permissifs, comme le vrai code
// qui ne dépend pas de Discord au chargement.
const PERMISSIVE = `
const handler = {
    get(t, p) {
        if (p === Symbol.toPrimitive) return () => "";
        if (p === "__esModule") return true;
        if (p === "then") return undefined;
        // definePlugin(x) => x ; ErrorBoundary.wrap(c) => composant ; etc.
        if (p === "default" || p === "definePlugin") return ident;
        if (p === "definePluginSettings") return def => ({ def, store: {}, use: () => ({}) });
        return proxy;
    },
    apply() { return proxy; },
    construct() { return proxy; },
    getPrototypeOf() { return catchAll; },
};
const proxy = new Proxy(function () {}, handler);
const catchAll = new Proxy({}, { get: (t, p) => handler.get(t, p) });
const ident = new Proxy(function (x) { return x; }, { get: (t, p) => handler.get(t, p), apply: (t, self, args) => args[0] });
module.exports = proxy;
`;

const pluginsDir = resolve("src/lowplugins");
const names = readdirSync(pluginsDir).filter(n => !n.startsWith("."));
const work = mkdtempSync(join(tmpdir(), "lc-startup-"));
let failures = 0;

for (const name of names) {
    const out = join(work, `${name}.cjs`);
    try {
        await esbuild.build({
            entryPoints: [join(pluginsDir, name)],
            bundle: true,
            format: "cjs",
            platform: "node",
            outfile: out,
            jsx: "automatic",
            logLevel: "silent",
            loader: { ".css": "empty", ".png": "empty" },
            plugins: [{
                name: "startup-stubs",
                setup(build) {
                    build.onResolve({ filter: /.*/ }, args => {
                        const p = args.path;
                        if (p === "@webpack/common") return { path: p, namespace: "common" };
                        if (p.startsWith(".") && !p.endsWith(".css")) return undefined;
                        if (p.endsWith(".css") || p.includes(".css?")) return { path: p, namespace: "empty" };
                        if (p.startsWith("@") || p.startsWith("~") || p.startsWith("file://") || p === "react" || p.startsWith("react/"))
                            return { path: p, namespace: "stub" };
                        return undefined;
                    });
                    build.onLoad({ filter: /.*/, namespace: "common" }, () => ({ contents: COMMON_AT_STARTUP, loader: "js" }));
                    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: PERMISSIVE, loader: "js" }));
                    build.onLoad({ filter: /.*/, namespace: "empty" }, () => ({ contents: "", loader: "js" }));
                }
            }]
        });
        globalThis.VencordNative ??= /** @type {any} */ ({ pluginHelpers: {} });
        require(out);
        console.log(`OK     ${name}`);
    } catch (e) {
        failures++;
        console.log(`PLANTE ${name} : ${e instanceof Error ? e.message : String(e)}`);
    }
}

console.log(failures ? `\n${failures} plugin(s) plantent au chargement : low-cord entier ne démarrerait pas.` : "\nAucun plugin ne plante au chargement.");
process.exit(failures ? 1 : 0);
