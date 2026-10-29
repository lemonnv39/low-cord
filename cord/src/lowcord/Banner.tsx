/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — bannière en tête de l'onglet low-cord.
//
// Logo en deux calques détourés depuis l'original (encre grise + son ombre),
// utilisés comme MASQUES : les couleurs restent pilotées par le CSS (thème
// clair / sombre) et un reflet traverse l'encre. Derrière : un nid d'abeilles
// qui se fond dans la page, et une lueur qui le parcourt (elle suit la souris
// au survol). Images embarquées en base64 : aucun fichier externe.

import { classNameFactory } from "@utils/css";
import { copyWithToast } from "@utils/discord";
import { useRef } from "@webpack/common";
import ink from "file://assets/logo-ink.png?base64";
import shadow from "file://assets/logo-shadow.png?base64";

import { t } from "./i18n";

const cl = classNameFactory("lc-banner-");
const INK_URL = `url("data:image/png;base64,${ink}")`;
const SHADOW_URL = `url("data:image/png;base64,${shadow}")`;

export function Banner({ hash }: { hash: string; }) {
    const rootRef = useRef<HTMLDivElement>(null);

    // Position de la souris -> variables CSS (pas d'état React : aucun re-rendu).
    function onMouseMove(e: React.MouseEvent<HTMLDivElement>) {
        const el = rootRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        el.style.setProperty("--lc-mx", `${((e.clientX - r.left) / r.width) * 100}%`);
        el.style.setProperty("--lc-my", `${((e.clientY - r.top) / r.height) * 100}%`);
    }

    return (
        <div className={cl("root")} ref={rootRef} onMouseMove={onMouseMove}>
            <div className={cl("hex")} aria-hidden="true" />
            <div className={cl("hex", "hex-light")} aria-hidden="true" />
            <div className={cl("halo")} aria-hidden="true" />

            <div className={cl("logo")} role="img" aria-label="low-cord by Shitday">
                <div className={cl("shadow")} style={{ maskImage: SHADOW_URL, WebkitMaskImage: SHADOW_URL }} />
                <div className={cl("ink")} style={{ maskImage: INK_URL, WebkitMaskImage: INK_URL }} />
            </div>

            <div className={cl("text")}>
                <div className={cl("tagline")}>{t("tab.about")}</div>
            </div>

            <button
                className={cl("build")}
                title={t("tab.copyBuild")}
                onClick={() => copyWithToast(hash, t("tab.buildCopied"))}
            >
                {t("tab.build", { hash })}
            </button>
        </div>
    );
}
