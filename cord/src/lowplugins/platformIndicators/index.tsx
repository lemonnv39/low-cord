/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2022 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/*
 * low-cord — version stabilisée du plugin PlatformIndicators de Vencord.
 * Même idée, mêmes emplacements, mêmes patches. Différences :
 *   - plateformes aussi pour les non-amis : repli sur la présence PAR SERVEUR
 *     (PresenceStore.presencesForGuilds), que getClientStatus() ignore ;
 *   - accès aux stores protégés (sessions nulles, clientInfo absent…) ;
 *   - couleur de statut : repli sur des couleurs fixes si le module Discord
 *     n'est plus trouvé (au lieu de casser toutes les icônes) ;
 *   - emplacements activables/désactivables sans redémarrer ;
 *   - textes traduits (FR/EN).
 */

import "./style.css";

import { addProfileBadge, BadgePosition, BadgeUserArgs, ProfileBadge, removeProfileBadge } from "@api/Badges";
import { addMemberListDecorator, removeMemberListDecorator } from "@api/MemberListDecorators";
import { addMessageDecoration, removeMessageDecoration } from "@api/MessageDecorations";
import { definePluginSettings } from "@api/Settings";
import { t } from "@lowcord/i18n";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { ClientStatusMap, DiscordPlatform, OnlineStatus, User } from "@vencord/discord-types";
import { filters, findStoreLazy, mapMangledModuleLazy } from "@webpack";
import { AuthenticationStore, PresenceStore, SelectedGuildStore, Tooltip, UserStore, useStateFromStores } from "@webpack/common";

const logger = new Logger("PlatformIndicators");

interface Session {
    sessionId: string;
    status: string;
    active: boolean;
    clientInfo?: {
        version: number;
        os: string;
        client: string;
    };
}

const SessionsStore = findStoreLazy("SessionsStore") as {
    getSessions(): Record<string, Session> | null | undefined;
};

// ── Couleur de statut ────────────────────────────────────────────────────
// Le hook de Discord est trouvé par une recherche webpack qui peut casser à une
// mise à jour de Discord. On résout UNE fois : soit le vrai hook (appelé à
// chaque rendu, ordre des hooks stable), soit des couleurs fixes.

const StatusColorModule = mapMangledModuleLazy([".5625*", "translate"], {
    useStatusFillColor: filters.byCode(".hex")
});

const FALLBACK_COLORS: Record<string, string> = {
    online: "#23a55a",
    idle: "#f0b232",
    dnd: "#f23f43",
    streaming: "#593695",
};
const fallbackStatusColor = (status: OnlineStatus) => FALLBACK_COLORS[status] ?? "#80848e";

let resolvedStatusColor: ((status: OnlineStatus) => string) | null = null;

function resolveStatusColor(): (status: OnlineStatus) => string {
    try {
        if (typeof StatusColorModule.useStatusFillColor === "function") return StatusColorModule.useStatusFillColor;
    } catch (e) {
        logger.warn("useStatusFillColor introuvable", e);
    }
    logger.warn("couleurs de statut de repli utilisées");
    return fallbackStatusColor;
}

function useStatusColor(status: OnlineStatus): string {
    resolvedStatusColor ??= resolveStatusColor();
    return resolvedStatusColor(status);
}

// ── Lecture des plateformes ──────────────────────────────────────────────

const isEmpty = (map: ClientStatusMap | null | undefined) => !map || Object.keys(map).length === 0;

function shallowEqual(a: ClientStatusMap | null, b: ClientStatusMap | null) {
    if (a === b) return true;
    if (!a || !b) return false;
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every(k => a[k as DiscordPlatform] === b[k as DiscordPlatform]);
}

/**
 * Plateformes d'un autre utilisateur. getClientStatus() ne couvre que la
 * présence « globale » (amis…) ; pour un non-ami, Discord ne la garde que par
 * serveur. On regarde donc ensuite le serveur courant, ou à défaut tout serveur commun.
 */
function getUserClientStatus(userId: string, guildId?: string | null): ClientStatusMap | null {
    try {
        const global = PresenceStore.getClientStatus(userId);
        if (!isEmpty(global)) return global;

        const byGuild = PresenceStore.getState()?.presencesForGuilds;
        if (!byGuild) return null;

        if (guildId) {
            // Contexte serveur connu (messages, liste des membres) : c'est là que Discord a la présence.
            const inGuild = byGuild[guildId]?.[userId]?.clientStatus;
            return isEmpty(inGuild) ? null : inGuild!;
        }
        // Pas de serveur (DM, profil hors serveur) : premier serveur commun qui a la présence.
        for (const id in byGuild) {
            const found = byGuild[id]?.[userId]?.clientStatus;
            if (!isEmpty(found)) return found;
        }
    } catch (e) {
        logger.error("lecture de la présence impossible", e);
    }
    return null;
}

