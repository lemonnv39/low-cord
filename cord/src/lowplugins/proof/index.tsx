/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * Proof — plugin de confidentialité UNIFIÉ. Un seul bouton œil dans la barre du
 * haut :
 *   - CLIC GAUCHE  : active/désactive le proofing global.
 *   - CLIC DROIT   : menu déroulant avec une case par mode, à cocher.
 *
 * Modes (chacun = une classe sur <body> + du CSS dans styles.css) :
 *   - dmList       : floute la liste des MP (+ notifications & icône barre des tâches)
 *   - conversation : floute les messages de la conversation ouverte (survol = révèle)
 *   - self         : floute ton panneau de compte en bas à gauche
 *   - servers      : floute les noms de serveurs & de membres
 *   - stream       : floute messages/médias, clic pour révéler (anti-capture)
 *   - voice        : cache les pseudos en vocal et dans les appels
 *
 * Le bouton s'injecte dans le tableau des boutons de la barre du haut (et non en
 * remplaçant le wrapper), pour coexister avec d'autres plugins (ex. FollowUser).
 *
 * NB : les sélecteurs CSS visent des classes hashées de Discord et peuvent
 * demander un ajustement si Discord bouge son code — à tester mode par mode.
 */

import "./styles.css";

import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { findComponentByCodeLazy } from "@webpack";
import { ContextMenuApi, Menu, useState } from "@webpack/common";

const Native = VencordNative.pluginHelpers.Proof as PluginNative<typeof import("./native")>;
const HeaderBarIcon = findComponentByCodeLazy(".HEADER_BAR_BADGE_BOTTOM,", 'position:"bottom"');

// ── Modes ────────────────────────────────────────────────────────────────────

const MODES = ["dmList", "conversation", "self", "servers", "stream", "voice"] as const;
type Mode = (typeof MODES)[number];

const MODE_LABEL: Record<Mode, string> = {
    dmList: "Liste des MP",
    conversation: "Conversation ouverte",
    self: "Moi (panneau de compte)",
    servers: "Serveurs (noms & membres)",
    stream: "Stream (messages/médias)",
    voice: "Vocal & appels (pseudos)",
};

const MODE_CLASS: Record<Mode, string> = {
    dmList: "proof-dmlist",
    conversation: "proof-conversation",
    self: "proof-self",
    servers: "proof-servers",
    stream: "proof-stream",
    voice: "proof-voice",
};

const settings = definePluginSettings({
    active: { type: OptionType.BOOLEAN, description: "Proofing activé (toggle global — clic gauche sur l'œil)", default: false },
    dmList: { type: OptionType.BOOLEAN, description: "Floute la liste des MP (+ notifications & barre des tâches)", default: true },
    conversation: { type: OptionType.BOOLEAN, description: "Floute les messages de la conversation ouverte", default: true },
    self: { type: OptionType.BOOLEAN, description: "Floute ton panneau de compte (bas à gauche)", default: true },
    servers: { type: OptionType.BOOLEAN, description: "Floute les noms de serveurs & de membres", default: false },
    stream: { type: OptionType.BOOLEAN, description: "Floute messages/médias, clic pour révéler (anti-capture)", default: false },
    voice: { type: OptionType.BOOLEAN, description: "Cache les pseudos en vocal et dans les appels", default: true },
});

// ── Application de l'état ─────────────────────────────────────────────────────

let redactNotifs = false;

function applyState() {
    const s = settings.store;
    const on = s.active;
    const b = document.body.classList;

    b.toggle("proof-on", on);
    for (const m of MODES) b.toggle(MODE_CLASS[m], on && !!s[m]);

    if (on && s.stream) enableStreamClicks();
    else disableStreamClicks();

    redactNotifs = on && !!s.dmList;
    try { Native?.setActive?.(redactNotifs); } catch { /* best-effort */ }
}

function teardown() {
    const b = document.body.classList;
    b.remove("proof-on");
    for (const m of MODES) b.remove(MODE_CLASS[m]);
    disableStreamClicks();
    redactNotifs = false;
    try { Native?.setActive?.(false); } catch { /* best-effort */ }
}

// ── Stream : clic pour révéler ────────────────────────────────────────────────

let streamClickHandler: ((e: MouseEvent) => void) | null = null;

const STREAM_SELECTOR =
    '[class*="messageContent_"], [class*="markup_"], [class*="imageWrapper_"], [class*="embedWrapper_"], [class*="attachment_"], [class*="video_"], [class*="newMosaicStyle_"], [class*="stickerAsset_"], [id^="message-accessories-"] article';

function enableStreamClicks() {
    if (streamClickHandler) return;
    streamClickHandler = (e: MouseEvent) => {
        const target = e.target as HTMLElement | null;
        if (!target) return;
        const el = target.closest(STREAM_SELECTOR);
        if (el && !el.classList.contains("proof-revealed")) {
            el.classList.add("proof-revealed");
            e.preventDefault();
            e.stopPropagation();
        }
    };
    document.addEventListener("click", streamClickHandler, true);
}

function disableStreamClicks() {
    if (streamClickHandler) {
        document.removeEventListener("click", streamClickHandler, true);
        streamClickHandler = null;
    }
    document.querySelectorAll(".proof-revealed").forEach(el => el.classList.remove("proof-revealed"));
}

// ── Notifications bureau (redaction) ──────────────────────────────────────────

let notificationHookInstalled = false;

