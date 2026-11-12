/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// MessageLogger — protection des conversations privées.
//
// Le journal ne peut garder que les messages que low-cord a VUS avant leur
// suppression. Trois cas lui échappaient :
//
//  1. Ton propre nettoyage (Message Cleaner) : il lit tout l'historique par
//     l'API et supprime de vieux messages que Discord n'avait jamais chargés.
//     → protectMessages() : le nettoyeur confie chaque page lue au journal
//       AVANT de supprimer.
//
//  2. Quelqu'un d'autre vide la conversation avec un outil du même genre : les
//     suppressions arrivent une par une, des plus récentes aux plus anciennes
//     (ou l'inverse). → Bouclier : dès qu'une série de suppressions est
//     repérée dans un MP ou un groupe, low-cord lit tout l'historique restant
//     (100 messages par requête, bien plus vite que l'outil ne supprime) en
//     partant des deux bouts, et en garde une copie.
//
//  3. Un message reçu pendant que Discord était fermé, puis supprimé avant
//     que tu n'ouvres la conversation. → Au démarrage, les derniers messages
//     des MP non lus sont copiés.

import { t } from "@lowcord/i18n";
import { ChannelStore, PrivateChannelSortStore, ReadStateStore, RestAPI, showToast, UserStore } from "@webpack/common";

import { folderLabel, logger } from "./capture";

interface Hooks {
    /** le plugin tourne */
    active(): boolean;
    /** bouclier activé dans les réglages */
    shield(): boolean;
    preload(): boolean;
    maxMessages(): number;
    /** MP ou groupe */
    isPrivate(channelId: string): boolean;
    /** copie un message ; `media` : archive aussi ses pièces jointes (selon les réglages) */
    capture(msg: any, media: boolean): void;
}

let hooks: Hooks | null = null;
export const setShieldHooks = (h: Hooks | null) => { hooks = h; };

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const compareIds = (a: string, b: string) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

async function getMessages(channelId: string, query: Record<string, any>): Promise<any[] | null> {
    for (let attempt = 0; attempt < 6; attempt++) {
        try {
            const res: any = await RestAPI.get({ url: `/channels/${channelId}/messages`, query });
            return Array.isArray(res?.body) ? res.body : [];
        } catch (e: any) {
            if (e?.status === 429) {
                await sleep(Math.ceil((e?.body?.retry_after ?? 3) * 1000) + 300);
                continue;
            }
            if ((e?.status == null || e.status >= 500) && attempt < 3) {
                await sleep(1500 * (attempt + 1));
                continue;
            }
            // 403 / 404 : plus d'accès à la conversation.
            return null;
        }
    }
    return null;
}

// ── 1. Nettoyage lancé par toi ───────────────────────────────────────────────
/** Conversations que ton Message Cleaner est en train de vider (le bouclier n'a pas à s'en mêler). */
const ownCleaning = new Set<string>();
export function markOwnCleaning(channelId: string, on: boolean) {
    if (on) ownCleaning.add(channelId);
    else ownCleaning.delete(channelId);
}

/**
 * Messages lus par un autre plugin juste avant de les supprimer : copiés dans
 * le journal pour que leur contenu y reste. `mediaOf` : archive aussi les
 * pièces jointes des messages de cette personne.
 */
export function protectMessages(channelId: string, messages: any[], mediaOf?: string) {
    if (!hooks?.active() || !Array.isArray(messages)) return;
    for (const msg of messages) {
        if (!msg?.id) continue;
        hooks.capture({ ...msg, channel_id: msg.channel_id ?? channelId }, !!mediaOf && msg.author?.id === mediaOf);
    }
}

// ── 2. Bouclier : quelqu'un vide la conversation ─────────────────────────────
const BURST_COUNT = 3;
const BURST_WINDOW = 25_000;
const COOLDOWN = 15 * 60_000;
const PAGE_DELAY = 350;
/** Pièces jointes archivées au plus par passage du bouclier. */
const MEDIA_CAP = 1500;

const recentDeletes = new Map<string, number[]>();
const burstAuthors = new Map<string, Set<string>>();
const lastShield = new Map<string, number>();
const running = new Set<string>();

