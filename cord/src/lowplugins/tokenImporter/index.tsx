/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * TokenImporter — tes PROPRES comptes Discord : ajoute-les avec un token que
 * tu possèdes déjà (copié depuis la console, un ancien export…), range-les en
 * dossiers, bascule de l'un à l'autre ou ouvre-les chacun dans sa fenêtre
 * (plugin MultiInstance).
 *
 * Volontairement absent : tout scan du disque à la recherche de tokens dans
 * d'autres applications et tout déchiffrement de clés d'autres logiciels.
 * Coller un token qu'on possède déjà est une chose ; aller le chercher dans les
 * fichiers d'autres logiciels en est une autre — ce plugin ne fait que la
 * première. Les tokens enregistrés sont chiffrés par Windows (safeStorage).
 */

import "./styles.css";

import * as DataStore from "@api/DataStore";
import ErrorBoundary from "@components/ErrorBoundary";
import { CopyIcon, DeleteIcon, FolderIcon, OpenExternalIcon } from "@components/Icons";
import { addHeaderBarButton, HeaderBarIcon, removeHeaderBarButton } from "@lowcord/headerBar";
import { t, useLang } from "@lowcord/i18n";
import { copyToClipboard } from "@utils/clipboard";
import { classNameFactory } from "@utils/css";
import definePlugin, { PluginNative } from "@utils/types";
import { RenderModalProps } from "@vencord/discord-types";
import { findByProps } from "@webpack";
import { Alerts, ContextMenuApi, IconUtils, Menu, Modal, openModal, showToast, useEffect, useMemo, useState } from "@webpack/common";
import type { MouseEvent, ReactNode } from "react";

const cl = classNameFactory("lc-ti-");
const Native = VencordNative.pluginHelpers.TokenImporter as PluginNative<typeof import("./native")>;

const STORE_KEY = "tokenimporter-accounts";
const STORE_KEY_FOLDERS = "tokenimporter-folders";
const ENC_PREFIX = "ti-enc:";
const TOKEN_REGEX = /(?:mfa\.[\w-]{84}|[\w-]{24,26}\.[\w-]{4,7}\.[\w-]{27,40})/g;

export interface SavedAccount {
    id: string;
    token: string;
    username: string;
    discriminator: string;
    avatar: string;
    /** absent / null = « Non classés » */
    folderId?: string | null;
    // En mémoire seulement : token indéchiffrable sur ce PC (données copiées
    // depuis un autre PC / une autre session Windows). `sealed` garde la
    // valeur chiffrée pour la réécrire intacte au lieu de la perdre.
    locked?: boolean;
    sealed?: string;
}

interface Folder {
    id: string;
    name: string;
}

interface CheckResult {
    valid: boolean;
    user?: { id: string; username: string; global_name?: string; discriminator?: string; avatar?: string; };
    error?: string;
}

