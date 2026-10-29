/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — bannière en tête de l'onglet low-cord.
//
// Le logo est un PNG détouré (blanc + transparence) utilisé comme MASQUE : sa
// couleur vient du thème (clair ou sombre), et un reflet le traverse à
// l'ouverture. Embarqué en base64 dans la build : aucun fichier externe.

import { classNameFactory } from "@utils/css";
import logo from "file://assets/banner.png?base64";

const cl = classNameFactory("lc-banner-");
const LOGO_URL = `url("data:image/png;base64,${logo}")`;

export function Banner({ meta }: { meta: string; }) {
    return (
        <div className={cl("root")}>
            <div className={cl("grid")} aria-hidden="true" />
            <div className={cl("glow")} aria-hidden="true" />
            <div className={cl("logo-wrap")}>
                <div
                    className={cl("logo")}
                    role="img"
                    aria-label="low-cord by shitday"
                    style={{ maskImage: LOGO_URL, WebkitMaskImage: LOGO_URL }}
                />
            </div>
            <span className={cl("meta")}>{meta}</span>
        </div>
    );
}
