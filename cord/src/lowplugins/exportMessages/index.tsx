/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * ExportMessages — exporte toute une conversation privée (MP ou groupe), du
 * premier au dernier message, en UN fichier .html autonome : interface soignée,
 * images intégrées, profils cliquables (bannière, avatar, bio), recherche,
 * visionneuse d'images, thème clair / sombre.
 *
 * Clic droit sur une personne ou un groupe → « Exporter la conversation ».
 * Rien ne quitte ton PC : le fichier est écrit là où tu choisis.
 */

import "./styles.css";

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { addLowCordMenuItem } from "@lowcord/contextMenu";
import { t, useLang } from "@lowcord/i18n";
import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { saveFile } from "@utils/web";
import type { Channel, RenderModalProps, User } from "@vencord/discord-types";
import { ChannelStore, Menu, Modal, openModal, showToast, useEffect, useRef, UserStore, useState } from "@webpack/common";

import { CanceledError, exportConversation, ExportProgress, MediaMode } from "./exporter";

const cl = classNameFactory("lc-em-");
const logger = new Logger("ExportMessages");

const settings = definePluginSettings({
    media: {
        type: OptionType.SELECT,
        description: "Media saved inside the exported file",
        options: [
            { label: "Images (photos, GIFs, avatars, banners, emojis)", value: "images", default: true },
            { label: "Everything (also videos, audio and files)", value: "all" },
            { label: "None (links only)", value: "none" },
        ],
    },
    maxMB: {
        type: OptionType.NUMBER,
        description: "Maximum total size of saved media (MB)",
        default: 300,
    },
});

/** Une seule exportation à la fois. */
let running = false;

// ── Fenêtre de progression ───────────────────────────────────────────────────
function ExportModal({ channelId, name, modalProps }: { channelId: string; name: string; modalProps: RenderModalProps; }) {
    useLang();
    const [p, setP] = useState<ExportProgress | null>(null);
    const [state, setState] = useState<"running" | "saving" | "done" | "error" | "canceled">("running");
    const [result, setResult] = useState<{ count: number; skipped: number; size: number; } | null>(null);
    const cancel = useRef({ canceled: false });

    useEffect(() => {
        running = true;
        exportConversation(channelId, { media: settings.store.media as MediaMode, maxMB: Number(settings.store.maxMB) || 0 }, cancel.current, setP)
            .then(async res => {
                setState("saving");
                if (IS_DISCORD_DESKTOP) await DiscordNative.fileManager.saveWithDialog(res.data, res.filename);
                else saveFile(new File([res.data as unknown as BlobPart], res.filename, { type: "text/html" }));
                setResult({ count: res.count, skipped: res.skipped, size: res.data.length });
                setState("done");
            })
            .catch(e => {
                if (e instanceof CanceledError) {
                    setState("canceled");
                    return;
                }
                logger.error("Export impossible", e);
                setState("error");
            })
            .finally(() => { running = false; });
        // Fenêtre fermée en cours de route : on arrête proprement.
        return () => { cancel.current.canceled = true; };
    }, []);

    const pct = !p ? 0
        : p.phase === "messages" ? 5
            : p.phase === "profiles" ? 15
                : p.phase === "media" ? 15 + Math.round(80 * (p.mediaTotal ? p.mediaDone / p.mediaTotal : 1))
                    : 98;
    const mb = (n: number) => (n / 1048576).toFixed(1);

    const status = state === "done" ? t("em.done", { count: result?.count ?? 0 })
        : state === "error" ? t("em.error")
            : state === "canceled" ? t("em.canceled")
                : state === "saving" ? t("em.saving")
                    : !p || p.phase === "messages" ? t("em.phaseMessages", { count: p?.messages ?? 0 })
                        : p.phase === "profiles" ? t("em.phaseProfiles")
                            : p.phase === "media" ? t("em.phaseMedia", { done: p.mediaDone, total: p.mediaTotal, mb: mb(p.bytes) })
                                : t("em.phaseWriting");

    const finished = state === "done" || state === "error" || state === "canceled";

    return (
        <Modal {...modalProps} size="sm" title={t("em.title")} subtitle={name}>
            <div className={cl("root")}>
                <div className={cl("status", state === "error" && "status-error")}>{status}</div>
                <div className={cl("bar")}>
                    <div className={cl("bar-fill", finished && "bar-done", state === "error" && "bar-error")} style={{ width: `${finished ? 100 : pct}%` }} />
                </div>
                {p && (
                    <div className={cl("stats")}>
                        <span><b>{p.messages.toLocaleString()}</b> {t("em.statMessages")}</span>
                        {p.mediaTotal > 0 && <span><b>{p.mediaDone}/{p.mediaTotal}</b> {t("em.statMedia")}</span>}
                        {p.bytes > 0 && <span><b>{mb(p.bytes)}</b> Mo</span>}
                    </div>
                )}
                {state === "done" && result && result.skipped > 0 && <div className={cl("hint")}>{t("em.skipped", { count: result.skipped })}</div>}
                {state === "done" && result && <div className={cl("hint")}>{t("em.fileSize", { mb: mb(result.size) })}</div>}
                {!finished && <div className={cl("hint")}>{t("em.keepOpen")}</div>}
                <div className={cl("actions")}>
                    {!finished
                        ? <button className={cl("btn")} disabled={state === "saving"} onClick={() => { cancel.current.canceled = true; }}>{t("em.cancel")}</button>
                        : <button className={cl("btn", "btn-primary")} onClick={modalProps.onClose}>{t("em.close")}</button>}
                </div>
            </div>
        </Modal>
    );
}

