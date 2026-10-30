/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — boutons dans la barre du haut de Discord (à droite), partagés
// entre plugins. Un seul patch (plugin du cœur LowCordHeaderBar) ; chaque
// plugin ajoute / retire son bouton ici. Sans ça, deux plugins qui patchent
// le même endroit se marcheraient dessus.

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

function Buttons() {
    const [, tick] = useState(0);
    useEffect(() => {
        const fn = () => tick(n => n + 1);
        listeners.add(fn);
        return () => { listeners.delete(fn); };
    }, []);

    return (
        <>
            {[...entries.values()].sort((a, b) => a.priority - b.priority).map(({ id, Component }) => (
                <ErrorBoundary key={id} noop>
                    <Component />
                </ErrorBoundary>
            ))}
        </>
    );
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