// ── Stockage ─────────────────────────────────────────────────────────────────
const makeFolderId = () => `folder-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

async function getFolders(): Promise<Folder[]> {
    const list = await DataStore.get<Folder[]>(STORE_KEY_FOLDERS);
    return Array.isArray(list) ? list.filter(f => f?.id && typeof f.name === "string") : [];
}

const saveFolders = (folders: Folder[]) => DataStore.set(STORE_KEY_FOLDERS, folders);

export async function getAccounts(): Promise<SavedAccount[]> {
    const raw = await DataStore.get<SavedAccount[]>(STORE_KEY);
    const out: SavedAccount[] = [];
    for (const acc of Array.isArray(raw) ? raw : []) {
        if (!acc?.id || typeof acc.token !== "string") continue;
        if (!acc.token.startsWith(ENC_PREFIX)) {
            out.push({ ...acc });
            continue;
        }
        const dec = await Native.decryptToken(acc.token.slice(ENC_PREFIX.length)).catch(() => null);
        out.push(dec ? { ...acc, token: dec } : { ...acc, token: "", locked: true, sealed: acc.token });
    }
    return out;
}

// Les enregistrements passent l'un après l'autre : deux actions rapprochées
// ne peuvent pas s'écraser mutuellement.
let saveQueue: Promise<void> = Promise.resolve();

function saveAccounts(accounts: SavedAccount[]): Promise<void> {
    const run = async () => {
        const unique = new Map<string, SavedAccount>();
        for (const a of accounts) unique.set(a.id, a);

        const stored: SavedAccount[] = [];
        for (const { locked, sealed, ...a } of unique.values()) {
            if (locked) {
                if (sealed) stored.push({ ...a, token: sealed });
                continue;
            }
            const enc = await Native.encryptToken(a.token).catch(() => null);
            stored.push({ ...a, token: enc ? ENC_PREFIX + enc : a.token });
        }
        await DataStore.set(STORE_KEY, stored);
    };
    saveQueue = saveQueue.then(run, run);
    return saveQueue;
}

function extractTokens(raw: string): string[] {
    const found = new Set<string>();
    TOKEN_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TOKEN_REGEX.exec(raw)) !== null) found.add(m[0]);
    return [...found];
}

function confirm(title: string, body: string, confirmText: string, onConfirm: () => void) {
    Alerts.show({ title, body, confirmText, cancelText: t("ti.cancel"), onConfirm });
}

const toast = (text: string, variant: "default" | "success" | "critical" = "default") => showToast({ text, variant });

// ── Basculer de compte ───────────────────────────────────────────────────────
// Discord retire `window.localStorage` du renderer (anti-vol de token) : un
// iframe about:blank garde la même origine avec un localStorage vivant.
// Renvoie true si au moins une écriture a réussi.
function persistToken(token: string): boolean {
    const value = JSON.stringify(token);
    let ok = false;

    try {
        const iframe = document.createElement("iframe");
        iframe.style.display = "none";
        document.body.appendChild(iframe);
        const ls = iframe.contentWindow?.localStorage;
        if (ls) {
            ls.setItem("token", value);
            ok = true;
        }
        iframe.remove();
    } catch (e) {
        console.error("[TokenImporter] persist via iframe failed:", e);
    }

    try {
        const ls = window.localStorage as Storage | undefined;
        if (typeof ls?.setItem === "function") {
            ls.setItem("token", value);
            ok = true;
        }
    } catch (e) {
        console.error("[TokenImporter] persist via window failed:", e);
    }

    return ok;
}

function switchToAccount(token: string) {
    // La persistance d'ABORD : c'est elle qui fait le basculement (au
    // rechargement Discord relit le token). Sans elle, recharger ne ferait que
    // revenir sur l'ancien compte.
    if (!persistToken(token)) {
        toast(t("ti.switchFailed"), "critical");
        return;
    }

    // En mémoire (best-effort) pour un basculement plus rapide.
    try {
        findByProps("getToken", "setToken")?.setToken?.(token);
        findByProps("dispatch", "subscribe", "register")?.dispatch?.({ type: "LOGIN_SUCCESS", token });
    } catch (e) {
        console.error("[TokenImporter] in-memory switch step failed (non fatal):", e);
    }

    setTimeout(() => void Native.reload(), 150);
}

// Déclare les comptes enregistrés dans le sélecteur multi-comptes natif de
// Discord, par l'action que Discord envoie lui-même après une connexion
// validée. Ne fait que déclarer des comptes dont on possède déjà le token.
function injectIntoNativeSwitcher(accounts: SavedAccount[]) {
    try {
        const dispatcher = findByProps("dispatch", "subscribe");
        const tokenMod = findByProps("getToken", "encryptAndStoreTokens");

        for (const acc of accounts) {
            if (!acc.id || !acc.token) continue;
            dispatcher?.dispatch?.({
                type: "MULTI_ACCOUNT_VALIDATE_TOKEN_SUCCESS",
                userId: acc.id,
                token: acc.token,
                user: {
                    id: acc.id,
                    username: acc.username,
                    discriminator: acc.discriminator ?? "0",
                    avatar: acc.avatar,
                    global_name: acc.username,
                    public_flags: 0,
                },
            });
        }

        if (tokenMod) {
            const tokens: Record<string, string> =
                (typeof tokenMod.getTokens === "function" ? tokenMod.getTokens() : tokenMod.tokens) || {};
            let changed = false;
            for (const acc of accounts) {
                if (acc.id && acc.token && tokens[acc.id] !== acc.token) {
                    tokens[acc.id] = acc.token;
                    changed = true;
                }
            }
            if (changed && typeof tokenMod.encryptAndStoreTokens === "function") tokenMod.encryptAndStoreTokens(tokens);
        }
    } catch (e) {
        console.error("[TokenImporter] injectIntoNativeSwitcher failed:", e);
    }
}

function copyMyToken() {
    try {
        const token = findByProps("getToken")?.getToken?.();
        if (!token) return;
        void copyToClipboard(token);
        toast(t("ti.tokenCopied"), "success");
    } catch { }
}

// Fenêtre à part, via le plugin MultiInstance (dépendance). Le token ne quitte
// pas cette machine.
async function openInStandaloneInstance(a: SavedAccount) {
    try {
        const mi = (VencordNative.pluginHelpers as any).MultiInstance;
        if (!mi?.openInstanceWindow) {
            toast(t("ti.needMultiInstance"), "critical");
            return;
        }
        const res = await mi.openInstanceWindow(a.token, a.id, a.username);
        if (res && res.ok === false) toast(t("ti.windowFailed", { error: res.error ?? "" }), "critical");
    } catch (e) {
        console.error("[TokenImporter] openInStandaloneInstance failed:", e);
        toast(t("ti.windowFailed", { error: "" }), "critical");
    }
}

// ── Autres installations ─────────────────────────────────────────────────────
// Guidé, pas automatique : on ne lit aucun fichier des autres installs. On
// ouvre l'appli et on copie le script à coller toi-même dans SA console pour
// récupérer TON propre token.
const LOCAL_INSTALL_TARGETS = [
    { label: "Discord", branch: "stable" },
    { label: "Discord Canary", branch: "canary" },
    { label: "Discord PTB", branch: "ptb" },
];

const TOKEN_GRAB_SCRIPT = `(function() {
    window.webpackChunkdiscord_app.push([
        [Symbol()],
        {},
        req => {
            if (!req.c) return;
            for (const m of Object.values(req.c)) {
                try {
                    if (!m.exports || m.exports === window) continue;
                    if (m.exports?.getToken) return copy(m.exports.getToken());
                    for (const ex in m.exports) {
                        if (m.exports?.[ex]?.getToken) return copy(m.exports[ex].getToken());
                    }
                } catch {}
            }
        },
    ]);
    window.webpackChunkdiscord_app.pop();
    console.log("Token copied to clipboard!");
})();`;

async function openLocalInstall(branch: string, label: string) {
    try {
        const res = await Native.launchLocalInstall(branch);
        if (!res.ok) {
            const key = res.error === "not_found" ? "ti.installNotFound" : res.error === "unsupported_platform" ? "ti.installUnsupported" : "ti.installFailed";
            toast(t(key, { name: label }), "critical");
        }
    } catch (e) {
        console.error("[TokenImporter] Failed to open install:", e);
    }
}

// ── Composants ───────────────────────────────────────────────────────────────
function avatarUrl(a: SavedAccount): string {
    if (a.avatar) return IconUtils.getUserAvatarURL({ id: a.id, avatar: a.avatar } as any, false, 64) ?? IconUtils.getDefaultAvatarURL(a.id, a.discriminator);
    return IconUtils.getDefaultAvatarURL(a.id, a.discriminator);
}

function Avatar({ account }: { account: SavedAccount; }) {
    const [failed, setFailed] = useState(false);
    if (failed) return <div className={cl("avatar", "avatar-empty")}>{account.username.slice(0, 1).toUpperCase()}</div>;
    return <img className={cl("avatar")} src={avatarUrl(account)} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

function IconButton({ title, danger, disabled, onClick, children }: { title: string; danger?: boolean; disabled?: boolean; onClick(): void; children: ReactNode; }) {
    return (
        <button className={cl("icon-btn", danger && "icon-btn-danger")} title={title} aria-label={title} disabled={disabled} onClick={onClick}>
            {children}
        </button>
    );
}

interface RowActions {
    folders: Folder[];
    onRemove(id: string): void;
    onRename(id: string, name: string): void;
    onMove(id: string, folderId: string | null): void;
}

function AccountRow({ account, folders, onRemove, onRename, onMove }: RowActions & { account: SavedAccount; }) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(account.username);
    useEffect(() => { if (editing) setDraft(account.username); }, [editing]);

    function commit() {
        const name = draft.trim();
        setEditing(false);
        if (name && name !== account.username) onRename(account.id, name);
    }

    // Clic droit : renommer (étiquette locale seulement) et ranger.
    function openMenu(e: MouseEvent) {
        e.preventDefault();
        ContextMenuApi.openContextMenu(e as any, () => (
            <Menu.Menu navId="lc-ti-account" onClose={ContextMenuApi.closeContextMenu}>
                <Menu.MenuItem id="lc-ti-rename" label={t("ti.rename")} action={() => setEditing(true)} />
                {folders.length > 0 && (
                    <Menu.MenuItem id="lc-ti-move" label={t("ti.moveTo")}>
                        {[...folders.map(f => ({ id: f.id as string | null, name: f.name })), { id: null, name: t("ti.unsorted") }]
                            .filter(f => f.id !== (account.folderId ?? null))
                            .map(f => <Menu.MenuItem key={f.id ?? "none"} id={`lc-ti-move-${f.id ?? "none"}`} label={f.name} action={() => onMove(account.id, f.id)} />)}
                    </Menu.MenuItem>
                )}
                <Menu.MenuSeparator />
                <Menu.MenuItem id="lc-ti-remove" label={t("ti.remove")} color="danger" action={() => onRemove(account.id)} />
            </Menu.Menu>
        ));
    }

    return (
        <div className={cl("row")} onContextMenu={openMenu}>
            <Avatar account={account} />
            <div className={cl("text")}>
                {editing ? (
                    <input
                        className={cl("input")}
                        autoFocus
                        value={draft}
                        maxLength={64}
                        onChange={e => setDraft(e.currentTarget.value)}
                        onBlur={commit}
                        onKeyDown={e => {
                            if (e.key === "Enter") commit();
                            else if (e.key === "Escape") setEditing(false);
                        }}
                    />
                ) : (
                    <span className={cl("name")}>
                        {account.username}{account.discriminator && account.discriminator !== "0" ? `#${account.discriminator}` : ""}
                    </span>
                )}
                {account.locked
                    ? <span className={cl("warn")}>{t("ti.locked")}</span>
                    : <span className={cl("sub")}>•••• •••• •••• ••••</span>}
            </div>
            <div className={cl("actions")}>
                <button className={cl("btn")} disabled={account.locked} onClick={() => switchToAccount(account.token)}>{t("ti.switch")}</button>
                <IconButton title={t("ti.openWindow")} disabled={account.locked} onClick={() => openInStandaloneInstance(account)}>
                    <OpenExternalIcon width={16} height={16} />
                </IconButton>
                <IconButton title={t("ti.copyToken")} disabled={account.locked} onClick={() => {
                    void copyToClipboard(account.token);
                    toast(t("ti.tokenCopied"), "success");
                }}>
                    <CopyIcon width={16} height={16} />
                </IconButton>
                <IconButton title={t("ti.remove")} danger onClick={() => onRemove(account.id)}>
                    <DeleteIcon width={16} height={16} />
                </IconButton>
            </div>
        </div>
    );
}

