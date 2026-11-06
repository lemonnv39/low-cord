/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// ExportMessages — moteur d'export : tout l'historique d'une conversation
// (du premier au dernier message), les profils des participants et les
// médias, assemblés en UN fichier .html autonome (template.html).
//
// - Historique : l'API de Discord, 100 messages par page, en respectant ses
//   limites de débit (429 → on attend le délai demandé).
// - Médias : téléchargés depuis les serveurs de Discord uniquement, intégrés
//   en base64 dans le fichier, dans la limite de taille choisie ; au-delà,
//   le fichier garde le lien d'origine.
// - Le fichier est assemblé par morceaux (jamais une seule chaîne géante).

import { getLang } from "@lowcord/i18n";
import { Logger } from "@utils/Logger";
import { ChannelStore, RestAPI, UserStore } from "@webpack/common";
import template from "file://./template.html";

const logger = new Logger("ExportMessages");

export type MediaMode = "images" | "all" | "none";

export interface ExportOptions {
    media: MediaMode;
    /** limite totale des médias intégrés, en Mo */
    maxMB: number;
}

export interface ExportProgress {
    phase: "messages" | "profiles" | "media" | "writing";
    messages: number;
    mediaDone: number;
    mediaTotal: number;
    bytes: number;
    skipped: number;
}

export class CanceledError extends Error { }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const PAGE_DELAY = 350;
const PROFILE_DELAY = 500;
const MEDIA_CONCURRENCY = 4;
const PER_FILE_MAX = 50 * 1024 * 1024;
const MEDIA_HOSTS = /^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net|images-ext-\d+\.discordapp\.net)\//;
const DISCORD_EPOCH = 1420070400000n;

const snowflakeTime = (id: string) => {
    try { return Number((BigInt(id) >> 22n) + DISCORD_EPOCH); } catch { return 0; }
};

// ── Requêtes ─────────────────────────────────────────────────────────────────
async function api(url: string, query: Record<string, any> | undefined, cancel: { canceled: boolean; }): Promise<any> {
    for (let attempt = 0; ; attempt++) {
        if (cancel.canceled) throw new CanceledError();
        try {
            const res: any = await RestAPI.get({ url, query });
            return res?.body;
        } catch (e: any) {
            if (e?.status === 429 && attempt < 15) {
                await sleep(Math.ceil((e?.body?.retry_after ?? 5) * 1000) + 300);
                continue;
            }
            if ((e?.status == null || e.status >= 500) && attempt < 4) {
                await sleep(2000 * (attempt + 1));
                continue;
            }
            throw e;
        }
    }
}

async function fetchAllMessages(channelId: string, cancel: { canceled: boolean; }, onPage: (count: number) => void) {
    const all: any[] = [];
    let before: string | undefined;
    for (; ;) {
        const page = await api(`/channels/${channelId}/messages`, { limit: 100, ...(before ? { before } : {}) }, cancel);
        if (!Array.isArray(page) || !page.length) break;
        all.push(...page);
        before = page[page.length - 1].id;
        onPage(all.length);
        if (page.length < 100) break;
        await sleep(PAGE_DELAY);
    }
    // L'API donne les plus récents d'abord : on remet dans l'ordre de lecture.
    return all.reverse();
}

// ── URL des images de Discord ────────────────────────────────────────────────
const animated = (hash?: string | null) => !!hash && hash.startsWith("a_");
function avatarUrl(id: string, hash?: string | null) {
    if (hash) return `https://cdn.discordapp.com/avatars/${id}/${hash}.${animated(hash) ? "gif" : "webp"}?size=128`;
    let index = 0;
    try { index = Number((BigInt(id) >> 22n) % 6n); } catch { }
    return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}
const bannerUrl = (id: string, hash: string) => `https://cdn.discordapp.com/banners/${id}/${hash}.${animated(hash) ? "gif" : "webp"}?size=600`;
const emojiUrl = (id: string, isAnimated?: boolean) => `https://cdn.discordapp.com/emojis/${id}.${isAnimated ? "gif" : "webp"}?size=48`;

function withParams(url: string, params: Record<string, string>) {
    try {
        const u = new URL(url);
        for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
        return u.toString();
    } catch {
        return url;
    }
}

// ── Plan des médias ──────────────────────────────────────────────────────────
interface MediaJob { key: string; url: string; maxBytes: number; }

