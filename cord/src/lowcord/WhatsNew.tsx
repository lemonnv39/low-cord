/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — fenêtre « Quoi de neuf ». Trois usages :
//  - « installed » : au premier démarrage après une mise à jour ;
//  - « upcoming »  : ce qu'apporte la version prête (clic droit sur la flèche
//    verte, ou réglages), avec un bouton pour l'installer ;
//  - « latest »    : les nouveautés de la version installée, depuis les réglages.
// Le contenu vient des commits publiés entre les deux versions : nouveautés
// (feat), améliorations, corrections (fix). Les commits internes (injecteur,
// low-sound, CI, docs) sont masqués.

import "./styles.css";

import type { ChangeEntry, Changes } from "@main/lowcordUpdater";
import { classNameFactory } from "@utils/css";
import { Modal, openModal, useEffect, useState } from "@webpack/common";

import { getLang, t, useLang } from "./i18n";
import { installAndRestart, useUpdateState } from "./update";

const cl = classNameFactory("lc-wn-");

type Kind = "new" | "improve" | "fix";
type Mode = "installed" | "upcoming" | "latest";

interface Point {
    text: string;
    /** sous-titre (« AntiMoveDeco : ») plutôt qu'un point */
    head?: boolean;
}

interface Item {
    kind: Kind;
    /** partie concernée (« low-sound », « onglet Plugins »…) */
    tag?: string;
    title: string;
    points: Point[];
    sha: string;
}

// low-sound a ses propres mises à jour : ses commits (scope « sound », « musical »
// avant son renommage) ne sont pas ceux de low-cord. Pareil pour l'injecteur.
const INTERNAL = /^(Merge |Squashed '|(\w+)\((injector|sound|musical)\))/;
const HIDDEN_TYPES = new Set(["ci", "docs", "test", "tests", "chore", "build"]);
const BASE_UPDATE = /mise à jour Vencord upstream|Vencord upstream/i;

/** « feat(cord): low-sound — titre » → type + partie + titre + points du corps. */
function parse(entry: ChangeEntry): Item | null {
    const [first, ...rest] = entry.message.split(/\r?\n/);
    if (!first || INTERNAL.test(first)) return null;

    const typed = /^(\w+)(?:\([^)]*\))?!?:\s*(.+)$/.exec(first);
    const type = typed?.[1].toLowerCase();
    if (type && HIDDEN_TYPES.has(type)) return null;
    const kind: Kind = type === "feat" ? "new" : type === "fix" ? "fix" : "improve";

    let title = (typed?.[2] ?? first).trim();
    let tag: string | undefined;
    if (BASE_UPDATE.test(first)) {
        title = t("upd.baseUpdate");
    } else {
        // « partie — titre » : la partie devient une étiquette, si elle est courte.
        const parts = /^(.{2,32}?) — (.+)$/.exec(title);
        if (parts && !parts[1].includes(";")) [, tag, title] = parts;
    }

    const points: Point[] = [];
    for (const line of rest) {
        const text = line.trim();
        if (!text || /^Co-Authored-By:/i.test(text)) continue;
        if (/^[-*•] /.test(text)) points.push({ text: text.slice(2).trim() });
        else if (/^\S.{1,40}\s?:$/.test(text)) points.push({ text: text.replace(/\s?:$/, ""), head: true });
        else if (points.length && !points[points.length - 1].head && /^\s{2,}/.test(line)) points[points.length - 1].text += " " + text;
    }
    // Un sous-titre sans point après lui ne sert à rien.
    const kept = points.filter((p, i) => !p.head || (points[i + 1] && !points[i + 1].head));
    const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
    return { kind, tag, title: cap(title), points: kept, sha: entry.sha };
}

const SECTIONS: { kind: Kind; label: "upd.sectionNew" | "upd.sectionImprove" | "upd.sectionFix"; }[] = [
    { kind: "new", label: "upd.sectionNew" },
    { kind: "improve", label: "upd.sectionImprove" },
    { kind: "fix", label: "upd.sectionFix" },
];

function KindIcon({ kind }: { kind: Kind; }) {
    const paths = {
        new: <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />,
        improve: <path d="M5 15l7-7 7 7" />,
        fix: <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z" />,
    };
    return (
        <span className={cl("icon", `icon-${kind}`)} aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                {paths[kind]}
            </svg>
        </span>
    );
}

const short = (sha?: string) => sha?.slice(0, 7) ?? "";

function formatDate(iso?: string) {
    if (!iso) return "";
    return new Date(iso).toLocaleDateString(getLang() === "fr" ? "fr-FR" : "en-US", { day: "numeric", month: "long", year: "numeric" });
}

const itemsOf = (changes: Changes) => changes.commits.map(parse).filter(Boolean).reverse() as Item[];

interface Options {
    /** version de départ (absente : derniers changements) */
    since?: string;
    /** version d'arrivée (absente : installée) */
    to?: string;
    mode: Mode;
    /** déjà chargés */
    changes?: Changes;
}

