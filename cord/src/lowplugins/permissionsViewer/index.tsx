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

/*
 * PermissionsViewer — voir les permissions d'un membre, d'un salon (ses
 * remplacements) ou de tous les rôles d'un serveur.
 *   - bouton bouclier dans la liste des rôles du profil d'un membre (patch) ;
 *   - entrée « Voir les permissions » dans les menus clic droit membre, salon,
 *     serveur et dans le menu de l'en-tête du serveur.
 */

import "./styles.css";

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { SafetyIcon } from "@components/Icons";
import { TooltipContainer } from "@components/TooltipContainer";
import { t } from "@lowcord/i18n";
import { Devs } from "@utils/constants";
import { classes } from "@utils/misc";
import definePlugin, { OptionType } from "@utils/types";
import type { Guild, RoleOrUserPermission } from "@vencord/discord-types";
import { PermissionOverwriteType } from "@vencord/discord-types/enums";
import { findCssClassesLazy } from "@webpack";
import { Button, ChannelStore, Dialog, GuildMemberStore, GuildRoleStore, GuildStore, Menu, Popout, useEffect, useRef, UserStore } from "@webpack/common";

import openRolesAndUsersPermissionsModal from "./components/RolesAndUsersPermissions";
import UserPermissions from "./components/UserPermissions";
import { ALL_PERMISSIONS, getSortedRolesForMember, loadGetGuildPermissionSpecMap, logger, sortPermissionOverwrites } from "./utils";

const PopoutClasses = findCssClassesLazy("container", "popoutRoleDot");

export const enum PermissionsSortOrder {
    HighestRole,
    LowestRole
}

const enum MenuItemParentType {
    User,
    Channel,
    Guild
}

export const settings = definePluginSettings({
    permissionsSortOrder: {
        description: "The sort method used for defining which role grants an user a certain permission",
        type: OptionType.SELECT,
        options: [
            { label: "Highest Role", value: PermissionsSortOrder.HighestRole, default: true },
            { label: "Lowest Role", value: PermissionsSortOrder.LowestRole }
        ]
    },
});

function displayNameOf(guildId: string, userId: string) {
    const member = GuildMemberStore.getMember(guildId, userId);
    const user = UserStore.getUser(userId);
    return member?.nick ?? user?.globalName ?? user?.username ?? t("perm.unknownUser");
}

/** Construit la liste à afficher selon l'origine du clic. null = rien d'affichable. */
function collectPermissions(guildId: string, type: MenuItemParentType | undefined, id?: string): { permissions: RoleOrUserPermission[]; header: string; } | null {
    const guild = GuildStore.getGuild(guildId);
    if (!guild) return null;

    if (type === MenuItemParentType.User) {
        const member = GuildMemberStore.getMember(guildId, id!);
        if (!member) return null;

        const permissions: RoleOrUserPermission[] = getSortedRolesForMember(guild, member)
            .map(role => ({ type: PermissionOverwriteType.ROLE, ...role }));

        if (guild.ownerId === id) {
            permissions.push({ type: PermissionOverwriteType.OWNER, permissions: ALL_PERMISSIONS() });
        }
        return { permissions, header: displayNameOf(guildId, id!) };
    }

    if (type === MenuItemParentType.Channel) {
        const channel = ChannelStore.getChannel(id!);
        if (!channel) return null;

        const overwrites = Object.values(channel.permissionOverwrites ?? {}).map(({ id, allow, deny, type }) => ({
            type,
            id,
            overwriteAllow: allow,
            overwriteDeny: deny
        }));
        return { permissions: sortPermissionOverwrites(overwrites, guildId), header: channel.name };
    }

    const permissions = (GuildRoleStore.getSortedRoles(guild.id) ?? [])
        .map(role => ({ type: PermissionOverwriteType.ROLE, ...role }));
    return { permissions, header: guild.name };
}