function startExport(channel: Channel | undefined, name: string) {
    if (!channel?.id) {
        showToast({ text: t("em.noConversation"), variant: "critical" });
        return;
    }
    if (running) {
        showToast({ text: t("em.alreadyRunning"), variant: "critical" });
        return;
    }
    openModal(props => (
        <ErrorBoundary>
            <ExportModal channelId={channel.id} name={name} modalProps={props} />
        </ErrorBoundary>
    ));
}

// ── Clic droit ───────────────────────────────────────────────────────────────
function ExportIcon({ width = 24, height = 24, className }: { width?: number | string; height?: number | string; className?: string; }) {
    return (
        <svg className={className} width={width} height={height} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3v12" />
            <path d="m7 10 5 5 5-5" />
            <path d="M5 21h14" />
        </svg>
    );
}

function addItem(children: any[], channel: Channel | undefined, name: string) {
    if (!channel?.id) return;
    addLowCordMenuItem(children, "actions", (
        <Menu.MenuItem
            id="lc-em-export"
            key="lc-em-export"
            label={t("em.menu")}
            leadingAccessory={{ type: "icon", icon: ExportIcon }}
            action={() => startExport(channel, name)}
        />
    ), 30);
}

const isPrivate = (c?: Channel | null) => !!c && (c.isDM?.() || c.isMultiUserDM?.());

const userMenu: NavContextMenuPatchCallback = (children, { user, channel }: { user?: User; channel?: Channel; }) => {
    if (!user?.id || user.id === UserStore.getCurrentUser()?.id) return;
    // Depuis la liste des MP, Discord donne le salon ; sinon on cherche le MP.
    const dmId = ChannelStore.getDMFromUserId(user.id);
    const dm = isPrivate(channel) ? channel : dmId ? ChannelStore.getChannel(dmId) : null;
    if (!dm) return;
    addItem(children, dm, user.globalName || user.username);
};

const groupMenu: NavContextMenuPatchCallback = (children, { channel }: { channel?: Channel; }) => {
    if (!isPrivate(channel)) return;
    const name = channel!.name || (channel!.recipients ?? []).map(id => UserStore.getUser(id)?.username ?? id).join(", ");
    addItem(children, channel, name);
};

export default definePlugin({
    name: "ExportMessages",
    description: "Export a whole private conversation (DM or group), from the first to the last message, as one polished .html file with images, clickable profiles and search.",
    tags: ["Chat", "Utility"],
    authors: [{ name: "shitday", id: 0n }],
    settings,

    contextMenus: {
        "user-context": userMenu,
        "gdm-context": groupMenu,
    },
});
