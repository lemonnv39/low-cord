/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — onglet « Cleaner » (sous low-sound) + rond vert dans la barre du
// haut tant qu'un nettoyage tourne.
//
// Les deux moteurs (messages, actions de masse) vivent au niveau du module :
// fermer les réglages ou changer de page ne les arrête pas. Seul « Arrêter »
// (ou désactiver Message Cleaner pour les messages) les stoppe.

import "./styles.css";

import { SettingsTab, wrapTab } from "@components/settings/tabs/BaseTab";
import { HeaderBarIcon, hideTempHeaderButton, showTempHeaderButton } from "@lowcord/headerBar";
import { state as msgState, subscribe as subscribeMessages } from "@lowplugins/messageCleaner/engine";
import type { IconProps } from "@utils/types";
import { SettingsRouter, useEffect, useState } from "@webpack/common";

import { state as actionState, subscribe as subscribeActions } from "./cleaner";
import { CleanerSection } from "./CleanerSection";
import { I18nKey, t, useLang } from "./i18n";

export function BroomIcon({ width = 20, height = 20, color }: IconProps & { color?: string; }) {
    return (
        <svg width={width} height={height} viewBox="0 0 24 24" fill="currentColor" style={color ? { color } : undefined} aria-hidden="true">
            {/* Manche */}
            <path d="M20.7 1.9a1 1 0 0 1 1.4 1.4l-7.3 7.3-1.4-1.4 7.3-7.3Z" />
            {/* Brosse */}
            <path d="M11.3 8.4a1 1 0 0 1 1.4 0l2.9 2.9a1 1 0 0 1 0 1.4l-.9.9-4.3-4.3.9-.9Zm-2.3 2.2 4.4 4.4c-.4 2.6-1.9 5.3-4.3 7.1a1 1 0 0 1-1.1.1l-1.4-.8 1.6-2.4a.5.5 0 0 0-.8-.6l-2 2.1-1.4-.8 1.5-2.5a.5.5 0 0 0-.8-.6l-1.9 2.1-1.2-.7a1 1 0 0 1-.3-1.4c1.8-2.5 4.9-4.3 7.5-5.4Z" />
        </svg>
    );
}

function CleanerSettings() {
    useLang();
    return (
        <SettingsTab>
            <CleanerSection />
        </SettingsTab>
    );
}

export default wrapTab(CleanerSettings, "cleaner");

// ── Rond vert dans la barre du haut ──────────────────────────────────────────
const isRunning = () => msgState.running || actionState.running;

function useRunning() {
    const [, tick] = useState(0);
    useEffect(() => {
        const fn = () => tick(n => n + 1);
        const a = subscribeMessages(fn);
        const b = subscribeActions(fn);
        return () => { a(); b(); };
    }, []);
}

function PulseDot() {
    return <span className="lc-cl-header-dot" />;
}

function CleanerHeaderButton() {
    useLang();
    useRunning();
    if (!isRunning()) return null;

    const run = msgState.current;
    const tooltip = actionState.running
        ? `${t(`cl.a.${actionState.action}` as I18nKey)} — ${actionState.done}/${actionState.total}`
        : t("cl.headerMessages", { name: run?.target.name ?? "…", count: run?.deleted ?? 0 });

    return (
        <HeaderBarIcon
            icon={PulseDot}
            tooltip={tooltip}
            onClick={() => SettingsRouter.openUserSettings("vencord_cleaner_panel")}
        />
    );
}

function syncHeader() {
    if (isRunning()) showTempHeaderButton("LowCordCleaner", CleanerHeaderButton);
    else hideTempHeaderButton("LowCordCleaner");
}

subscribeMessages(syncHeader);
subscribeActions(syncHeader);
