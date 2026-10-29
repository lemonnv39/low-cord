/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BrowserWindow } from "electron";

// Discord cuit l'avatar de l'expéditeur du MP (avec le badge non-lu) dans une
// seule image et la passe à BrowserWindow#setOverlayIcon, que Windows affiche
// sur le bouton de la barre des tâches — avant même d'ouvrir la conversation.
// C'est une API Windows native appelée depuis le process principal, donc pas de
// hook côté renderer comme pour les notifications bureau ; on patche la méthode
// elle-même et on retire l'icône quand le mode "liste des MP" est actif.
let proofActive = false;

export function setActive(_: any, active: boolean) {
    proofActive = active;
}

const originalSetOverlayIcon = BrowserWindow.prototype.setOverlayIcon;
BrowserWindow.prototype.setOverlayIcon = function (overlay, description) {
    return originalSetOverlayIcon.call(this, proofActive ? null : overlay, description);
};
