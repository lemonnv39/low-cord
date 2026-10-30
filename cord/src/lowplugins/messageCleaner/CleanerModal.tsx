/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Message Cleaner — fenêtre principale : choisir où nettoyer, suivre la
// progression, régler la vitesse, consulter l'historique.

import "./style.css";

import ErrorBoundary from "@components/ErrorBoundary";
import { getLang, I18nKey, t, useLang } from "@lowcord/i18n";
import { classNameFactory } from "@utils/css";
import { RenderModalProps } from "@vencord/discord-types";
import { Alerts, ChannelStore, GuildStore, Modal, openModal, RelationshipStore, useEffect, useMemo, UserStore, useState } from "@webpack/common";

import { clearHistory, enqueue, exportHistory, RunRecord, state, stop, subscribe, Target, TargetKind } from "./engine";

const cl = classNameFactory("lc-mc-");

export function useEngine() {
    const [, tick] = useState(0);
    useEffect(() => subscribe(() => tick(n => n + 1)), []);
    return state;
}

// ── Cibles possibles ─────────────────────────────────────────────────────────
interface Row extends Target {
    sub?: string;
}

const avatarOf = (u: any) => u?.getAvatarURL?.(undefined, 64, false) ?? (u?.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.webp?size=64` : undefined);

function privateRows(): Row[] {
    const rows: Row[] = [];
    const withDm = new Set<string>();

    for (const c of ChannelStore.getSortedPrivateChannels()) {
        if (c.isDM()) {
            const userId = c.getRecipientId();
            if (!userId) continue;
            const u = UserStore.getUser(userId);
            withDm.add(userId);
            rows.push({ kind: "dm", id: c.id, name: u?.globalName || u?.username || userId, sub: u?.username ? `@${u.username}` : undefined, icon: avatarOf(u) });
        } else if (c.isMultiUserDM()) {
            const names = c.recipients.map(id => UserStore.getUser(id)?.username).filter(Boolean);
            rows.push({
                kind: "group",
                id: c.id,
                name: c.name || names.join(", ") || c.id,
                sub: t("mc.groupMembers", { count: c.recipients.length + 1 }),
                icon: c.icon ? `https://cdn.discordapp.com/channel-icons/${c.id}/${c.icon}.webp?size=64` : undefined,
            });
        }
    }

    // Amis sans MP ouvert : le MP est ouvert au moment du nettoyage.
    for (const id of RelationshipStore.getFriendIDs()) {
        if (withDm.has(id)) continue;
        const u = UserStore.getUser(id);
        rows.push({ kind: "user", id, name: u?.globalName || u?.username || id, sub: t("mc.friendNoDm"), icon: avatarOf(u) });
    }
    return rows;
}

