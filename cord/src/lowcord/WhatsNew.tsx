/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — fenêtre « Quoi de neuf », ouverte au premier démarrage après une
// mise à jour. Le contenu vient des commits publiés entre la version vue la
// dernière fois et celle installée : nouveautés (feat), corrections (fix) et
// le reste. Les commits internes (injecteur, import de la base Vencord) sont
// résumés ou masqués.

import "./styles.css";

import type { ChangeEntry, Changes } from "@main/lowcordUpdater";
import { classNameFactory } from "@utils/css";
import { Modal, openModal } from "@webpack/common";

import { getLang, t, useLang } from "./i18n";

const cl = classNameFactory("lc-wn-");

type Kind = "new" | "fix" | "other";

interface Item {
    kind: Kind;
    title: string;
    points: string[];
}

// low-musical a ses propres mises à jour : ses commits (scope « musical ») ne sont pas ceux de low-cord.
const INTERNAL = /^(Merge |Squashed '|(\w+)\((injector|musical)\))/;
const BASE_UPDATE = /mise à jour Vencord upstream|Vencord upstream/i;

/** « feat(cord): titre » / « Plugin : titre » → type + titre + points du corps. */
function parse(entry: ChangeEntry): Item | null {
    const [first, ...rest] = entry.message.split(/\r?\n/);
    if (!first || INTERNAL.test(first)) return null;

    const typed = /^(\w+)(?:\([^)]*\))?!?:\s*(.+)$/.exec(first);
    const type = typed?.[1].toLowerCase();
    const kind: Kind = type === "feat" ? "new" : type === "fix" ? "fix" : "other";
    let title = (typed?.[2] ?? first).trim();
    if (BASE_UPDATE.test(first)) title = t("upd.baseUpdate");

    const points: string[] = [];
    for (const line of rest) {
        const text = line.trim();
        if (!text || /^Co-Authored-By:/i.test(text)) continue;
        if (/^[-*•] /.test(text)) points.push(text.slice(2).trim());
        else if (points.length && /^\s{2,}/.test(line)) points[points.length - 1] += " " + text;
    }
    return { kind, title: title.charAt(0).toUpperCase() + title.slice(1), points };
}

const SECTIONS: { kind: Kind; label: "upd.sectionNew" | "upd.sectionFix" | "upd.sectionOther"; }[] = [
    { kind: "new", label: "upd.sectionNew" },
    { kind: "fix", label: "upd.sectionFix" },
    { kind: "other", label: "upd.sectionOther" },
];

function WhatsNew({ changes, modalProps }: { changes: Changes; modalProps: any; }) {
    useLang();
    const items = changes.commits.map(parse).filter(Boolean).reverse() as Item[];
    const last = changes.commits[changes.commits.length - 1];
    const date = last?.date ? new Date(last.date).toLocaleDateString(getLang() === "fr" ? "fr-FR" : "en-US", { day: "numeric", month: "long", year: "numeric" }) : "";

    return (
        <Modal {...modalProps} size="md" title={t("upd.whatsNew")} subtitle={t("upd.version", { version: changes.current?.slice(0, 7) ?? "", date })}>
            <div className={cl("root")}>
                {SECTIONS.map(({ kind, label }) => {
                    const list = items.filter(i => i.kind === kind);
                    if (!list.length) return null;
                    return (
                        <section key={kind} className={cl("section")}>
                            <div className={cl("head")}>
                                <span className={cl("dot", `dot-${kind}`)} />
                                <span>{t(label)}</span>
                                <span className={cl("count")}>{list.length}</span>
                            </div>
                            <ul className={cl("list")}>
                                {list.map((item, i) => (
                                    <li key={i}>
                                        <div className={cl("title")}>{item.title}</div>
                                        {item.points.length > 0 && (
                                            <ul className={cl("points")}>
                                                {item.points.map((p, j) => <li key={j}>{p}</li>)}
                                            </ul>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        </section>
                    );
                })}
                <div className={cl("foot")}>
                    <button className={cl("btn")} onClick={modalProps.onClose}>{t("upd.gotIt")}</button>
                </div>
            </div>
        </Modal>
    );
}

/** Ouvre la fenêtre s'il y a quelque chose à montrer ; renvoie false sinon. */
export function openWhatsNew(changes: Changes) {
    if (!changes.commits.some(c => parse(c))) return false;
    openModal(props => <WhatsNew changes={changes} modalProps={props} />);
    return true;
}
