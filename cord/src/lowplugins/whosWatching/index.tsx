/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * WhosWatching — qui regarde ton live. Sous le panneau de ton stream : le
 * nombre de spectateurs et leurs avatars (clic = profil) ; au survol de
 * l'icône du live : la liste complète. En option, une pop-up quand
 * quelqu'un rejoint ou quitte ton live.
 */

import "./styles.css";

import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { t, useLang } from "@lowcord/i18n";
import { classNameFactory } from "@utils/css";
import { openUserProfile } from "@utils/discord";
import definePlugin, { OptionType } from "@utils/types";
import { User } from "@vencord/discord-types";
import { ApplicationStreamingStore, GuildMemberStore, React, RelationshipStore, showToast, Tooltip, UserStore, useStateFromStores } from "@webpack/common";
import type { ComponentType, PropsWithChildren } from "react";

const cl = classNameFactory("lc-ww-");
const MAX_AVATARS = 8;

const settings = definePluginSettings({
    showPanel: {
        type: OptionType.BOOLEAN,
        description: "Show spectators under your stream panel",
        default: true,
        restartNeeded: true,
    },
    notify: {
        type: OptionType.BOOLEAN,
        description: "Pop-up when someone joins or leaves your stream",
        default: false,
    },
});

// ── Données ──────────────────────────────────────────────────────────────────
/** Spectateurs de TON live ; liste vide si tu ne streames pas. */
function useViewers() {
    // Chaîne d'ID : le composant ne se re-rend que si la liste change vraiment.
    const key = useStateFromStores([ApplicationStreamingStore], () => {
        const stream = ApplicationStreamingStore.getCurrentUserActiveStream();
        return stream ? `${stream.guildId ?? ""}|${ApplicationStreamingStore.getViewerIds(stream).join(",")}` : null;
    });
    if (key == null) return null;
    const [guildId, ids] = key.split("|");
    return { guildId: guildId || undefined, ids: ids ? ids.split(",") : [] };
}

function displayName(user: User, guildId?: string) {
    return (guildId && GuildMemberStore.getNick(guildId, user.id))
        || RelationshipStore.getNickname(user.id)
        || user.globalName
        || user.username;
}

const avatarOf = (user: User, guildId?: string) => user.getAvatarURL?.(guildId, 64, false);

// ── Composants ───────────────────────────────────────────────────────────────
function ViewerList({ ids, guildId }: { ids: string[]; guildId?: string; }) {
    useLang();
    const users = ids.map(id => UserStore.getUser(id)).filter(Boolean) as User[];
    const unknown = ids.length - users.length;

    return (
        <div className={cl("tip")}>
            <div className={cl("tip-head")}>
                <span className={cl("live")} />
                {t(ids.length ? "ww.viewers" : "ww.noViewers", { count: ids.length })}
            </div>
            {users.map(u => (
                <div key={u.id} className={cl("tip-row")}>
                    <img className={cl("tip-avatar")} src={avatarOf(u, guildId)} alt="" />
                    <span className={cl("tip-name")}>{displayName(u, guildId)}</span>
                    {displayName(u, guildId) !== u.username && <span className={cl("tip-user")}>@{u.username}</span>}
                </div>
            ))}
            {unknown > 0 && <div className={cl("tip-more")}>{t("ww.unknown", { count: unknown })}</div>}
        </div>
    );
}

function SpectatorsBar() {
    useLang();
    const viewers = useViewers();
    if (!viewers) return null;
    const { ids, guildId } = viewers;
    const users = ids.map(id => UserStore.getUser(id)).filter(Boolean) as User[];
    const shown = users.slice(0, MAX_AVATARS);
    const rest = ids.length - shown.length;

    return (
        <div className={cl("bar")}>
            <div className={cl("bar-head")}>
                <span className={cl("live")} />
                <span className={cl("bar-title")}>{t(ids.length ? "ww.viewers" : "ww.noViewers", { count: ids.length })}</span>
            </div>
            {ids.length > 0 && (
                <div className={cl("stack")}>
                    {shown.map(u => (
                        <Tooltip key={u.id} text={displayName(u, guildId)}>
                            {props => (
                                <button {...props} className={cl("face")} onClick={() => openUserProfile(u.id).catch(() => null)}>
                                    <img src={avatarOf(u, guildId)} alt={displayName(u, guildId)} />
                                </button>
                            )}
                        </Tooltip>
                    ))}
                    {rest > 0 && (
                        <Tooltip text={<ViewerList ids={ids} guildId={guildId} />}>
                            {props => <span {...props} className={cl("face", "face-more")}>+{rest}</span>}
                        </Tooltip>
                    )}
                </div>
            )}
        </div>
    );
}