function FolderBlock({ name, count, open, onToggle, onMenu, editing, onRename, onCancel, children }: {
    name: string;
    count: number;
    open: boolean;
    onToggle(): void;
    onMenu?(e: MouseEvent): void;
    editing?: boolean;
    onRename?(name: string): void;
    onCancel?(): void;
    children: ReactNode;
}) {
    const [draft, setDraft] = useState(name);
    useEffect(() => { if (editing) setDraft(name); }, [editing]);

    return (
        <div className={cl("folder")}>
            <div className={cl("folder-head")} onClick={editing ? undefined : onToggle} onContextMenu={onMenu} role="button" aria-expanded={open}>
                <span className={cl("chevron", !open && "chevron-closed")}>▾</span>
                {editing ? (
                    <input
                        className={cl("input")}
                        autoFocus
                        value={draft}
                        maxLength={64}
                        onClick={e => e.stopPropagation()}
                        onChange={e => setDraft(e.currentTarget.value)}
                        onBlur={() => onRename?.(draft)}
                        onKeyDown={e => {
                            if (e.key === "Enter") onRename?.(draft);
                            else if (e.key === "Escape") onCancel?.();
                        }}
                    />
                ) : <span className={cl("folder-name")}>{name}</span>}
                <span className={cl("count")}>{count}</span>
            </div>
            {open && <div className={cl("folder-body")}>{children}</div>}
        </div>
    );
}

