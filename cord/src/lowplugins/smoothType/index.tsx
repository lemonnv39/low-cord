/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * SmoothType — le curseur de la zone de texte glisse en douceur d'une
 * position à l'autre au lieu de sauter.
 *
 * Le vrai curseur de Discord est rendu transparent (`caret-color` sur
 * [data-slate-editor], un attribut stable de l'éditeur de Discord) et
 * remplacé par un trait positionné à partir de la sélection réelle, qui se
 * déplace avec une transition CSS. Il clignote quand on ne tape pas.
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { AccessibilityStore } from "@webpack/common";

const settings = definePluginSettings({
    transitionDelay: {
        description: "Caret glide duration (ms)",
        type: OptionType.NUMBER,
        default: 60,
        onChange: () => applyCSS(),
    },
    animationType: {
        description: "Easing curve for the caret glide",
        type: OptionType.SELECT,
        options: [
            { label: "Ease", value: "ease", default: true },
            { label: "Linear", value: "linear" },
            { label: "Ease In", value: "ease-in" },
            { label: "Ease Out", value: "ease-out" },
            { label: "Ease In Out", value: "ease-in-out" },
        ],
        onChange: () => applyCSS(),
    },
    caretColor: {
        description: "Caret color (CSS color, e.g. #ffffff). Empty = the text color of the theme",
        type: OptionType.STRING,
        default: "",
        onChange: () => applyCSS(),
    },
});

const STYLE_ID = "lc-smoothtype-style";
const CARET_ID = "lc-smoothtype-caret";
const EDITOR = "[data-slate-editor]";
const EASINGS = new Set(["ease", "linear", "ease-in", "ease-out", "ease-in-out"]);

let caretEl: HTMLDivElement | null = null;
let rafId: number | null = null;
let blinkTimeout: ReturnType<typeof setTimeout> | null = null;
let observer: MutationObserver | null = null;
let observed: Element | null = null;
let active: Listener[] = [];

const editorOf = (el: Element | null) => el?.closest(EDITOR) ?? null;

function buildCSS(): string {
    const { transitionDelay, animationType, caretColor } = settings.store;
    // Valeurs vérifiées : un réglage invalide ne doit pas casser la feuille de style.
    const duration = Math.max(0, Math.min(1000, Number(transitionDelay) || 0));
    const easing = EASINGS.has(animationType) ? animationType : "ease";
    const color = caretColor && CSS.supports("color", caretColor) ? caretColor : "var(--text-default, var(--text-normal, #dbdee1))";
    // Réglage « Animations réduites » de Discord : le curseur ne glisse pas.
    const glide = AccessibilityStore?.useReducedMotion ? 0 : duration;
    return `
@keyframes lc-smoothtype-blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
}
#${CARET_ID} {
    position: fixed;
    top: 0;
    left: 0;
    width: 2px;
    border-radius: 2px;
    background: ${color};
    pointer-events: none;
    z-index: 1000;
    display: none;
    transition: left ${glide}ms ${easing}, top ${glide}ms ${easing}, height ${glide}ms ${easing};
}
#${CARET_ID}.lc-no-glide {
    transition: none;
}
#${CARET_ID}.is-blinking {
    animation: lc-smoothtype-blink 1s ease-in-out infinite;
}
${EDITOR} {
    caret-color: transparent !important;
}
`;
}

function applyCSS() {
    if (!document.getElementById(STYLE_ID) && !caretEl) return; // plugin arrêté
    document.getElementById(STYLE_ID)?.remove();
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = buildCSS();
    document.head.appendChild(style);
}

function getCaret(): HTMLDivElement {
    if (!caretEl || !caretEl.isConnected) {
        caretEl = document.createElement("div");
        caretEl.id = CARET_ID;
        document.body.appendChild(caretEl);
    }
    return caretEl;
}

function hide() {
    if (caretEl) caretEl.style.display = "none";
}

/** Clignote seulement quand on ne tape pas (comme un vrai curseur). */
function pauseBlink() {
    const el = getCaret();
    el.classList.remove("is-blinking");
    if (blinkTimeout) clearTimeout(blinkTimeout);
    blinkTimeout = setTimeout(() => el.classList.add("is-blinking"), 600);
}

/** Position du curseur : le bord gauche de la sélection réduite à un point. */
function caretRect(): DOMRect | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    if (!editorOf(range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer.parentElement : range.startContainer as Element)) return null;

    const rect = range.getClientRects()[0] ?? null;
    if (rect && rect.height > 0) return rect;

    // Ligne vide : pas de rectangle pour la sélection, on prend le début de la ligne.
    const node = range.startContainer;
    const line = (node.nodeType === Node.TEXT_NODE ? node.parentElement : node as Element)?.closest("[data-slate-node='element']") ?? (node as Element);
    const box = (line as Element)?.getBoundingClientRect?.();
    if (!box || box.height === 0) return null;
    const style = getComputedStyle(line as Element);
    const left = box.left + (parseFloat(style.paddingLeft) || 0);
    const lineHeight = parseFloat(style.lineHeight) || box.height;
    return new DOMRect(left, box.top + (parseFloat(style.paddingTop) || 0), 0, Math.min(lineHeight, box.height));
}