// Même priorité que le plugin d'origine : en ligne > inactif > le reste.
const STATUS_PRIORITY: Record<string, number> = { online: 2, idle: 1 };

/** Plateformes de l'utilisateur courant, depuis ses sessions actives. */
function getOwnClientStatus(): ClientStatusMap | null {
    let sessions: Record<string, Session> | null | undefined;
    try {
        sessions = SessionsStore.getSessions();
    } catch (e) {
        logger.error("SessionsStore indisponible", e);
        return null;
    }
    if (!sessions || typeof sessions !== "object") return null;

    const result: ClientStatusMap = {};
    for (const session of Object.values(sessions)) {
        const client = session?.clientInfo?.client as DiscordPlatform | undefined;
        if (!client || (client as string) === "unknown") continue;

        // Plusieurs sessions sur la même plateforme : on garde le statut prioritaire.
        const current = result[client];
        if (!current || (STATUS_PRIORITY[session.status] ?? 0) > (STATUS_PRIORITY[current] ?? 0)) {
            result[client] = session.status as OnlineStatus;
        }
    }
    return result;
}

const isSelf = (userId: string) => userId === AuthenticationStore.getId();

// ── Icônes ───────────────────────────────────────────────────────────────

function Icon(path: string, opts?: { viewBox?: string; width?: number; height?: number; }) {
    return ({ color, tooltip, small }: { color: string; tooltip: string; small: boolean; }) => (
        <Tooltip text={tooltip}>
            {tooltipProps => (
                <svg
                    {...tooltipProps}
                    height={(opts?.height ?? 20) - (small ? 3 : 0)}
                    width={(opts?.width ?? 20) - (small ? 3 : 0)}
                    viewBox={opts?.viewBox ?? "0 0 24 24"}
                    fill={color}
                >
                    <path d={path} />
                </svg>
            )}
        </Tooltip>
    );
}

const Icons = {
    desktop: Icon("M4 2.5c-1.103 0-2 .897-2 2v11c0 1.104.897 2 2 2h7v2H7v2h10v-2h-4v-2h7c1.103 0 2-.896 2-2v-11c0-1.103-.897-2-2-2H4Zm16 2v9H4v-9h16Z"),
    web: Icon("M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2Zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93Zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39Z"),
    mobile: Icon("M 187 0 L 813 0 C 916.277 0 1000 83.723 1000 187 L 1000 1313 C 1000 1416.277 916.277 1500 813 1500 L 187 1500 C 83.723 1500 0 1416.277 0 1313 L 0 187 C 0 83.723 83.723 0 187 0 Z M 125 1000 L 875 1000 L 875 250 L 125 250 Z M 500 1125 C 430.964 1125 375 1180.964 375 1250 C 375 1319.036 430.964 1375 500 1375 C 569.036 1375 625 1319.036 625 1250 C 625 1180.964 569.036 1125 500 1125 Z", { viewBox: "0 0 1000 1500", height: 17, width: 17 }),
    embedded: Icon("M3.06 20.4q-1.53 0-2.37-1.065T.06 16.74l1.26-9q.27-1.8 1.605-2.97T6.06 3.6h11.88q1.8 0 3.135 1.17t1.605 2.97l1.26 9q.21 1.53-.63 2.595T20.94 20.4q-.63 0-1.17-.225T18.78 19.5l-2.7-2.7H7.92l-2.7 2.7q-.45.45-.99.675t-1.17.225Zm14.94-7.2q.51 0 .855-.345T19.2 12q0-.51-.345-.855T18 10.8q-.51 0-.855.345T16.8 12q0 .51.345 .855T18 13.2Zm-2.4-3.6q.51 0 .855-.345T16.8 8.4q0-.51-.345-.855T15.6 7.2q-.51 0-.855.345T14.4 8.4q0 .51.345 .855T15.6 9.6ZM6.9 13.2h1.8v-2.1h2.1v-1.8h-2.1v-2.1h-1.8v2.1h-2.1v1.8h2.1v2.1Z", { viewBox: "0 0 24 24", height: 20, width: 20 }),
    vr: Icon("M8.46 8.64a1 1 0 0 1 1 1c0 .44-.3.8-.72.92l-.11.07c-.08.06-.2.19-.2.41a.99.99 0 0 1-.98.86h-.06a1 1 0 0 1-.94-1.05l.02-.32c.05-1.06.92-1.9 1.99-1.9ZM15.55 5a5.5 5.5 0 0 1 5.15 3.67h.3a2 2 0 0 1 2 2v3.18a2 2 0 0 1-2 1.99h-.2A4.54 4.54 0 0 1 16.55 19a4.45 4.45 0 0 1-3.6-1.83 1.2 1.2 0 0 0-1.9 0 4.44 4.44 0 0 1-3.9 1.82 4.54 4.54 0 0 1-3.94-3.15H3a2 2 0 0 1-2-2v-3.18c0-1.1.9-1.99 2-1.99h.3A5.5 5.5 0 0 1 8.46 5h7.09Zm-7.1 2C6.6 7 5.06 8.5 4.97 10.41l-.02.66v3.18c0 1.43 1.05 2.66 2.34 2.74.85.06 1.63-.32 2.14-1.01a3.2 3.2 0 0 1 2.57-1.3c1 0 1.97.48 2.57 1.3.5.69 1.3 1.08 2.14 1.01 1.3-.08 2.34-1.31 2.34-2.74l-.02-3.84a3.54 3.54 0 0 0-3.49-3.43H8.45Z", { viewBox: "0 4 24 16", height: 20, width: 20 }),
} satisfies Record<DiscordPlatform, any>;