// ── Onglet « Comptes » ───────────────────────────────────────────────────────
function SavedTab({ accounts, folders, loaded, actions, onFoldersChange, onDeleteFolder }: {
    accounts: SavedAccount[];
    folders: Folder[];
    loaded: boolean;
    actions: Omit<RowActions, "folders">;
    onFoldersChange(folders: Folder[]): void;
    onDeleteFolder(id: string): void;
}) {
    // Dossiers dépliés (tout replié au départ, sauf un dossier qu'on vient de créer).
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [editingId, setEditingId] = useState<string | null>(null);

    const toggle = (id: string) => setExpanded(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
    });

    function addFolder() {
        const names = new Set(folders.map(f => f.name));
        let name = t("ti.newFolderName");
        for (let n = 2; names.has(name); n++) name = `${t("ti.newFolderName")} ${n}`;
        const folder: Folder = { id: makeFolderId(), name };
        onFoldersChange([...folders, folder]);
        setEditingId(folder.id);
        setExpanded(prev => new Set(prev).add(folder.id));
    }

    function renameFolder(id: string, name: string) {
        const trimmed = name.trim();
        setEditingId(null);
        if (trimmed) onFoldersChange(folders.map(f => f.id === id ? { ...f, name: trimmed } : f));
    }

    const byFolder = useMemo(() => {
        const map = new Map<string | null, SavedAccount[]>([[null, []]]);
        for (const f of folders) map.set(f.id, []);
        for (const a of accounts) map.get(a.folderId && map.has(a.folderId) ? a.folderId : null)!.push(a);
        return map;
    }, [accounts, folders]);

    function exportTxt() {
        confirm(t("ti.exportTitle"), t("ti.exportBody"), t("ti.export"), () => void doExport());
    }

    async function doExport() {
        const usable = (list: SavedAccount[]) => list.filter(a => !a.locked && a.token).map(a => ({ username: a.username, token: a.token }));
        const groups = folders.map(f => ({ name: f.name, accounts: usable(byFolder.get(f.id) ?? []) }));
        groups.push({ name: t("ti.unsorted"), accounts: usable(byFolder.get(null) ?? []) });
        const nonEmpty = groups.filter(g => g.accounts.length);
        if (!nonEmpty.length) {
            toast(t("ti.nothingToExport"));
            return;
        }
        const res = await Native.exportTokens(nonEmpty);
        if (res.ok) toast(t("ti.exported", { count: res.count ?? 0 }), "success");
        else if (res.error !== "canceled") toast(t("ti.exportFailed", { error: res.error ?? "" }), "critical");
    }

    const rowActions: RowActions = { ...actions, folders };
    const rows = (list: SavedAccount[]) => list.map(a => <AccountRow key={a.id} account={a} {...rowActions} />);

    return (
        <>
            <div className={cl("tools")}>
                <button className={cl("btn")} onClick={copyMyToken}>{t("ti.copyMine")}</button>
                <button className={cl("btn")} onClick={addFolder}>{t("ti.newFolder")}</button>
                <span className={cl("spacer")} />
                <button className={cl("btn")} onClick={exportTxt} disabled={!accounts.some(a => !a.locked)}>{t("ti.exportTxt")}</button>
            </div>

            <div className={cl("list")}>
                {!loaded ? (
                    <div className={cl("empty")}>{t("ti.loading")}</div>
                ) : !accounts.length && !folders.length ? (
                    <div className={cl("empty")}>{t("ti.noAccounts")}</div>
                ) : !folders.length ? (
                    rows(accounts)
                ) : (
                    <>
                        {folders.map(f => (
                            <FolderBlock
                                key={f.id}
                                name={f.name}
                                count={byFolder.get(f.id)?.length ?? 0}
                                open={expanded.has(f.id)}
                                onToggle={() => toggle(f.id)}
                                editing={editingId === f.id}
                                onRename={name => renameFolder(f.id, name)}
                                onCancel={() => setEditingId(null)}
                                onMenu={e => {
                                    e.preventDefault();
                                    ContextMenuApi.openContextMenu(e as any, () => (
                                        <Menu.Menu navId="lc-ti-folder" onClose={ContextMenuApi.closeContextMenu}>
                                            <Menu.MenuItem id="lc-ti-folder-rename" label={t("ti.rename")} action={() => setEditingId(f.id)} />
                                            <Menu.MenuItem id="lc-ti-folder-delete" label={t("ti.deleteFolder")} color="danger" action={() => onDeleteFolder(f.id)} />
                                        </Menu.Menu>
                                    ));
                                }}
                            >
                                {byFolder.get(f.id)?.length ? rows(byFolder.get(f.id)!) : <div className={cl("hint")}>{t("ti.emptyFolder")}</div>}
                            </FolderBlock>
                        ))}
                        <FolderBlock
                            name={t("ti.unsorted")}
                            count={byFolder.get(null)?.length ?? 0}
                            open={expanded.has("__unsorted")}
                            onToggle={() => toggle("__unsorted")}
                        >
                            {byFolder.get(null)?.length ? rows(byFolder.get(null)!) : <div className={cl("hint")}>{t("ti.noUnsorted")}</div>}
                        </FolderBlock>
                    </>
                )}
            </div>
            <div className={cl("hint")}>{t("ti.rightClickHint")}</div>
        </>
    );
}