function Content({ changes, error }: { changes: Changes | null; error: boolean; }) {
    if (error) return <div className={cl("empty")}>{t("upd.loadFailed")}</div>;
    if (!changes) {
        return (
            <div className={cl("loading")}>
                {[0, 1, 2].map(i => <div key={i} className={cl("skeleton")} style={{ animationDelay: `${i * 120}ms` }} />)}
            </div>
        );
    }
    const items = itemsOf(changes);
    if (!items.length) return <div className={cl("empty")}>{t("upd.nothingVisible")}</div>;

    let n = 0;
    return (
        <>
            <div className={cl("summary")}>
                {SECTIONS.map(({ kind, label }) => {
                    const count = items.filter(i => i.kind === kind).length;
                    return count > 0 && (
                        <span key={kind} className={cl("pill", `pill-${kind}`)}>
                            <KindIcon kind={kind} />
                            {count} {t(label).toLowerCase()}
                        </span>
                    );
                })}
            </div>
            {SECTIONS.map(({ kind, label }) => {
                const list = items.filter(i => i.kind === kind);
                if (!list.length) return null;
                return (
                    <section key={kind} className={cl("section")}>
                        <div className={cl("head")}>
                            <KindIcon kind={kind} />
                            <span>{t(label)}</span>
                            <span className={cl("count")}>{list.length}</span>
                        </div>
                        <ul className={cl("list")}>
                            {list.map(item => (
                                <li key={item.sha} className={cl("item", `item-${kind}`)} style={{ animationDelay: `${Math.min(n++, 12) * 45}ms` }}>
                                    <div className={cl("item-head")}>
                                        {item.tag && <span className={cl("tag")}>{item.tag}</span>}
                                        <span className={cl("title")}>{item.title}</span>
                                    </div>
                                    {item.points.length > 0 && (
                                        <ul className={cl("points")}>
                                            {item.points.map((p, j) => p.head
                                                ? <li key={j} className={cl("point-head")}>{p.text}</li>
                                                : <li key={j}>{p.text}</li>
                                            )}
                                        </ul>
                                    )}
                                </li>
                            ))}
                        </ul>
                    </section>
                );
            })}
        </>
    );
}

function WhatsNew({ options, modalProps }: { options: Options; modalProps: any; }) {
    useLang();
    const { installing } = useUpdateState();
    const [changes, setChanges] = useState<Changes | null>(options.changes ?? null);
    const [error, setError] = useState(false);

    useEffect(() => {
        if (options.changes) return;
        VencordNative.lowcordUpdate.changes(options.since, options.to).then(c => {
            if (c.error) setError(true);
            else setChanges(c);
        }, () => setError(true));
    }, []);

    const { mode } = options;
    const lastDate = changes?.commits[changes.commits.length - 1]?.date;
    const versions = options.since && options.to
        ? `${short(options.since)} → ${short(options.to)}`
        : short(options.to ?? changes?.current);
    const subtitle = [versions, formatDate(lastDate)].filter(Boolean).join(" · ");

    const github = changes?.url
        ? { text: t("upd.github"), variant: "secondary", onClick: () => VencordNative.native.openExternal(changes.url!) }
        : null;
    const actions = mode === "upcoming"
        ? [
            { text: t("upd.later"), variant: "secondary", onClick: modalProps.onClose },
            { text: t("upd.installNow"), variant: "primary", loading: installing, onClick: installAndRestart },
        ]
        : [
            ...(github ? [github] : []),
            { text: t("upd.gotIt"), variant: "primary", onClick: modalProps.onClose },
        ];

    return (
        <Modal
            {...modalProps}
            size="md"
            title={t(mode === "upcoming" ? "upd.upcomingTitle" : mode === "installed" ? "upd.installedTitle" : "upd.whatsNew")}
            subtitle={subtitle}
            actions={actions}
        >
            <div className={cl("root")}>
                {mode === "installed" && <div className={cl("hello")}>{t("upd.installedHint")}</div>}
                {mode === "upcoming" && <div className={cl("hello")}>{t("upd.upcomingHint")}</div>}
                <Content changes={changes} error={error} />
            </div>
        </Modal>
    );
}

/**
 * Ouvre la fenêtre. Avec `onlyIfContent`, les changements sont chargés
 * d'abord et la fenêtre ne s'ouvre que s'il y a quelque chose à montrer.
 */
export async function openWhatsNew(options: Options & { onlyIfContent?: boolean; }): Promise<"opened" | "empty" | "error"> {
    if (options.onlyIfContent && !options.changes) {
        const changes = await VencordNative.lowcordUpdate.changes(options.since, options.to);
        if (changes.error) return "error";
        if (!itemsOf(changes).length) return "empty";
        options = { ...options, changes };
    }
    openModal(props => <WhatsNew options={options} modalProps={props} />);
    return "opened";
}