function serverRows(): Row[] {
    return Object.values(GuildStore.getGuilds())
        .map(g => ({
            kind: "server" as const,
            id: g.id,
            name: g.name,
            icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.webp?size=64` : undefined,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

// ── Confirmation (jamais de suppression sans accord explicite) ───────────────
export function confirmClean(targets: Target[], onDone?: () => void) {
    if (!targets.length) return;
    const names = targets.slice(0, 6).map(t => t.name).join(", ") + (targets.length > 6 ? ` +${targets.length - 6}` : "");
    Alerts.show({
        title: t("mc.confirmTitle"),
        body: (
            <div className={cl("confirm")}>
                <p>{t("mc.confirmBody", { names })}</p>
                <p className={cl("muted")}>{t("mc.confirmNote")}</p>
            </div>
        ),
        confirmText: t("mc.confirmGo"),
        cancelText: t("mc.cancel"),
        confirmColor: "red",
        onConfirm() {
            enqueue(targets);
            onDone?.();
        },
    });
}

// ── Composants ───────────────────────────────────────────────────────────────
function Avatar({ src, name, square }: { src?: string; name: string; square?: boolean; }) {
    const [failed, setFailed] = useState(false);
    if (src && !failed) return <img className={cl("avatar", square && "square")} src={src} alt="" loading="lazy" onError={() => setFailed(true)} />;
    return <div className={cl("avatar", "avatar-empty", square && "square")}>{name.slice(0, 1).toUpperCase()}</div>;
}

const kindLabel: Record<TargetKind, I18nKey> = {
    dm: "mc.kind.dm", user: "mc.kind.dm", group: "mc.kind.group", channel: "mc.kind.channel", server: "mc.kind.server",
};

function duration(ms: number) {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m} min ${s % 60} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function Progress() {
    const s = useEngine();
    const run = s.current;
    if (!s.running && !run) return null;

    const done = run ? run.deleted + run.gone : 0;
    const total = run?.total && run.total > 0 ? Math.max(run.total, done) : undefined;
    const pct = total ? Math.min(100, (done / total) * 100) : undefined;
    const elapsed = run ? Date.now() - run.startedAt : 0;
    const eta = run && total && done > 3 ? (elapsed / done) * (total - done) : undefined;

    return (
        <div className={cl("progress")}>
            <div className={cl("progress-head")}>
                <div className={cl("progress-title")}>
                    <span className={cl("pulse")} />
                    {run ? t("mc.cleaning", { name: run.target.name }) : t("mc.preparing")}
                </div>
                <button className={cl("btn", "btn-stop")} onClick={stop}>{t("mc.stop")}</button>
            </div>
            <div className={cl("bar")}>
                <div className={cl("bar-fill", pct == null && "bar-indeterminate")} style={pct != null ? { width: `${pct}%` } : undefined} />
            </div>
            {run && (
                <div className={cl("stats")}>
                    <span><b>{run.deleted}</b>{total ? ` / ~${total}` : ""} {t("mc.deleted")}</span>
                    {run.gone > 0 && <span>{run.gone} {t("mc.gone")}</span>}
                    {run.skipped > 0 && <span>{run.skipped} {t("mc.skipped")}</span>}
                    {run.failed > 0 && <span className={cl("err")}>{run.failed} {t("mc.failed")}</span>}
                    <span className={cl("spacer")} />
                    {s.penalty > 1.05 && <span className={cl("warn")} title={t("mc.slowedHint")}>{t("mc.slowed")}</span>}
                    {eta != null && <span className={cl("muted")}>{t("mc.eta", { time: duration(eta) })}</span>}
                </div>
            )}
            {s.queue.length > 0 && <div className={cl("muted", "queue")}>{t("mc.queued", { names: s.queue.map(q => q.name).join(", ") })}</div>}
        </div>
    );
}

const PRESETS: { key: I18nKey; ms: number; }[] = [
    { key: "mc.speed.safe", ms: 1500 },
    { key: "mc.speed.normal", ms: 700 },
    { key: "mc.speed.fast", ms: 400 },
];

function Speed({ delay, onChange }: { delay: number; onChange(ms: number): void; }) {
    return (
        <div className={cl("speed")}>
            <span className={cl("speed-label")}>{t("mc.speed")}</span>
            <div className={cl("segmented")}>
                {PRESETS.map(p => (
                    <button key={p.ms} className={cl("seg", delay === p.ms && "seg-on")} onClick={() => onChange(p.ms)}>{t(p.key)}</button>
                ))}
            </div>
            <input
                className={cl("range")}
                type="range"
                min={250}
                max={3000}
                step={50}
                value={delay}
                onChange={e => onChange(Number(e.currentTarget.value))}
                aria-label={t("mc.speed")}
            />
            <span className={cl("speed-value")} title={t("mc.speedHint")}>{t("mc.perMessage", { ms: delay })}</span>
        </div>
    );
}

function Picker({ rows, empty, selected, setSelected }: { rows: Row[]; empty: I18nKey; selected: Set<string>; setSelected(s: Set<string>): void; }) {
    const [search, setSearch] = useState("");
    const q = search.trim().toLowerCase();
    const visible = q ? rows.filter(r => r.name.toLowerCase().includes(q) || r.sub?.toLowerCase().includes(q) || r.id.includes(q)) : rows;
    const keyOf = (r: Row) => `${r.kind}:${r.id}`;
    const allOn = visible.length > 0 && visible.every(r => selected.has(keyOf(r)));

    function toggle(r: Row) {
        const next = new Set(selected);
        if (next.has(keyOf(r))) next.delete(keyOf(r));
        else next.add(keyOf(r));
        setSelected(next);
    }

    function toggleAll() {
        const next = new Set(selected);
        for (const r of visible) allOn ? next.delete(keyOf(r)) : next.add(keyOf(r));
        setSelected(next);
    }

    return (
        <>
            <div className={cl("tools")}>
                <input className={cl("search")} value={search} onChange={e => setSearch(e.currentTarget.value)} placeholder={t("mc.search")} spellCheck={false} />
                <button className={cl("btn")} onClick={toggleAll} disabled={!visible.length}>{t(allOn ? "mc.selectNone" : "mc.selectAll")}</button>
            </div>
            <div className={cl("list")}>
                {!visible.length && <div className={cl("empty")}>{t(q ? "mc.noMatch" : empty)}</div>}
                {visible.map(r => {
                    const on = selected.has(keyOf(r));
                    return (
                        <button key={keyOf(r)} className={cl("row", on && "row-on")} onClick={() => toggle(r)} role="checkbox" aria-checked={on}>
                            <span className={cl("check", on && "check-on")} />
                            <Avatar src={r.icon} name={r.name} square={r.kind === "server" || r.kind === "group"} />
                            <span className={cl("row-text")}>
                                <span className={cl("row-name")}>{r.name}</span>
                                {r.sub && <span className={cl("row-sub")}>{r.sub}</span>}
                            </span>
                        </button>
                    );
                })}
            </div>
        </>
    );
}

function History() {
    const s = useEngine();
    const locale = getLang() === "fr" ? "fr-FR" : "en-US";

    function save() {
        const blob = new Blob([exportHistory()], { type: "text/plain" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `low-cord-cleaner-${new Date().toISOString().slice(0, 10)}.txt`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    return (
        <>
            <div className={cl("tools")}>
                <span className={cl("muted")}>{t("mc.historyHint")}</span>
                <span className={cl("spacer")} />
                <button className={cl("btn")} onClick={save} disabled={!s.history.length}>{t("mc.export")}</button>
                <button className={cl("btn", "btn-danger")} onClick={clearHistory} disabled={!s.history.length || s.running}>{t("mc.clearHistory")}</button>
            </div>
            <div className={cl("list")}>
                {!s.history.length && <div className={cl("empty")}>{t("mc.noHistory")}</div>}
                {s.history.map((r: RunRecord) => (
                    <div key={r.key} className={cl("hist", `hist-${r.status}`)}>
                        <Avatar src={r.target.icon} name={r.target.name} square={r.target.kind === "server" || r.target.kind === "group"} />
                        <div className={cl("row-text")}>
                            <span className={cl("row-name")}>
                                {r.target.name}
                                <span className={cl("tag")}>{t(kindLabel[r.target.kind])}</span>
                                <span className={cl("tag", `status-${r.status}`)}>{t(`mc.status.${r.status}` as I18nKey)}</span>
                            </span>
                            <span className={cl("row-sub")}>
                                {new Date(r.startedAt).toLocaleString(locale, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                                {r.endedAt ? ` · ${duration(r.endedAt - r.startedAt)}` : ""}
                                {" · "}{r.deleted} {t("mc.deleted")}
                                {r.gone ? ` · ${r.gone} ${t("mc.gone")}` : ""}
                                {r.skipped ? ` · ${r.skipped} ${t("mc.skipped")}` : ""}
                                {r.failed ? ` · ${r.failed} ${t("mc.failed")}` : ""}
                                {r.error ? ` · ${r.error}` : ""}
                            </span>
                        </div>
                    </div>
                ))}
            </div>
        </>
    );
}

type Tab = "private" | "servers" | "channels" | "history";

function CleanerModal({ modalProps, delay, setDelay }: { modalProps: RenderModalProps; delay: number; setDelay(ms: number): void; }) {
    useLang();
    const s = useEngine();
    const [tab, setTab] = useState<Tab>("private");
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [ids, setIds] = useState("");
    const [speed, setSpeed] = useState(delay);

    const priv = useMemo(privateRows, []);
    const servers = useMemo(serverRows, []);

    function changeSpeed(ms: number) {
        setSpeed(ms);
        setDelay(ms);
    }

    const channelTargets: Target[] = ids.split(/[\s,;]+/).filter(id => /^\d{15,25}$/.test(id)).map(id => {
        const c = ChannelStore.getChannel(id);
        return { kind: c && !c.guild_id ? (c.isMultiUserDM() ? "group" : "dm") : "channel", id, name: c?.name ? `#${c.name}` : t("mc.channelId", { id }) };
    });

    const picked: Target[] = tab === "channels"
        ? channelTargets
        : [...priv, ...servers].filter(r => selected.has(`${r.kind}:${r.id}`));

    function start() {
        confirmClean(picked, () => {
            setSelected(new Set());
            setIds("");
        });
    }

    const TABS: { id: Tab; key: I18nKey; }[] = [
        { id: "private", key: "mc.tab.private" },
        { id: "servers", key: "mc.tab.servers" },
        { id: "channels", key: "mc.tab.channels" },
        { id: "history", key: "mc.tab.history" },
    ];

    return (
        <Modal {...modalProps} size="lg" title={t("mc.title")} subtitle={t("mc.subtitle")}>
            <div className={cl("root")}>
                <Progress />

                <div className={cl("tabs")}>
                    {TABS.map(x => (
                        <button key={x.id} className={cl("tab", tab === x.id && "tab-on")} onClick={() => setTab(x.id)}>
                            {t(x.key)}
                            {x.id === "history" && s.history.length > 0 && <span className={cl("count")}>{s.history.length}</span>}
                        </button>
                    ))}
                </div>

                <div className={cl("body")}>
                    {tab === "private" && <Picker rows={priv} empty="mc.noPrivate" selected={selected} setSelected={setSelected} />}
                    {tab === "servers" && <Picker rows={servers} empty="mc.noServers" selected={selected} setSelected={setSelected} />}
                    {tab === "channels" && (
                        <div className={cl("ids")}>
                            <label className={cl("ids-label")}>{t("mc.idsLabel")}</label>
                            <textarea className={cl("textarea")} value={ids} onChange={e => setIds(e.currentTarget.value)} placeholder="123456789012345678, 987654321098765432" spellCheck={false} />
                            <span className={cl("muted")}>{t("mc.idsHint", { count: channelTargets.length })}</span>
                        </div>
                    )}
                    {tab === "history" && <History />}
                </div>

                {tab !== "history" && (
                    <div className={cl("footer")}>
                        <Speed delay={speed} onChange={changeSpeed} />
                        <button className={cl("btn", "btn-primary")} disabled={!picked.length} onClick={start}>
                            {s.running ? t("mc.addToQueue", { count: picked.length }) : t("mc.start", { count: picked.length })}
                        </button>
                    </div>
                )}
            </div>
        </Modal>
    );
}

export function openCleaner(delay: number, setDelay: (ms: number) => void) {
    openModal(props => (
        <ErrorBoundary>
            <CleanerModal modalProps={props} delay={delay} setDelay={setDelay} />
        </ErrorBoundary>
    ));
}
