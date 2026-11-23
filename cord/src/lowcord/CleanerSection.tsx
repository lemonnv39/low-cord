/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — section « Cleaner » de l'onglet low-cord : recherche par ID,
// actions de masse, liste à garder, vitesse, avancement en direct.

import { useSettings } from "@api/Settings";
import { Forms } from "@lowcord/compat";
import { confirmClean, useEngine } from "@lowplugins/messageCleaner/CleanerModal";
import { stop as stopMessages, Target } from "@lowplugins/messageCleaner/engine";
import { classNameFactory } from "@utils/css";
import { Alerts, ChannelStore, GuildStore, RelationshipStore, useEffect, useState, useStateFromStores } from "@webpack/common";

import {
    ActionKind, Found, getKeepRaw, Item, itemsFor, listServers, messageTargets, REL, resolveId,
    runAction, setFast, setKeepRaw, state as actionState, stop as stopActions, subscribe,
} from "./cleaner";
import { I18nKey, t } from "./i18n";

const cl = classNameFactory("lc-cl-");
const ocl = classNameFactory("lc-opt-");

function useActions() {
    const [, tick] = useState(0);
    useEffect(() => subscribe(() => tick(n => n + 1)), []);
    return actionState;
}

// ── Confirmations ────────────────────────────────────────────────────────────
function names(items: { name: string; }[]) {
    return items.slice(0, 8).map(i => i.name).join(", ") + (items.length > 8 ? ` +${items.length - 8}` : "");
}

function confirmAction(action: ActionKind, items: Item[] = itemsFor(action)) {
    if (!items.length) return;
    Alerts.show({
        title: t(`cl.a.${action}` as I18nKey),
        body: (
            <div className={cl("confirm")}>
                <p>{t("cl.confirmBody", { count: items.length, names: names(items) })}</p>
                <p className={cl("muted")}>{t("cl.confirmNote")}</p>
            </div>
        ),
        confirmText: t("cl.go"),
        cancelText: t("mc.cancel"),
        confirmColor: "red",
        onConfirm: () => void runAction(action, items),
    });
}

