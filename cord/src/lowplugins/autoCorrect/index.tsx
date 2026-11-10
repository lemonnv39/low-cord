/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// AutoCorrect — corrige la grammaire française des messages au moment de
// l'envoi (Entrée), sans toucher à l'argot (tkt, slt, mdr…).
//
// Bouton dans la barre de chat, à côté de la frappe silencieuse :
//  - clic : activer / désactiver ;
//  - clic droit : réglages, dans un panneau juste au-dessus.
//
// Deux modes :
//  - envoi auto : Entrée → corrigé → envoyé ;
//  - confirmation : Entrée → le message corrigé remplace le texte tapé ;
//    Entrée encore → envoyé. Sans faute, il part dès la 1ʳᵉ Entrée.
//
// Le moteur (Grammalecte) tourne dans le processus principal : voir native.ts.
// Une correction qui échoue ou tarde (plus de 2,5 s) n'empêche jamais
// l'envoi : le message part tel quel.

import "./style.css";

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { MessageSendListener } from "@api/MessageEvents";
import { t, useLang } from "@lowcord/i18n";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { useEffect, useState } from "@webpack/common";

import { ensureEngine, refreshEngine, warmup } from "./engine";
import { correctText, resetLive, startLive, stopLive, useLive } from "./live";
import { LivePreview, replaceInput, setInputAnchor } from "./LivePreview";
import { closePanel, isPanelOpen, openPanel } from "./Panel";
import { ButtonState, getEngineState, setButtonState, settings, useButtonState } from "./settings";

const logger = new Logger("AutoCorrect");

const TIMEOUT = 2500;

// ── Envoi ────────────────────────────────────────────────────────────────────
/** Mode confirmation : texte corrigé en attente de la 2ᵉ Entrée, par salon. */
const pending = new Map<string, string>();
const same = (a: string, b: string) => a.trim() === b.trim();

function skip(content: string) {
    if (!content.trim()) return true;
    const prefixes = settings.store.ignorePrefixes.split(/\s+/).filter(Boolean);
    return prefixes.some(p => content.startsWith(p));
}

function withTimeout<T>(p: Promise<T>, ms: number) {
    return Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("délai dépassé")), ms))]);
}

const onSend: MessageSendListener = async (channelId, msg) => {
    const s = settings.store;
    if (!s.isEnabled) return;
    const { content } = msg;

    // 2ᵉ Entrée en mode confirmation : le message part, toujours (jamais deux
    // annulations de suite : si le texte corrigé n'a pas pris dans la zone de
    // saisie, il est corrigé ici et envoyé quand même).
    const waiting = pending.get(channelId);
    pending.delete(channelId);
    if (waiting != null) {
        if (!same(waiting, content) && !skip(content)) {
            try {
                const again = await withTimeout(correctText(content), TIMEOUT);
                if (again?.fixes?.length) msg.content = again.text;
            } catch { }
        }
        setButtonState("done");
        resetLive();
        return;
    }
    if (skip(content) || !getEngineState()?.installed) {
        if (getEngineState() && !getEngineState()!.installed) ensureEngine();
        setButtonState("idle");
        return;
    }

    setButtonState("working");
    let result: { text: string; fixes: { from: string; to: string; }[]; };
    try {
        // Déjà analysé par l'aperçu pendant la frappe : la correction est instantanée.
        result = await withTimeout(correctText(content), TIMEOUT);
    } catch (e) {
        // Jamais bloquer un message : il part sans correction.
        logger.warn("Correction impossible, message envoyé tel quel", e);
        setButtonState("idle");
        return;
    }

    if (typeof result?.text !== "string" || !result.fixes?.length || same(result.text, content)) {
        setButtonState("done");
        resetLive();
        return;
    }

    s.totalFixed = (s.totalFixed ?? 0) + result.fixes.length;

    if (s.mode === "confirm") {
        pending.set(channelId, result.text);
        replaceInput(result.text, channelId);
        setButtonState("pending");
        return { cancel: true };
    }

    msg.content = result.text;
    setButtonState("done");
    resetLive();
};

