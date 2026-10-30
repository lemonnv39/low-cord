/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * Message Cleaner — supprime tes propres messages (MP, groupes, serveurs,
 * salons). Ouverture : bouton dans la barre du haut, ou clic droit sur une
 * personne, un salon, un groupe, un serveur ou un message. Toujours une
 * confirmation avant de commencer ; rien d'autre que tes messages n'est
 * touché, et aucun message n'est jamais envoyé.
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { addHeaderBarButton, HeaderBarIcon, removeHeaderBarButton } from "@lowcord/headerBar";
import { t, useLang } from "@lowcord/i18n";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, Menu, UserStore } from "@webpack/common";
import type { ReactElement } from "react";

import { confirmClean, openCleaner, useEngine } from "./CleanerModal";
import { loadHistory, setBaseDelay, state, stop, Target } from "./engine";

const settings = definePluginSettings({
    delayMs: {
        type: OptionType.NUMBER,
        description: "Delay between two deletions (ms). Lower is faster; Discord slows you down if it is too fast.",
        default: 700,
        onChange: (v: number) => setBaseDelay(v),
    },
});

function EraserIcon({ size = 20 }: { size?: number | string; }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path fillRule="evenodd" clipRule="evenodd" d="M14.6 2.6a2 2 0 0 1 2.83 0l4 4a2 2 0 0 1 0 2.83L12.3 18.56H20a1 1 0 1 1 0 2H8.4a1 1 0 0 1-.7-.3l-5.1-5.1a2 2 0 0 1 0-2.83L14.6 2.6Zm-4.65 7.82-4.93 4.93L8.82 19.1h.65l4.62-4.62-4.14-4.06Z" />
        </svg>
    );
}

const open = () => openCleaner(settings.store.delayMs, ms => { settings.store.delayMs = ms; });

function HeaderButton() {
    useLang();
    const s = useEngine();
    const run = s.current;
    const tooltip = run
        ? t("mc.headerRunning", { name: run.target.name, count: run.deleted })
        : t("mc.title");

    return (
        <div className={s.running ? "lc-mc-header-running" : undefined} style={{ display: "contents" }}>
            <HeaderBarIcon icon={() => <EraserIcon />} tooltip={tooltip} onClick={open} selected={s.running} />
        </div>
    );
}

// ── Clic droit ───────────────────────────────────────────────────────────────
function menuItem(id: string, label: string, target: Target | null) {
    if (state.running) {
        return <Menu.MenuItem id={`lc-mc-stop-${id}`} label={t("mc.stopCleaning")} color="danger" action={stop} />;
    }
    if (!target) return null;
    return <Menu.MenuItem id={`lc-mc-${id}`} label={label} color="danger" action={() => confirmClean([target])} />;
}

function channelTarget(channel: any): Target | null {
    if (!channel?.id) return null;
    if (channel.isDM?.()) {
        const u = UserStore.getUser(channel.getRecipientId());
        return { kind: "dm", id: channel.id, name: u?.globalName || u?.username || channel.id };
    }
    if (channel.isMultiUserDM?.()) return { kind: "group", id: channel.id, name: channel.name || t("mc.kind.group") };
    return { kind: "channel", id: channel.id, name: `#${channel.name ?? channel.id}` };
}

const push = (children: any[], item: ReactElement | null) => {
    if (item) children.push(<Menu.MenuGroup key="lc-mc-group">{item}</Menu.MenuGroup>);
};

const userMenu: NavContextMenuPatchCallback = (children, { user }: { user?: any; }) => {
    if (!user?.id || user.id === UserStore.getCurrentUser()?.id || user.bot) return;
    const dmId = ChannelStore.getDMFromUserId(user.id);
    const name = user.globalName || user.username;
    const target: Target = dmId ? { kind: "dm", id: dmId, name } : { kind: "user", id: user.id, name };
    push(children, menuItem("user", t("mc.menuUser", { name }), target));
};

const channelMenu: NavContextMenuPatchCallback = (children, { channel }: { channel?: any; }) => {
    const target = channelTarget(channel);
    if (!target) return;
    push(children, menuItem("channel", t(target.kind === "channel" ? "mc.menuChannel" : "mc.menuConversation", { name: target.name }), target));
};

const guildMenu: NavContextMenuPatchCallback = (children, { guild }: { guild?: any; }) => {
    if (!guild?.id) return;
    push(children, menuItem("guild", t("mc.menuServer"), { kind: "server", id: guild.id, name: guild.name }));
};

const messageMenu: NavContextMenuPatchCallback = (children, { channel, message }: { channel?: any; message?: any; }) => {
    const target = channelTarget(channel ?? ChannelStore.getChannel(message?.channel_id));
    if (!target) return;
    push(children, menuItem("message", t(target.kind === "channel" ? "mc.menuChannel" : "mc.menuConversation", { name: target.name }), target));
};

export default definePlugin({
    name: "MessageCleaner",
    description: "Bulk-delete your own messages in DMs, groups, servers and channels.",
    tags: ["Utility", "Privacy"],
    authors: [{ name: "0ctane", id: 0n }],
    settings,

    contextMenus: {
        "user-context": userMenu,
        "channel-context": channelMenu,
        "gdm-context": channelMenu,
        "thread-context": channelMenu,
        "guild-context": guildMenu,
        "message": messageMenu,
    },

    flux: {
        // Changement de compte : son propre historique.
        CONNECTION_OPEN: () => { loadHistory(); },
    },

    start() {
        setBaseDelay(settings.store.delayMs);
        loadHistory();
        addHeaderBarButton("MessageCleaner", HeaderButton, 7);
    },

    stop() {
        removeHeaderBarButton("MessageCleaner");
        stop();
    },
});
