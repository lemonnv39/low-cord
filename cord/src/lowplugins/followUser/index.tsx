/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * FollowUser — suit un utilisateur en vocal : quand il change de salon, tu le
 * rejoins. Clic droit sur quelqu'un → « Suivre ». Un cœur dans la barre du
 * haut indique le suivi actif (clic : rejoindre son vocal, clic droit : arrêter).
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { addHeaderBarButton, HeaderBarIcon, removeHeaderBarButton } from "@lowcord/headerBar";
import { t, useLang } from "@lowcord/i18n";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { ChannelStore, Menu, PermissionsBits, PermissionStore, SelectedChannelStore, showToast, useEffect, UserStore, useState, VoiceStateStore } from "@webpack/common";

const logger = new Logger("FollowUser");

const ChannelActions = findByPropsLazy("selectVoiceChannel", "selectChannel");

// Un suivi par compte (plusieurs comptes peuvent partager le même Discord).
const dsKey = () => `followuser-v2-${UserStore.getCurrentUser()?.id ?? "?"}`;

const settings = definePluginSettings({
    inactivityMinutes: {
        type: OptionType.SELECT,
        description: "Automatically stop following after this long without voice activity from the followed user",
        options: [
            { label: "5 minutes", value: 5 },
            { label: "15 minutes", value: 15 },
            { label: "30 minutes", value: 30, default: true },
            { label: "1 hour", value: 60 },
            { label: "3 hours", value: 180 },
            { label: "Never", value: 0 },
        ],
    },
});

// ── État ──────────────────────────────────────────────────────────────────────
let followedId: string | null = null;
let followedName = "";
let followedChannel: string | null = null;
let inactivityTimer: ReturnType<typeof setTimeout> | null = null;

const listeners = new Set<() => void>();
function notifyAll() { listeners.forEach(fn => fn()); }

function useFollowState() {
    const [, tick] = useState(0);
    useEffect(() => {
        const fn = () => tick(n => n + 1);
        listeners.add(fn);
        return () => { listeners.delete(fn); };
    }, []);
    return followedId;
}

function persist() {
    return DataStore.set(dsKey(), followedId ? { id: followedId, name: followedName } : null)
        .catch(e => logger.error("Sauvegarde impossible", e));
}

function getChannelOf(userId: string): string | null {
    return VoiceStateStore.getVoiceStateForUser(userId)?.channelId ?? null;
}

function joinChannel(channelId: string) {
    if (SelectedChannelStore.getVoiceChannelId() === channelId) return true;

    const channel = ChannelStore.getChannel(channelId);
    if (!channel) {
        showToast({ text: t("fu.unreachable", { name: followedName }), variant: "critical" });
        return false;
    }
    const isPrivate = channel.isDM() || channel.isMultiUserDM();
    if (!isPrivate && !PermissionStore.can(PermissionsBits.CONNECT, channel)) {
        showToast({ text: t("fu.noPermission", { name: followedName }), variant: "critical" });
        return false;
    }

    // Différé : on est souvent appelé depuis un événement Flux, et rejoindre un
    // salon en déclenche un autre (« dispatch pendant un dispatch »).
    setTimeout(() => {
        try {
            ChannelActions.selectVoiceChannel(channelId);
        } catch (e) {
            logger.error("Impossible de rejoindre le salon", e);
        }
    }, 100);
    return true;
}

// ── Arrêt automatique après inactivité ───────────────────────────────────────
function clearInactivityTimer() {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = null;
}

function resetInactivityTimer() {
    clearInactivityTimer();
    const minutes = settings.store.inactivityMinutes ?? 30;
    if (!minutes) return; // 0 = jamais
    inactivityTimer = setTimeout(() => {
        if (!followedId) return;
        showToast({ text: t("fu.inactive", { name: followedName, minutes }), variant: "critical" });
        unfollow(true);
    }, minutes * 60 * 1000);
}

// ── Suivi ────────────────────────────────────────────────────────────────────
function follow(userId: string) {
    const user = UserStore.getUser(userId);
    followedId = userId;
    followedName = user?.globalName ?? user?.username ?? userId;
    followedChannel = getChannelOf(userId);

    persist();
    resetInactivityTimer();
    notifyAll();

    if (followedChannel) {
        if (joinChannel(followedChannel)) showToast({ text: t("fu.followJoin", { name: followedName }), variant: "success" });
    } else {
        showToast({ text: t("fu.followWait", { name: followedName }), variant: "success" });
    }
}

