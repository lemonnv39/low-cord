/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Icônes : bundled at build time as base64 by the `file://` loader (scripts/build/
// common.mjs's fileUrlPlugin) — no extra asset-copy step needed, unlike
// Nightcord's original version which relied on a separate collect-assets.mjs
// script to place loose .ico files next to the exe after every build.
import { app, BrowserWindow, ipcMain, session, shell } from "electron";
import icon1 from "file://./icons/1.ico?base64";
import icon2 from "file://./icons/2.ico?base64";
import icon3 from "file://./icons/3.ico?base64";
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";

// MultiInstance — opens an account already saved in TokenImporter in its own
// Discord window, with its own session (persist:abyss-mi-{userId}).
//
// Unlike some implementations of this feature that use webSecurity:false and
// strip CSP globally, this version keeps Chromium's same-origin policy intact
// and grants mic/camera through a real permission handler scoped to this one
// session — no broad security relaxation just to make the window work.

const openWindows = new Map<string, BrowserWindow>();

const VALID_DOMAINS = new Set(["discord.com", "ptb.discord.com", "canary.discord.com"]);
const USER_ID = /^\d{15,22}$/;

const isDiscordUrl = (url: string) => {
    try {
        const u = new URL(url);
        return u.protocol === "https:" && VALID_DOMAINS.has(u.hostname);
    } catch {
        return false;
    }
};

// Journal de diagnostic (userData/abyss-mi-debug.log). Sert à comprendre les
// fenêtres bloquées en chargement sans DevTools : on y consigne les étapes et
// les erreurs de rendu de chaque instance (jamais le token). Silencieux,
// jamais fatal, et remis à zéro au-delà de 1 Mo pour ne pas grossir sans fin.
const LOG_MAX_BYTES = 1024 * 1024;
function miLog(...args: any[]): void {
    try {
        const file = join(app.getPath("userData"), "abyss-mi-debug.log");
        if (existsSync(file) && statSync(file).size > LOG_MAX_BYTES) writeFileSync(file, "");
        const parts = args.map(a => (typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()));
        appendFileSync(file, `[${new Date().toISOString()}] ${parts.join(" ")}\n`);
    } catch { }
}

// Écrit le token dans TOUS les storages possibles, en résistant au fait que
// Discord retire `window.localStorage` (anti-vol de token) : si l'accès direct
// échoue, on repasse par un iframe about:blank (même origine, storage vivant).
// Source d'une fonction (raw, home) à exécuter dans la page : le token est
// passé en argument, jamais collé dans un fichier.
const INJECT_FN = `function(raw, home){
    try {
        if (!raw || raw === "undefined") return;
        var q = JSON.stringify(raw);
        function setLS(k, v){
            try { window.localStorage.setItem(k, v); return true; } catch(e){}
            try {
                var f = document.createElement("iframe");
                f.style.display = "none";
                (document.body || document.documentElement).appendChild(f);
                f.contentWindow.localStorage.setItem(k, v);
                f.remove();
                return true;
            } catch(e){}
            return false;
        }
        setLS("token", q);
        setLS("default_token", q);
        if ((location.pathname.indexOf("/login") >= 0 || location.pathname === "/") && !window.__mi_redirected) {
            window.__mi_redirected = true;
            location.href = home;
        }
    } catch(e){}
}`;

const cleanToken = (token: string) => String(token || "").trim().replace(/^"+|"+$/g, "");
const injectCall = (token: string, home: string) => `(${INJECT_FN})(${JSON.stringify(cleanToken(token))}, ${JSON.stringify(home)});`;

// Rotates red → black → green → red... across successive detached instances,
// so each one is visually distinct from the main window (Discord's blue,
// Canary's yellow) AND from each other on the Windows taskbar — ported from
// Nightcord's multiInstance plugin, which does the exact same rotation.
const INSTANCE_ICONS = [icon1, icon2, icon3];
let iconCounter = 0;

// Windows derives the TASKBAR button's icon from the window's AppUserModelID
// registration (setAppDetails' appIconPath below), not from BrowserWindow's
// `icon` option alone — that one only covers the window's own title-bar/
// Alt-Tab icon. appIconPath needs a real file on disk, so the bundled base64
// gets written out once per icon, on first use, into userData.
const iconFilePaths = new Map<number, string>();

function instanceIconDir(): string {
    const dir = join(app.getPath("userData"), "abyss-mi-icons");
    mkdirSync(dir, { recursive: true });
    return dir;
}

function nextInstanceIconPath(): string | undefined {
    try {
        const index = iconCounter % INSTANCE_ICONS.length;
        iconCounter++;

        let filePath = iconFilePaths.get(index);
        if (!filePath || !existsSync(filePath)) {
            filePath = join(instanceIconDir(), `${index}.ico`);
            writeFileSync(filePath, Buffer.from(INSTANCE_ICONS[index], "base64"));
            iconFilePaths.set(index, filePath);
        }
        return filePath;
    } catch {
        return undefined;
    }
}

// Discord's own in-page titlebar (the min/maximize/close buttons Discord
// draws itself once frame:false hides the OS ones) controls the window via
// ipcRenderer.invoke("DISCORD_WINDOW_CLOSE" | "..._MINIMIZE" | "..._MAXIMIZE"
// | "..._RESTORE"), which Discord's core handles with a GLOBAL ipcMain
// handler that always resolves to the main window — click close on a
// detached instance and it closes the main Discord/Canary window instead.
// webContents.ipc.handle registers a handler local to just this sender,
// which Electron prioritizes over the global ipcMain one — so we intercept
// these same channels per-window and point them at `win` instead. Ported
// from Nightcord's multiInstance plugin, which hit and fixed this exact bug.
//
// Sans webContents.ipc (Electron < 17, pas le cas de Discord), on ne touche
// à rien : retirer les gestionnaires globaux de Discord pour les remplacer
// casserait les boutons de la fenêtre principale une fois l'instance fermée.
function registerWindowControlIpc(win: BrowserWindow): () => void {
    const wc = win.webContents as any; // webContents.ipc: Electron 17+
    if (!wc.ipc?.handle) {
        miLog("webContents.ipc indisponible : boutons de fenêtre non redirigés");
        return () => { };
    }

    const CLOSE = "DISCORD_WINDOW_CLOSE";
    const MINIMIZE = "DISCORD_WINDOW_MINIMIZE";
    const MAXIMIZE = "DISCORD_WINDOW_MAXIMIZE";
    const RESTORE = "DISCORD_WINDOW_RESTORE";

    const handleClose = () => { if (!win.isDestroyed()) win.close(); };
    const handleMinimize = () => { if (!win.isDestroyed()) win.minimize(); };
    const handleMaximize = () => {
        if (win.isDestroyed()) return;
        if (win.isMaximized()) win.unmaximize(); else win.maximize();
    };
    const handleRestore = () => { if (!win.isDestroyed()) win.restore(); };

    try {
        wc.ipc.handle(CLOSE, handleClose);
        wc.ipc.handle(MINIMIZE, handleMinimize);
        wc.ipc.handle(MAXIMIZE, handleMaximize);
        wc.ipc.handle(RESTORE, handleRestore);
    } catch (e) {
        miLog("window control ipc failed", String(e));
    }
    return () => {
        for (const ch of [CLOSE, MINIMIZE, MAXIMIZE, RESTORE]) {
            try { wc.ipc.removeHandler(ch); } catch { }
        }
    };
}

// ── Token remis au chargement, sans fichier ─────────────────────────────────
// Discord décide dès son démarrage s'il y a une session : le token doit être
// dans localStorage AVANT son JS, et de façon synchrone (une écriture
// asynchrone arrivait trop tard → écran /login). Plutôt que d'écrire un
// fichier .js contenant le token en clair (resté sur le disque si Discord
// plante), le préload — identique pour toutes les fenêtres, sans secret —
// demande le token au processus principal par un appel IPC synchrone. Seule
// une fenêtre ouverte par ce plugin reçoit une réponse.
const TOKEN_CHANNEL = "ABYSS_MI_GET_TOKEN";
const tokensByWebContents = new Map<number, { token: string; home: string; }>();

try {
    ipcMain.on(TOKEN_CHANNEL, event => {
        const entry = tokensByWebContents.get(event.sender.id);
        // Pendant le préload, l'adresse du cadre peut encore être vide : on
        // refuse seulement une page qui n'est clairement pas Discord.
        const url = event.senderFrame?.url ?? "";
        const allowed = !url || url === "about:blank" || isDiscordUrl(url);
        event.returnValue = entry && allowed ? entry : null;
    });
} catch (e) {
    console.error("[MultiInstance] token channel failed:", e);
}

const PRELOAD_SOURCE = [
    "// Abyss MultiInstance - token preload (synchronous, pre-bundle, no secret on disk)",
    "(function() {",
    "  try {",
    "    var electron = require('electron');",
    `    var entry = electron.ipcRenderer.sendSync(${JSON.stringify(TOKEN_CHANNEL)});`,
    "    if (!entry || !entry.token) return;",
    "    var Q = JSON.stringify(entry.token);",
    "    try { localStorage.setItem('token', Q); localStorage.setItem('default_token', Q); } catch(e) {}",
    "    try { if (window && window.localStorage) { window.localStorage.setItem('token', Q); window.localStorage.setItem('default_token', Q); } } catch(e) {}",
    // Réinjection main-world (au cas où) : même logique + redirection depuis /login.
    `    try { electron.webFrame.executeJavaScript("(" + ${JSON.stringify(INJECT_FN)} + ")(" + JSON.stringify(entry.token) + ", " + JSON.stringify(entry.home) + ");").catch(function(){}); } catch(e) {}`,
    "  } catch(e) {}",
    "})();",
].join("\n");

function preloadDir(): string {
    const dir = join(app.getPath("userData"), "abyss-mi-preloads");
    mkdirSync(dir, { recursive: true });
    return dir;
}

// Anciennes versions : un fichier par fenêtre, avec le token en clair. On les
// efface tous (aucune fenêtre d'instance n'est encore ouverte à ce stade).
function removeLegacyTokenPreloads() {
    try {
        const dir = join(app.getPath("userData"), "abyss-mi-preloads");
        if (!existsSync(dir)) return;
        for (const f of readdirSync(dir)) {
            if (/^token-preload-\d+\.js$/.test(f)) {
                try { unlinkSync(join(dir, f)); } catch { }
            }
        }
    } catch { }
}

let preloadPath: string | null = null;
function sharedPreload(): string {
    if (preloadPath && existsSync(preloadPath)) return preloadPath;
    removeLegacyTokenPreloads();
    preloadPath = join(preloadDir(), "instance-preload.js");
    writeFileSync(preloadPath, PRELOAD_SOURCE, "utf-8");
    return preloadPath;
}

if (app.isReady()) removeLegacyTokenPreloads();
else app.once("ready", removeLegacyTokenPreloads);

// Permission handler scoped to THIS session only — cleaner than stripping
// CSP/Permissions-Policy globally: mic and camera work without a prompt (like
// in the main window), nothing else is relaxed. Only Discord itself gets
// them, not a third-party page embedded in an iframe (activities, embeds).
const MEDIA_PERMISSIONS = new Set(["media", "microphone", "camera", "display-capture"]);
function grantMediaPermissions(ses: Electron.Session) {
    ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
        callback(MEDIA_PERMISSIONS.has(permission) && isDiscordUrl(details.requestingUrl ?? ""));
    });
    ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
        return MEDIA_PERMISSIONS.has(permission) && isDiscordUrl(requestingOrigin);
    });
}

