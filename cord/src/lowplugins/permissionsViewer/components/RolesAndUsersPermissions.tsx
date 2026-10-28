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

import ErrorBoundary from "@components/ErrorBoundary";
import { Flex } from "@components/Flex";
import { CopyIdIcon, ImageIcon, InfoIcon, OwnerCrownIcon } from "@components/Icons";
import { t } from "@lowcord/i18n";
import { cl, getPermissionSpecMap, hasAdministrator, loadGetGuildPermissionSpecMap, logger, permissionDescription, permissionTitle, roleManagedBy } from "@lowplugins/permissionsViewer/utils";
import { copyToClipboard } from "@utils/clipboard";
import { getUniqueUsername, openImageModal } from "@utils/discord";
import { Guild, RenderModalProps, Role, RoleOrUserPermission, UnicodeEmoji, User } from "@vencord/discord-types";
import { PermissionOverwriteType } from "@vencord/discord-types/enums";
import { findByCodeLazy, findByPropsLazy } from "@webpack";
import { ContextMenuApi, FluxDispatcher, GuildMemberStore, GuildRoleStore, Menu, Modal, openModalLazy, PermissionsBits, PermissionStore, ScrollerThin, showToast, Text, Tooltip, useEffect, useMemo, UserStore, useState, useStateFromStores } from "@webpack/common";

import { PermissionAllowedIcon, PermissionDeniedIcon } from "./icons";

type GetRoleIconData = (role: Role, size: number) => { customIconSrc?: string; unicodeEmoji?: UnicodeEmoji; };
const getRoleIconData: GetRoleIconData = findByCodeLazy("convertSurrogateToName", "customIconSrc", "unicodeEmoji");
const GuildSettingsActions = findByPropsLazy("open", "selectRole", "updateGuild");

function getRoleIconSrc(role: Role) {
    try {
        const icon = getRoleIconData(role, 20);
        return icon?.customIconSrc ?? icon?.unicodeEmoji?.url;
    } catch {
        return undefined;
    }
}

function copy(text: string) {
    copyToClipboard(text);
    showToast({ text: t("common.copied"), variant: "success" });
}

// Ordre d'affichage : propriétaire, puis rôles, puis membres.
const TYPE_ORDER: Record<number, number> = {
    [PermissionOverwriteType.OWNER]: 0,
    [PermissionOverwriteType.ROLE]: 1,
    [PermissionOverwriteType.MEMBER]: 2,
};

function DetailRow({ label, children }: { label: string; children: React.ReactNode; }) {
    return (
        <div className={cl("detail-row")}>
            <Text variant="text-xs/semibold" className={cl("detail-label")}>{label}</Text>
            <Text variant="text-sm/normal">{children}</Text>
        </div>
    );
}

/** Infos de l'élément sélectionné (rôle, membre ou propriétaire). */
function SelectedDetails({ item, role, user }: { item: RoleOrUserPermission; role?: Role; user?: User; }) {
    const yesNo = (v: boolean) => t(v ? "common.yes" : "common.no");

    if (item.type === PermissionOverwriteType.ROLE && role) {
        const managedBy = roleManagedBy(role);
        return (
            <div className={cl("details")}>
                <DetailRow label={t("perm.position")}>{role.position}</DetailRow>
                <DetailRow label={t("perm.color")}>
                    {role.colorString
                        ? <span className={cl("copyable")} onClick={() => copy(role.colorString!)}>{role.colorString}</span>
                        : t("common.none")}
                </DetailRow>
                <DetailRow label={t("perm.hoisted")}>{yesNo(role.hoist)}</DetailRow>
                <DetailRow label={t("perm.mentionable")}>{yesNo(role.mentionable)}</DetailRow>
                {managedBy && <DetailRow label={t("perm.managed")}>{managedBy}</DetailRow>}
                <DetailRow label={t("perm.id")}>
                    <span className={cl("copyable")} onClick={() => copy(role.id)}>{role.id}</span>
                </DetailRow>
            </div>
        );
    }

    if (item.type === PermissionOverwriteType.MEMBER && item.id) {
        return (
            <div className={cl("details")}>
                {user && <DetailRow label="@">{user.username}</DetailRow>}
                <DetailRow label={t("perm.id")}>
                    <span className={cl("copyable")} onClick={() => copy(item.id!)}>{item.id}</span>
                </DetailRow>
            </div>
        );
    }

    return null;
}

