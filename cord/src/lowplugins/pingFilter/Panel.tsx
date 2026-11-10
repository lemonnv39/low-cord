/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// PingFilter — panneau des réglages du plugin : choix, options, serveurs
// exclus, application avec barre de progression, récapitulatif et journal.

import { t, useLang } from "@lowcord/i18n";
import { IconUtils, NavigationRouter, useEffect, useMemo, useRef, useState } from "@webpack/common";

import { allGuilds, applyToAll, getBackup, Options, Profile, Progress, restoreBackup, RunResult } from "./apply";
import { addRun, clearLogs, GhostLog, useLogs } from "./logs";
import { currentOptions, settings } from "./settings";

const PROFILES: { id: Profile; label: Parameters<typeof t>[0]; hint: Parameters<typeof t>[0]; }[] = [
    { id: "mentions", label: "pf.p.mentions", hint: "pf.p.mentionsHint" },
    { id: "mentionsEveryone", label: "pf.p.mentionsEveryone", hint: "pf.p.mentionsEveryoneHint" },
    { id: "none", label: "pf.p.none", hint: "pf.p.noneHint" },
    { id: "all", label: "pf.p.all", hint: "pf.p.allHint" },
    { id: "default", label: "pf.p.default", hint: "pf.p.defaultHint" },
];

/** Phrases du récapitulatif, d'après ce qui a été appliqué. */
function recapLines(o: Options, r: RunResult) {
    const lines: string[] = [];
    const roles = o.includeRoles ? t("pf.r.rolesYes") : t("pf.r.rolesNo");
    switch (o.profile) {
        case "mentions": lines.push(t("pf.r.mentions"), roles, t("pf.r.noEveryone")); break;
        case "mentionsEveryone": lines.push(t("pf.r.mentionsEveryone"), roles); break;
        case "none": lines.push(t("pf.r.none")); break;
        case "all": lines.push(t("pf.r.all")); break;
        case "default": lines.push(t("pf.r.default")); break;
    }
    lines.push(t(o.muteServers ? "pf.r.muted" : "pf.r.unmuted"));
    if (r.resetChannels) lines.push(t("pf.r.channels", { n: r.resetChannels }));
    if (!o.mobilePush) lines.push(t("pf.r.noPush"));
    if (o.noHighlights) lines.push(t("pf.r.noHighlights"));
    lines.push(t("pf.r.dms"));
    return lines;
}

function Check({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange(v: boolean): void; label: string; hint?: string; disabled?: boolean; }) {
    return (
        <label className={`lc-pf-check${disabled ? " lc-pf-disabled" : ""}`}>
            <input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.currentTarget.checked)} />
            <span className="lc-pf-box" aria-hidden="true" />
            <span className="lc-pf-check-text">
                <span>{label}</span>
                {hint && <small>{hint}</small>}
            </span>
        </label>
    );
}

function ServerPicker({ disabled }: { disabled: boolean; }) {
    useLang();
    const { excluded } = settings.use(["excluded"]);
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");
    const guilds = useMemo(allGuilds, [open]);
    const ex = new Set(excluded ?? []);
    const shown = search.trim() ? guilds.filter(g => g.name.toLowerCase().includes(search.toLowerCase())) : guilds;
    const toggle = (id: string) => {
        const next = new Set(ex);
        if (next.has(id)) next.delete(id); else next.add(id);
        settings.store.excluded = [...next];
    };
    const targets = guilds.filter(g => !ex.has(g.id)).length;
    return (
        <div className="lc-pf-servers">
            <button className="lc-pf-row-btn" onClick={() => setOpen(!open)} disabled={disabled}>
                <span>{t("pf.servers", { n: targets, total: guilds.length })}</span>
                {ex.size > 0 && <span className="lc-pf-muted">{t("pf.excluded", { n: ex.size })}</span>}
                <span className="lc-pf-chevron" aria-hidden="true">{open ? "▴" : "▾"}</span>
            </button>
            {open && (
                <div className="lc-pf-picker">
                    <div className="lc-pf-picker-bar">
                        <input className="lc-pf-input" placeholder={t("pf.search")} value={search} onChange={e => setSearch(e.currentTarget.value)} />
                        <button className="lc-pf-mini" onClick={() => { settings.store.excluded = []; }}>{t("pf.all")}</button>
                        <button className="lc-pf-mini" onClick={() => { settings.store.excluded = guilds.map(g => g.id); }}>{t("pf.none")}</button>
                    </div>
                    <div className="lc-pf-list">
                        {shown.map(g => {
                            const icon = g.icon ? IconUtils.getGuildIconURL({ id: g.id, icon: g.icon, size: 32 }) : null;
                            const on = !ex.has(g.id);
                            return (
                                <button key={g.id} className={`lc-pf-guild${on ? " lc-pf-guild-on" : ""}`} onClick={() => toggle(g.id)}>
                                    {icon ? <img src={icon} alt="" /> : <span className="lc-pf-guild-ph">{g.name.slice(0, 2)}</span>}
                                    <span className="lc-pf-guild-name">{g.name}</span>
                                    <span className="lc-pf-guild-state">{on ? "✓" : t("pf.skip")}</span>
                                </button>
                            );
                        })}
                        {!shown.length && <div className="lc-pf-muted lc-pf-empty">{t("pf.noResult")}</div>}
                    </div>
                </div>
            )}
        </div>
    );
}

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