function applyCaretPosition() {
    if (!editorOf(document.activeElement)) {
        hide();
        return;
    }
    // Du texte sélectionné : la surbrillance de Discord suffit, pas de curseur.
    const rect = caretRect();
    if (!rect) {
        hide();
        return;
    }

    const el = getCaret();
    const left = `${Math.round(rect.left)}px`;
    const top = `${Math.round(rect.top)}px`;
    const height = `${Math.round(rect.height)}px`;
    const wasHidden = el.style.display !== "block";

    if (wasHidden) {
        // Première apparition : placé directement, sans glisser depuis l'ancienne position.
        el.classList.add("lc-no-glide");
        el.style.left = left;
        el.style.top = top;
        el.style.height = height;
        el.style.display = "block";
        void el.offsetWidth;
        el.classList.remove("lc-no-glide");
        pauseBlink();
        return;
    }
    if (el.style.left !== left || el.style.top !== top) pauseBlink();
    el.style.left = left;
    el.style.top = top;
    el.style.height = height;
}

function scheduleUpdate() {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
        rafId = null;
        applyCaretPosition();
    });
}

/** On ne surveille que l'éditeur qui a le focus (pas toute la page). */
function observe(editor: Element | null) {
    if (editor === observed) return;
    observer?.disconnect();
    observed = editor;
    if (!editor) return;
    observer ??= new MutationObserver(scheduleUpdate);
    observer.observe(editor, { childList: true, subtree: true, characterData: true });
}

function onFocusIn() {
    observe(editorOf(document.activeElement));
    scheduleUpdate();
}

function onFocusOut() {
    // Le focus peut passer d'un éditeur à un autre : on attend de savoir où il va.
    setTimeout(() => {
        const editor = editorOf(document.activeElement);
        observe(editor);
        if (!editor) hide();
        else scheduleUpdate();
    }, 0);
}

function onVisibilityChange() {
    if (document.hidden) hide();
    else scheduleUpdate();
}

type Listener = [EventTarget, string, EventListener, boolean | AddEventListenerOptions];

// Créée au démarrage : au chargement du fichier, `document` n'existe pas
// encore partout (et tout low-cord planterait).
const makeListeners = (): Listener[] => [
    [document, "selectionchange", scheduleUpdate, false],
    [document, "focusin", onFocusIn, true],
    [document, "focusout", onFocusOut, true],
    [document, "keyup", scheduleUpdate, true],
    [document, "mouseup", scheduleUpdate, true],
    // Clic ailleurs / fenêtre quittée (Alt+Tab) : le curseur disparaît même
    // si le navigateur n'a pas signalé la perte du focus.
    [document, "mousedown", scheduleUpdate, true],
    [window, "blur", hide, false],
    [window, "focus", scheduleUpdate, false],
    [document, "visibilitychange", onVisibilityChange, false],
    // Défilement d'un long message, fenêtre redimensionnée : le curseur suit.
    [document, "scroll", scheduleUpdate, { capture: true, passive: true }],
    [window, "resize", scheduleUpdate, { passive: true }],
];

export default definePlugin({
    name: "SmoothType",
    description: "The chat input caret glides smoothly from one position to the next instead of jumping.",
    tags: ["Appearance", "Chat"],
    authors: [{ name: "0ctane", id: 0n }],
    settings,

    start() {
        getCaret();
        applyCSS();
        active = makeListeners();
        for (const [target, type, fn, opts] of active) target.addEventListener(type, fn, opts);
        onFocusIn();
    },

    stop() {
        for (const [target, type, fn, opts] of active) target.removeEventListener(type, fn, opts);
        active = [];
        observer?.disconnect();
        observer = null;
        observed = null;
        if (blinkTimeout) clearTimeout(blinkTimeout);
        if (rafId !== null) cancelAnimationFrame(rafId);
        blinkTimeout = null;
        rafId = null;
        document.getElementById(STYLE_ID)?.remove();
        caretEl?.remove();
        caretEl = null;
    },
});