// ── Recherche par ID ─────────────────────────────────────────────────────────
function Icon({ src, name }: { src?: string; name: string; }) {
    const [failed, setFailed] = useState(false);
    if (src && !failed) return <img className={cl("icon")} src={src} alt="" onError={() => setFailed(true)} />;
    return <div className={cl("icon", "icon-text")}>{name.replace(/^#/, "").slice(0, 2).toUpperCase()}</div>;
}

function Btn({ label, onClick, danger, disabled }: { label: string; onClick(): void; danger?: boolean; disabled?: boolean; }) {
    return <button className={cl("btn", danger && "btn-danger")} onClick={onClick} disabled={disabled}>{label}</button>;
}

function FoundCard({ f, busy }: { f: Found; busy: boolean; }) {
    const clean = (target: Target) => confirmClean([target]);
    const one = (action: ActionKind, id: string) => confirmAction(action, [{ id, name: f.name }]);
    const buttons: React.ReactElement[] = [];

    switch (f.kind) {
        case "server":
            buttons.push(<Btn key="c" label={t("cl.f.cleanServer")} onClick={() => clean({ kind: "server", id: f.id, name: f.name })} />);
            if (!f.owner) buttons.push(<Btn key="l" danger disabled={busy} label={t("cl.f.leave")} onClick={() => one("leaveServers", f.id)} />);
            break;
        case "channel":
            buttons.push(<Btn key="c" label={t("cl.f.cleanChannel")} onClick={() => clean({ kind: "channel", id: f.id, name: f.name })} />);
            if (f.guildId && GuildStore.getGuild(f.guildId)) {
                buttons.push(<Btn key="s" label={t("cl.f.cleanServer")} onClick={() => clean({ kind: "server", id: f.guildId!, name: f.sub ?? f.guildId! })} />);
            }
            break;
        case "group":
            buttons.push(<Btn key="c" label={t("cl.f.cleanConv")} onClick={() => clean({ kind: "group", id: f.id, name: f.name })} />);
            buttons.push(<Btn key="l" danger disabled={busy} label={t("cl.f.leaveGroup")} onClick={() => one("leaveGroups", f.id)} />);
            break;
        case "dm":
        case "user": {
            const userId = f.kind === "user" ? f.id : f.sub!;
            buttons.push(<Btn key="c" label={t("cl.f.cleanConv")} onClick={() => clean(f.dmId ? { kind: "dm", id: f.dmId, name: f.name } : { kind: "user", id: userId, name: f.name })} />);
            if (f.dmId) buttons.push(<Btn key="d" disabled={busy} label={t("cl.f.closeDm")} onClick={() => one("closeDms", f.dmId!)} />);
            if (f.relation === REL.FRIEND) buttons.push(<Btn key="f" danger disabled={busy} label={t("cl.f.unfriend")} onClick={() => one("removeFriends", userId)} />);
            if (f.relation === REL.OUTGOING) buttons.push(<Btn key="o" disabled={busy} label={t("cl.f.cancelRequest")} onClick={() => one("cancelOutgoing", userId)} />);
            if (f.relation === REL.INCOMING) buttons.push(<Btn key="i" disabled={busy} label={t("cl.f.refuse")} onClick={() => one("refuseIncoming", userId)} />);
            if (f.relation === REL.BLOCKED) buttons.push(<Btn key="b" disabled={busy} label={t("cl.f.unblock")} onClick={() => one("unblockAll", userId)} />);
            break;
        }
    }

    return (
        <div className={cl("found")}>
            <Icon src={f.icon} name={f.name} />
            <div className={ocl("text")}>
                <div className={ocl("name")}>
                    {f.name}
                    <span className={ocl("gain")}>{t(`cl.k.${f.kind}` as I18nKey)}</span>
                    {f.owner && <span className={ocl("extra")}>{t("cl.owner")}</span>}
                </div>
                <div className={ocl("desc")}>{f.sub && f.sub !== f.name ? `${f.sub} · ` : ""}{f.id}</div>
            </div>
            <div className={cl("found-actions")}>{buttons}</div>
        </div>
    );
}

function IdSearch({ busy }: { busy: boolean; }) {
    const [query, setQuery] = useState("");
    const [found, setFound] = useState<Found | null | "none" | "loading">(null);

    useEffect(() => {
        const id = query.match(/\d{15,21}/)?.[0];
        if (!id) return void setFound(null);
        let alive = true;
        setFound("loading");
        const timer = setTimeout(() => {
            resolveId(id).then(f => alive && setFound(f ?? "none")).catch(() => alive && setFound("none"));
        }, 300);
        return () => { alive = false; clearTimeout(timer); };
    }, [query]);

    return (
        <div className={cl("search")}>
            <input
                className={cl("input")}
                placeholder={t("cl.searchPlaceholder")}
                value={query}
                onChange={e => setQuery(e.currentTarget.value)}
                spellCheck={false}
            />
            {found === "loading" && <div className={cl("muted", "pad")}>{t("cl.searching")}</div>}
            {found === "none" && <div className={cl("muted", "pad")}>{t("cl.notFound")}</div>}
            {found && typeof found === "object" && <FoundCard f={found} busy={busy} />}
        </div>
    );
}

// ── Actions de masse ─────────────────────────────────────────────────────────
interface Bulk { key: string; label: I18nKey; desc: I18nKey; count: number; run(): void; danger?: boolean; }

function useCounts() {
    return useStateFromStores([GuildStore, ChannelStore, RelationshipStore], () => {
        const rel = { 1: 0, 2: 0, 3: 0, 4: 0 } as Record<number, number>;
        for (const [, type] of RelationshipStore.getMutableRelationships()) rel[type] = (rel[type] ?? 0) + 1;
        const priv = ChannelStore.getSortedPrivateChannels() as any[];
        return {
            servers: Object.keys(GuildStore.getGuilds()).length,
            dms: priv.filter(c => c.type === 1).length,
            groups: priv.filter(c => c.type === 3).length,
            friends: rel[REL.FRIEND], blocked: rel[REL.BLOCKED], incoming: rel[REL.INCOMING], outgoing: rel[REL.OUTGOING],
        };
    });
}

function BulkGrid({ busy }: { busy: boolean; }) {
    const c = useCounts();
    const { owned } = listServers();

    const list: Bulk[] = [
        { key: "mp", label: "cl.b.cleanPrivate", desc: "cl.b.cleanPrivate.desc", count: c.dms + c.groups, run: () => confirmClean(messageTargets("private")) },
        { key: "ms", label: "cl.b.cleanServers", desc: "cl.b.cleanServers.desc", count: c.servers, run: () => confirmClean(messageTargets("servers")) },
        { key: "ls", label: "cl.a.leaveServers", desc: "cl.b.leaveServers.desc", count: c.servers - owned, run: () => confirmAction("leaveServers"), danger: true },
        { key: "lg", label: "cl.a.leaveGroups", desc: "cl.b.leaveGroups.desc", count: c.groups, run: () => confirmAction("leaveGroups"), danger: true },
        { key: "cd", label: "cl.a.closeDms", desc: "cl.b.closeDms.desc", count: c.dms, run: () => confirmAction("closeDms") },
        { key: "rf", label: "cl.a.removeFriends", desc: "cl.b.removeFriends.desc", count: c.friends, run: () => confirmAction("removeFriends"), danger: true },
        { key: "co", label: "cl.a.cancelOutgoing", desc: "cl.b.cancelOutgoing.desc", count: c.outgoing, run: () => confirmAction("cancelOutgoing") },
        { key: "ri", label: "cl.a.refuseIncoming", desc: "cl.b.refuseIncoming.desc", count: c.incoming, run: () => confirmAction("refuseIncoming") },
        { key: "ub", label: "cl.a.unblockAll", desc: "cl.b.unblockAll.desc", count: c.blocked, run: () => confirmAction("unblockAll") },
    ];

    return (
        <div className={cl("grid")}>
            {list.map(b => (
                <button
                    key={b.key}
                    className={cl("tile", b.danger && "tile-danger")}
                    disabled={busy || !b.count}
                    onClick={b.run}
                >
                    <span className={cl("tile-head")}>
                        <span className={cl("tile-name")}>{t(b.label)}</span>
                        <span className={ocl("gain")}>{b.count}</span>
                    </span>
                    <span className={cl("tile-desc")}>{t(b.desc)}</span>
                </button>
            ))}
        </div>
    );
}

// ── Avancement ───────────────────────────────────────────────────────────────
function Progress() {
    const a = useActions();
    const m = useEngine();
    const run = m.current;

    if (!a.running && !m.running && !a.last) return null;

    return (
        <div className={cl("progress")}>
            {a.running && (
                <div className={cl("prow")}>
                    <span className={cl("dot")} />
                    <div className={ocl("text")}>
                        <div className={ocl("name")}>{t(`cl.a.${a.action}` as I18nKey)} — {a.done}/{a.total}</div>
                        <div className={ocl("desc")}>
                            {a.current?.name}{a.slowed ? ` · ${t("cl.slowed")}` : ""}{a.failed.length ? ` · ${t("cl.failed", { count: a.failed.length })}` : ""}
                        </div>
                        <div className={cl("bar")}><div style={{ width: `${(a.done / Math.max(1, a.total)) * 100}%` }} /></div>
                    </div>
                    <Btn danger label={t("cl.stop")} onClick={stopActions} />
                </div>
            )}
            {!a.running && a.last && (
                <div className={cl("prow", "muted")}>
                    {t("cl.lastDone", { action: t(`cl.a.${a.last.action}` as I18nKey), done: a.last.done, failed: a.last.failed })}
                    {a.last.stopped ? ` · ${t("cl.stopped")}` : ""}
                </div>
            )}
            {m.running && (
                <div className={cl("prow")}>
                    <span className={cl("dot")} />
                    <div className={ocl("text")}>
                        <div className={ocl("name")}>
                            {t("cl.messages")} — {run?.target.name ?? "…"}
                        </div>
                        <div className={ocl("desc")}>
                            {run?.phase === "backup"
                                ? t("cl.backup")
                                : t("cl.msgProgress", { deleted: run?.deleted ?? 0, total: run?.total ?? "?", queue: m.queue.length })}
                            {m.penalty > 1.2 ? ` · ${t("cl.slowed")}` : ""}
                        </div>
                        {run?.total ? <div className={cl("bar")}><div style={{ width: `${Math.min(100, (run.deleted / run.total) * 100)}%` }} /></div> : null}
                    </div>
                    <Btn danger label={t("cl.stop")} onClick={stopMessages} />
                </div>
            )}
        </div>
    );
}

// ── Section ──────────────────────────────────────────────────────────────────
export function CleanerSection() {
    const s = useSettings(["plugins.Settings.lowcordCleanerFast", "plugins.Settings.lowcordCleanerKeep"] as any);
    const fast = (s.plugins.Settings as any)?.lowcordCleanerFast === true;
    const [keep, setKeep] = useState(getKeepRaw);
    const a = useActions();

    return (
        <section>
            <Forms.FormTitle tag="h5">{t("cl.title")}</Forms.FormTitle>
            <Forms.FormText className={ocl("hint")}>{t("cl.hint")}</Forms.FormText>

            <div className={ocl("card")}>
                <div className={ocl("row", "main")}>
                    <div className={ocl("text")}>
                        <div className={ocl("name")}>{t("cl.search")}</div>
                        <div className={ocl("desc")}>{t("cl.searchDesc")}</div>
                        <IdSearch busy={a.running} />
                    </div>
                </div>

                <div className={ocl("row")}>
                    <div className={ocl("text")}>
                        <div className={ocl("name")}>{t("cl.speed")}</div>
                        <div className={ocl("desc")}>{t(fast ? "cl.speed.fast.desc" : "cl.speed.safe.desc")}</div>
                    </div>
                    <div className="lc-segmented" role="radiogroup" aria-label={t("cl.speed")}>
                        <button role="radio" aria-checked={!fast} className={`lc-segment${!fast ? " lc-segment-on" : ""}`} onClick={() => setFast(false)}>{t("cl.speed.safe")}</button>
                        <button role="radio" aria-checked={fast} className={`lc-segment${fast ? " lc-segment-on" : ""}`} onClick={() => setFast(true)}>{t("cl.speed.fast")}</button>
                    </div>
                </div>

                <div className={ocl("row")}>
                    <div className={ocl("text")}>
                        <div className={ocl("name")}>{t("cl.keep")}</div>
                        <div className={ocl("desc")}>{t("cl.keepDesc")}</div>
                        <textarea
                            className={cl("input", "keep")}
                            rows={2}
                            placeholder="123456789012345678, 987654321098765432"
                            value={keep}
                            onChange={e => { setKeep(e.currentTarget.value); setKeepRaw(e.currentTarget.value); }}
                            spellCheck={false}
                        />
                    </div>
                </div>

                <div className={cl("bulk")}>
                    <BulkGrid busy={a.running} />
                </div>

                <Progress />
            </div>
        </section>
    );
}
