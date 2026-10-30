/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// MessageLogger — visionneuse du journal : conversations à gauche, messages
// supprimés / modifiés à droite, groupés par jour, avec filtres, recherche et
// médias archivés.

import "./journal.css";

import ErrorBoundary from "@components/ErrorBoundary";
import { CopyIcon, DeleteIcon, FolderIcon } from "@components/Icons";
import { getLang, I18nKey, t, useLang } from "@lowcord/i18n";
import { classNameFactory } from "@utils/css";
import { copyWithToast, openUserProfile } from "@utils/discord";
import { RenderModalProps } from "@vencord/discord-types";
import { Alerts, Modal, openModal, Parser, showToast, Text, useEffect, useMemo, useRef, UserStore, useState } from "@webpack/common";

import { currentAccount, Native } from "./capture";
import type { ConversationSummary, LogAttachment, LogEvent, LogEventType, LogQueryResult, LogStats } from "./types";

const cl = classNameFactory("vc-mlj-");
/** Compte connecté : chaque compte a son propre journal. */
const acc = () => currentAccount() ?? "";
const PAGE = 60;

type Scope = "all" | "dm" | "guild";

export interface JournalFilter {
    channelId?: string;
    authorId?: string;
}

// ── Utilitaires ──────────────────────────────────────────────────────────────
const locale = () => (getLang() === "fr" ? "fr-FR" : "en-US");