// ── Onglet « Ajouter » ───────────────────────────────────────────────────────
type AddResult = { ok: boolean; label: string; };

const CHECK_ERROR_KEY: Record<string, Parameters<typeof t>[0]> = {
    unauthorized: "ti.err.unauthorized",
    malformed: "ti.err.malformed",
    rate_limited: "ti.err.rateLimited",
    timeout: "ti.err.timeout",
    network_error: "ti.err.network",
};

function AddTab({ onAdded }: { onAdded(accounts: SavedAccount[]): void; }) {
    const [paste, setPaste] = useState("");
    const [checking, setChecking] = useState(false);
    const [results, setResults] = useState<AddResult[]>([]);
    const detected = useMemo(() => extractTokens(paste).length, [paste]);

    async function verifyAndAdd() {
        const tokens = extractTokens(paste);
        if (!tokens.length) return;
        setChecking(true);
        setResults([]);
        const out: AddResult[] = [];
        const retry: string[] = [];
        try {
            const existing = await getAccounts();
            for (const tok of tokens) {
                let r: CheckResult;
                try { r = await Native.checkToken(tok); } catch { r = { valid: false, error: "exception" }; }
                if (r.valid && r.user) {
                    const u = r.user;
                    const name = u.global_name || u.username;
                    const known = existing.find(a => a.id === u.id);
                    if (!known) {
                        existing.push({ id: u.id, token: tok, username: name, discriminator: u.discriminator ?? "0", avatar: u.avatar ?? "" });
                        out.push({ ok: true, label: t("ti.added", { name }) });
                    } else if (known.locked || known.token !== tok) {
                        // Nouveau token pour un compte déjà là : on le remplace,
                        // en gardant le nom choisi et le dossier.
                        Object.assign(known, { token: tok, locked: false, sealed: undefined, avatar: u.avatar ?? "" });
                        out.push({ ok: true, label: t("ti.updated", { name: known.username }) });
                    } else {
                        out.push({ ok: true, label: t("ti.alreadyThere", { name: known.username }) });
                    }
                } else {
                    // Limite de Discord / réseau : le token n'est pas forcément
                    // mauvais, il reste dans la zone pour réessayer.
                    if (r.error === "rate_limited" || r.error === "timeout" || r.error === "network_error") retry.push(tok);
                    out.push({ ok: false, label: t(CHECK_ERROR_KEY[r.error ?? ""] ?? "ti.err.unauthorized") });
                }
            }
            await saveAccounts(existing);
            injectIntoNativeSwitcher(existing);
            onAdded(existing);
        } catch (e) {
            console.error("[TokenImporter] add failed:", e);
            out.push({ ok: false, label: t("ti.err.save") });
        } finally {
            setResults(out);
            setPaste(retry.join("\n"));
            setChecking(false);
        }
    }

    return (
        <>
            <div className={cl("hint")}>{t("ti.pasteHint")}</div>
            <textarea
                className={cl("textarea")}
                value={paste}
                onChange={e => setPaste(e.currentTarget.value)}
                placeholder={t("ti.pastePlaceholder")}
                spellCheck={false}
                rows={6}
            />
            <div className={cl("tools")}>
                <span className={cl("muted")}>{t("ti.detected", { count: detected })}</span>
                <span className={cl("spacer")} />
                <button className={cl("btn", "btn-primary")} disabled={checking || !detected} onClick={verifyAndAdd}>
                    {t(checking ? "ti.checking" : "ti.verifyAdd")}
                </button>
            </div>
            {results.length > 0 && (
                <div className={cl("results")}>
                    {results.map((r, i) => (
                        <div key={i} className={cl("result", !r.ok && "result-bad")}>
                            <span className={cl("dot")} />
                            {r.label}
                        </div>
                    ))}
                </div>
            )}
        </>
    );
}

