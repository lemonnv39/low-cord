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
import { ComponentDispatch, showToast, useEffect } from "@webpack/common";

import { ensureEngine, Native, refreshEngine, warmup } from "./engine";
import { closePanel, isPanelOpen, openPanel } from "./Panel";
import { activeGroups, ButtonState, getEngineState, setButtonState, settings, useButtonState, userWords } from "./settings";

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

function replaceInput(text: string) {
    // Comme Discord quand il remet un brouillon : on vide, puis on insère.
    ComponentDispatch.dispatchToLastSubscribed("CLEAR_TEXT");
    ComponentDispatch.dispatchToLastSubscribed("INSERT_TEXT", { rawText: text, plainText: text });
}

const onSend: MessageSendListener = async (channelId, msg) => {
    const s = settings.store;
    if (!s.isEnabled) return;
    const { content } = msg;

    // 2ᵉ Entrée en mode confirmation : le texte corrigé part tel quel.
    const waiting = pending.get(channelId);
    pending.delete(channelId);
    if (waiting != null && same(waiting, content)) {
        setButtonState("done");
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
        result = await withTimeout(Native.correct(content, { groups: activeGroups(), whitelist: userWords(), custom: s.common, accents: s.accents }), TIMEOUT);
    } catch (e) {
        // Jamais bloquer un message : il part sans correction.
        logger.warn("Correction impossible, message envoyé tel quel", e);
        setButtonState("idle");
        return;
    }

    if (typeof result?.text !== "string" || !result.fixes?.length || same(result.text, content)) {
        setButtonState("done");
        return;
    }

    s.totalFixed = (s.totalFixed ?? 0) + result.fixes.length;
    const summary = result.fixes.slice(0, 4).map(f => `${f.from} → ${f.to}`).join(" · ") + (result.fixes.length > 4 ? " …" : "");

    if (s.mode === "confirm") {
        pending.set(channelId, result.text);
        replaceInput(result.text);
        setButtonState("pending");
        if (s.showToast) showToast({ text: t("ac.confirmToast", { fixes: summary }) });
        return { cancel: true };
    }

    msg.content = result.text;
    setButtonState("done");
    if (s.showToast) showToast({ text: t("ac.fixedToast", { n: result.fixes.length, fixes: summary }), variant: "success" });
};

// ── Bouton ───────────────────────────────────────────────────────────────────
/** Carré avec un rond : le rond tourne pendant la correction, puis devient un cercle de petits traits. */
export function AutoCorrectIcon({ state = "idle", off = false, size = 20 }: { state?: ButtonState; off?: boolean; size?: number; }) {
    return (
        <svg className={`lc-ac-icon lc-ac-${off ? "off" : state}`} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="4.5" stroke="currentColor" strokeWidth="2" />
            {/* Repos : rond plein trait. */}
            <circle className="lc-ac-ring" cx="12" cy="12" r="4.6" stroke="currentColor" strokeWidth="2" />
            {/* Correction en cours : arc qui tourne. */}
            <circle className="lc-ac-spin" cx="12" cy="12" r="4.6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray="9 20" />
            {/* Corrigé : cercle de petits traits. */}
            <circle className="lc-ac-ticks" cx="12" cy="12" r="4.6" stroke="currentColor" strokeWidth="2.6" strokeDasharray="1.2 1.69" />
            {off && <path d="M4 20 20 4" stroke="var(--status-danger, #f23f43)" strokeWidth="2.2" strokeLinecap="round" />}
        </svg>
    );
}

const AutoCorrectButton: ChatBarButtonFactory = ({ isMainChat, channel }) => {
    useLang();
    const { isEnabled, mode } = settings.use(["isEnabled", "mode"]);
    const state = useButtonState();

    useEffect(() => { if (isMainChat) warmup(); }, [isMainChat, channel?.id]);

    if (!isMainChat) return null;

    const tooltip = !isEnabled
        ? t("ac.tooltipOff")
        : state === "pending" ? t("ac.tooltipPending") : t(mode === "confirm" ? "ac.tooltipOnConfirm" : "ac.tooltipOnAuto");

    return (
        <ChatBarButton
            tooltip={tooltip}
                onClick={() => {
                    settings.store.isEnabled = !settings.store.isEnabled;
                    pending.clear();
                    setButtonState("idle");
                    if (settings.store.isEnabled) ensureEngine(true);
                }}
                onContextMenu={e => {
                    e.preventDefault();
                    if (isPanelOpen()) return closePanel();
                openPanel((e.currentTarget as HTMLElement).getBoundingClientRect());
            }}
        >
            <AutoCorrectIcon state={state} off={!isEnabled} />
        </ChatBarButton>
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
        await refreshEngine();
        if (settings.store.isEnabled) ensureEngine(!getEngineState()?.installed);
    },

    stop() {
        pending.clear();
        closePanel();
        setButtonState("idle");
    },
});
