/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * AntiMoveDeco — verrouille ton salon vocal : si quelqu'un d'autre te
 * déplace ou te déconnecte, tu y es ramené. Bouton cadenas dans la barre du
 * haut (clic : activer / désactiver). Clic droit : choisir ce qui est
 * protégé (gardé d'une session à l'autre) :
 *  - anti-déplacement, anti-déconnexion ;
 *  - anti-mute serveur et anti-sourdine serveur : le mute / la sourdine mis
 *    par un modérateur sont retirés aussitôt. Il faut pour ça les permissions
 *    « Rendre muet » / « Mettre en sourdine » sur le serveur.
 *
 * Tes propres actions sont respectées : Discord annonce localement chaque
 * choix de salon que TU fais (VOICE_CHANNEL_SELECT) avant que le serveur ne
 * confirme le changement. Un changement confirmé par le serveur sans choix
 * de ta part juste avant = déplacement ou déconnexion par quelqu'un d'autre.
 */

import "./style.css";

import { definePluginSettings } from "@api/Settings";
import { addHeaderBarButton, HeaderBarIcon, removeHeaderBarButton } from "@lowcord/headerBar";
import { t, useLang } from "@lowcord/i18n";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { ChannelStore, ContextMenuApi, Menu, PermissionsBits, PermissionStore, RestAPI, SelectedChannelStore, showToast, useEffect, UserStore, useState } from "@webpack/common";

const logger = new Logger("AntiMoveDeco");
const ChannelActions = findByPropsLazy("selectVoiceChannel", "disconnect");

const settings = definePluginSettings({
    notify: {
        type: OptionType.BOOLEAN,
        description: "Show a pop-up when you are brought back",
        default: true,
    },
    antiMove: {
        type: OptionType.BOOLEAN,
        description: "Bring you back when someone moves you to another channel",
        default: true,
    },
    antiDeco: {
        type: OptionType.BOOLEAN,
        description: "Bring you back when someone disconnects you",
        default: true,
    },
    noServerMute: {
        type: OptionType.BOOLEAN,
        description: "Remove a server mute put on you (needs the Mute Members permission)",
        default: false,
    },
    noServerDeafen: {
        type: OptionType.BOOLEAN,
        description: "Remove a server deafen put on you (needs the Deafen Members permission)",
        default: false,
    },
});

/** Délai pendant lequel un changement de salon est attribué à ton propre choix. */
const INTENT_WINDOW = 6000;
/** Au-delà de ce nombre de retours en 30 s, on abandonne (salon supprimé, accès retiré…). */
const MAX_RETURNS = 3;
const RETURN_WINDOW = 30_000;

let target: string | null = null;
let intent: { channelId: string | null; at: number; } | null = null;
let ourSelect = false;
let returns: number[] = [];

/** Salon verrouillé (null = verrou désactivé). */
export const getLockedChannel = () => target;

const listeners = new Set<() => void>();
const emit = () => listeners.forEach(fn => fn());

const channelName = (id: string | null) => {
    const c = id ? ChannelStore.getChannel(id) : null;
    return c?.name ? `#${c.name}` : t("amd.unknownChannel");
};

function notify(text: string, variant: "default" | "success" | "critical" = "default") {
    if (settings.store.notify || variant === "critical") showToast({ text, variant });
}

function lock(channelId: string) {
    target = channelId;
    returns = [];
    emit();
}

function unlock() {
    target = null;
    intent = null;
    returns = [];
    emit();
}

export function toggle() {
    if (target) {
        unlock();
        notify(t("amd.off"));
        return;
    }
    const channelId = SelectedChannelStore.getVoiceChannelId();
    if (!channelId) {
        showToast({ text: t("amd.joinFirst"), variant: "critical" });
        return;
    }
    lock(channelId);
    notify(t("amd.on", { channel: channelName(channelId) }), "success");
}