class MediaPlan {
    jobs: MediaJob[] = [];
    private byUrl = new Map<string, string>();

    /** Renvoie la clé de l'image (même URL = même clé, téléchargée une fois). */
    add(url: string | undefined | null, maxBytes = PER_FILE_MAX): string | undefined {
        if (!url || !MEDIA_HOSTS.test(url)) return undefined;
        let key = this.byUrl.get(url);
        if (!key) {
            key = (this.jobs.length + 1).toString(36);
            this.byUrl.set(url, key);
            this.jobs.push({ key, url, maxBytes });
        }
        return key;
    }
}

const SAFE_MIME = /^[\w.+-]+\/[\w.+-]+$/;

function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(SAFE_MIME.test(blob.type) ? blob : new Blob([blob], { type: "application/octet-stream" }));
    });
}

async function downloadAll(plan: MediaPlan, budgetBytes: number, cancel: { canceled: boolean; }, progress: ExportProgress, emit: () => void) {
    const out = new Map<string, string>();
    let used = 0;
    let next = 0;

    async function worker() {
        while (next < plan.jobs.length) {
            if (cancel.canceled) throw new CanceledError();
            const job = plan.jobs[next++];
            try {
                const res = await fetch(job.url);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const announced = Number(res.headers.get("content-length") ?? 0);
                if (announced > job.maxBytes || used + announced > budgetBytes) {
                    progress.skipped++;
                    void res.body?.cancel().catch(() => { });
                } else {
                    const blob = await res.blob();
                    if (blob.size > job.maxBytes || used + blob.size > budgetBytes) {
                        progress.skipped++;
                    } else {
                        used += blob.size;
                        out.set(job.key, await blobToDataUrl(blob));
                        progress.bytes = used;
                    }
                }
            } catch (e) {
                if (e instanceof CanceledError) throw e;
                // Lien expiré / supprimé : le fichier gardera le lien d'origine.
                progress.skipped++;
            }
            progress.mediaDone++;
            emit();
        }
    }

    await Promise.all(Array.from({ length: MEDIA_CONCURRENCY }, worker));
    return out;
}

// ── Conversion des messages ──────────────────────────────────────────────────
interface ExportUser {
    id: string;
    name: string;
    username: string;
    bot?: boolean;
    avatar?: string;
    avatarUrl?: string;
    banner?: string;
    bannerUrl?: string;
    accent?: number;
    bio?: string;
    pronouns?: string;
    createdAt?: number;
}

function displayUser(raw: any): ExportUser {
    const live = UserStore.getUser(raw.id);
    return {
        id: raw.id,
        name: raw.global_name || live?.globalName || raw.username || live?.username || raw.id,
        username: raw.username || live?.username || raw.id,
        bot: !!(raw.bot ?? live?.bot) || undefined,
        avatarUrl: avatarUrl(raw.id, raw.avatar ?? live?.avatar),
        createdAt: snowflakeTime(raw.id),
    };
}

const CUSTOM_EMOJI = /<(a?):\w{1,32}:(\d{5,22})>/g;