function installNotificationHook() {
    if (notificationHookInstalled) return;
    notificationHookInstalled = true;

    const OriginalNotification = window.Notification;
    if (!OriginalNotification) return;

    const ProxiedNotification = new Proxy(OriginalNotification, {
        construct(target, args: [title: string, options?: NotificationOptions]) {
            if (!redactNotifs) return new target(...args);
            const [, options] = args;
            const redactedOptions: NotificationOptions = { ...options, body: "Nouveau message", icon: undefined };
            delete (redactedOptions as any).image;
            return new target("Discord", redactedOptions);
        }
    });

    Object.defineProperty(window, "Notification", { value: ProxiedNotification, writable: true, configurable: true });
}

// ── Icônes ───────────────────────────────────────────────────────────────────

function EyeIcon({ width = 20, height = 20 }: { width?: number; height?: number; }) {
    return (
        <svg aria-hidden="true" role="img" xmlns="http://www.w3.org/2000/svg" width={width} height={height} fill="none" viewBox="0 0 24 24">
            <path fill="currentColor" d="M12 5C5.648 5 1 12 1 12s4.648 7 11 7 11-7 11-7-4.648-7-11-7Zm0 12a5 5 0 1 1 0-10 5 5 0 0 1 0 10Zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" />
        </svg>
    );
}

function EyeSlashIcon({ width = 20, height = 20 }: { width?: number; height?: number; }) {
    return (
        <svg aria-hidden="true" role="img" xmlns="http://www.w3.org/2000/svg" width={width} height={height} fill="none" viewBox="0 0 24 24">
            <path fill="currentColor" d="M2.22 2.22a.75.75 0 0 1 1.06 0l18.5 18.5a.75.75 0 1 1-1.06 1.06l-3.56-3.56A11.18 11.18 0 0 1 12 19C5.648 19 1 12 1 12s1.81-2.73 4.69-4.95L2.22 3.28a.75.75 0 0 1 0-1.06ZM7.1 8.52A8.87 8.87 0 0 0 3.07 12 9.57 9.57 0 0 0 12 17c1.47 0 2.85-.34 4.1-.93l-1.7-1.7A3 3 0 0 1 10.63 10.6L7.1 8.52ZM12 5c1.92 0 3.7.52 5.25 1.37l-1.5 1.5A8.87 8.87 0 0 0 20.93 12a9.57 9.57 0 0 1-3.37 3.44l1.5 1.5C21.42 15.2 23 12 23 12s-4.648-7-11-7Z" />
        </svg>
    );
}

// ── Menu clic droit ──────────────────────────────────────────────────────────

function ProofMenu({ onChange }: { onChange: () => void; }) {
    const [, force] = useState({});
    const s = settings.store;
    const refresh = () => { applyState(); force({}); onChange(); };

    return (
        <Menu.Menu navId="lowcord-proof-menu" onClose={ContextMenuApi.closeContextMenu} aria-label="Options de Proof">
            <Menu.MenuGroup label="Proofing">
                <Menu.MenuCheckboxItem
                    id="proof-active"
                    label="Activé (global)"
                    checked={s.active}
                    action={() => { s.active = !s.active; refresh(); }}
                />
                <Menu.MenuSeparator />
                {MODES.map(m => (
                    <Menu.MenuCheckboxItem
                        key={m}
                        id={`proof-${m}`}
                        label={MODE_LABEL[m]}
                        checked={!!s[m]}
                        action={() => { (s as any)[m] = !s[m]; refresh(); }}
                    />
                ))}
            </Menu.MenuGroup>
        </Menu.Menu>
    );
}

// ── Bouton de la barre du haut ────────────────────────────────────────────────

function ProofHeaderButton() {
    const [, force] = useState({});
    const on = settings.store.active;

    return (
        // Le bouton de Discord ne gère pas le clic droit : on l'attrape autour.
        <div style={{ display: "contents" }} onContextMenu={e => {
            e.preventDefault();
            ContextMenuApi.openContextMenu(e as any, () => <ProofMenu onChange={() => force({})} />);
        }}>
            <HeaderBarIcon
                icon={on ? EyeSlashIcon : EyeIcon}
                tooltip={on ? "Proof : ON — clic droit = options" : "Proof : OFF — clic = activer · clic droit = options"}
                onClick={() => { settings.store.active = !settings.store.active; applyState(); force({}); }}
                selected={on}
            />
        </div>
    );
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export default definePlugin({
    name: "Proof",
    description: "Confidentialité tout-en-un : floute MP, conversations, ton profil, serveurs, et cache les pseudos en vocal. Œil dans la barre du haut — clic = toggle, clic droit = choisir les modes.",
    tags: ["Privacy", "Utility"],
    authors: [{ name: "0ctane", id: 0n }],
    settings,

    patches: [
        {
            // Injecte notre bouton dans le tableau des boutons de la barre du haut
            // (sans remplacer le wrapper → coexiste avec FollowUser & co).
            find: '?"BACK_FORWARD_NAVIGATION":',
            replacement: {
                match: /(trailing:.{0,100}?\{children:\[)/,
                replace: "$1$self.renderButton(),"
            }
        }
    ],

    renderButton() {
        return (
            <ErrorBoundary key="proof" noop>
                <ProofHeaderButton />
            </ErrorBoundary>
        );
    },

    start() {
        installNotificationHook();
        applyState();
    },
    stop() {
        teardown();
    }
});