function bringBack(reason: "moved" | "disconnected") {
    const channelId = target;
    if (!channelId) return;

    const now = Date.now();
    returns = returns.filter(at => now - at < RETURN_WINDOW);
    const channel = ChannelStore.getChannel(channelId);
    const allowed = channel && (!channel.guild_id || PermissionStore.can(PermissionsBits.CONNECT, channel));

    if (!allowed || returns.length >= MAX_RETURNS) {
        unlock();
        showToast({ text: t("amd.gaveUp", { channel: channelName(channelId) }), variant: "critical" });
        return;
    }
    returns.push(now);

    // Petit délai : laisse Discord finir de traiter le déplacement avant d'y revenir.
    setTimeout(() => {
        if (target !== channelId) return;
        try {
            ourSelect = true;
            ChannelActions.selectVoiceChannel(channelId);
        } catch (e) {
            logger.error("Retour dans le salon impossible", e);
        } finally {
            ourSelect = false;
        }
        notify(t(reason === "moved" ? "amd.backMoved" : "amd.backDisconnected", { channel: channelName(channelId) }));
    }, 400);
}

function onVoiceChannelSelect({ channelId }: { channelId?: string | null; }) {
    // Nos propres retours ne comptent pas comme un choix de l'utilisateur.
    if (!ourSelect) intent = { channelId: channelId ?? null, at: Date.now() };
}

// ── Mute / sourdine serveur ──────────────────────────────────────────────────
// Retirés seulement avec la permission sur le salon ; au plus 3 fois en 30 s
// (un modérateur qui insiste ne déclenche pas une boucle).
const undone: number[] = [];
const warnedNoPerm = new Set<string>();

async function undoServer(kind: "mute" | "deaf", guildId: string, channelId: string) {
    const channel = ChannelStore.getChannel(channelId);
    const perm = kind === "mute" ? PermissionsBits.MUTE_MEMBERS : PermissionsBits.DEAFEN_MEMBERS;
    if (!channel || !PermissionStore.can(perm, channel)) {
        const key = `${kind}:${guildId}`;
        if (!warnedNoPerm.has(key)) {
            warnedNoPerm.add(key);
            showToast({ text: t(kind === "mute" ? "amd.noPermMute" : "amd.noPermDeaf"), variant: "critical" });
        }
        return;
    }
    const now = Date.now();
    while (undone.length && now - undone[0] > RETURN_WINDOW) undone.shift();
    if (undone.length >= MAX_RETURNS) return;
    undone.push(now);
    const me = UserStore.getCurrentUser()?.id;
    try {
        await RestAPI.patch({ url: `/guilds/${guildId}/members/${me}`, body: { [kind]: false } });
        notify(t(kind === "mute" ? "amd.unmuted" : "amd.undeafened"));
    } catch (e) {
        logger.error(`Retrait du ${kind} serveur impossible`, e);
    }
}

interface VoiceState {
    userId: string;
    channelId?: string | null;
    guildId?: string | null;
    mute?: boolean;
    deaf?: boolean;
}

function onVoiceStates({ voiceStates }: { voiceStates?: VoiceState[]; }) {
    if (!target || !Array.isArray(voiceStates)) return;
    const me = UserStore.getCurrentUser()?.id;
    const mine = voiceStates.find(s => s.userId === me);
    if (!mine) return;

    const now = (mine.channelId ?? null);
    // Toujours dans le salon verrouillé : seuls le mute / la sourdine serveur comptent.
    if (now === target) {
        const guildId = mine.guildId ?? ChannelStore.getChannel(now)?.guild_id;
        if (guildId) {
            if (mine.mute && settings.store.noServerMute) undoServer("mute", guildId, now);
            if (mine.deaf && settings.store.noServerDeafen) undoServer("deaf", guildId, now);
        }
        return;
    }

    const chosen = intent && Date.now() - intent.at < INTENT_WINDOW && intent.channelId === now;
    intent = null;

    if (chosen) {
        // C'est toi : on suit ton choix au lieu de te ramener.
        if (now == null) {
            unlock();
            notify(t("amd.offLeft"));
        } else {
            lock(now);
            notify(t("amd.followed", { channel: channelName(now) }));
        }
        return;
    }

    // Protection coupée pour ce cas : on suit au lieu de ramener.
    if (now == null && !settings.store.antiDeco) {
        unlock();
        notify(t("amd.offLeft"));
        return;
    }
    if (now != null && !settings.store.antiMove) {
        lock(now);
        notify(t("amd.followed", { channel: channelName(now) }));
        return;
    }

    bringBack(now == null ? "disconnected" : "moved");
}

// ── Menu du clic droit : ce qui est protégé ─────────────────────────────────
function DangerLabel({ text }: { text: string; }) {
    return (
        <span className="lc-amd-danger">
            {text}
            <small>{t("amd.menuPerms")}</small>
        </span>
    );
}

