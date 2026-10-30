/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * ClearFriends — retirer plusieurs amis d'un coup, depuis une liste à cocher
 * (bouton dans la barre du haut). Toujours une confirmation ; rythme sûr
 * avec gestion des limites de Discord ; « ami depuis » et tri par ancienneté.
 */

import "./styles.css";

import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { addHeaderBarButton, HeaderBarIcon, removeHeaderBarButton } from "@lowcord/headerBar";
import { getLang, I18nKey, t, useLang } from "@lowcord/i18n";
import { classNameFactory } from "@utils/css";
import definePlugin, { OptionType } from "@utils/types";
import { RenderModalProps } from "@vencord/discord-types";
import { Alerts, Modal, openModal, RelationshipStore, useEffect, useMemo, UserStore, useState } from "@webpack/common";

import { enqueue, FriendRef, setDelay, state, stop, subscribe } from "./engine";

const cl = classNameFactory("lc-cf-");

const settings = definePluginSettings({
    delayMs: {
        type: OptionType.NUMBER,
        description: "Delay between two removals (ms)",
        default: 1000,
        onChange: (v: number) => setDelay(v),
    },
});

function useEngine() {
    const [, tick] = useState(0);
    useEffect(() => subscribe(() => tick(n => n + 1)), []);
    return state;
}

function FriendRemoveIcon({ size = 20 }: { size?: number | string; }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M11.53 11A9.53 9.53 0 0 0 2 20.53c0 .81.66 1.47 1.47 1.47h.22c.24 0 .44-.17.5-.4.29-1.12.84-2.17 1.32-2.91.14-.21.43-.1.4.15l-.25 2.61c-.03.3.2.55.5.55h7.63c.12 0 .17-.31.06-.36C12.82 21.14 12 20.22 12 19a3 3 0 0 1 3-3h5.02c.38 0 .61-.4.4-.72A9.52 9.52 0 0 0 12.47 11h-.94ZM12 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" />
            <path d="M15 18a1 1 0 1 0 0 2h8a1 1 0 0 0 0-2h-8Z" />
        </svg>
    );
}

interface Friend {
    id: string;
    name: string;
    username: string;
    avatar?: string;
    /** date de l'amitié (ms), si Discord la connaît */
    since?: number;
}

function loadFriends(): Friend[] {
    return RelationshipStore.getFriendIDs().map(id => {
        const u = UserStore.getUser(id);
        const since = Date.parse(RelationshipStore.getSince(id) ?? "");
        return {
            id,
            name: u?.globalName || u?.username || id,
            username: u?.username ?? "",
            avatar: u?.getAvatarURL?.(undefined, 64, false),
            since: Number.isFinite(since) ? since : undefined,
        };
    });
}

type Sort = "name" | "oldest" | "newest";

function Avatar({ src, name }: { src?: string; name: string; }) {
    const [failed, setFailed] = useState(false);
    if (src && !failed) return <img className={cl("avatar")} src={src} alt="" loading="lazy" onError={() => setFailed(true)} />;
    return <div className={cl("avatar", "avatar-empty")}>{name.slice(0, 1).toUpperCase()}</div>;
}

function confirmRemove(list: FriendRef[], onDone: () => void) {
    const names = list.slice(0, 8).map(f => f.name).join(", ") + (list.length > 8 ? ` +${list.length - 8}` : "");
    Alerts.show({
        title: t("cf.confirmTitle", { count: list.length }),
        body: (
            <div className={cl("confirm")}>
                <p>{names}</p>
                <p className={cl("muted")}>{t("cf.confirmNote")}</p>
            </div>
        ),
        confirmText: t("cf.confirmGo", { count: list.length }),
        cancelText: t("cf.cancel"),
        confirmColor: "red",
        onConfirm() {
            enqueue(list);
            onDone();
        },
    });
}