const PLATFORM_LABEL = {
    desktop: "platform.desktop",
    web: "platform.web",
    mobile: "platform.mobile",
    embedded: "platform.embedded",
    vr: "platform.vr",
} as const satisfies Record<DiscordPlatform, string>;

function getPlatformTooltip(platform: string): string {
    const key = PLATFORM_LABEL[platform as DiscordPlatform];
    return key ? t(key) : platform.charAt(0).toUpperCase() + platform.slice(1);
}

function PlatformIcon({ platform, status, small }: { platform: string; status: OnlineStatus; small: boolean; }) {
    const IconComponent = Icons[platform as DiscordPlatform] ?? Icons.desktop;
    return <IconComponent color={useStatusColor(status)} tooltip={getPlatformTooltip(platform)} small={small} />;
}

function PlatformIndicators({ statusMap, small }: { statusMap: ClientStatusMap; small: boolean; }) {
    const entries = Object.entries(statusMap);
    if (!entries.length) return null;

    return (
        <span className="vc-platform-indicator" style={{ gap: "2px" }}>
            {entries.map(([platform, status]) => (
                <PlatformIcon key={platform} platform={platform} status={status} small={small} />
            ))}
        </span>
    );
}

function CurrentUserPlatformIndicators({ small }: { small: boolean; }) {
    const statusMap = useStateFromStores([SessionsStore], getOwnClientStatus, null, shallowEqual);
    return statusMap ? <PlatformIndicators statusMap={statusMap} small={small} /> : null;
}

function OtherUserPlatformIndicators({ userId, guildId, small }: { userId: string; guildId?: string | null; small: boolean; }) {
    const statusMap = useStateFromStores([PresenceStore], () => getUserClientStatus(userId, guildId), [userId, guildId], shallowEqual);
    return statusMap ? <PlatformIndicators statusMap={statusMap} small={small} /> : null;
}

function renderPlatformIndicators(user: User | null | undefined, small: boolean, guildId?: string | null) {
    if (!user || user.bot) return null;
    if (isSelf(user.id)) return <CurrentUserPlatformIndicators small={small} />;
    return <OtherUserPlatformIndicators userId={user.id} guildId={guildId} small={small} />;
}

// ── Badges de profil ─────────────────────────────────────────────────────

function BadgeIcon({ userId, guildId, platform }: { userId: string; guildId?: string; platform: string; }) {
    // Statut lu en direct : la couleur suit les changements tant que le profil est ouvert.
    const status = useStateFromStores(
        [PresenceStore, SessionsStore],
        () => (isSelf(userId) ? getOwnClientStatus() : getUserClientStatus(userId, guildId))?.[platform as DiscordPlatform] ?? null,
        [userId, guildId, platform]
    );
    if (!status) return null;

    return (
        <span className="vc-platform-indicator">
            <PlatformIcon platform={platform} status={status} small={false} />
        </span>
    );
}

function getBadges({ userId, guildId }: BadgeUserArgs): ProfileBadge[] {
    const user = UserStore.getUser(userId);
    if (!user || user.bot) return [];

    const statusMap = isSelf(userId) ? getOwnClientStatus() : getUserClientStatus(userId, guildId);
    if (!statusMap) return [];

    return Object.keys(statusMap).map(platform => ({
        key: `vc-platform-indicator-${platform}`,
        id: `vc-platform-indicator-${platform}`,
        component: () => <BadgeIcon userId={userId} guildId={guildId} platform={platform} />,
    }));
}

