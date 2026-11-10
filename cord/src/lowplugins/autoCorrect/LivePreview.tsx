/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// AutoCorrect — aperçu en direct, rendu par le bouton de la barre de chat :
//  - une barre juste au-dessus de la zone de texte : le message corrigé, les
//    mots corrigés en vert, un rond qui tourne pendant l'analyse (clic :
//    appliquer la correction dans la zone de texte) ;
//  - les fautes soulignées en rouge dans la zone de texte elle-même (traits
//    dessinés par-dessus : le texte de Discord n'est pas modifié).

import ErrorBoundary from "@components/ErrorBoundary";
import { t, useLang } from "@lowcord/i18n";
import { ChannelStore, ComponentDispatch, ReactDOM, useEffect, useLayoutEffect, useRef, UserStore, useState } from "@webpack/common";

import { diff, getLive, Piece, useLive } from "./live";
import { settings } from "./settings";

/** Repère dans la barre de chat principale (posé par le bouton) : sert à retrouver sa zone de saisie. */
let inputAnchor: HTMLElement | null = null;
export const setInputAnchor = (el: HTMLElement | null) => { if (el) inputAnchor = el; };

/**
 * Remplace le texte de la zone de saisie. On sélectionne tout puis on tape le
 * nouveau texte (insertText) : l'éditeur de Discord le traite comme une vraie
 * frappe (annulable avec Ctrl+Z). Lancé au tour suivant : appelé pendant un
 * envoi, Discord doit d'abord finir de traiter l'Entrée.
 */
export function replaceInput(text: string) {
    const fallback = () => {
        // La méthode de Discord pour remettre un brouillon.
        ComponentDispatch.dispatchToLastSubscribed("CLEAR_TEXT");
        ComponentDispatch.dispatchToLastSubscribed("INSERT_TEXT", { rawText: text, plainText: text });
    };
    setTimeout(() => {
        const { editor } = findInput(inputAnchor);
        if (!editor?.isConnected) return fallback();
        editor.focus();
        const range = document.createRange();
        range.selectNodeContents(editor);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        // L'éditeur prend la sélection en compte au tour suivant : on tape ensuite.
        setTimeout(() => {
            if (!document.execCommand("insertText", false, text)) fallback();
        }, 30);
    }, 0);
}

/** Mentions, salons et emojis lisibles (« <@123> » → « @pseudo »). */
function pretty(text: string) {
    return text
        .replace(/<@!?(\d+)>/g, (m, id) => {
            const u = UserStore.getUser(id);
            return u ? `@${(u as any).globalName ?? u.username}` : m;
        })
        .replace(/<#(\d+)>/g, (m, id) => {
            const c = ChannelStore.getChannel(id);
            return c?.name ? `#${c.name}` : m;
        })
        .replace(/<a?(:[\w~]+:)\d+>/g, "$1");
}

function Spinner() {
    return (
        <svg className="lc-ac-live-spin" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeDasharray="1.5 3.53" />
        </svg>
    );
}

function Check() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m5 12.5 4.5 4.5L19 7.5" />
        </svg>
    );
}

interface Box { left: number; top: number; width: number; height: number; }

/** Zone de saisie de Discord autour du bouton. */
function findInput(anchor: HTMLElement | null) {
    const form = anchor?.closest("form");
    const box = form?.querySelector<HTMLElement>("[class*='channelTextArea']") ?? form;
    const editor = form?.querySelector<HTMLElement>("[role='textbox']");
    return { box: box ?? null, editor: editor ?? null };
}

/**
 * Rectangles à l'écran des mots fautifs dans la zone de saisie : on cherche
 * chaque mot, dans l'ordre, dans le texte affiché par l'éditeur.
 */