// ── Onglet « Autres installations » ──────────────────────────────────────────
function LocalTab() {
    return (
        <>
            <div className={cl("hint")}>{t("ti.localHint")}</div>
            <div className={cl("list")}>
                {LOCAL_INSTALL_TARGETS.map(target => (
                    <div key={target.branch} className={cl("row")}>
                        <div className={cl("text")}>
                            <span className={cl("name")}>{target.label}</span>
                            <span className={cl("sub")}>{t("ti.localSteps")}</span>
                        </div>
                        <div className={cl("actions")}>
                            <button className={cl("btn")} onClick={() => openLocalInstall(target.branch, target.label)}>{t("ti.open")}</button>
                            <IconButton title={t("ti.copyScript")} onClick={() => {
                                void copyToClipboard(TOKEN_GRAB_SCRIPT);
                                toast(t("ti.scriptCopied", { name: target.label }), "success");
                            }}>
                                <CopyIcon width={16} height={16} />
                            </IconButton>
                        </div>
                    </div>
                ))}
            </div>
        </>
    );
}

// ── Fenêtre ──────────────────────────────────────────────────────────────────
type Tab = "saved" | "add" | "local";

function TokenImporterModal({ modalProps }: { modalProps: RenderModalProps; }) {
    useLang();
    const [tab, setTab] = useState<Tab>("saved");
    const [accounts, setAccounts] = useState<SavedAccount[]>([]);
    const [folders, setFolders] = useState<Folder[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [encrypted, setEncrypted] = useState(true);

    useEffect(() => {
        Promise.all([getAccounts(), getFolders()])
            .then(([a, f]) => { setAccounts(a); setFolders(f); })
            .catch(e => console.error("[TokenImporter] load failed:", e))
            .finally(() => setLoaded(true));
        Native.isEncryptionAvailable().then(setEncrypted).catch(() => setEncrypted(false));
    }, []);

    // Toujours à partir de l'état le plus récent : deux actions rapprochées
    // ne s'annulent pas.
    function updateAccounts(change: (list: SavedAccount[]) => SavedAccount[]) {
        setAccounts(prev => {
            const next = change(prev);
            void saveAccounts(next);
            return next;
        });
    }

    function removeAccount(id: string) {
        const acc = accounts.find(a => a.id === id);
        confirm(t("ti.removeTitle"), t("ti.removeBody", { name: acc?.username ?? id }), t("ti.remove"), () => updateAccounts(list => list.filter(a => a.id !== id)));
    }

    function changeFolders(next: Folder[]) {
        setFolders(next);
        void saveFolders(next);
    }

    function deleteFolder(folderId: string) {
        changeFolders(folders.filter(f => f.id !== folderId));
        updateAccounts(list => list.map(a => a.folderId === folderId ? { ...a, folderId: null } : a));
    }

    const actions = {
        onRemove: removeAccount,
        onRename: (id: string, name: string) => updateAccounts(list => list.map(a => a.id === id ? { ...a, username: name } : a)),
        onMove: (id: string, folderId: string | null) => updateAccounts(list => list.map(a => a.id === id ? { ...a, folderId } : a)),
    };

    const tabs: { id: Tab; label: string; }[] = [
        { id: "saved", label: accounts.length ? `${t("ti.tabSaved")} (${accounts.length})` : t("ti.tabSaved") },
        { id: "add", label: t("ti.tabAdd") },
        { id: "local", label: t("ti.tabLocal") },
    ];

    return (
        <Modal {...modalProps} size="md" title={t("ti.title")} subtitle={t("ti.subtitle")}>
            <div className={cl("root")}>
                <div className={cl("tabs")}>
                    {tabs.map(x => (
                        <button key={x.id} className={cl("chip", tab === x.id && "chip-on")} onClick={() => setTab(x.id)}>{x.label}</button>
                    ))}
                </div>
                {!encrypted && <div className={cl("banner")}>{t("ti.noEncryption")}</div>}
                {tab === "saved" && (
                    <SavedTab accounts={accounts} folders={folders} loaded={loaded} actions={actions} onFoldersChange={changeFolders} onDeleteFolder={deleteFolder} />
                )}
                {tab === "add" && <AddTab onAdded={setAccounts} />}
                {tab === "local" && <LocalTab />}
            </div>
        </Modal>
    );
}

const open = () => openModal(props => (
    <ErrorBoundary>
        <TokenImporterModal modalProps={props} />
    </ErrorBoundary>
));

function HeaderButton() {
    useLang();
    return <HeaderBarIcon icon={() => <FolderIcon width={20} height={20} />} tooltip={t("ti.title")} onClick={open} />;
}

export default definePlugin({
    name: "TokenImporter",
    description: "Add and switch between your own Discord accounts with a token you already have, sorted in folders, or open each one in its own window. No disk scan, no other app touched.",
    tags: ["Utility"],
    authors: [{ name: "0ctane", id: 0n }],
    dependencies: ["MultiInstance"],

    start() {
        addHeaderBarButton("TokenImporter", HeaderButton, 8);
        // Les comptes réapparaissent dans le sélecteur natif après un redémarrage.
        getAccounts().then(injectIntoNativeSwitcher).catch(() => { });
    },

    stop() {
        removeHeaderBarButton("TokenImporter");
    },
});