function unfollow(silent = false) {
    const name = followedName;
    followedId = null;
    followedName = "";
    followedChannel = null;
    clearInactivityTimer();
    persist();
    notifyAll();
    if (name && !silent) showToast({ text: t("fu.unfollowed", { name }) });
}

function joinFollowed() {
    if (!followedChannel) {
        showToast({ text: t("fu.notInVoice", { name: followedName }), variant: "critical" });
        return;
    }
    if (joinChannel(followedChannel)) resetInactivityTimer();
}

// ── Icône ────────────────────────────────────────────────────────────────────
function HeartIcon() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24">
            <path fill="currentColor" d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
        </svg>
    );
}

// ── Bouton de la barre du haut (visible seulement pendant un suivi) ──────────
function FollowHeaderButton() {
    useLang();
    const id = useFollowState();
    if (!id) return null;

    return (
        // Le bouton de Discord ne gère pas le clic droit : on l'attrape autour.
        <div style={{ display: "contents" }} onContextMenu={e => { e.preventDefault(); unfollow(); }}>
            <HeaderBarIcon
                icon={HeartIcon}
                tooltip={t("fu.headerTooltip", { name: followedName })}
                onClick={joinFollowed}
                selected={true}
            />
        </div>
    );
}

// ── Menu clic droit ──────────────────────────────────────────────────────────
const userContextPatch: NavContextMenuPatchCallback = (children, props) => {
    const userId: string | undefined = props?.user?.id;
    if (!userId) return;

    // On ne se suit pas soi-même.
    if (userId === UserStore.getCurrentUser()?.id) return;

    const isFollowed = followedId === userId;
    children.push(
        <Menu.MenuGroup>
            <Menu.MenuCheckboxItem
                id="vc-follow-user"
                label={t("fu.follow")}
                checked={isFollowed}
                action={() => isFollowed ? unfollow() : follow(userId)}
            />
        </Menu.MenuGroup>
    );
};

/** Reprend le suivi enregistré pour le compte connecté (au démarrage ou après un changement de compte). */
async function restoreFollow() {
    if (!UserStore.getCurrentUser()) return;
    clearInactivityTimer();
    followedId = null;
    followedName = "";
    followedChannel = null;

    let saved = await DataStore.get<{ id: string; name: string; } | null>(dsKey()).catch(() => null);
    // Ancienne version : un seul suivi pour tous les comptes. Repris une fois, puis effacé.
    if (saved === undefined) {
        const old = await DataStore.get<{ id: string; name: string; } | null>("followuser-v2").catch(() => null);
        if (old?.id) {
            saved = old;
            await DataStore.set(dsKey(), old).catch(() => null);
            await DataStore.del("followuser-v2").catch(() => null);
        }
    }
    if (saved?.id) {
        followedId = saved.id;
        followedName = saved.name || saved.id;
        followedChannel = getChannelOf(saved.id);
        resetInactivityTimer();
    }
    notifyAll();
}

// ── Plugin ───────────────────────────────────────────────────────────────────
export default definePlugin({
    name: "FollowUser",
    description: "Follow a user in voice: when they switch channels, you join them",
    tags: ["Voice", "Utility"],
    authors: [{ name: "0ctane", id: 0n }],
    settings,

    contextMenus: {
        "user-context": userContextPatch,
        "user-profile-actions": userContextPatch,
        "gdm-context": userContextPatch,
    },

    flux: {
        // Connexion (ou changement de compte) : le suivi propre à ce compte.
        CONNECTION_OPEN: () => { void restoreFollow(); },
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates?: { userId: string; channelId?: string | null; }[]; }) {
            if (!followedId || !Array.isArray(voiceStates)) return;
            for (const state of voiceStates) {
                if (state.userId !== followedId) continue;
                const channelId = state.channelId ?? null;
                if (channelId === followedChannel) continue;

                followedChannel = channelId;
                notifyAll();
                if (!channelId) continue;

                resetInactivityTimer();
                if (joinChannel(channelId)) showToast({ text: t("fu.moved", { name: followedName }) });
            }
        },
    },

    start() {
        addHeaderBarButton("FollowUser", FollowHeaderButton, 5);
        void restoreFollow();
    },

    stop() {
        removeHeaderBarButton("FollowUser");
        clearInactivityTimer();
        followedId = null;
        followedName = "";
        followedChannel = null;
        notifyAll();
    },
});