function RolesAndUsersPermissionsComponent({ permissions: rawPermissions, guild, modalProps, header }: { permissions: Array<RoleOrUserPermission>; guild: Guild; modalProps: RenderModalProps; header: string; }) {
    const spec = useMemo(() => getPermissionSpecMap(guild), [guild.id]);

    // Copie triée AVANT le rendu (l'ancienne version triait en place après coup : index décalés).
    const permissions = useMemo(
        () => [...rawPermissions].sort((a, b) => (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9)),
        [rawPermissions]
    );

    const memberIds = useMemo(
        () => permissions.filter(p => p.type === PermissionOverwriteType.MEMBER && p.id).map(p => p.id!),
        [permissions]
    );

    // Re-rendu uniquement quand un des membres concernés arrive (pas sur chaque changement du serveur).
    useStateFromStores(
        [GuildMemberStore],
        () => memberIds.filter(id => GuildMemberStore.isMember(guild.id, id)).length,
        [memberIds]
    );

    useEffect(() => {
        const missing = memberIds.filter(id => !GuildMemberStore.isMember(guild.id, id));
        if (!missing.length) return;
        FluxDispatcher.dispatch({ type: "GUILD_MEMBERS_REQUEST", guildIds: [guild.id], userIds: missing });
    }, [memberIds]);

    const [selectedItemIndex, selectItem] = useState(0);
    const selectedItem = permissions[selectedItemIndex];

    const roles = GuildRoleStore.getRolesSnapshot(guild.id) ?? {};
    const selectedRole = selectedItem?.id ? roles[selectedItem.id] : undefined;
    const selectedUser = selectedItem?.type === PermissionOverwriteType.MEMBER ? UserStore.getUser(selectedItem.id ?? "") : undefined;

    const selectedIsAdmin = selectedItem?.type === PermissionOverwriteType.ROLE && hasAdministrator(selectedItem.permissions);

    return (
        <Modal
            {...modalProps}
            size="xl"
            title={t("perm.modalTitle", { name: header })}
        >
            {!selectedItem && (
                <div className={cl("modal-no-perms")}>
                    <Text variant="heading-lg/normal">{t("perm.empty")}</Text>
                </div>
            )}

            {selectedItem && (
                <div className={cl("modal-container")}>
                    <ScrollerThin className={cl("modal-list")} orientation="auto">
                        {permissions.map((permission, index) => {
                            const user: User | undefined = UserStore.getUser(permission.id ?? "");
                            const role: Role | undefined = roles[permission.id ?? ""];
                            const roleIconSrc = role != null ? getRoleIconSrc(role) : undefined;

                            return (
                                <div
                                    key={`${permission.type}-${permission.id ?? "owner"}`}
                                    className={cl("modal-list-item-btn")}
                                    onClick={() => selectItem(index)}
                                    role="button"
                                    tabIndex={0}
                                >
                                    <div
                                        className={cl("modal-list-item", { "modal-list-item-active": selectedItemIndex === index })}
                                        onContextMenu={e => {
                                            if (permission.type === PermissionOverwriteType.ROLE && permission.id)
                                                ContextMenuApi.openContextMenu(e, () => (
                                                    <RoleContextMenu guild={guild} roleId={permission.id!} />
                                                ));
                                            else if (permission.type === PermissionOverwriteType.MEMBER && permission.id)
                                                ContextMenuApi.openContextMenu(e, () => (
                                                    <UserContextMenu userId={permission.id!} />
                                                ));
                                        }}
                                    >
                                        {(permission.type === PermissionOverwriteType.ROLE || permission.type === PermissionOverwriteType.OWNER) && (
                                            <span
                                                className={cl("modal-role-circle")}
                                                style={{ backgroundColor: role?.colorString ?? "var(--primary-300)" }}
                                            />
                                        )}
                                        {permission.type === PermissionOverwriteType.ROLE && roleIconSrc != null && (
                                            <img className={cl("modal-role-image")} src={roleIconSrc} alt="" />
                                        )}
                                        {permission.type === PermissionOverwriteType.MEMBER && user != null && (
                                            <img className={cl("modal-user-img")} src={user.getAvatarURL(void 0, void 0, false)} alt="" />
                                        )}
                                        <Text variant="text-md/normal" className={cl("modal-list-item-text")}>
                                            {
                                                permission.type === PermissionOverwriteType.ROLE
                                                    ? role?.name ?? t("perm.unknownRole")
                                                    : permission.type === PermissionOverwriteType.MEMBER
                                                        ? (user != null ? getUniqueUsername(user) : null) ?? t("perm.unknownUser")
                                                        : (
                                                            <Flex gap="0.2em">
                                                                @{t("perm.owner").toLowerCase()}
                                                                <OwnerCrownIcon height={18} width={18} aria-hidden="true" />
                                                            </Flex>
                                                        )
                                            }
                                        </Text>
                                    </div>
                                </div>
                            );
                        })}
                    </ScrollerThin>
                    <div className={cl("modal-divider")} />
                    <ScrollerThin className={cl("modal-perms")} orientation="auto">
                        <SelectedDetails item={selectedItem} role={selectedRole} user={selectedUser} />
                        {selectedIsAdmin && (
                            <Text variant="text-sm/medium" className={cl("notice")}>{t("perm.admin")}</Text>
                        )}
                        {Object.values(PermissionsBits).map(bit => {
                            const overrideType = (() => {
                                const { permissions, overwriteAllow, overwriteDeny } = selectedItem;

                                if (permissions != null)
                                    return (permissions & bit) === bit ? "allowed" : "denied";
                                if (overwriteAllow && (overwriteAllow & bit) === bit)
                                    return "allowed";
                                if (overwriteDeny && (overwriteDeny & bit) === bit)
                                    return "denied";
                                return "default";
                            })();

                            if (overrideType === "default") return null;

                            const description = permissionDescription(spec, bit);

                            return (
                                <div key={String(bit)} className={cl("modal-perms-item")}>
                                    <div className={cl("modal-perms-item-icon")}>
                                        {overrideType === "allowed" && <PermissionAllowedIcon />}
                                        {overrideType === "denied" && <PermissionDeniedIcon />}
                                    </div>
                                    <Text variant="text-md/normal">{permissionTitle(spec, bit)}</Text>
                                    {description && (
                                        <Tooltip text={description}>
                                            {props => <InfoIcon {...props} />}
                                        </Tooltip>
                                    )}
                                </div>
                            );
                        })}
                    </ScrollerThin>
                </div>
            )}
        </Modal>
    );
}