/**
 * Remplace la div qui entoure le panneau du stream : on y ajoute la barre des
 * spectateurs. La référence (ref) que Discord pose sur cette div est
 * transmise telle quelle.
 */
// Créé au premier affichage, jamais au chargement du fichier : à ce
// moment-là React n'existe pas encore (tout low-cord planterait).
let streamPanelWrapper: ComponentType<any> | null = null;
function getStreamPanelWrapper() {
    return streamPanelWrapper ??= React.forwardRef<HTMLDivElement, PropsWithChildren<Record<string, any>>>((props, ref) => (
        <>
            <div {...props} ref={ref}>{props.children}</div>
            <ErrorBoundary noop>
                <SpectatorsBar />
            </ErrorBoundary>
        </>
    ));
}

// Icône du live avec la liste au survol. Une seule version par composant
// d'origine : en recréer une à chaque affichage faisait recharger l'icône
// et refermer l'infobulle sans arrêt.
const wrapped = new WeakMap<ComponentType<any>, ComponentType<any>>();
function wrapStreamIcon(Original: ComponentType<any>) {
    let Wrapped = wrapped.get(Original);
    if (!Wrapped) {
        Wrapped = ErrorBoundary.wrap((props: any) => {
            const viewers = useViewers();
            if (!viewers) return <Original {...props} />;
            return (
                <Tooltip text={<ViewerList ids={viewers.ids} guildId={viewers.guildId} />}>
                    {({ onMouseEnter, onMouseLeave }) => (
                        <div onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
                            <Original {...props} />
                        </div>
                    )}
                </Tooltip>
            );
        }, { noop: true });
        wrapped.set(Original, Wrapped);
    }
    return Wrapped;
}

// ── Pop-ups d'arrivée / de départ ────────────────────────────────────────────
let lastViewers: Set<string> | null = null;

function onStreamChange() {
    const stream = ApplicationStreamingStore.getCurrentUserActiveStream();
    if (!stream) {
        lastViewers = null;
        return;
    }
    const now = new Set(ApplicationStreamingStore.getViewerIds(stream));
    if (lastViewers && settings.store.notify) {
        const name = (id: string) => {
            const u = UserStore.getUser(id);
            return u ? displayName(u, stream.guildId ?? undefined) : id;
        };
        for (const id of now) if (!lastViewers.has(id)) showToast({ text: t("ww.joined", { name: name(id) }), variant: "success" });
        for (const id of lastViewers) if (!now.has(id)) showToast({ text: t("ww.left", { name: name(id) }) });
    }
    lastViewers = now;
}

export default definePlugin({
    name: "WhosWatching",
    description: "See who is watching your stream: list on hover, bar under your stream panel.",
    tags: ["Activity", "Voice"],
    authors: [{ name: "Fres", id: 0n }, { name: "thororen", id: 0n }],
    settings,

    patches: [
        {
            // Icône du live dans ton panneau vocal
            find: ".Masks.STATUS_SCREENSHARE,width:32",
            replacement: {
                match: /\((\i\.\i)(?=,{mask:\i\.\i\.Masks\.STATUS_SCREENSHARE)/,
                replace: "($self.wrapStreamIcon($1)"
            }
        },
        {
            // Panneau du stream : barre des spectateurs en dessous
            find: ",setIsForceShowSharingPopout:",
            replacement: {
                match: /"div"(?=.{0,50}stream:\i,canGoLive:\i)/,
                replace: "$self.StreamPanelWrapper"
            },
            predicate: () => settings.store.showPanel,
        }
    ],

    wrapStreamIcon,
    get StreamPanelWrapper() {
        return getStreamPanelWrapper();
    },

    start() {
        lastViewers = null;
        ApplicationStreamingStore.addChangeListener(onStreamChange);
    },

    stop() {
        ApplicationStreamingStore.removeChangeListener(onStreamChange);
        lastViewers = null;
    },
});
