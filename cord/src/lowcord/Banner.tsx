/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — bannière en tête de l'onglet low-cord : le logo détouré
// (mascotte + LOW-CORD), un reflet de lumière qui le traverse et un halo doux.
// Image embarquée en base64 : aucun fichier externe.

import { classNameFactory } from "@utils/css";
import { copyWithToast } from "@utils/discord";
import banner from "file://assets/banner-lowcord.png?base64";

import { t } from "./i18n";
import { ShinyLogo } from "./ShinyLogo";

const cl = classNameFactory("lc-banner-");
const BANNER = `data:image/png;base64,${banner}`;

export function Banner({ hash }: { hash: string; }) {
    return (
        <div className={cl("root")}>
            <ShinyLogo src={BANNER} label="low-cord" />

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