function dayKey(ts: number) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(ts: number) {
    const today = new Date();
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if (dayKey(ts) === dayKey(today.getTime())) return t("ml.j.today");
    if (dayKey(ts) === dayKey(yesterday.getTime())) return t("ml.j.yesterday");
    const label = new Date(ts).toLocaleDateString(locale(), { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    return label.charAt(0).toUpperCase() + label.slice(1);
}

const time = (ts: number) => new Date(ts).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const dateTime = (ts: number) => new Date(ts).toLocaleString(locale(), { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

export function formatBytes(n: number) {
    if (n < 1024) return `${n} o`;
    if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} Ko`;
    if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} Mo`;
    return `${(n / 1024 ** 3).toFixed(2)} Go`;
}

const isImage = (a: LogAttachment) => a.contentType?.startsWith("image/") || /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(a.filename);
/** Taille max lue dans la fenêtre (au-delà : ouverture dans le lecteur du PC). */
const MAX_INLINE = 40 * 1024 * 1024;
const isVideo = (a: LogAttachment) => a.contentType?.startsWith("video/") || /\.(mp4|webm|mov|mkv)$/i.test(a.filename);

function Avatar({ src, fallback, square }: { src?: string; fallback: string; square?: boolean; }) {
    const [failed, setFailed] = useState(false);
    if (src && !failed) return <img className={cl("avatar", square && "square")} src={src} alt="" loading="lazy" onError={() => setFailed(true)} />;
    return <div className={cl("avatar", "avatar-empty", square && "square")}>{fallback.slice(0, 1).toUpperCase()}</div>;
}

function Content({ text, channelId, messageId }: { text: string; channelId: string; messageId: string; }) {
    if (!text) return <span className={cl("muted")}>{t("ml.j.noText")}</span>;
    return (
        <ErrorBoundary fallback={() => <span>{text}</span>}>
            {Parser.parse(text, true, { channelId, messageId, allowLinks: true, allowList: true, allowHeading: true })}
        </ErrorBoundary>
    );
}

// ── Médias ───────────────────────────────────────────────────────────────────
// Fichiers lus depuis le disque -> adresses blob, réutilisées tant que la
// fenêtre est ouverte, libérées à sa fermeture.
const blobs = new Map<string, string>();
function releaseBlobs() {
    blobs.forEach(url => URL.revokeObjectURL(url));
    blobs.clear();
}

function useBlob(rel: string | undefined, contentType: string | undefined, wanted: boolean) {
    const [url, setUrl] = useState(rel ? blobs.get(rel) : undefined);
    useEffect(() => {
        if (!rel || !wanted || url || !Native) return;
        let alive = true;
        Native.readMedia(acc(), rel).then(data => {
            if (!data || !alive) return;
            const blob = URL.createObjectURL(new Blob([data], { type: contentType || "application/octet-stream" }));
            blobs.set(rel, blob);
            setUrl(blob);
        }).catch(() => null);
        return () => { alive = false; };
    }, [rel, wanted]);
    return url;
}

function Attachment({ a, rel }: { a: LogAttachment; rel?: string; }) {
    const ref = useRef<HTMLDivElement>(null);
    const [visible, setVisible] = useState(false);
    const [playVideo, setPlayVideo] = useState(false);
    const image = isImage(a);
    const video = isVideo(a);

    // Chargement seulement quand la vignette arrive à l'écran.
    useEffect(() => {
        if (!rel || !image || !ref.current) return;
        const obs = new IntersectionObserver(entries => {
            if (entries.some(e => e.isIntersecting)) {
                setVisible(true);
                obs.disconnect();
            }
        });
        obs.observe(ref.current);
        return () => obs.disconnect();
    }, [rel]);

    const url = useBlob(rel, a.contentType, (image && visible) || playVideo);

    return (
        <div className={cl("file")} ref={ref}>
            {image && rel && (url
                ? <img className={cl("thumb")} src={url} alt={a.filename} onClick={() => Native?.openMedia(acc(), rel)} title={t("ml.j.open")} />
                : <div className={cl("thumb", "thumb-loading")} />)}
            {video && rel && playVideo && url && <video className={cl("thumb")} src={url} controls autoPlay />}

            <div className={cl("file-row")}>
                <span className={cl("file-name")} title={a.filename}>{a.filename}</span>
                <span className={cl("muted")}>{formatBytes(a.size)}</span>
                {rel
                    ? (
                        <>
                            {video && !playVideo && a.size <= MAX_INLINE && <button className={cl("link")} onClick={() => setPlayVideo(true)}>{t("ml.j.play")}</button>}
                            <button className={cl("link")} onClick={() => Native?.openMedia(acc(), rel)}>{t("ml.j.open")}</button>
                            <button className={cl("link")} onClick={() => Native?.showMedia(acc(), rel)}>{t("ml.j.show")}</button>
                        </>
                    )
                    : <span className={cl("badge", "badge-warn")} title={t("ml.j.notArchivedHint")}>{t("ml.j.notArchived")}</span>}
            </div>
        </div>
    );
}

// ── Une entrée du journal ────────────────────────────────────────────────────
const TYPE_LABEL: Record<LogEventType, I18nKey> = {
    delete: "ml.j.type.delete",
    edit: "ml.j.type.edit",
    attachments: "ml.j.type.attachments",
};

function Entry({ ev, media, showChannel, onAuthor }: { ev: LogEvent; media: Record<string, string>; showChannel: boolean; onAuthor(id: string): void; }) {
    const name = ev.author?.name ?? t("ml.j.unknownAuthor");

    return (
        <div className={cl("entry", `entry-${ev.type}`)}>
            <Avatar src={ev.author?.avatar} fallback={name} />
            <div className={cl("entry-main")}>
                <div className={cl("entry-head")}>
                    {ev.author
                        ? <button className={cl("author")} onClick={() => onAuthor(ev.author!.id)} title={t("ml.j.onlyThisUser")}>{name}</button>
                        : <span className={cl("author", "muted")}>{name}</span>}
                    {ev.author && ev.author.username && ev.author.username !== name && <span className={cl("muted")}>@{ev.author.username}</span>}
                    {ev.author?.bot && <span className={cl("badge")}>BOT</span>}
                    <span className={cl("badge", `badge-${ev.type}`)}>{t(TYPE_LABEL[ev.type])}</span>
                    {ev.bulk && <span className={cl("badge")} title={t("ml.j.bulkHint")}>{t("ml.j.bulk")}</span>}
                    <span className={cl("spacer")} />
                    <span className={cl("time")} title={dateTime(ev.at)}>{time(ev.at)}</span>
                </div>

                <div className={cl("meta")}>
                    {t("ml.j.sentAt", { date: dateTime(ev.sentAt) })}
                    {showChannel && <> · {ev.guildName ? `${ev.guildName} ` : ""}{ev.channelName}</>}
                </div>

                {ev.partial
                    ? <div className={cl("body", "muted")}>{t("ml.j.partial")}</div>
                    : ev.type === "edit"
                        ? (
                            <div className={cl("diff")}>
                                <div className={cl("diff-old")}><span className={cl("diff-label")}>{t("ml.j.before")}</span><Content text={ev.content} channelId={ev.channelId} messageId={ev.messageId} /></div>
                                <div className={cl("diff-new")}><span className={cl("diff-label")}>{t("ml.j.after")}</span><Content text={ev.newContent ?? ""} channelId={ev.channelId} messageId={ev.messageId} /></div>
                            </div>
                        )
                        : ev.type === "delete" && <div className={cl("body")}><Content text={ev.content} channelId={ev.channelId} messageId={ev.messageId} /></div>}

                {ev.stickers?.length ? <div className={cl("meta")}>{t("ml.j.stickers", { names: ev.stickers.map(s => s.name).join(", ") })}</div> : null}
                {ev.embeds ? <div className={cl("meta")}>{t("ml.j.embeds", { count: ev.embeds })}</div> : null}

                {ev.attachments.length > 0 && (
                    <div className={cl("files")}>
                        {ev.attachments.map(a => <Attachment key={a.id} a={a} rel={media[a.id]} />)}
                    </div>
                )}

                <div className={cl("actions")}>
                    {!!ev.content && (
                        <button className={cl("link")} onClick={() => copyWithToast(ev.type === "edit" ? `${ev.content}\n→\n${ev.newContent ?? ""}` : ev.content, t("ml.j.copied"))}>
                            <CopyIcon width={14} height={14} /> {t("ml.j.copyText")}
                        </button>
                    )}
                    {ev.author && <button className={cl("link")} onClick={() => openUserProfile(ev.author!.id).catch(() => null)}>{t("ml.j.profile")}</button>}
                    <button className={cl("link")} onClick={() => copyWithToast(`${ev.author?.id ?? "?"} / ${ev.channelId} / ${ev.messageId}`, t("ml.j.copied"))}>{t("ml.j.copyIds")}</button>
                </div>
            </div>
        </div>
    );
}

// ── Liste des conversations ──────────────────────────────────────────────────
function ConversationItem({ c, active, onClick }: { c: ConversationSummary; active: boolean; onClick(): void; }) {
    const title = c.channelKind === "dm" ? (c.peer?.name ?? c.channelName) : c.channelName;
    return (
        <button className={cl("conv", active && "conv-active")} onClick={onClick}>
            <Avatar src={c.channelKind === "dm" ? c.peer?.avatar : undefined} fallback={title} square={c.channelKind !== "dm"} />
            <div className={cl("conv-text")}>
                <div className={cl("conv-name")} title={title}>{title}</div>
                <div className={cl("conv-sub")}>
                    {c.channelKind === "guild" && c.guildName ? `${c.guildName} · ` : ""}
                    {t("ml.j.counts", { deletes: c.deletes, edits: c.edits })}
                </div>
            </div>
        </button>
    );
}

// ── Fenêtre principale ───────────────────────────────────────────────────────
function JournalModal({ modalProps, initial }: { modalProps: RenderModalProps; initial: JournalFilter; }) {
    useLang();
    const selfId = UserStore.getCurrentUser()?.id;
    const [channelId, setChannelId] = useState(initial.channelId);
    const [authorId, setAuthorId] = useState(initial.authorId);
    const [type, setType] = useState<LogEventType | undefined>();
    const [scope, setScope] = useState<Scope>("all");
    const [search, setSearch] = useState("");
    const [debounced, setDebounced] = useState("");
    const [result, setResult] = useState<LogQueryResult | null>(null);
    const [convs, setConvs] = useState<ConversationSummary[]>([]);
    const [loadingMore, setLoadingMore] = useState(false);
    const [refresh, setRefresh] = useState(0);

    useEffect(() => releaseBlobs, []);

    useEffect(() => {
        const timer = setTimeout(() => setDebounced(search), 250);
        return () => clearTimeout(timer);
    }, [search]);

    useEffect(() => {
        Native?.conversations(acc()).then(setConvs).catch(() => setConvs([]));
    }, [refresh]);

    const kind = scope === "all" ? undefined : scope;
    useEffect(() => {
        let alive = true;
        Native?.query(acc(), { channelId, authorId, type, kind, search: debounced, offset: 0, limit: PAGE })
            .then(r => alive && setResult(r))
            .catch(() => alive && setResult({ items: [], total: 0, media: {} }));
        return () => { alive = false; };
    }, [channelId, authorId, type, kind, debounced, refresh]);

    function loadMore() {
        if (!result || !Native) return;
        setLoadingMore(true);
        Native.query(acc(), { channelId, authorId, type, kind, search: debounced, offset: result.items.length, limit: PAGE })
            .then(r => setResult(prev => prev && { items: [...prev.items, ...r.items], total: r.total, media: { ...prev.media, ...r.media } }))
            .finally(() => setLoadingMore(false));
    }

    const groups = useMemo(() => {
        const dm = convs.filter(c => c.channelKind === "dm");
        const group = convs.filter(c => c.channelKind === "group");
        const guild = convs.filter(c => c.channelKind === "guild");
        return { dm, group, guild };
    }, [convs]);

    const days = useMemo(() => {
        const out: { key: string; label: string; items: LogEvent[]; }[] = [];
        for (const ev of result?.items ?? []) {
            const key = dayKey(ev.at);
            const last = out[out.length - 1];
            if (last?.key === key) last.items.push(ev);
            else out.push({ key, label: dayLabel(ev.at), items: [ev] });
        }
        return out;
    }, [result]);

    const current = convs.find(c => c.channelId === channelId);
    const authorName = authorId && (result?.items.find(e => e.author?.id === authorId)?.author?.name ?? UserStore.getUser(authorId)?.username ?? authorId);

    function clearCurrent() {
        if (!channelId || !current) return;
        Alerts.show({
            title: t("ml.j.clearConvTitle"),
            body: t("ml.j.clearConvBody", { name: current.channelKind === "dm" ? (current.peer?.name ?? current.channelName) : current.channelName }),
            confirmText: t("ml.j.clear"),
            cancelText: t("ml.j.cancel"),
            confirmColor: "red",
            async onConfirm() {
                await Native?.clearConversation(acc(), channelId);
                releaseBlobs();
                setChannelId(undefined);
                setRefresh(n => n + 1);
                showToast({ text: t("ml.j.cleared"), variant: "success" });
            },
        });
    }

    const section = (key: I18nKey, list: ConversationSummary[]) => list.length > 0 && (
        <>
            <div className={cl("side-title")}>{t(key)} <span className={cl("muted")}>{list.length}</span></div>
            {list.map(c => <ConversationItem key={c.channelId} c={c} active={c.channelId === channelId} onClick={() => setChannelId(c.channelId)} />)}
        </>
    );

    return (
        <Modal {...modalProps} size="xl" title={t("ml.j.title")} subtitle={t("ml.j.subtitle")}>
            <div className={cl("root")}>
                <aside className={cl("side")}>
                    <button className={cl("conv", !channelId && "conv-active")} onClick={() => setChannelId(undefined)}>
                        <div className={cl("conv-text")}>
                            <div className={cl("conv-name")}>{t("ml.j.allConversations")}</div>
                            <div className={cl("conv-sub")}>{t("ml.j.convCount", { count: convs.length })}</div>
                        </div>
                    </button>
                    {section("ml.j.sideDm", groups.dm)}
                    {section("ml.j.sideGroups", groups.group)}
                    {section("ml.j.sideServers", groups.guild)}
                    {!convs.length && <div className={cl("side-empty")}>{t("ml.j.emptySide")}</div>}
                </aside>

                <section className={cl("main")}>
                    <div className={cl("toolbar")}>
                        <div className={cl("chips")}>
                            {([undefined, "delete", "edit", "attachments"] as const).map(v => (
                                <button key={v ?? "all"} className={cl("chip", type === v && "chip-on")} onClick={() => setType(v)}>
                                    {t(v ? TYPE_LABEL[v] : "ml.j.type.all")}
                                </button>
                            ))}
                            {!channelId && (
                                <>
                                    <span className={cl("sep")} />
                                    {(["all", "dm", "guild"] as Scope[]).map(s => (
                                        <button key={s} className={cl("chip", scope === s && "chip-on")} onClick={() => setScope(s)}>
                                            {t(`ml.j.scope.${s}` as I18nKey)}
                                        </button>
                                    ))}
                                </>
                            )}
                        </div>
                        <input
                            className={cl("search")}
                            value={search}
                            placeholder={t("ml.j.search")}
                            onChange={e => setSearch(e.currentTarget.value)}
                            spellCheck={false}
                        />
                    </div>

                    <div className={cl("filters")}>
                        {current && <span className={cl("filter")}>{current.channelKind === "dm" ? (current.peer?.name ?? current.channelName) : `${current.guildName ? current.guildName + " " : ""}${current.channelName}`}</span>}
                        {authorId && (
                            <span className={cl("filter")}>
                                {t("ml.j.onlyUser", { name: authorName ?? authorId })}
                                <button className={cl("filter-x")} onClick={() => setAuthorId(undefined)} aria-label="x">×</button>
                            </span>
                        )}
                        <span className={cl("spacer")} />
                        {result && <span className={cl("muted")}>{t("ml.j.total", { count: result.total })}</span>}
                    </div>

                    <div className={cl("list")}>
                        {!Native && <div className={cl("empty")}>{t("ml.j.noNative")}</div>}
                        {Native && !result && <div className={cl("empty")}>{t("ml.j.loading")}</div>}
                        {result && !result.items.length && <div className={cl("empty")}>{t(debounced || type || authorId ? "ml.j.noMatch" : "ml.j.empty")}</div>}
                        {days.map(day => (
                            <div key={day.key} className={cl("day")}>
                                <div className={cl("day-label")}><span>{day.label}</span><span className={cl("muted")}>{day.items.length}</span></div>
                                {day.items.map(ev => (
                                    <Entry key={ev.key} ev={ev} media={result!.media} showChannel={!channelId} onAuthor={id => setAuthorId(id)} />
                                ))}
                            </div>
                        ))}
                        {result && result.items.length < result.total && (
                            <button className={cl("more")} disabled={loadingMore} onClick={loadMore}>
                                {t("ml.j.more", { count: result.total - result.items.length })}
                            </button>
                        )}
                    </div>

                    <div className={cl("footer")}>
                        <button className={cl("link")} onClick={() => Native?.openFolder(acc())}><FolderIcon width={14} height={14} /> {t("ml.j.openFolder")}</button>
                        {current && <button className={cl("link", "link-danger")} onClick={clearCurrent}><DeleteIcon width={14} height={14} /> {t("ml.j.clearConv")}</button>}
                    </div>
                </section>
            </div>
        </Modal>
    );
}

export function openJournal(initial: JournalFilter = {}) {
    openModal(props => (
        <ErrorBoundary>
            <JournalModal modalProps={props} initial={initial} />
        </ErrorBoundary>
    ));
}

// ── Panneau dans les réglages du plugin ──────────────────────────────────────
export function JournalPanel() {
    useLang();
    const [stats, setStats] = useState<LogStats | null>(null);

    useEffect(() => {
        if (!Native) return;
        let alive = true;
        const load = () => Native!.stats(acc()).then(s => alive && setStats(s)).catch(() => null);
        load();
        const timer = setInterval(load, 3000);
        return () => { alive = false; clearInterval(timer); };
    }, []);

    function clearAll() {
        Alerts.show({
            title: t("ml.j.clearAllTitle"),
            body: t("ml.j.clearAllBody"),
            confirmText: t("ml.j.clear"),
            cancelText: t("ml.j.cancel"),
            confirmColor: "red",
            async onConfirm() {
                await Native?.clearAll(acc());
                setStats(await Native!.stats(acc()));
                showToast({ text: t("ml.j.cleared"), variant: "success" });
            },
        });
    }

    if (!Native) return null;
    return (
        <div className={cl("panel")}>
            <Text variant="heading-md/semibold">{t("ml.j.title")}</Text>
            {stats && (
                <div className={cl("stats")}>
                    <div><b>{stats.events}</b><span>{t("ml.j.statEvents")}</span></div>
                    <div><b>{stats.mediaFiles}</b><span>{t("ml.j.statMedia")}</span></div>
                    <div><b>{formatBytes(stats.mediaBytes)}</b><span>{t("ml.j.statSize")}</span></div>
                    <div><b>{stats.snapshots}</b><span>{t("ml.j.statSnapshots")}</span></div>
                </div>
            )}
            {!!stats?.queue && <div className={cl("muted")}>{t("ml.j.queue", { count: stats.queue })}</div>}
            <div className={cl("panel-actions")}>
                <button className={cl("btn", "btn-primary")} onClick={() => openJournal()}>{t("ml.j.openJournal")}</button>
                <button className={cl("btn")} onClick={() => Native!.openFolder(acc())}>{t("ml.j.openFolder")}</button>
                <button className={cl("btn", "btn-danger")} onClick={clearAll}>{t("ml.j.clearAll")}</button>
            </div>
        </div>
    );
}