function PencilIcon() {
    return (
        <svg role="img" width="18" height="18" fill="none" viewBox="0 0 24 24">
            <path fill="currentColor" d="m13.96 5.46 4.58 4.58a1 1 0 0 0 1.42 0l1.38-1.38a2 2 0 0 0 0-2.82l-3.18-3.18a2 2 0 0 0-2.82 0l-1.38 1.38a1 1 0 0 0 0 1.42ZM2.11 20.16l.73-4.22a3 3 0 0 1 .83-1.61l7.87-7.87a1 1 0 0 1 1.42 0l4.58 4.58a1 1 0 0 1 0 1.42l-7.87 7.87a3 3 0 0 1-1.6.83l-4.23.73a1.5 1.5 0 0 1-1.73-1.73Z" />
        </svg>
    );
}

/** Menu clic droit d'un rôle : modifier (si autorisé), copier la couleur, voir l'icône, copier l'ID. */
function RoleContextMenu({ guild, roleId }: { guild: Guild; roleId: string; }) {
    const role = GuildRoleStore.getRole(guild.id, roleId);

    let canManageRoles = false;
    try {
        canManageRoles = !!PermissionStore.getGuildPermissionProps(guild)?.canManageRoles;
    } catch { }

    return (
        <Menu.Menu
            navId={cl("role-context-menu")}
            onClose={ContextMenuApi.closeContextMenu}
            aria-label={t("perm.roleDetails")}
        >
            {canManageRoles && role && (
                <Menu.MenuItem
                    id={cl("edit-role")}
                    label={t("perm.editRole")}
                    leadingAccessory={{ type: "icon", icon: PencilIcon }}
                    action={async () => {
                        try {
                            await GuildSettingsActions.open(guild.id, "ROLES");
                            GuildSettingsActions.selectRole(role.id);
                        } catch (e) {
                            logger.error("ouverture des réglages du rôle impossible", e);
                        }
                    }}
                />
            )}
            {role?.colorString && (
                <Menu.MenuItem
                    id={cl("copy-role-color")}
                    label={t("perm.copyColor")}
                    action={() => copy(role.colorString!)}
                />
            )}
            {role?.icon && (
                <Menu.MenuItem
                    id={cl("view-role-icon")}
                    label={t("perm.viewIcon")}
                    leadingAccessory={{ type: "icon", icon: ImageIcon }}
                    action={() => openImageModal({
                        url: `${location.protocol}//${window.GLOBAL_ENV.CDN_HOST}/role-icons/${role.id}/${role.icon}.png?size=128`,
                        height: 128,
                        width: 128
                    })}
                />
            )}
            <Menu.MenuItem
                id={cl("copy-role-id")}
                label={t("perm.copyRoleId")}
                leadingAccessory={{ type: "icon", icon: CopyIdIcon }}
                action={() => copy(roleId)}
            />
        </Menu.Menu>
    );
}

function UserContextMenu({ userId }: { userId: string; }) {
    return (
        <Menu.Menu
            navId={cl("user-context-menu")}
            onClose={ContextMenuApi.closeContextMenu}
            aria-label={t("perm.copyUserId")}
        >
            <Menu.MenuItem
                id={cl("copy-user-id")}
                label={t("perm.copyUserId")}
                leadingAccessory={{ type: "icon", icon: CopyIdIcon }}
                action={() => copy(userId)}
            />
        </Menu.Menu>
    );
}

const RolesAndUsersPermissions = ErrorBoundary.wrap(RolesAndUsersPermissionsComponent);

export default function openRolesAndUsersPermissionsModal(permissions: Array<RoleOrUserPermission>, guild: Guild, header: string) {
    return openModalLazy(async () => {
        // Les libellés de Discord sont un plus : s'ils ne chargent pas, on affiche les noms de repli.
        await loadGetGuildPermissionSpecMap().catch(e => logger.warn("chargement des libellés impossible", e));

        return modalProps => (
            <RolesAndUsersPermissions
                modalProps={modalProps}
                permissions={permissions}
                guild={guild}
                header={header}
            />
        );
    });
}
