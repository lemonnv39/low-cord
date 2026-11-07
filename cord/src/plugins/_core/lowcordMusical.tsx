/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-musical — bouton dans le panneau du compte (en bas à gauche), juste
// avant micro / casque. Visible seulement si low-musical est installé
// (Paramètres → low-musical). Ouvre le panneau flottant, ou ramène au premier
// plan la fenêtre à part si le panneau y est détaché. Fermer ne coupe pas la
// diffusion.

import ErrorBoundary from "@components/ErrorBoundary";
import { useMusical } from "@lowcord/musical/engine";
import { MusicalIcon } from "@lowcord/musical/LowMusicalTab";
import { MusicalPanel } from "@lowcord/musical/Panel";
import { useDetached } from "@lowcord/musical/popoutKey";
import { closeFloating, detach, toggleFloating, useFloatingOpen } from "@lowcord/musical/window";
import definePlugin from "@utils/types";
import { findComponentByCodeLazy } from "@webpack";
import { ReactDOM } from "@webpack/common";

// Bouton natif du panneau du compte (même rendu que micro / casque).
const PanelButton = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");

function MusicalButton(props: { nameplate?: unknown; }) {
    const music = useMusical();
    const open = useFloatingOpen();
    const detached = useDetached();
    if (!music.installed) return null;

    const live = Object.values(music.accounts).some(a => a.state === "in_voice");
    return (
        <>
            <PanelButton
                tooltipText={live ? "low-musical · en diffusion" : "low-musical"}
                icon={() => <MusicalIcon width={20} height={20} />}
                role="switch"
                ariaChecked={open || detached}
                plated={props?.nameplate != null}
                onClick={detached ? detach : toggleFloating}
            />
            {open && !detached && ReactDOM.createPortal(<MusicalPanel mode="floating" onClose={closeFloating} onDetach={detach} />, document.body)}
        </>
    );
}

export default definePlugin({
    name: "LowCordMusical",
    description: "low-musical button in the account panel",
    authors: [{ name: "shitday", id: 0n }],
    required: true,
    hidden: true,

    patches: [
        {
            find: "#{intl::USER_PROFILE_ACCOUNT_POPOUT_BUTTON_A11Y_LABEL}",
            replacement: {
                match: /children:\[(?=.{0,25}?accountContainerRef)/,
                replace: "children:[$self.MusicalButton(arguments[0]),"
            }
        }
    ],

    MusicalButton: ErrorBoundary.wrap(MusicalButton, { noop: true }),
});
