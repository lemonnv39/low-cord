/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
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

import { t } from "@lowcord/i18n";
import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import { Guild, GuildMember, Role } from "@vencord/discord-types";
import { PermissionOverwriteType } from "@vencord/discord-types/enums";
import { extractAndLoadChunksLazy, findByPropsLazy } from "@webpack";
import { GuildRoleStore, i18n, PermissionsBits } from "@webpack/common";

import { PermissionsSortOrder, settings } from ".";

export const logger = new Logger("PermissionsViewer");
export const cl = classNameFactory("vc-permviewer-");

export const loadGetGuildPermissionSpecMap = extractAndLoadChunksLazy([".PRIMARY,badgeTooltipDelay:"]);
const SpecMapModule = findByPropsLazy("getGuildPermissionSpecMap");

interface PermissionSpec {
    title?: string;
    description?: unknown;
}

/** Libellés de permissions de Discord (dans sa langue). Vide si le module n'est plus trouvé. */
export function getPermissionSpecMap(guild: Guild): Record<string, PermissionSpec> {
    try {
        return SpecMapModule.getGuildPermissionSpecMap(guild) ?? {};
    } catch (e) {
        logger.warn("getGuildPermissionSpecMap indisponible, noms de repli utilisés", e);
        return {};
    }
}

const NAME_BY_BIT = new Map<bigint, string>();
function bitName(bit: bigint) {
    if (!NAME_BY_BIT.size) {
        for (const [name, value] of Object.entries(PermissionsBits)) NAME_BY_BIT.set(value, name);
    }
    const raw = NAME_BY_BIT.get(bit) ?? String(bit);
    return raw.toLowerCase().split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** Titre d'une permission : celui de Discord, sinon le nom du bit mis en forme (jamais de crash). */
export function permissionTitle(spec: Record<string, PermissionSpec>, bit: bigint): string {
    return spec[String(bit)]?.title || bitName(bit);
}

export function permissionDescription(spec: Record<string, PermissionSpec>, bit: bigint): string | null {
    const { description } = spec[String(bit)] ?? {};
    if (!description) return null;
    try {
        return typeof description === "function" ? i18n.intl.format(description as any, {}) : String(description);
    } catch {
        return null;
    }
}

export const ALL_PERMISSIONS = () => Object.values(PermissionsBits).reduce((prev, curr) => prev | curr, 0n);

export const hasAdministrator = (permissions: bigint | undefined) =>
    permissions != null && (permissions & PermissionsBits.ADMINISTRATOR) === PermissionsBits.ADMINISTRATOR;

export function getSortedRolesForMember({ id: guildId }: Guild, member: GuildMember) {
    // L'ID du serveur est le rôle @everyone
    return (GuildRoleStore.getSortedRoles(guildId) ?? [])
        .filter(role => role.id === guildId || member.roles.includes(role.id));
}

export function sortUserRoles(roles: Role[]) {
    switch (settings.store.permissionsSortOrder) {
        case PermissionsSortOrder.HighestRole:
            return roles.sort((a, b) => b.position - a.position);
        case PermissionsSortOrder.LowestRole:
            return roles.sort((a, b) => a.position - b.position);
        default:
            return roles;
    }
}

/** Rôles d'abord (du plus haut au plus bas, rôles supprimés à la fin), puis les membres. */
export function sortPermissionOverwrites<T extends { id: string; type: number; }>(overwrites: T[], guildId: string) {
    const roles = GuildRoleStore.getRolesSnapshot(guildId) ?? {};
    const rank = (o: T) => (o.type === PermissionOverwriteType.ROLE ? 0 : 1);

    return overwrites.sort((a, b) => {
        if (rank(a) !== rank(b)) return rank(a) - rank(b);
        if (a.type !== PermissionOverwriteType.ROLE) return 0;
        return (roles[b.id]?.position ?? -1) - (roles[a.id]?.position ?? -1);
    });
}

/** Qui gère ce rôle (bot, boosts, intégration), d'après ses tags. */
export function roleManagedBy(role: Role): string | null {
    if (!role.managed && !role.tags) return null;
    if (role.tags?.bot_id) return t("perm.managedBot");
    if (role.tags && "premium_subscriber" in role.tags) return t("perm.managedBooster");
    if (role.managed || role.tags?.integration_id) return t("perm.managedIntegration");
    return null;
}