function GhostRow({ g }: { g: GhostLog; }) {
    const go = () => NavigationRouter.transitionTo(`/channels/${g.guildId ?? "@me"}/${g.channelId}`);
    return (
        <li className="lc-pf-log-item">
            <div className="lc-pf-log-head">
                <b>{g.author}</b>
                <span className={`lc-pf-tag lc-pf-tag-${g.kind}`}>{t(g.kind === "delete" ? "pf.g.deleted" : "pf.g.edited")}</span>
                <span className="lc-pf-tag">{t(g.target === "me" ? "pf.g.me" : g.target === "role" ? "pf.g.role" : "pf.g.everyone")}</span>
                <span className="lc-pf-muted">{when(g.at)}</span>
            </div>
            <button className="lc-pf-link" onClick={go}>{g.guild ? `${g.guild} · ` : ""}{g.channel}</button>
            {g.content && <div className="lc-pf-quote">{g.content}</div>}
        </li>
    );
}

function Journal() {
    useLang();
    const { runs, ghosts } = useLogs();
    const { ghostWatch, ghostToast } = settings.use(["ghostWatch", "ghostToast"]);
    const [open, setOpen] = useState(false);
    const [tab, setTab] = useState<"ghosts" | "runs">("ghosts");
    return (
        <div className="lc-pf-journal">
            <button className="lc-pf-row-btn" onClick={() => setOpen(!open)}>
                <span>{t("pf.journal")}</span>
                <span className="lc-pf-muted">{t("pf.journalCount", { g: ghosts.length, r: runs.length })}</span>
                <span className="lc-pf-chevron" aria-hidden="true">{open ? "▴" : "▾"}</span>
            </button>
            {open && (
                <div className="lc-pf-journal-body">
                    <div className="lc-pf-tabs" role="tablist">
                        <button role="tab" aria-selected={tab === "ghosts"} className={tab === "ghosts" ? "lc-pf-tab-on" : undefined} onClick={() => setTab("ghosts")}>{t("pf.tabGhosts", { n: ghosts.length })}</button>
                        <button role="tab" aria-selected={tab === "runs"} className={tab === "runs" ? "lc-pf-tab-on" : undefined} onClick={() => setTab("runs")}>{t("pf.tabRuns", { n: runs.length })}</button>
                        <span className="lc-pf-spacer" />
                        <button className="lc-pf-mini" onClick={() => clearLogs(tab)}>{t("pf.clear")}</button>
                    </div>
                    {tab === "ghosts" ? (
                        <>
                            <Check checked={ghostWatch} onChange={v => { settings.store.ghostWatch = v; }} label={t("pf.ghostWatch")} hint={t("pf.ghostWatchHint")} />
                            <Check checked={ghostToast} disabled={!ghostWatch} onChange={v => { settings.store.ghostToast = v; }} label={t("pf.ghostToast")} />
                            {ghosts.length
                                ? <ul className="lc-pf-log">{ghosts.map((g, i) => <GhostRow key={i} g={g} />)}</ul>
                                : <div className="lc-pf-muted lc-pf-empty">{t("pf.noGhosts")}</div>}
                        </>
                    ) : runs.length ? (
                        <ul className="lc-pf-log">
                            {runs.map((r, i) => (
                                <li key={i} className="lc-pf-log-item">
                                    <div className="lc-pf-log-head">
                                        <b>{r.kind === "restore" ? t("pf.runRestore") : t(PROFILES.find(p => p.id === r.profile)?.label ?? "pf.p.mentions")}</b>
                                        <span className="lc-pf-muted">{when(r.at)}</span>
                                    </div>
                                    <div className="lc-pf-muted">
                                        {t("pf.runSummary", { ok: r.ok, total: r.total })}
                                        {r.stopped && ` · ${t("pf.stopped")}`}
                                    </div>
                                    {r.failed.map((f, j) => <div key={j} className="lc-pf-error-line">{f.name} : {f.error}</div>)}
                                </li>
                            ))}
                        </ul>
                    ) : <div className="lc-pf-muted lc-pf-empty">{t("pf.noRuns")}</div>}
                </div>
            )}
        </div>
    );
}

