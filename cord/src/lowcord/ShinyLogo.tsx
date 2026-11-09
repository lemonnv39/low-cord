/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — logo détouré avec un reflet de lumière qui le traverse (à
// l'ouverture, puis au survol), un halo doux derrière, et des effets en plus
// (`children`, ex. l'éclat de l'éclair de low-sound). Le reflet ne touche que
// le dessin : l'image elle-même sert de masque.

import { classNameFactory } from "@utils/css";
import type { CSSProperties, ReactNode } from "react";

const cl = classNameFactory("lc-shine-");

export function ShinyLogo({ src, label, tone = "silver", children }: {
    /** image en data URL (PNG détouré) */
    src: string;
    label: string;
    /** couleur du reflet et du halo */
    tone?: "silver" | "gold";
    children?: ReactNode;
}) {
    const style = { "--lc-shine-img": `url("${src}")` } as CSSProperties;
    return (
        <div className={cl("root", `tone-${tone}`)} style={style} role="img" aria-label={label}>
            <span className={cl("halo")} aria-hidden="true" />
            <img className={cl("img")} src={src} alt="" draggable={false} />
            <span className={cl("sheen")} aria-hidden="true" />
            {children}
        </div>
    );
}