function MenuItem(guildId: string, { id, type, withIcon }: { id?: string, type?: MenuItemParentType, withIcon?: boolean; }) {
    if (type === MenuItemParentType.User && !GuildMemberStore.isMember(guildId, id!)) return null;

    return (
        <Menu.MenuItem
            id="perm-viewer-permissions"
            label={t("perm.view")}
            leadingAccessory={withIcon ? { type: "icon", icon: SafetyIcon } : undefined}
            action={() => {
                try {
                    const data = collectPermissions(guildId, type, id);
                    if (!data) return;
                    const guild = GuildStore.getGuild(guildId)!;
                    openRolesAndUsersPermissionsModal(data.permissions, guild, data.header);
                } catch (e) {
                    logger.error("ouverture des permissions impossible", e);
                }
            }}
        />
    );
}

function makeContextMenuPatch(childId: string | string[], type?: MenuItemParentType, withIcon = false): NavContextMenuPatchCallback {
    return (children, props) => {
        if (
            !props ||
            (type === MenuItemParentType.User && (!props.user || !props.guildId)) ||
            (type === MenuItemParentType.Guild && !props.guild) ||
            (type === MenuItemParentType.Channel && (!props.channel || !props.guild))
        ) {
            return;
        }

        const item = type === MenuItemParentType.User
            ? MenuItem(props.guildId, { id: props.user.id, type, withIcon })
            : type === MenuItemParentType.Channel
                ? MenuItem(props.guild.id, { id: props.channel.id, type, withIcon })
                : MenuItem(props.guild.id, { withIcon });

        if (item == null) return;

        const group = findGroupChildrenByChildId(childId, children);
        if (group) {
            group.push(item);
            return;
        }

        // "roles" peut manquer si le membre n'a aucun rôle : on l'ajoute au-dessus de « Copier l'ID »
        if (childId === "roles" && props.guildId) {
            children.splice(-1, 0, <Menu.MenuGroup>{item}</Menu.MenuGroup>);
        }
    };
}

export default definePlugin({
    name: "PermissionsViewer",
    description: "View the permissions a user or channel has, and the roles of a server",
    tags: ["Servers", "Roles", "Utility"],
    authors: [Devs.Nuckyz, Devs.Ven],
    settings,

    patches: [
        {
            find: "#{intl::COLLAPSE_ROLES}",
            replacement: {
                match: /(?<=\i\.id\)\),\i\(\))(?=,\i\?)/,
                replace: ",$self.ViewPermissionsButton(arguments[0])"
            }
        }
    ],

    ViewPermissionsButton: ErrorBoundary.wrap(({ className, guild, userId }: { className: string; guild: Guild; userId: string; }) => {
        const buttonRef = useRef(null);
        useEffect(() => void loadGetGuildPermissionSpecMap().catch(e => logger.warn("chargement des libellés impossible", e)), []);

        if (!guild) return null;
        const guildMember = GuildMemberStore.getMember(guild.id, userId);
        if (!guildMember) return null;

        return (
            <Popout
                position="bottom"
                align="center"
                targetElementRef={buttonRef}
                renderPopout={({ closePopout }) => (
                    <Dialog className={PopoutClasses.container} style={{ width: "500px" }}>
                        <UserPermissions guild={guild} guildMember={guildMember} closePopout={closePopout} />
                    </Dialog>
                )}
            >
                {popoutProps => (
                    <TooltipContainer text={t("perm.view")}>
                        <Button
                            {...popoutProps}
                            ref={buttonRef}
                            color={Button.Colors.CUSTOM}
                            look={Button.Looks.FILLED}
                            size={Button.Sizes.NONE}
                            className={classes(className, "vc-permviewer-role-button")}
                        >
                            <SafetyIcon height="16" width="16" />
                        </Button>
                    </TooltipContainer>
                )}
            </Popout>
        );
    }, { noop: true }),

    contextMenus: {
        "user-context": makeContextMenuPatch("roles", MenuItemParentType.User),
        "channel-context": makeContextMenuPatch(["mute-channel", "unmute-channel"], MenuItemParentType.Channel),
        "guild-context": makeContextMenuPatch("privacy", MenuItemParentType.Guild),
        "guild-header-popout": makeContextMenuPatch("privacy", MenuItemParentType.Guild, true)
    }
});
