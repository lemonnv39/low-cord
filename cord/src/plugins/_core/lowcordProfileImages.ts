/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — avatar et bannière des cartes de profil, partagés entre plugins
// (clic : ViewIcons, clic droit : ImageToolkit). Voir src/lowcord/profileImages.ts.

import { avatarClick, avatarHooks, bannerHooks } from "@lowcord/profileImages";
import definePlugin from "@utils/types";

export default definePlugin({
    name: "LowCordProfileImages",
    description: "Shared click / right-click on profile avatars and banners for low-cord plugins",
    authors: [{ name: "shitday", id: 0n }],
    required: true,
    hidden: true,

    patches: [
        {
            // Avatar d'une carte de profil
            find: "return{avatarProps:{",
            replacement: [
                {
                    // clic droit
                    match: /\{avatarProps:(\i),eventHandlers:(\i),isAnimating:(\i)\}=(\i)\((\i)\)/,
                    replace: "{avatarProps:$1,eventHandlers:$2,isAnimating:$3}=$self.avatarHooks($4($5),$5)"
                },
                {
                    // clic : seulement là où Discord propose déjà d'agrandir l'avatar
                    match: /(\i)=(null!=(\i)\.user\.avatar\|\|\3\.user\.hasAvatarForGuild\((\i)\)\?\i:void 0);/,
                    replace: "$1=$self.avatarClick($3.user,$4,$2);"
                }
            ]
        },
        {
            // Bannière d'une carte de profil : on lui passe nos actions
            find: 'backgroundColor:"COMPLETE"===',
            replacement: {
                match: /\(0,\i\.jsx\)\(\i\.\i,\{(?=fillClassName:.{0,40}?,bannerSrc:(\i),)/,
                replace: "$&...$self.bannerHooks(arguments[0],$1),"
            }
        },
        {
            // Affichage de la bannière : clic / clic droit sur l'image elle-même
            find: '"--custom-cutout-radius":',
            replacement: {
                match: /(?<=function \i\((\i)\)\{let\{bannerSrc:.{0,600}?)style:\{(?=\.\.\.\i,backgroundImage:)/,
                replace: 'onClick:$1.vcOnClick,onContextMenu:$1.vcOnContextMenu,style:{cursor:$1.vcOnClick!=null?"pointer":void 0,'
            }
        }
    ],

    avatarClick,
    avatarHooks,
    bannerHooks,
});
