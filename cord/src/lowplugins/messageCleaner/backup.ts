/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Message Cleaner — sauvegarde avant nettoyage. Avant de vider un MP ou un
// groupe, toute la conversation est exportée en un fichier .html (moteur du
// plugin ExportMessages) et rangée dans le dossier de cette conversation du
// journal de MessageLogger : <pseudo> [<id>]\sauvegardes\.

import { Settings } from "@api/Settings";
import { exportConversation, ExportProgress, MediaMode } from "@lowplugins/exportMessages/exporter";
import { folderLabel } from "@lowplugins/messageLogger/capture";
import { protectMessages } from "@lowplugins/messageLogger/shield";
import { PluginNative } from "@utils/types";
import { ChannelStore, UserStore } from "@webpack/common";

const Native = VencordNative.pluginHelpers.MessageLogger as PluginNative<typeof import("@lowplugins/messageLogger/native")> | undefined;

export interface BackupResult {
    file: string;
    count: number;
    size: number;
}

export const canBackup = (channelId: string | null) => {
    const channel = channelId ? ChannelStore.getChannel(channelId) : null;
    return !!Native && !!channel && !channel.guild_id;
};

const CHUNK = 4 * 1024 * 1024;
const pad = (n: number) => String(n).padStart(2, "0");

/** Renvoie null si la conversation est vide (rien à sauvegarder). */
export async function backupConversation(
    channelId: string,
    cancel: { canceled: boolean; },
    onProgress: (p: ExportProgress) => void,
): Promise<BackupResult | null> {
    const me = UserStore.getCurrentUser()?.id;
    if (!Native || !me) throw new Error("no-native");

    // Mêmes réglages que le plugin ExportMessages (médias intégrés, taille max).
    const prefs = Settings.plugins.ExportMessages ?? {};
    const res = await exportConversation(
        channelId,
        { media: (prefs.media ?? "images") as MediaMode, maxMB: Number(prefs.maxMB ?? 300) || 0 },
        cancel,
        onProgress,
        // Chaque page lue part aussi dans le journal : ce qui va être supprimé y reste.
        page => protectMessages(channelId, page, me),
    );
    if (!res.count) return null;

    const d = new Date();
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}h${pad(d.getMinutes())}`;
    const token = await Native.backupBegin(me, channelId, folderLabel(channelId), `${stamp} - avant nettoyage`);
    try {
        for (let i = 0; i < res.data.length; i += CHUNK) {
            if (cancel.canceled) throw new Error("canceled");
            await Native.backupChunk(token, res.data.subarray(i, i + CHUNK));
        }
        const file = await Native.backupEnd(token, true);
        if (!file) throw new Error("write");
        return { file, count: res.count, size: res.data.length };
    } catch (e) {
        await Native.backupEnd(token, false).catch(() => null);
        throw e;
    }
}

export function openBackup(channelId: string, file: string) {
    const me = UserStore.getCurrentUser()?.id;
    if (me) Native?.openBackup(me, channelId, file).catch(() => null);
}

export function showBackup(channelId: string, file: string) {
    const me = UserStore.getCurrentUser()?.id;
    if (me) Native?.showBackup(me, channelId, file).catch(() => null);
}