const badge: ProfileBadge = {
    id: "vc_platform_indicator_wrapper",
    getBadges,
    position: BadgePosition.START,
};

// ── Emplacements ─────────────────────────────────────────────────────────

const indicatorLocations = {
    list: {
        description: "Show indicators in the member list",
        onEnable: () => addMemberListDecorator("platform-indicator", ({ user }) =>
            renderPlatformIndicators(user, true, SelectedGuildStore.getGuildId())),
        onDisable: () => removeMemberListDecorator("platform-indicator"),
    },
    badges: {
        description: "Show indicators in user profiles, as badges",
        onEnable: () => addProfileBadge(badge),
        onDisable: () => removeProfileBadge(badge),
    },
    messages: {
        description: "Show indicators inside messages",
        onEnable: () => addMessageDecoration("platform-indicator", props =>
            renderPlatformIndicators(props.message?.author, false, props.channel?.guild_id)),
        onDisable: () => removeMessageDecoration("platform-indicator"),
    },
};

type LocationKey = keyof typeof indicatorLocations;

function locationSetting(key: LocationKey) {
    return {
        type: OptionType.BOOLEAN as const,
        description: indicatorLocations[key].description,
        default: true,
        // Appliqué à chaud : chaque réglage sait quel emplacement il pilote.
        onChange(enabled: boolean) {
            if (!plugin.started) return;
            if (enabled) indicatorLocations[key].onEnable();
            else indicatorLocations[key].onDisable();
        },
    };
}

const settings = definePluginSettings({
    list: locationSetting("list"),
    badges: locationSetting("badges"),
    messages: locationSetting("messages"),
    colorMobileIndicator: {
        type: OptionType.BOOLEAN,
        description: "Whether to make the mobile indicator match the color of the user status.",
        default: true,
        // Piloté par des patches : ne s'applique qu'au chargement.
        restartNeeded: true,
    },
});

const plugin = definePlugin({
    name: "PlatformIndicators",
    description: "Adds platform indicators (Desktop, Mobile, Web...) to users",
    tags: ["Appearance"],
    authors: [Devs.kemo, Devs.TheSun, Devs.Nuckyz, Devs.Ven],
    dependencies: ["MessageDecorationsAPI", "MemberListDecoratorsAPI"],
    settings,

    start() {
        for (const key of Object.keys(indicatorLocations) as LocationKey[]) {
            if (settings.store[key]) indicatorLocations[key].onEnable();
        }
    },

    stop() {
        for (const location of Object.values(indicatorLocations)) location.onDisable();
    },

    patches: [
        {
            find: ".Masks.STATUS_ONLINE_MOBILE",
            predicate: () => settings.store.colorMobileIndicator,
            replacement: [
                {
                    // Return the STATUS_ONLINE_MOBILE mask if the user is on mobile, no matter the status
                    match: /\.STATUS_TYPING;switch(?=.+?(if\(\i\)return \i\.\i\.Masks\.STATUS_ONLINE_MOBILE))/,
                    replace: ".STATUS_TYPING;$1;switch"
                },
                {
                    // Return the STATUS_ONLINE_MOBILE mask if the user is on mobile, no matter the status
                    match: /switch\(\i\)\{case \i\.\i\.ONLINE:(if\(\i\)return\{[^}]+\})/,
                    replace: "$1;$&"
                }
            ]
        },
        {
            find: ".AVATAR_STATUS_MOBILE_16;",
            predicate: () => settings.store.colorMobileIndicator,
            replacement: [
                {
                    // Return the AVATAR_STATUS_MOBILE size mask if the user is on mobile, no matter the status
                    match: /\i===\i\.\i\.ONLINE&&(?=.{0,70}\.AVATAR_STATUS_MOBILE_16;)/,
                    replace: ""
                },
                {
                    // Fix sizes for mobile indicators which aren't online
                    match: /(?<=\(\i\.status,)(\i)(?=,\{.{0,15}isMobile:(\i))/,
                    replace: '$2?"online":$1'
                },
                {
                    // Make isMobile true no matter the status
                    match: /(?<=\i&&!\i)&&\i===\i\.\i\.ONLINE/,
                    replace: ""
                }
            ]
        },
        {
            find: "}isMobileOnline(",
            predicate: () => settings.store.colorMobileIndicator,
            replacement: {
                // Make isMobileOnline return true no matter what is the user status
                match: /(?<=\i\[\i\.\i\.MOBILE\])===\i\.\i\.ONLINE/,
                replace: "!= null"
            }
        }
    ]
});

export default plugin;
