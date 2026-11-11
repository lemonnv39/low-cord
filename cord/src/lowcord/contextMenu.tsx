/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — entrées des plugins low-cord dans les menus clic droit (personne,
// MP, groupe, salon, serveur) : toutes en haut du menu, rangées par section,
// une séparation entre chaque section et avant les entrées de Discord. Sans
// ça, chaque plugin posait les siennes à un endroit différent.

import { Menu } from "@webpack/common";
import type { ReactNode } from "react";

/**
 * - view : consulter (journal, images, permissions, infos)
 * - actions : agir sans risque (suivre en vocal)
 * - export : sortir des données (exporter la conversation)
 * - danger : effacer / supprimer
 */
export type LowMenuSection = "view" | "actions" | "export" | "danger";

const SECTIONS: LowMenuSection[] = ["view", "actions", "export", "danger"];
const KEY = "lowcord-menu-";

interface Entry {
    order: number;
    node: ReactNode;
}

// Un tableau `children` par affichage du menu, partagé par tous les plugins.
const menus = new WeakMap<any[], Map<LowMenuSection, Entry[]>>();

/**
 * Ajoute une entrée en haut du menu. `order` range les entrées d'une même
 * section (plus petit = plus haut), quel que soit l'ordre de chargement des
 * plugins.
 */
export function addLowCordMenuItem(children: any[], section: LowMenuSection, node: ReactNode, order = 50) {
    if (!node) return;
    let sections = menus.get(children);
    if (!sections) menus.set(children, sections = new Map());
    const list = sections.get(section) ?? [];
    list.push({ order, node });
    list.sort((a, b) => a.order - b.order);
    sections.set(section, list);

    // Nos groupes déjà posés sont retirés puis reposés en tête, dans l'ordre.
    for (let i = children.length - 1; i >= 0; i--) {
        if (typeof children[i]?.key === "string" && children[i].key.startsWith(KEY)) children.splice(i, 1);
    }
    const groups = SECTIONS
        .filter(s => sections!.get(s)?.length)
        .map(s => <Menu.MenuGroup key={KEY + s}>{sections!.get(s)!.map(e => e.node)}</Menu.MenuGroup>);
    children.unshift(...groups);
}