function OptionsMenu() {
    useLang();
    const s = settings.use(["antiMove", "antiDeco", "noServerMute", "noServerDeafen"]);
    return (
        <Menu.Menu navId="lc-amd-options" onClose={ContextMenuApi.closeContextMenu} aria-label={t("amd.menuTitle")}>
            <Menu.MenuGroup label={t("amd.menuTitle")}>
                <Menu.MenuCheckboxItem id="lc-amd-move" label={t("amd.menuMove")} checked={s.antiMove} action={() => { settings.store.antiMove = !s.antiMove; }} />
                <Menu.MenuCheckboxItem id="lc-amd-deco" label={t("amd.menuDeco")} checked={s.antiDeco} action={() => { settings.store.antiDeco = !s.antiDeco; }} />
            </Menu.MenuGroup>
            <Menu.MenuSeparator />
            <Menu.MenuGroup>
                <Menu.MenuCheckboxItem id="lc-amd-mute" label={<DangerLabel text={t("amd.menuMute")} /> as any} checked={s.noServerMute} action={() => { settings.store.noServerMute = !s.noServerMute; }} />
                <Menu.MenuCheckboxItem id="lc-amd-deaf" label={<DangerLabel text={t("amd.menuDeaf")} /> as any} checked={s.noServerDeafen} action={() => { settings.store.noServerDeafen = !s.noServerDeafen; }} />
            </Menu.MenuGroup>
        </Menu.Menu>
    );
}

function openOptions(e: React.MouseEvent) {
    e.preventDefault();
    ContextMenuApi.openContextMenu(e as any, () => <OptionsMenu />);
}

// ── Bouton ───────────────────────────────────────────────────────────────────
function LockIcon({ on }: { on: boolean; }) {
    return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            {on
                ? <path fillRule="evenodd" clipRule="evenodd" d="M7 9V7a5 5 0 0 1 10 0v2h.5A2.5 2.5 0 0 1 20 11.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 19.5v-8A2.5 2.5 0 0 1 6.5 9H7Zm2 0h6V7a3 3 0 1 0-6 0v2Zm3 4a1.5 1.5 0 0 0-1 2.62V17a1 1 0 1 0 2 0v-1.38A1.5 1.5 0 0 0 12 13Z" />
                : <path fillRule="evenodd" clipRule="evenodd" d="M9 9V7a3 3 0 0 1 5.83-1 1 1 0 0 0 1.89-.66A5 5 0 0 0 7 7v2h-.5A2.5 2.5 0 0 0 4 11.5v8A2.5 2.5 0 0 0 6.5 22h11a2.5 2.5 0 0 0 2.5-2.5v-8A2.5 2.5 0 0 0 17.5 9H9Zm3 4a1.5 1.5 0 0 0-1 2.62V17a1 1 0 1 0 2 0v-1.38A1.5 1.5 0 0 0 12 13Z" />}
        </svg>
    );
}

function LockButton() {
    useLang();
    const [, tick] = useState(0);
    useEffect(() => {
        const fn = () => tick(n => n + 1);
        listeners.add(fn);
        return () => { listeners.delete(fn); };
    }, []);

    const on = target != null;
    return (
        <div className={on ? "lc-amd-on" : undefined} style={{ display: "contents" }} onContextMenu={openOptions}>
            <HeaderBarIcon
                icon={() => <LockIcon on={on} />}
                tooltip={on ? t("amd.tooltipOn", { channel: channelName(target) }) : t("amd.tooltipOff")}
                onClick={toggle}
                selected={on}
            />
        </div>
    );
}

export default definePlugin({
    name: "AntiMoveDeco",
    description: "Anti move & disconnect: if someone moves or disconnects you, you are brought back.",
    tags: ["Voice", "Utility"],
    authors: [{ name: "0ctane", id: 0n }],
    settings,

    flux: {
        VOICE_CHANNEL_SELECT: onVoiceChannelSelect,
        VOICE_STATE_UPDATES: onVoiceStates,
        // Nouveau compte : le verrou de l'ancien ne s'applique plus.
        CONNECTION_OPEN: () => { unlock(); },
    },

    start() {
        addHeaderBarButton("AntiMoveDeco", LockButton, 4);
    },

    stop() {
        removeHeaderBarButton("AntiMoveDeco");
        unlock();
    },
});