// ── Bouton ───────────────────────────────────────────────────────────────────
/**
 * Feuille de texte + point d'état en bas à droite : vert actif, rouge coupé,
 * anneau qui tourne pendant la correction, pulsation une fois corrigé (et
 * lente en attendant la 2ᵉ Entrée en mode confirmation).
 */
export function AutoCorrectIcon({ state = "idle", off = false, size = 20 }: { state?: ButtonState; off?: boolean; size?: number; }) {
    return (
        <svg className={`lc-ac-icon lc-ac-${off ? "off" : state}`} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <mask id="lc-ac-cut">
                <rect width="24" height="24" fill="#fff" />
                <circle cx="18.5" cy="18.5" r="5.6" fill="#000" />
            </mask>
            <g mask="url(#lc-ac-cut)" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
                <path d="M14 2v5a1 1 0 0 0 1 1h5" />
                <path d="M10 9H8" />
                <path d="M16 13H8" />
                <path d="M16 17H8" />
            </g>
            <circle className="lc-ac-dot-state" cx="18.5" cy="18.5" r="3.4" />
            <circle className="lc-ac-dot-spin" cx="18.5" cy="18.5" r="3.4" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeDasharray="12 10" />
        </svg>
    );
}

const AutoCorrectButton: ChatBarButtonFactory = ({ isMainChat, channel }) => {
    useLang();
    const { isEnabled, mode } = settings.use(["isEnabled", "mode"]);
    const sending = useButtonState();
    // Pendant la frappe, l'analyse en direct fait aussi tourner l'icône.
    const { analyzing } = useLive();
    const state = sending === "idle" && analyzing && isEnabled ? "working" : sending;
    // Repère dans la barre de chat : l'aperçu se place au-dessus de la zone de saisie qui le contient.
    const [anchor, setAnchor] = useState<HTMLElement | null>(null);

    useEffect(() => { if (isMainChat) warmup(); }, [isMainChat, channel?.id]);

    if (!isMainChat) return null;

    const tooltip = !isEnabled
        ? t("ac.tooltipOff")
        : state === "pending" ? t("ac.tooltipPending") : t(mode === "confirm" ? "ac.tooltipOnConfirm" : "ac.tooltipOnAuto");

    return (
        <>
            <ChatBarButton
                tooltip={tooltip}
                onClick={() => {
                    settings.store.isEnabled = !settings.store.isEnabled;
                    pending.clear();
                    setButtonState("idle");
                    resetLive();
                    if (settings.store.isEnabled) ensureEngine(true);
                }}
                onContextMenu={e => {
                    e.preventDefault();
                    if (isPanelOpen()) return closePanel();
                    openPanel((e.currentTarget as HTMLElement).getBoundingClientRect());
                }}
            >
                <AutoCorrectIcon state={state} off={!isEnabled} />
                <span ref={el => { setAnchor(el); setInputAnchor(el); }} hidden />
            </ChatBarButton>
            <LivePreview anchor={anchor} />
        </>
    );
};

export default definePlugin({
    name: "AutoCorrect",
    description: "Corrects French grammar in your messages when you send them (son/sont, a/à, agreements…), without touching slang",
    authors: [],
    tags: ["Chat", "Utility"],
    settings,

    // Déclaré ici (pas ajouté à la main) : c'est ce qui active le crochet
    // d'envoi de low-cord (MessageEventsAPI).
    onBeforeMessageSend: onSend,

    chatBarButton: {
        icon: () => <AutoCorrectIcon />,
        render: AutoCorrectButton,
    },

    async start() {
        startLive();
        await refreshEngine();
        if (settings.store.isEnabled) ensureEngine(!getEngineState()?.installed);
    },

    stop() {
        stopLive();
        pending.clear();
        closePanel();
        setButtonState("idle");
    },
});
