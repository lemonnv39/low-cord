/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-sound — le panneau est sa propre fenêtre (sans cadre, système de
// fenêtres de Discord) : il s'ouvre centré sur Discord et se déplace en le
// tenant par son en-tête, y compris sur un autre écran. Il est rendu par ce
// même Discord : l'état des comptes et les réglages sont partagés, et le
// fermer ne coupe rien.

import { findComponentByCodeLazy } from "@webpack";
import { PopoutActions, PopoutWindowStore } from "@webpack/common";

import { SoundPanel } from "./Panel";
import { WINDOW_KEY } from "./popoutKey";

// Cadre des fenêtres de Discord (thème, raccourcis, styles), ici sans barre de titre.
const PopoutWindow = findComponentByCodeLazy('"Missing guestWindow reference"');

const WIDTH = 1240;
const HEIGHT = 800;

export const closePanel = () => PopoutActions.close(WINDOW_KEY);

/** Ouvre le panneau centré sur Discord (ou le ramène au premier plan s'il est déjà ouvert). */
export function openPanel() {
    // Taille gardée par Discord si la fenêtre a déjà été redimensionnée.
    const saved = PopoutWindowStore.getWindowState(WINDOW_KEY);
    const width = saved?.width || WIDTH;
    const height = saved?.height || HEIGHT;
    const left = Math.round(window.screenX + (window.outerWidth - width) / 2);
    const top = Math.round(window.screenY + (window.outerHeight - height) / 2);

    PopoutActions.open(
        WINDOW_KEY,
        key => (
            <PopoutWindow windowKey={key} title="low-sound" withTitleBar={false} contentClassName="lc-ls-window-content">
                <SoundPanel onClose={closePanel} />
            </PopoutWindow>
        ),
        // Fond transparent : seuls les blocs du panneau sont visibles.
        { defaultWidth: WIDTH, defaultHeight: HEIGHT, left, top, transparent: true, backgroundColor: "#00000000" } as any,
    );
}
