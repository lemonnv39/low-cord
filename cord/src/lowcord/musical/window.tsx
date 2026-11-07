/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-musical — ouverture du panneau : flottant au-dessus de Discord, ou dans
// une fenêtre à part (même système que « Ouvrir l'appel dans une fenêtre »
// de Discord), qu'on peut poser sur un autre écran. La fenêtre est rendue par
// ce même Discord : l'état des comptes et les réglages sont partagés, et la
// fermer ne coupe rien.

import { findComponentByCodeLazy } from "@webpack";
import { PopoutActions, useEffect, useState } from "@webpack/common";

import { MusicalPanel } from "./Panel";
import { WINDOW_KEY } from "./popoutKey";

// Cadre des fenêtres détachées de Discord (thème, raccourcis, styles).
const PopoutWindow = findComponentByCodeLazy('"Missing guestWindow reference"');

// Panneau flottant ouvert ou non (partagé entre le bouton et la fenêtre).
let floatingOpen = false;
const listeners = new Set<() => void>();
const setFloating = (open: boolean) => {
    floatingOpen = open;
    listeners.forEach(fn => fn());
};

export function useFloatingOpen() {
    const [, tick] = useState(0);
    useEffect(() => {
        const fn = () => tick(n => n + 1);
        listeners.add(fn);
        return () => { listeners.delete(fn); };
    }, []);
    return floatingOpen;
}

export const toggleFloating = () => setFloating(!floatingOpen);
export const closeFloating = () => setFloating(false);

/** Ouvre la fenêtre à part (ou la met au premier plan si elle l'est déjà). */
export function detach() {
    setFloating(false);
    PopoutActions.open(
        WINDOW_KEY,
        key => (
            <PopoutWindow windowKey={key} title="low-musical" withTitleBar contentClassName="lc-mp-window-content">
                <MusicalPanel mode="window" onAttach={attach} />
            </PopoutWindow>
        ),
        { defaultWidth: 1000, defaultHeight: 760 },
    );
}

/** Ferme la fenêtre à part et rouvre le panneau dans Discord. */
export function attach() {
    PopoutActions.close(WINDOW_KEY);
    setFloating(true);
}