export async function exportConversation(
    channelId: string,
    opts: ExportOptions,
    cancel: { canceled: boolean; },
    onProgress: (p: ExportProgress) => void,
): Promise<{ filename: string; data: Uint8Array; skipped: number; count: number; }> {
    const progress: ExportProgress = { phase: "messages", messages: 0, mediaDone: 0, mediaTotal: 0, bytes: 0, skipped: 0 };
    const emit = () => onProgress({ ...progress });
    emit();

    const channel = ChannelStore.getChannel(channelId);
    const me = UserStore.getCurrentUser();
    if (!channel || !me) throw new Error("channel");

    // 1. Tout l'historique
    const raw = await fetchAllMessages(channelId, cancel, n => { progress.messages = n; emit(); });

    // 2. Participants (auteurs, destinataires, mentionnés)
    const users = new Map<string, ExportUser>();
    const mentions: Record<string, string> = {};
    // Une personne vue d'abord sans détails (destinataire inconnu de Discord)
    // est complétée dès qu'un message apporte son pseudo et son avatar.
    const addUser = (u: any) => {
        if (!u?.id) return;
        const known = users.get(u.id);
        if (!known || (known.username === known.id && u.username)) users.set(u.id, displayUser(u));
    };
    addUser({ id: me.id, username: me.username, global_name: me.globalName, avatar: me.avatar, bot: me.bot });
    for (const id of channel.recipients ?? []) {
        const u = UserStore.getUser(id);
        addUser(u ? { id, username: u.username, global_name: u.globalName, avatar: u.avatar, bot: u.bot } : { id });
    }
    for (const m of raw) {
        addUser(m.author);
        for (const u of m.mentions ?? []) mentions[u.id] = u.global_name || u.username;
        if (m.referenced_message?.author) addUser(m.referenced_message.author);
    }

    // 3. Profils (bannière, bio…) des participants — erreurs ignorées : le
    //    profil garde alors les infos de base.
    progress.phase = "profiles";
    emit();
    const counts = new Map<string, number>();
    for (const m of raw) counts.set(m.author?.id, (counts.get(m.author?.id) ?? 0) + 1);
    const members = [...users.keys()].filter(id => counts.has(id) || channel.recipients?.includes(id) || id === me.id).slice(0, 25);
    for (const id of members) {
        try {
            const p = await api(`/users/${id}/profile`, { with_mutual_guilds: false, with_mutual_friends: false }, cancel);
            const u = users.get(id)!;
            const banner = p?.user_profile?.banner ?? p?.user?.banner;
            if (banner) u.bannerUrl = bannerUrl(id, banner);
            u.accent = p?.user_profile?.accent_color ?? p?.user?.accent_color ?? undefined;
            u.bio = p?.user_profile?.bio || p?.user?.bio || undefined;
            u.pronouns = p?.user_profile?.pronouns || undefined;
        } catch (e) {
            if (e instanceof CanceledError) throw e;
        }
        await sleep(PROFILE_DELAY);
    }

    // 4. Messages compacts + plan des médias
    const plan = new MediaPlan();
    const withMedia = opts.media !== "none";
    for (const u of users.values()) {
        u.avatar = plan.add(u.avatarUrl, 8 * 1024 * 1024);
        if (u.bannerUrl) u.banner = plan.add(u.bannerUrl, 15 * 1024 * 1024);
    }
    const emojis: Record<string, string | undefined> = {};
    const addEmoji = (id: string, isAnimated?: boolean) => {
        if (!(id in emojis)) emojis[id] = plan.add(emojiUrl(id, isAnimated), 2 * 1024 * 1024);
    };

    const isMedia = (ct: string) => /^(image|video|audio)\//.test(ct);
    const messages = raw.map(m => {
        for (const [, a, id] of String(m.content ?? "").matchAll(CUSTOM_EMOJI)) addEmoji(id, a === "a");
        for (const r of m.reactions ?? []) if (r.emoji?.id) addEmoji(r.emoji.id, r.emoji.animated);

        const at = (m.attachments ?? []).map((a: any) => {
            const ct = String(a.content_type ?? "");
            const image = ct.startsWith("image/");
            let k: string | undefined;
            if (withMedia && (image || opts.media === "all")) {
                // Grandes photos : version redimensionnée par Discord (bien plus légère).
                const url = image && a.size > 8 * 1024 * 1024 && a.proxy_url ? withParams(a.proxy_url, { width: "1600" }) : a.url;
                k = plan.add(url, image ? 25 * 1024 * 1024 : PER_FILE_MAX);
            }
            return { n: a.filename, s: a.size, ct: isMedia(ct) ? ct : ct || undefined, w: a.width, h: a.height, k, u: a.url };
        });

        const em = (m.embeds ?? []).map((e: any) => {
            const pic = (x: any) => x ? { k: withMedia ? plan.add(x.proxy_url ?? x.url, 15 * 1024 * 1024) : undefined, u: x.proxy_url ?? x.url } : undefined;
            return {
                type: e.type,
                title: e.title,
                url: e.url,
                desc: e.description,
                color: e.color,
                provider: e.provider?.name,
                author: e.author?.name ? { name: e.author.name, icon: pic(e.author.proxy_icon_url ? { proxy_url: e.author.proxy_icon_url } : null) } : undefined,
                fields: (e.fields ?? []).map((f: any) => ({ name: f.name, value: f.value })),
                image: pic(e.image),
                thumb: pic(e.thumbnail),
                footer: e.footer?.text,
            };
        }).filter((e: any) => e.title || e.desc || e.image || e.thumb || e.fields.length);

        const st = (m.sticker_items ?? []).map((s: any) => ({
            n: s.name,
            // 3 = animation Lottie (non affichable sans bibliothèque) : le nom suffit.
            k: s.format_type === 3 ? undefined : plan.add(`https://media.discordapp.net/stickers/${s.id}.${s.format_type === 4 ? "gif" : "png"}?size=160`, 5 * 1024 * 1024),
        }));

        const ref = m.message_reference?.message_id && m.type === 19 ? {
            id: m.message_reference.message_id,
            a: m.referenced_message?.author?.id,
            c: m.referenced_message ? String(m.referenced_message.content ?? "") : null,
        } : undefined;

        return {
            id: m.id,
            t: Date.parse(m.timestamp),
            e: m.edited_timestamp ? Date.parse(m.edited_timestamp) : undefined,
            a: m.author?.id,
            c: m.content || "",
            type: m.type,
            p: m.pinned || undefined,
            r: ref,
            at: at.length ? at : undefined,
            em: em.length ? em : undefined,
            st: st.length ? st : undefined,
            re: (m.reactions ?? []).map((r: any) => ({ id: r.emoji?.id ?? undefined, n: r.emoji?.id ? `:${r.emoji.name}:` : r.emoji?.name, count: r.count })),
            target: m.mentions?.[0]?.id,
            call: m.call ? { missed: !(m.call.participants ?? []).includes(me.id) } : undefined,
        };
    });

    // Icône du groupe
    const icon = channel.icon ? `https://cdn.discordapp.com/channel-icons/${channel.id}/${channel.icon}.webp?size=160` : undefined;
    const iconKey = icon ? plan.add(icon, 5 * 1024 * 1024) : undefined;

    // 5. Téléchargement des médias (avatars et émojis passent en premier)
    progress.phase = "media";
    progress.mediaTotal = plan.jobs.length;
    emit();
    const assets = await downloadAll(plan, Math.max(0, opts.maxMB) * 1024 * 1024, cancel, progress, emit);

    // 6. Assemblage du fichier
    progress.phase = "writing";
    emit();
    const others = (channel.recipients ?? []).filter(id => id !== me.id);
    const name = channel.name || others.map(id => users.get(id)?.name ?? id).join(", ") || channel.id;
    const channelNames: Record<string, string> = {};
    for (const m of raw) {
        for (const [, id] of String(m.content ?? "").matchAll(/<#(\d{5,22})>/g)) {
            const c = ChannelStore.getChannel(id);
            if (c?.name) channelNames[id] = c.name;
        }
    }

    const data = {
        v: 1,
        lang: getLang(),
        exportedAt: new Date().toISOString(),
        me: me.id,
        channel: { id: channel.id, name, kind: others.length > 1 || channel.isMultiUserDM?.() ? "group" : "dm", recipients: [...others, me.id], icon: iconKey, iconUrl: icon },
        users: Object.fromEntries(users),
        mentions,
        roles: {},
        channels: channelNames,
        emojis,
        messages,
    };

    // JSON dans une balise <script> : « < » échappé pour qu'aucun texte de
    // message ne puisse fermer la balise et injecter du code dans la page.
    const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
    const BS = String.fromCharCode(92);
    const json = JSON.stringify(data).replace(/</g, BS + "u003c").split(LS).join(BS + "u2028").split(PS).join(BS + "u2029");
    const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]!));
    // Remplacements par fonction : un « $& » dans un nom ne doit rien déclencher.
    const [head, tail] = template
        .replace("__LANG__", () => data.lang)
        .replace("__TITLE__", () => escapeHtml(`${name} — low-cord`))
        .split("<!--DATA-->");

    const encoder = new TextEncoder();
    const parts: Uint8Array[] = [encoder.encode(head), encoder.encode(`<script type="application/json" id="export-data">${json}</script>\n`)];
    for (const [key, url] of assets) {
        // Base64 et type MIME vérifié : rien à échapper.
        parts.push(encoder.encode(`<script type="text/plain" id="a-${key}">${url}</script>\n`));
    }
    parts.push(encoder.encode(tail));

    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
        out.set(p, offset);
        offset += p.length;
    }

    const day = new Date().toISOString().slice(0, 10);
    const safe = name.replace(/[\\/:*?"<>|\r\n]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 60) || "conversation";
    logger.info(`Export : ${messages.length} messages, ${assets.size}/${plan.jobs.length} médias, ${(total / 1048576).toFixed(1)} Mo`);
    return { filename: `DM ${safe} ${day}.html`, data: out, skipped: progress.skipped, count: messages.length };
}