function ClearFriendsModal({ modalProps }: { modalProps: RenderModalProps; }) {
    useLang();
    const s = useEngine();
    const [friends, setFriends] = useState<Friend[]>(loadFriends);
    const [search, setSearch] = useState("");
    const [sort, setSort] = useState<Sort>("name");
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const locale = getLang() === "fr" ? "fr-FR" : "en-US";

    // La liste suit les retraits en cours (et ceux faits ailleurs).
    useEffect(() => subscribe(() => {
        const ids = new Set(RelationshipStore.getFriendIDs());
        setFriends(list => list.filter(f => ids.has(f.id) && !state.removed.has(f.id)));
    }), []);

    const visible = useMemo(() => {
        const q = search.trim().toLowerCase();
        const list = q ? friends.filter(f => f.name.toLowerCase().includes(q) || f.username.toLowerCase().includes(q) || f.id.includes(q)) : [...friends];
        if (sort === "name") list.sort((a, b) => a.name.localeCompare(b.name));
        else list.sort((a, b) => ((a.since ?? 0) - (b.since ?? 0)) * (sort === "oldest" ? 1 : -1));
        return list;
    }, [friends, search, sort]);

    const queued = new Set([...s.queue.map(f => f.id), s.current?.id]);
    const allOn = visible.length > 0 && visible.every(f => selected.has(f.id));

    function toggle(id: string) {
        const next = new Set(selected);
        next.has(id) ? next.delete(id) : next.add(id);
        setSelected(next);
    }

    function toggleAll() {
        const next = new Set(selected);
        for (const f of visible) allOn ? next.delete(f.id) : next.add(f.id);
        setSelected(next);
    }

    const picked = friends.filter(f => selected.has(f.id) && !queued.has(f.id));
    const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;

    const SORTS: { id: Sort; key: I18nKey; }[] = [
        { id: "name", key: "cf.sort.name" },
        { id: "oldest", key: "cf.sort.oldest" },
        { id: "newest", key: "cf.sort.newest" },
    ];

    return (
        <Modal {...modalProps} size="md" title={t("cf.title")} subtitle={t("cf.subtitle", { count: friends.length })}>
            <div className={cl("root")}>
                {(s.running || s.failed.length > 0) && (
                    <div className={cl("progress")}>
                        <div className={cl("progress-head")}>
                            <span className={cl("progress-title")}>
                                {s.running
                                    ? t("cf.removing", { name: s.current?.name ?? "…" })
                                    : t("cf.finished")}
                            </span>
                            {s.running && <button className={cl("btn")} onClick={stop}>{t("cf.stop")}</button>}
                        </div>
                        <div className={cl("bar")}><div className={cl("bar-fill")} style={{ width: `${pct}%` }} /></div>
                        <div className={cl("stats")}>
                            <span><b>{s.done}</b> / {s.total}</span>
                            {s.failed.length > 0 && <span className={cl("err")} title={s.failed.map(f => f.name).join(", ")}>{t("cf.failed", { count: s.failed.length })}</span>}
                            {s.slowed && <span className={cl("warn")}>{t("cf.slowed")}</span>}
                        </div>
                    </div>
                )}

                <div className={cl("tools")}>
                    <input className={cl("search")} value={search} onChange={e => setSearch(e.currentTarget.value)} placeholder={t("cf.search")} spellCheck={false} autoFocus />
                    <button className={cl("btn")} onClick={toggleAll} disabled={!visible.length}>{t(allOn ? "cf.selectNone" : "cf.selectAll")}</button>
                </div>
                <div className={cl("sorts")}>
                    <span className={cl("muted")}>{t("cf.sortBy")}</span>
                    {SORTS.map(x => (
                        <button key={x.id} className={cl("chip", sort === x.id && "chip-on")} onClick={() => setSort(x.id)}>{t(x.key)}</button>
                    ))}
                    <span className={cl("spacer")} />
                    {selected.size > 0 && <span className={cl("muted")}>{t("cf.selected", { count: selected.size })}</span>}
                </div>

                <div className={cl("list")}>
                    {!visible.length && <div className={cl("empty")}>{t(search ? "cf.noMatch" : "cf.noFriends")}</div>}
                    {visible.map(f => {
                        const on = selected.has(f.id);
                        const busy = queued.has(f.id);
                        return (
                            <button key={f.id} className={cl("row", on && "row-on", busy && "row-busy")} onClick={() => !busy && toggle(f.id)} role="checkbox" aria-checked={on}>
                                <span className={cl("check", on && "check-on")} />
                                <Avatar src={f.avatar} name={f.name} />
                                <span className={cl("text")}>
                                    <span className={cl("name")}>{f.name}</span>
                                    <span className={cl("sub")}>
                                        {f.username && `@${f.username}`}
                                        {f.since ? ` · ${t("cf.since", { date: new Date(f.since).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" }) })}` : ""}
                                    </span>
                                </span>
                                {busy && <span className={cl("muted")}>{t(s.current?.id === f.id ? "cf.now" : "cf.waiting")}</span>}
                            </button>
                        );
                    })}
                </div>

                <div className={cl("footer")}>
                    <button className={cl("btn")} onClick={() => setFriends(loadFriends())}>{t("cf.refresh")}</button>
                    <span className={cl("spacer")} />
                    <button
                        className={cl("btn", "btn-danger")}
                        disabled={!picked.length}
                        onClick={() => confirmRemove(picked.map(f => ({ id: f.id, name: f.name })), () => setSelected(new Set()))}
                    >
                        {t(s.running ? "cf.addToQueue" : "cf.remove", { count: picked.length })}
                    </button>
                </div>
            </div>
        </Modal>
    );
}

const open = () => openModal(props => (
    <ErrorBoundary>
        <ClearFriendsModal modalProps={props} />
    </ErrorBoundary>
));

function HeaderButton() {
    useLang();
    const s = useEngine();
    return (
        <div className={s.running ? "lc-cf-header-running" : undefined} style={{ display: "contents" }}>
            <HeaderBarIcon
                icon={() => <FriendRemoveIcon />}
                tooltip={s.running ? t("cf.headerRunning", { done: s.done, total: s.total }) : t("cf.title")}
                onClick={open}
                selected={s.running}
            />
        </div>
    );
}

export default definePlugin({
    name: "ClearFriends",
    description: "Remove several friends at once, from a searchable checklist in the top bar.",
    tags: ["Friends", "Utility"],
    authors: [{ name: "0ctane", id: 0n }],
    settings,

    start() {
        setDelay(settings.store.delayMs);
        addHeaderBarButton("ClearFriends", HeaderButton, 6);
    },

    stop() {
        removeHeaderBarButton("ClearFriends");
        stop();
    },
});
