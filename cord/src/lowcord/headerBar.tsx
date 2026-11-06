/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — boutons dans la barre du haut de Discord (à droite), partagés
// entre plugins. Un seul patch (plugin du cœur LowCordHeaderBar) ; chaque
// plugin ajoute / retire son bouton ici. Sans ça, deux plugins qui patchent
// le même endroit se marcheraient dessus.
//
// Deux zones, chacune encadrée de traits gris :
//   [Discord] | [temporaire] | [boutons low-cord]
// La zone temporaire n'existe que tant qu'un plugin y montre un bouton (ex. le
// suivi en cours de FollowUser) ; vide, elle disparaît avec ses traits.

import ErrorBoundary from "@components/ErrorBoundary";
import { findComponentByCodeLazy } from "@webpack";
import { useEffect, useState } from "@webpack/common";
import type { ComponentType, PropsWithChildren } from "react";

/** Bouton d'icône natif de la barre du haut (tooltip, état sélectionné…). */
export const HeaderBarIcon = findComponentByCodeLazy(".HEADER_BAR_BADGE_BOTTOM,", 'position:"bottom"');

interface Entry {
    id: string;
    Component: ComponentType;
    /** plus petit = plus à gauche */
    priority: number;
}

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(fn => fn());

export function addHeaderBarButton(id: string, Component: ComponentType, priority = 10) {
    entries.set(id, { id, Component, priority });
    emit();
}

export function removeHeaderBarButton(id: string) {
    if (entries.delete(id)) emit();
}

const tempEntries = new Map<string, Entry>();

/** Bouton temporaire, dans sa propre zone (entre deux traits) tant qu'il est affiché. */
export function showTempHeaderButton(id: string, Component: ComponentType, priority = 10) {
    const current = tempEntries.get(id);
    if (current?.Component === Component && current.priority === priority) return;
    tempEntries.set(id, { id, Component, priority });
    emit();
}

export function hideTempHeaderButton(id: string) {
    if (tempEntries.delete(id)) emit();
}

// Même trait que celui qui sépare les boutons de la fenêtre (réduire, fermer).
const DIVIDER: React.CSSProperties = {
    flex: "none",
    alignSelf: "center",
    width: 1,
    height: 20,
    margin: "0 6px",
    borderRadius: 1,
    background: "var(--border-subtle, var(--background-modifier-accent, rgb(255 255 255 / 12%)))",
};

function Buttons() {
    const [, tick] = useState(0);
    useEffect(() => {
        const fn = () => tick(n => n + 1);
        listeners.add(fn);
        return () => { listeners.delete(fn); };
    }, []);

    if (!entries.size && !tempEntries.size) return null;
    return (
        <>
            {tempEntries.size > 0 && (
                <>
                    {/* Zone temporaire, séparée de Discord et des boutons low-cord. */}
                    <div style={DIVIDER} aria-hidden="true" />
                    {renderEntries(tempEntries)}
                </>
            )}
            {entries.size > 0 && (
                <>
                    {/* Sépare ce qui précède (Discord ou zone temporaire) des boutons low-cord. */}
                    <div style={DIVIDER} aria-hidden="true" />
                    {renderEntries(entries)}
                </>
            )}
        </>
    );
}

function renderEntries(map: Map<string, Entry>) {
    return [...map.values()].sort((a, b) => a.priority - b.priority).map(({ id, Component }) => (
        <ErrorBoundary key={id} noop>
            <Component />
        </ErrorBoundary>
    ));
}

/** Remplace le Fragment des boutons de droite de la barre du haut (voir le patch). */
export function TrailingWrapper({ children }: PropsWithChildren) {
    return (
        <>
            {children}
            <ErrorBoundary noop>
                <Buttons />
            </ErrorBoundary>
        </>
    );
}
