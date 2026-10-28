/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/*
 * PlainFolderIcon — affiche une icône de dossier simple au lieu de la grille
 * des 4 mini-icônes de serveurs sur les dossiers fermés.
 *
 * Discord rend TOUJOURS les deux couches dans le même conteneur (l'icône de
 * dossier et la grille `.slice(0,4)` des serveurs) et bascule de l'une à
 * l'autre en CSS. Le patch ajoute une classe sur ce conteneur dans le même
 * état que Discord (« pas en train de glisser un serveur dessus ») ; le CSS
 * fait le reste. Aucun code exécuté à l'usage : un patch + une feuille de style.
 *
 * Vérifié contre le code réel de Discord (Stable + Canary, 2026-10-28) :
 *   …slice(0,4).map(…)…className:l()({[nX.NG]:s,[nX.yd]:!s}) …
 */

import "./style.css";

import { Devs } from "@utils/constants";
import definePlugin from "@utils/types";

const PLAIN_CLASS = "lc-plain-folder-icon";

export default definePlugin({
    name: "PlainFolderIcon",
    description: "Don't show the small guild icons in folders",
    tags: ["Appearance", "Customisation"],
    authors: [Devs.botato],

    patches: [
        {
            find: "#{intl::GUILD_FOLDER_TOOLTIP_A11Y_LABEL}",
            replacement: {
                // Fenêtre bornée (≈130 caractères dans le code actuel) : si Discord
                // réorganise ce module, le patch échoue proprement au lieu d'aller
                // accrocher un autre `[x]:a,[y]:!a` plus loin et de styler le mauvais élément.
                match: /\.slice\(0,4\).{0,250}?\]:(\i),\[\i\.\i\]:!\1/,
                replace: (m, showsPreview) => `${m},${JSON.stringify(PLAIN_CLASS)}:!${showsPreview}`
            }
        }
    ]
});
