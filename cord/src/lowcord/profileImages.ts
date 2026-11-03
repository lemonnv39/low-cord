/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — avatar et bannière d'un profil, partagés entre plugins.
//
// Un seul patch (plugin du cœur LowCordProfileImages) branche l'avatar et la
// bannière des cartes de profil ; chaque plugin y inscrit ce qu'il fait au
// clic (ViewIcons : agrandir) ou au clic droit (ImageToolkit : outils).
// Sans plugin inscrit, Discord garde son comportement.
//
// Règle unique : seulement sur le profil de QUELQU'UN D'AUTRE. Jamais sur le
// tien (popout du compte, éditeur de profil dans les réglages), où un clic
// sur l'image sert à autre chose.

import { openImageModal } from "@utils/discord";
import type { User } from "@vencord/discord-types";
import { UserStore } from "@webpack/common";
import type { MouseEvent } from "react";

export type ProfileImageKind = "avatar" | "banner";

export interface ProfileImage {
    kind: ProfileImageKind;
    url: string;
    user: User;
    guildId?: string | null;
}

export type ProfileImageHandler = (image: ProfileImage, event?: MouseEvent) => void;

const handlers = {
    click: new Map<string, ProfileImageHandler>(),
    context: new Map<string, ProfileImageHandler>(),
};

/** Inscrit (ou retire avec null) l'action d'un plugin. */
export function setProfileImageHandler(type: keyof typeof handlers, owner: string, fn: ProfileImageHandler | null) {
    if (fn) handlers[type].set(owner, fn);
    else handlers[type].delete(owner);
}

const handlerFor = (type: keyof typeof handlers) => [...handlers[type].values()].at(-1);

function isSomeoneElse(user: User | undefined) {
    const me = UserStore.getCurrentUser()?.id;
    return !!user?.id && !!me && user.id !== me;
}

// ── Adresses des images ──────────────────────────────────────────────────────
const CDN_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

/** Image servie par Discord (les seules qu'on télécharge nous-mêmes). */
export function isDiscordCdn(url: string) {
    try {
        const u = new URL(url);
        return u.protocol === "https:" && CDN_HOSTS.has(u.hostname);
    } catch {
        return false;
    }
}

export function isAnimated(url: string) {
    try {
        const u = new URL(url, location.href);
        return u.searchParams.get("animated") === "true" || /\/a_[^/]*$/.test(u.pathname) || /\.gif$/i.test(u.pathname);
    } catch {
        return false;
    }
}

/**
 * Même image en taille `size` (et au format voulu si elle n'est pas animée :
 * une image animée garde son format, sinon elle deviendrait fixe).
 */
export function resizeImage(url: string, size: number, format?: string) {
    try {
        const u = new URL(url, location.href);
        if (!CDN_HOSTS.has(u.hostname)) return u.toString();
        u.searchParams.set("size", String(size));
        if (format && !isAnimated(url)) u.pathname = u.pathname.replace(/\.(png|jpe?g|webp)$/i, `.${format}`);
        return u.toString();
    } catch {
        return url;
    }
}

const BANNER_RATIO = 600 / 240;

/** Ouvre l'image en grand (visionneuse de Discord). */
export function openFullImage(url: string, kind: ProfileImageKind, size = 1024, format?: string) {
    openImageModal({
        url: resizeImage(url, size, format),
        original: resizeImage(url, 4096, format),
        width: kind === "banner" ? 1024 : 512,
        height: kind === "banner" ? Math.round(1024 / BANNER_RATIO) : 512,
    });
}

// ── Appelé par le code de Discord (patches de LowCordProfileImages) ──────────

function avatarOf(user: User, guildId?: string | null): ProfileImage {
    return { kind: "avatar", url: user.getAvatarURL(guildId ?? undefined, 1024, true), user, guildId };
}

/**
 * Clic sur l'avatar d'une carte de profil. `original` = ce que Discord ferait
 * (rien si null : Discord ne propose pas d'agrandir cet avatar ici).
 */
export function avatarClick(user: User, guildId: string | null | undefined, original: (() => void) | undefined) {
    const fn = handlerFor("click");
    if (!fn || original == null || !isSomeoneElse(user)) return original;
    return () => fn(avatarOf(user, guildId));
}

/** Ajoute le clic droit aux évènements de l'avatar d'une carte de profil. */
export function avatarHooks<T extends { eventHandlers?: object; }>(result: T, props: any): T {
    const fn = handlerFor("context");
    const user = props?.user as User | undefined;
    if (!fn || !result?.eventHandlers || !isSomeoneElse(user)) return result;
    const guildId = props.displayProfile?.guildId ?? props.guildId;
    return {
        ...result,
        eventHandlers: {
            ...result.eventHandlers,
            onContextMenu: (e: MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                fn(avatarOf(user!, guildId), e);
            },
        },
    };
}

/**
 * Bannière d'une carte de profil. Rien pendant l'édition de son profil
 * (bannière en attente) ni sur son propre profil. Seul un clic sur la
 * bannière elle-même compte, pas sur un bouton posé dessus.
 */
export function bannerHooks(props: any, src: string | null | undefined) {
    const user = props?.user as User | undefined;
    if (!src || props?.pendingBanner != null || !isSomeoneElse(user)) return {};

    const image: ProfileImage = { kind: "banner", url: src, user: user!, guildId: props.displayProfile?.guildId ?? props.guildId };
    const click = handlerFor("click");
    const context = handlerFor("context");
    return {
        vcOnClick: click && ((e: MouseEvent) => {
            if (e.target !== e.currentTarget) return;
            e.stopPropagation();
            click(image, e);
        }),
        vcOnContextMenu: context && ((e: MouseEvent) => {
            if (e.target !== e.currentTarget) return;
            e.preventDefault();
            e.stopPropagation();
            context(image, e);
        }),
    };
}
