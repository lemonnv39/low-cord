/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Journal affiché dans la fenêtre de réglages du plugin : filtres par type,
// recherche, regroupement par jour, heure exacte de chaque événement.

import { getLang, I18nKey, t, useLang } from "@lowcord/i18n";
import { classNameFactory } from "@utils/css";
import { copyWithToast, openUserProfile } from "@utils/discord";
import { Text, useMemo, useState } from "@webpack/common";

import { clearLog, useLogEntries } from "./log";
import { LogEntry, LogKind } from "./types";

const cl = classNameFactory("lc-rn-");
const PAGE = 50;

type Filter = "all" | LogKind;
const FILTERS: Filter[] = ["all", "friend", "request", "server", "group"];

const isPerson = (kind: LogKind) => kind === "friend" || kind === "request";

function dayKey(ts: number) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function formatDay(ts: number, locale: string) {
    const d = new Date(ts);
    const today = new Date();
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if (dayKey(ts) === dayKey(today.getTime())) return t("rn.log.today");
    if (dayKey(ts) === dayKey(yesterday.getTime())) return t("rn.log.yesterday");
    const label = d.toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    return label.charAt(0).toUpperCase() + label.slice(1);
}

function Row({ entry, locale }: { entry: LogEntry; locale: string; }) {
    const person = isPerson(entry.kind);
    const time = new Date(entry.ts).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

    return (
        <div
            className={cl("row", person && "clickable")}
            onClick={person ? () => openUserProfile(entry.targetId).catch(() => null) : undefined}
            title={person ? t("rn.log.openProfile") : undefined}
        >
            {entry.icon
                ? <img className={cl("avatar", !person && "square")} src={entry.icon} alt="" loading="lazy" />
                : <div className={cl("avatar", "placeholder", !person && "square")}>{entry.name.slice(0, 1).toUpperCase()}</div>}

            <div className={cl("main")}>
                <div className={cl("line")}>
                    <span className={cl("name")}>{entry.name}</span>
                    {entry.username && entry.username !== entry.name && <span className={cl("muted")}>@{entry.username}</span>}
                </div>
                <div className={cl("line")}>
                    <span className={cl("action", entry.kind)}>{t(`rn.log.action.${entry.kind}` as I18nKey)}</span>
                    {entry.offline && <span className={cl("tag")} title={t("rn.log.offlineHint")}>{t("rn.log.offline")}</span>}
                </div>
            </div>

            <div className={cl("meta")}>
                <span className={cl("time")}>{time}</span>
                <span
                    className={cl("id")}
                    title={t("rn.log.copyId")}
                    onClick={e => { e.stopPropagation(); copyWithToast(entry.targetId, t("rn.log.copied")); }}
                >
                    {entry.targetId}
                </span>
            </div>
        </div>
    );
}

export function LogPanel() {
    useLang();
    const entries = useLogEntries();
    const [filter, setFilter] = useState<Filter>("all");
    const [query, setQuery] = useState("");
    const [shown, setShown] = useState(PAGE);
    const [confirmClear, setConfirmClear] = useState(false);

    const locale = getLang() === "fr" ? "fr-FR" : "en-US";

    const counts = useMemo(() => {
        const c: Record<Filter, number> = { all: entries.length, friend: 0, request: 0, server: 0, group: 0 };
        for (const e of entries) c[e.kind]++;
        return c;
    }, [entries]);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        return entries.filter(e =>
            (filter === "all" || e.kind === filter) &&
            (!q || e.name.toLowerCase().includes(q) || e.username?.toLowerCase().includes(q) || e.targetId.includes(q))
        );
    }, [entries, filter, query]);

    const visible = filtered.slice(0, shown);

    // Regroupement par jour (les entrées sont déjà triées, plus récentes d'abord)
    const days: { key: string; label: string; items: LogEntry[]; }[] = [];
    for (const e of visible) {
        const key = dayKey(e.ts);
        const last = days[days.length - 1];
        if (last?.key === key) last.items.push(e);
        else days.push({ key, label: formatDay(e.ts, locale), items: [e] });
    }

    return (
        <div className={cl("panel")}>
            <div className={cl("head")}>
                <Text variant="heading-md/semibold">{t("rn.log.title")}</Text>
                {entries.length > 0 && (
                    <button
                        className={cl("btn", confirmClear && "danger")}
                        onClick={() => {
                            if (!confirmClear) return setConfirmClear(true);
                            clearLog();
                            setConfirmClear(false);
                        }}
                        onMouseLeave={() => setConfirmClear(false)}
                    >
                        {t(confirmClear ? "rn.log.confirmClear" : "rn.log.clear")}
                    </button>
                )}
            </div>

            <div className={cl("filters")}>
                {FILTERS.map(f => (
                    <button
                        key={f}
                        className={cl("chip", filter === f && "active")}
                        onClick={() => { setFilter(f); setShown(PAGE); }}
                    >
                        {t(`rn.log.filter.${f}` as I18nKey)} <span className={cl("count")}>{counts[f]}</span>
                    </button>
                ))}
            </div>

            <input
                className={cl("search")}
                value={query}
                placeholder={t("rn.log.search")}
                onChange={e => { setQuery(e.currentTarget.value); setShown(PAGE); }}
                spellCheck={false}
            />

            {!entries.length
                ? <div className={cl("empty")}>{t("rn.log.empty")}</div>
                : !filtered.length
                    ? <div className={cl("empty")}>{t("rn.log.noMatch")}</div>
                    : (
                        <div className={cl("list")}>
                            {days.map(day => (
                                <div key={day.key} className={cl("day")}>
                                    <div className={cl("day-label")}>
                                        <span>{day.label}</span>
                                        <span className={cl("muted")}>{day.items.length}</span>
                                    </div>
                                    {day.items.map(e => <Row key={e.key} entry={e} locale={locale} />)}
                                </div>
                            ))}
                            {filtered.length > shown && (
                                <button className={cl("btn", "more")} onClick={() => setShown(n => n + PAGE)}>
                                    {t("rn.log.more", { count: filtered.length - shown })}
                                </button>
                            )}
                        </div>
                    )}
        </div>
    );
}