export async function openInstanceWindow(
    _: any,
    token: string,
    userId: string,
    username = "",
    domain = "discord.com"
): Promise<{ ok: boolean; error?: string; }> {
    try {
        // L'id sert de nom de session et de clé : un vrai identifiant Discord
        // uniquement (rien qui puisse viser une autre session).
        if (typeof userId !== "string" || !USER_ID.test(userId)) return { ok: false, error: "invalid_user" };
        if (!cleanToken(token)) return { ok: false, error: "missing_token" };

        const existing = openWindows.get(userId);
        if (existing && !existing.isDestroyed()) {
            if (existing.isMinimized()) existing.restore();
            existing.show();
            existing.focus();
            return { ok: true };
        }

        const targetDomain = VALID_DOMAINS.has(domain) ? domain : "discord.com";
        const homeUrl = `https://${targetDomain}/channels/@me`;
        const label = String(username || userId).replace(/[\r\n]+/g, " ").slice(0, 64);

        const ses = session.fromPartition(`persist:abyss-mi-${userId}`, { cache: true });
        grantMediaPermissions(ses);

        // Block "browser handoff" — meaningless in a window already signed in
        // via token, and it could mix this instance up with the main window's
        // account.
        ses.webRequest.onBeforeRequest({ urls: ["*://discord.com/handoff*", "*://*.discord.com/handoff*"] }, (_d, cb) => cb({ cancel: true }));

        ses.setPreloads([sharedPreload()]);

        // Abyss's patched BrowserWindow constructor (src/main/patcher.ts) sees
        // any window with both a preload AND a title and overwrites
        // process.env.DISCORD_PRELOAD with whatever we passed as `preload`
        // (our own preload.js) — clobbering the *real* Discord core preload
        // path it held since the main window was created, which every window's
        // preload.js relies on to chain-load Discord's native bindings. Save
        // it now, restore it right after construction.
        const realDiscordPreload = process.env.DISCORD_PRELOAD;

        // Windows groups taskbar buttons by AppUserModelID, which normally
        // defaults to the running exe's — a plain new window would look like
        // just another Discord/Canary window under the same group and icon.
        // A unique id per window (set via setAppDetails below, right after
        // construction) keeps it fully separate.
        const uniqueAppId = `abyss.instance.${userId}.${Date.now()}`;
        const instanceIconPath = nextInstanceIconPath();

        let win: BrowserWindow;
        try {
            win = new BrowserWindow({
                width: 1280,
                height: 800,
                minWidth: 940,
                minHeight: 500,
                autoHideMenuBar: true,
                backgroundColor: "#313338",
                title: `Discord [${label}]`,
                // Discord draws its own title bar/window controls in-page — a
                // framed window on top of that doubled up the window chrome
                // (native OS titlebar + Discord's own). frame:false leaves only
                // Discord's own, same as Abyss's main window.
                frame: false,
                titleBarStyle: "hidden",
                icon: instanceIconPath,
                webPreferences: {
                    session: ses,
                    contextIsolation: true,
                    nodeIntegration: false,
                    sandbox: false,
                    // This file ships bundled into dist/desktop/patcher.js, right next
                    // to preload.js — same directory Abyss's own main window preload
                    // lives in. Pointing here (instead of leaving preload unset) is
                    // what makes the instance run Abyss itself, not bare Discord:
                    // Abyss's preload.js injects renderer.js (all plugins) into the
                    // page, then chain-loads Discord's own real preload via
                    // process.env.DISCORD_PRELOAD — already set once, by the main
                    // window, for the lifetime of this process.
                    preload: join(__dirname, "preload.js"),
                    // Deliberately absent: webSecurity:false. The same-origin
                    // policy stays on — no reason to turn it off just to show
                    // discord.com in its own session.
                },
            });
        } finally {
            // Restauré même si la construction échoue.
            if (realDiscordPreload !== undefined) process.env.DISCORD_PRELOAD = realDiscordPreload;
        }

        // Must run immediately after construction, before the window shows —
        // this is what stops Windows from grouping it with the main process.
        if (process.platform === "win32") {
            try {
                win.setAppDetails({
                    appId: uniqueAppId,
                    appIconPath: instanceIconPath,
                    relaunchDisplayName: `Discord [${label}]`,
                });
            } catch (e) {
                console.warn("[MultiInstance] setAppDetails failed:", e);
            }
        }

        const wc = win.webContents;
        const wcId = wc.id;
        // Le token reste en mémoire, rattaché à cette fenêtre seulement.
        tokensByWebContents.set(wcId, { token: cleanToken(token), home: homeUrl });
        openWindows.set(userId, win);

        // Registered now, before Discord's own JS loads (dom-ready), so its
        // window-control buttons hit this instance's handler from the start.
        const cleanupWindowControlIpc = registerWindowControlIpc(win);

        win.once("closed", () => {
            openWindows.delete(userId);
            tokensByWebContents.delete(wcId);
            cleanupWindowControlIpc();
            // Stop this session's service workers so push notifications end
            // once the instance is closed.
            ses.clearStorageData({ storages: ["serviceworkers"] }).catch(() => { });
        });

        // Redundant injection: the preload sets the token before Discord even
        // starts, but we repeat it on every (re)navigation just in case (e.g.
        // reconnect after a network drop). Same robust helper (iframe fallback)
        // so it still lands even once Discord has removed window.localStorage.
        const injectJs = injectCall(token, homeUrl);
        const reinject = () => {
            if (!win.isDestroyed() && isDiscordUrl(wc.getURL())) wc.executeJavaScript(injectJs).catch(() => { });
        };
        wc.on("dom-ready", reinject);
        wc.on("did-navigate", reinject);

        // ── Diagnostic + récupération ──────────────────────────────────────
        // Bloqué en chargement token valide : on trace la cause et, si l'app
        // n'a pas monté après un délai, on recharge UNE fois (souvent une course
        // au premier boot d'une session neuve, réglée dès que le token est là).
        miLog("open", userId, "domain=" + targetDomain);
        wc.on("did-fail-load", (_e, code, desc, url) => miLog("did-fail-load", userId, code, desc, url));
        wc.on("render-process-gone", (_e, details) => miLog("render-process-gone", userId, details));
        wc.on("preload-error", (_e, path, err) => miLog("preload-error", userId, path, String(err)));
        wc.on("unresponsive", () => miLog("unresponsive", userId));
        wc.on("did-finish-load", () => miLog("did-finish-load", userId));

        let recovered = false;
        const probeJs = "(function(){try{return JSON.stringify({href:location.href,title:document.title,hasChat:!!document.querySelector('[class*=\"chat\"],[class*=\"chatContent\"]'),hasLogin:!!(document.querySelector('input[name=\"email\"]')||document.querySelector('[class*=\"authBox\"]')),spinner:!!document.querySelector('[class*=\"initialLoad\"],[class*=\"loadingScreen\"],[class*=\"spinner\"]')});}catch(e){return \"probe-error:\"+e;}})();";
        setTimeout(async () => {
            if (win.isDestroyed()) return;
            try {
                const raw = await wc.executeJavaScript(probeJs);
                miLog("watchdog@15s", userId, raw);
                const st = typeof raw === "string" && raw[0] === "{" ? JSON.parse(raw) : null;
                if (!recovered && (!st || !st.hasChat)) {
                    recovered = true;
                    miLog("watchdog renav-once", userId);
                    // Re-navigate to /channels/@me (NOT reload — a reload would
                    // just reload /login). The preload re-runs and writes the
                    // token synchronously before this fresh load.
                    if (!win.isDestroyed()) wc.loadURL(homeUrl).catch(() => { });
                }
            } catch (e) {
                miLog("watchdog probe failed", userId, String(e));
                if (!recovered && !win.isDestroyed()) { recovered = true; miLog("watchdog renav after probe fail", userId); wc.loadURL(homeUrl).catch(() => { }); }
            }
        }, 15000);

        wc.on("page-title-updated", (e, title) => {
            const clean = title.replace(/^\(\d+\)\s*/, "").replace(/\s*\[.*\]$/, "");
            win.setTitle(`${clean} [${label}]`);
            e.preventDefault();
        });

        // Stay on discord.com/ptb/canary — any other link opens in the system
        // browser instead of inside this window. Le nom de domaine est vérifié
        // en entier (« discord.com.autre-site.com » ne passe plus).
        const openOutside = (url: string) => {
            try {
                const { protocol } = new URL(url);
                if (protocol === "https:" || protocol === "http:") void shell.openExternal(url);
            } catch { }
        };
        wc.on("will-navigate", (e, url) => {
            if (url.includes("/handoff")) { e.preventDefault(); return; }
            if (!isDiscordUrl(url)) {
                e.preventDefault();
                openOutside(url);
            }
        });
        wc.setWindowOpenHandler(({ url }) => {
            if (!url.includes("/handoff")) openOutside(url);
            return { action: "deny" };
        });

        await win.loadURL(homeUrl);
        return { ok: true };
    } catch (e: any) {
        return { ok: false, error: e?.message ?? String(e) };
    }
}

export async function closeInstance(_: any, userId: string): Promise<void> {
    const win = openWindows.get(userId);
    if (win && !win.isDestroyed()) win.close();
}

export async function getOpenInstances(_: any): Promise<string[]> {
    return [...openWindows.entries()].filter(([, w]) => !w.isDestroyed()).map(([id]) => id);
}
