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
import { HeaderBarIcon, hideTempHeaderButton, showTempHeaderButton } from "@lowcord/headerBar";
import { t, useLang } from "@lowcord/i18n";
import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { saveFile } from "@utils/web";
import type { Channel, RenderModalProps, User } from "@vencord/discord-types";
import { ChannelStore, Menu, Modal, openModal, showToast, useEffect, UserStore, useState } from "@webpack/common";

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

// ── Export en cours (indépendant de la fenêtre) ─────────────────────────────
// L'export vit ici, pas dans la fenêtre : la fermer (clic à côté, Échap) ne
// l'arrête pas. Un bouton dans la barre du haut permet de la rouvrir, et le
// clic droit sur la même conversation la rouvre aussi au lieu de recommencer.
type JobState = "running" | "saving" | "done" | "error" | "canceled";

interface Job {
    channelId: string;
    name: string;
    state: JobState;
    progress: ExportProgress | null;
    result: { count: number; skipped: number; size: number; } | null;
    cancel: { canceled: boolean; };
}

let job: Job | null = null;
const listeners = new Set<() => void>();
const emit = () => {
    if (job && (job.state === "running" || job.state === "saving")) showTempHeaderButton("ExportMessages", HeaderButton);
    else hideTempHeaderButton("ExportMessages");
    listeners.forEach(fn => fn());
};

function useJob() {
    const [, tick] = useState(0);
    useEffect(() => {
        const fn = () => tick(n => n + 1);
        listeners.add(fn);
        return () => { listeners.delete(fn); };
    }, []);
    return job;
}

function update(patch: Partial<Job>) {
    if (!job) return;
    Object.assign(job, patch);
    emit();
}

function runJob(channelId: string, name: string) {
    const current: Job = { channelId, name, state: "running", progress: null, result: null, cancel: { canceled: false } };
    job = current;
    emit();
    exportConversation(channelId, { media: settings.store.media as MediaMode, maxMB: Number(settings.store.maxMB) || 0 }, current.cancel, progress => {
        if (job === current) update({ progress });
    })
        .then(async res => {
            if (job !== current) return;
            update({ state: "saving" });
            if (IS_DISCORD_DESKTOP) await DiscordNative.fileManager.saveWithDialog(res.data, res.filename);
            else saveFile(new File([res.data as unknown as BlobPart], res.filename, { type: "text/html" }));
            update({ state: "done", result: { count: res.count, skipped: res.skipped, size: res.data.length } });
            showToast({ text: t("em.done", { count: res.count }), variant: "success" });
        })
        .catch(e => {
            if (job !== current) return;
            if (e instanceof CanceledError) {
                update({ state: "canceled" });
                return;
            }
            logger.error("Export impossible", e);
            update({ state: "error" });
            showToast({ text: t("em.error"), variant: "critical" });
        });
}

const isActive = (j: Job | null) => !!j && (j.state === "running" || j.state === "saving");

// ── Fenêtre de progression ───────────────────────────────────────────────────
function ExportModal({ modalProps }: { modalProps: RenderModalProps; }) {
    useLang();
    const j = useJob();
    if (!j) return null;
    const p = j.progress;
    const { state, result } = j;

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

    const finished = !isActive(j);

    return (
        <Modal {...modalProps} size="sm" title={t("em.title")} subtitle={j.name}>
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
                {!finished && <div className={cl("hint")}>{t("em.background")}</div>}
                <div className={cl("actions")}>
                    {!finished && <button className={cl("btn")} disabled={state === "saving"} onClick={() => { j.cancel.canceled = true; }}>{t("em.cancel")}</button>}
                    <button className={cl("btn", "btn-primary")} onClick={modalProps.onClose}>{t(finished ? "em.close" : "em.hide")}</button>
                </div>
            </div>
        </Modal>
    );
}

const openProgress = () => openModal(props => (
    <ErrorBoundary>
        <ExportModal modalProps={props} />
    </ErrorBoundary>
));

function HeaderButton() {
    useLang();
    const j = useJob();
    const p = j?.progress;
    const label = !p || p.phase === "messages" ? t("em.phaseMessages", { count: p?.messages ?? 0 })
        : p.phase === "media" ? t("em.headerMedia", { done: p.mediaDone, total: p.mediaTotal })
            : t("em.title");
    return <HeaderBarIcon icon={() => <ExportIcon width={20} height={20} />} tooltip={`${j?.name ?? ""} — ${label}`} onClick={openProgress} />;
}

function startExport(channel: Channel | undefined, name: string) {
    if (!channel?.id) {
        showToast({ text: t("em.noConversation"), variant: "critical" });
        return;
    }
    if (isActive(job)) {
        // Même conversation : on montre l'export en cours au lieu de recommencer.
        if (job!.channelId !== channel.id) showToast({ text: t("em.alreadyRunning"), variant: "critical" });
        openProgress();
        return;
    }
    runJob(channel.id, name);
    openProgress();
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

    stop() {
        if (job) job.cancel.canceled = true;
        hideTempHeaderButton("ExportMessages");
    },
});