/** À chaque suppression reçue dans une conversation privée. */
export function noteDelete(channelId: string, authorId?: string) {
    if (!hooks?.active() || !hooks.shield() || ownCleaning.has(channelId) || !hooks.isPrivate(channelId)) return;
    const now = Date.now();
    const list = (recentDeletes.get(channelId) ?? []).filter(at => now - at < BURST_WINDOW);
    list.push(now);
    recentDeletes.set(channelId, list);
    if (authorId) {
        if (!burstAuthors.has(channelId)) burstAuthors.set(channelId, new Set());
        burstAuthors.get(channelId)!.add(authorId);
    }
    if (list.length < BURST_COUNT || running.has(channelId) || now - (lastShield.get(channelId) ?? 0) < COOLDOWN) return;
    lastShield.set(channelId, now);
    void shieldChannel(channelId);
}

async function shieldChannel(channelId: string) {
    const h = hooks;
    if (!h) return;
    running.add(channelId);
    const me = UserStore.getCurrentUser()?.id;
    const name = folderLabel(channelId) ?? channelId;
    showToast({ text: t("ml.shield.start", { name }), variant: "default", duration: 6000 });
    logger.info(`Bouclier : série de suppressions dans ${name}, copie de l'historique`);

    // Les pièces jointes de la personne qui supprime sont archivées en priorité.
    const authors = burstAuthors.get(channelId);
    const wantsMedia = (msg: any) => (authors?.size ? authors.has(msg.author?.id) : msg.author?.id !== me);
    let mediaLeft = MEDIA_CAP;
    let saved = 0;
    const seen = new Set<string>();

    try {
        const maxPages = Math.ceil(Math.max(100, h.maxMessages()) / 100);
        // Une page depuis la fin, une depuis le début, jusqu'à ce qu'elles se
        // rejoignent : l'outil d'en face peut partir d'un bout comme de l'autre.
        let before: string | undefined;
        let after = "0";
        for (let page = 0; page < maxPages && hooks === h && h.active(); page++) {
            const fromEnd = page % 2 === 0;
            const list = await getMessages(channelId, fromEnd ? { limit: 100, ...(before ? { before } : {}) } : { limit: 100, after });
            if (!list?.length) break;

            for (const msg of list) {
                // Les deux curseurs se recouvrent à la jonction : chaque message une seule fois.
                if (seen.has(msg.id)) continue;
                seen.add(msg.id);
                const count = Array.isArray(msg.attachments) ? msg.attachments.length : 0;
                const media = count > 0 && mediaLeft >= count && wantsMedia(msg);
                if (media) mediaLeft -= count;
                h.capture({ ...msg, channel_id: channelId }, media);
            }
            saved = seen.size;

            const ids = list.map(m => String(m.id)).sort(compareIds);
            if (fromEnd) before = ids[0];
            else after = ids[ids.length - 1];
            // Page incomplète : un bout est atteint. Curseurs croisés : tout est lu.
            if (list.length < 100 || (before && compareIds(before, after) <= 0)) break;
            await sleep(PAGE_DELAY);
        }
        showToast({ text: t("ml.shield.done", { name, count: saved }), variant: "success" });
        logger.info(`Bouclier : ${saved} messages copiés (${name})`);
    } catch (e) {
        logger.error("Bouclier interrompu", e);
    } finally {
        running.delete(channelId);
        burstAuthors.delete(channelId);
    }
}

// ── 3. MP non lus au démarrage ───────────────────────────────────────────────
const PRELOAD_MAX = 12;
let lastPreload = 0;

export async function preloadUnread() {
    const h = hooks;
    if (!h?.active() || !h.preload() || Date.now() - lastPreload < 10 * 60_000) return;
    lastPreload = Date.now();
    // Laisse Discord finir de démarrer.
    await sleep(12_000);
    try {
        const ids = (PrivateChannelSortStore.getPrivateChannelIds?.() ?? [])
            .filter(id => ChannelStore.getChannel(id) && ReadStateStore.hasUnread?.(id))
            .slice(0, PRELOAD_MAX);
        for (const id of ids) {
            if (hooks !== h || !h.active()) return;
            const list = await getMessages(id, { limit: 50 });
            for (const msg of list ?? []) h.capture({ ...msg, channel_id: id }, true);
            await sleep(1500);
        }
        if (ids.length) logger.info(`MP non lus copiés : ${ids.length} conversation(s)`);
    } catch (e) {
        logger.error("Copie des MP non lus impossible", e);
    }
}