function squiggles(editor: HTMLElement, wrong: Piece[]) {
    const nodes: Text[] = [];
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
    const full = nodes.map(n => n.data).join("");
    const starts: number[] = [];
    let acc = 0;
    for (const n of nodes) { starts.push(acc); acc += n.data.length; }
    const locate = (pos: number) => {
        let k = starts.length - 1;
        while (k > 0 && starts[k] > pos) k--;
        return { node: nodes[k], offset: pos - starts[k] };
    };

    const rects: Box[] = [];
    let from = 0;
    for (const piece of wrong) {
        const word = piece.text.trim();
        if (!word) continue;
        let at = full.indexOf(word, from);
        // Le mot doit être entier (pas un bout d'un autre mot).
        while (at >= 0 && (/[\p{L}\d]/u.test(full[at - 1] ?? "") || /[\p{L}\d]/u.test(full[at + word.length] ?? ""))) at = full.indexOf(word, at + 1);
        if (at < 0) continue;
        from = at + word.length;
        const range = document.createRange();
        const s = locate(at), e = locate(at + word.length);
        try {
            range.setStart(s.node, s.offset);
            range.setEnd(e.node, e.offset);
        } catch { continue; }
        for (const r of range.getClientRects()) rects.push({ left: r.left, top: r.bottom - 3, width: r.width, height: 4 });
    }
    return rects;
}

export function LivePreview({ anchor }: { anchor: HTMLElement | null; }) {
    useLang();
    const live = useLive();
    const { isEnabled, livePreview } = settings.use(["isEnabled", "livePreview"]);
    const [layout, setLayout] = useState<{ box: Box | null; marks: Box[]; }>({ box: null, marks: [] });
    const lastLayout = useRef("");
    const [, tick] = useState(0);

    // Suit la zone de saisie (taille de fenêtre, défilement, zone qui grandit).
    useEffect(() => {
        const { box: el } = findInput(anchor);
        if (!el) return;
        const update = () => tick(n => n + 1);
        const ro = new ResizeObserver(update);
        ro.observe(el);
        window.addEventListener("resize", update);
        document.addEventListener("scroll", update, true);
        return () => {
            ro.disconnect();
            window.removeEventListener("resize", update);
            document.removeEventListener("scroll", update, true);
        };
    }, [anchor]);

    const show = isEnabled && livePreview && live.text.trim().length >= 3 && (live.analyzing || live.result != null);
    const parts = live.result ? diff(live.text, live.result.text) : null;
    const hasFixes = !!live.result?.fixes.length && live.result.text !== live.text;

    // Positions recalculées à chaque rendu, appliquées seulement si elles changent.
    useLayoutEffect(() => {
        const { box: el, editor } = findInput(anchor);
        let next: { box: Box | null; marks: Box[]; } = { box: null, marks: [] };
        if (show && el) {
            const r = el.getBoundingClientRect();
            next = {
                box: { left: r.left, top: r.top, width: r.width, height: r.height },
                marks: editor && parts && hasFixes ? squiggles(editor, parts.before.filter(p => p.changed)) : [],
            };
        }
        const k = JSON.stringify(next);
        if (k !== lastLayout.current) {
            lastLayout.current = k;
            setLayout(next);
        }
    });

    const { box, marks } = layout;
    if (!show || !box) return null;

    const apply = () => {
        const cur = getLive();
        if (cur.result && cur.fresh && cur.result.text !== cur.text) replaceInput(cur.result.text);
    };

    return ReactDOM.createPortal(
        <ErrorBoundary noop>
            <div
                className={`lc-ac-live${hasFixes ? " lc-ac-live-fix" : ""}`}
                // Largeur de la phrase seulement (grandit avec la frappe), jamais plus large que la zone de saisie.
                style={{ left: box.left, bottom: window.innerHeight - box.top + 6, maxWidth: box.width }}
                onMouseDown={e => e.preventDefault()}
                onClick={apply}
                role={hasFixes ? "button" : undefined}
                title={hasFixes ? t("ac.liveApply") : undefined}
            >
                <div className="lc-ac-live-text">
                    {parts && hasFixes
                        ? parts.after.map((p, i) => p.changed
                            ? <span key={i} className="lc-ac-live-new">{pretty(p.text)}</span>
                            : <span key={i}>{pretty(p.text)}</span>)
                        : <span className="lc-ac-live-plain">{pretty(live.text)}</span>}
                </div>
                <div className="lc-ac-live-side">
                    {live.analyzing
                        ? <Spinner />
                        : hasFixes
                            ? <span className="lc-ac-live-count">{t("ac.liveCount", { n: live.result!.fixes.length })}</span>
                            : <span className="lc-ac-live-ok"><Check />{t("ac.liveClean")}</span>}
                </div>
            </div>
            {marks.map((m, i) => (
                <div key={i} className="lc-ac-squiggle" style={{ left: m.left, top: m.top, width: m.width }} />
            ))}
        </ErrorBoundary>,
        document.body
    );
}