export function Panel() {
    useLang();
    const s = settings.use(["profile", "includeRoles", "muteServers", "mobilePush", "noHighlights", "excluded"]);
    const [running, setRunning] = useState<"apply" | "restore" | null>(null);
    const [progress, setProgress] = useState<Progress | null>(null);
    const [done, setDone] = useState<{ options: Options; result: RunResult; restored?: boolean; } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [hasBackup, setHasBackup] = useState(false);
    const signal = useRef({ stopped: false });

    useEffect(() => { getBackup().then(b => setHasBackup(!!b)); }, [running]);
    // Panneau fermé pendant l'application : on s'arrête proprement.
    useEffect(() => () => { signal.current.stopped = true; }, []);

    const total = allGuilds().filter(g => !(s.excluded ?? []).includes(g.id)).length;
    const set = <K extends keyof typeof s>(k: K) => (v: any) => { (settings.store as any)[k] = v; };

    const run = async (kind: "apply" | "restore") => {
        signal.current = { stopped: false };
        setRunning(kind);
        setDone(null);
        setError(null);
        setProgress({ done: 0, total: 0, current: "" });
        const options = currentOptions();
        try {
            const result = kind === "apply"
                ? await applyToAll(options, setProgress, signal.current)
                : await restoreBackup(setProgress, signal.current);
            addRun({ at: Date.now(), kind, profile: options.profile, total: result.ok.length + result.failed.length, ok: result.ok.length, failed: result.failed.map(f => ({ name: f.name, error: f.error })), stopped: result.stopped });
            setDone({ options, result, restored: kind === "restore" });
        } catch (e: any) {
            setError(String(e?.message ?? e));
        } finally {
            setRunning(null);
            setProgress(null);
        }
    };

    const pct = progress?.total ? Math.round((progress.done / progress.total) * 100) : 0;
    const roleOption = s.profile === "mentions" || s.profile === "mentionsEveryone";

    return (
        <div className="lc-pf">
            <p className="lc-pf-intro">{t("pf.intro")}</p>

            <div className="lc-pf-label">{t("pf.when")}</div>
            <div className="lc-pf-profiles" role="radiogroup">
                {PROFILES.map(p => (
                    <button key={p.id} role="radio" aria-checked={s.profile === p.id} disabled={!!running}
                        className={`lc-pf-profile${s.profile === p.id ? " lc-pf-profile-on" : ""}`} onClick={() => set("profile")(p.id)}>
                        <span className="lc-pf-radio" aria-hidden="true" />
                        <span className="lc-pf-profile-text">
                            <span>{t(p.label)}</span>
                            <small>{t(p.hint)}</small>
                        </span>
                    </button>
                ))}
            </div>

            <div className="lc-pf-label">{t("pf.options")}</div>
            <div className="lc-pf-options">
                <Check checked={s.includeRoles} disabled={!roleOption || !!running} onChange={set("includeRoles")} label={t("pf.o.roles")} hint={t("pf.o.rolesHint")} />
                <Check checked={s.muteServers} disabled={!!running} onChange={set("muteServers")} label={t("pf.o.mute")} hint={t("pf.o.muteHint")} />
                <Check checked={s.mobilePush} disabled={!!running} onChange={set("mobilePush")} label={t("pf.o.push")} hint={t("pf.o.pushHint")} />
                <Check checked={s.noHighlights} disabled={!!running} onChange={set("noHighlights")} label={t("pf.o.highlights")} hint={t("pf.o.highlightsHint")} />
            </div>

            <div className="lc-pf-label">{t("pf.serversLabel")}</div>
            <ServerPicker disabled={!!running} />

            {running && progress && (
                <div className="lc-pf-progress">
                    <div className="lc-pf-progress-head">
                        <span>{t(running === "apply" ? "pf.applying" : "pf.restoring")}</span>
                        <span className="lc-pf-num">{progress.done}/{progress.total || total} · {pct} %</span>
                    </div>
                    <div className="lc-pf-bar"><span className="lc-pf-bar-fill" style={{ width: `${pct}%` }} /></div>
                    {progress.current && <div className="lc-pf-muted lc-pf-current">{progress.current}</div>}
                </div>
            )}

            {error && <div className="lc-pf-error">{error}</div>}

            {done && !running && (
                <div className="lc-pf-recap">
                    <div className="lc-pf-recap-title">
                        {done.restored ? t("pf.restored") : t("pf.recapTitle")}
                    </div>
                    {!done.restored && <ul>{recapLines(done.options, done.result).map((l, i) => <li key={i}>{l}</li>)}</ul>}
                    <div className="lc-pf-recap-foot">
                        {t("pf.runSummary", { ok: done.result.ok.length, total: done.result.ok.length + done.result.failed.length })}
                        {done.result.failed.length > 0 && <span className="lc-pf-error-inline"> · {t("pf.failed", { n: done.result.failed.length })}</span>}
                        {done.result.stopped && ` · ${t("pf.stopped")}`}
                    </div>
                </div>
            )}

            <div className="lc-pf-actions">
                {running ? (
                    <button className="lc-pf-btn" onClick={() => { signal.current.stopped = true; }}>{t("pf.stop")}</button>
                ) : (
                    <>
                        {hasBackup && <button className="lc-pf-btn" onClick={() => run("restore")}>{t("pf.undo")}</button>}
                        <button className="lc-pf-btn lc-pf-btn-primary" disabled={!total} onClick={() => run("apply")}>{t("pf.apply", { n: total })}</button>
                    </>
                )}
            </div>

            <Journal />
        </div>
    );
}
