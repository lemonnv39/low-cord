/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// RecIndicator — badge « REC » sur les membres du vocal qui ont activé les
// clips Discord. Le serveur vocal envoie à chaque participant les flags des
// autres (RTC_CONNECTION_FLAGS) ; ClipsStore les garde par personne. Discord
// s'en sert seulement pour un avertissement sans nom : ici on montre qui.

import "./style.css";

import { t } from "@lowcord/i18n";
import definePlugin from "@utils/types";
import { findStoreLazy } from "@webpack";
import { SelectedChannelStore, Tooltip, useStateFromStores, VoiceStateStore } from "@webpack/common";

const ClipsStore = findStoreLazy("ClipsStore");

// Les flags restent en mémoire après un départ : on ne les croit que pour les
// gens du salon où on est (le seul dont on reçoit les flags).
function useRec(userId: string | undefined) {
    return useStateFromStores([ClipsStore, VoiceStateStore, SelectedChannelStore], () => {
        if (!userId) return false;
        const mine = SelectedChannelStore.getVoiceChannelId();
        if (!mine || VoiceStateStore.getVoiceStateForUser(userId)?.channelId !== mine) return false;
        return ClipsStore.isClipsEnabledForUser(userId) === true;
    }, [userId]);
}

function RecBadge() {
    return (
        <Tooltip text={t("rec.tooltip")} key="lc-rec">
            {props => <span {...props} className="lc-rec-badge">REC</span>}
        </Tooltip>
    );
}

export default definePlugin({
    name: "RecIndicator",
    description: "Shows a REC badge next to voice members who have Discord Clips enabled (they can record your voice). Only in the channel you're in",
    authors: [],
    tags: ["Voice", "Privacy"],

    patches: [
        {
            // Icônes à droite d'un membre dans la liste du salon vocal (muet, caméra, stream…).
            find: '"soundboard-mute")',
            replacement: [
                {
                    // Le hook est posé avant le `return null` du composant, pour garder l'ordre des hooks.
                    match: /(?<=function \i\((\i)\)\{)(?=let\{className:\i,mute:\i,localMute:\i,localVideoDisabled:)/,
                    replace: "let lcRec=$self.useRec($1.user?.id);"
                },
                {
                    match: /(?=let \i=null!=\i&&!\i\.isEmbedded;return 0!==(\i)\.length)/,
                    replace: "lcRec&&$1.push($self.RecBadge());"
                }
            ]
        }
    ],

    useRec,
    RecBadge,
});
