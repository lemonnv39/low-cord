/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-sound — bouton dans le panneau du compte (en bas à gauche), juste
// avant micro / casque. Visible seulement si low-sound est installé
// (Paramètres → low-sound). Ouvre le panneau (sa propre fenêtre, centrée
// sur Discord) ou le ramène au premier plan. Le fermer ne coupe pas la diffusion.

import ErrorBoundary from "@components/ErrorBoundary";
import { isActive, useLowSound } from "@lowcord/sound/engine";
import { SoundIcon } from "@lowcord/sound/LowSoundTab";
import { usePanelOpen } from "@lowcord/sound/popoutKey";
import { openPanel } from "@lowcord/sound/window";
import definePlugin from "@utils/types";
import { findComponentByCodeLazy } from "@webpack";

// Bouton natif du panneau du compte (même rendu que micro / casque).
const PanelButton = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");

function SoundButton(props: { nameplate?: unknown; }) {
    const music = useLowSound();
    const open = usePanelOpen();
    if (!music.installed) return null;

    const accounts = Object.values(music.accounts);
    const live = accounts.some(a => a.state === "in_voice");
    // Actif (au moins un compte connecté) : l'éclair passe au rouge, comme le micro coupé.
    const active = accounts.some(isActive);
    return (
        <PanelButton
            tooltipText={live ? "low-sound · en diffusion" : active ? "low-sound · actif" : "low-sound"}
            icon={() => (
                <span style={{ display: "flex", color: active ? "var(--status-danger, #f23f43)" : undefined }}>
                    <SoundIcon width={20} height={20} />
                </span>
            )}
            role="switch"
            ariaChecked={open}
            plated={props?.nameplate != null}
            onClick={openPanel}
        />
    );
}

export default definePlugin({
    name: "LowCordSound",
    description: "low-sound button in the account panel",
    authors: [{ name: "shitday", id: 0n }],
    required: true,
    hidden: true,

    patches: [
        {
            find: "#{intl::USER_PROFILE_ACCOUNT_POPOUT_BUTTON_A11Y_LABEL}",
            replacement: {
                match: /children:\[(?=.{0,25}?accountContainerRef)/,
                replace: "children:[$self.SoundButton(arguments[0]),"
            }
        }
    ],

    SoundButton: ErrorBoundary.wrap(SoundButton, { noop: true }),
});
