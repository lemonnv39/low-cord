/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — modules que peut importer un plugin perso écrit comme un plugin
// Vencord (import … from "@api/Settings", "@webpack/common"…). Les plugins
// perso sont compilés à part : leurs imports sont reliés ici, aux vrais
// modules de low-cord.

import * as ApiBadges from "@api/Badges";
import * as ApiChatButtons from "@api/ChatButtons";
import * as ApiCommands from "@api/Commands";
import * as ApiContextMenu from "@api/ContextMenu";
import * as ApiDataStore from "@api/DataStore";
import * as Api from "@api/index";
import * as ApiMemberListDecorators from "@api/MemberListDecorators";
import * as ApiMessageAccessories from "@api/MessageAccessories";
import * as ApiMessageDecorations from "@api/MessageDecorations";
import * as ApiMessageEvents from "@api/MessageEvents";
import * as ApiMessagePopover from "@api/MessagePopover";
import * as ApiMessageUpdater from "@api/MessageUpdater";
import * as ApiNotices from "@api/Notices";
import * as ApiNotifications from "@api/Notifications";
import * as ApiPluginManager from "@api/PluginManager";
import * as ApiServerList from "@api/ServerList";
import * as ApiSettings from "@api/Settings";
import * as ApiStyles from "@api/Styles";
import * as ApiUserSettings from "@api/UserSettings";
import * as CBaseText from "@components/BaseText";
import * as CButton from "@components/Button";
import * as CCard from "@components/Card";
import * as CCodeBlock from "@components/CodeBlock";
import * as CDivider from "@components/Divider";
import * as CErrorBoundary from "@components/ErrorBoundary";
import * as CErrorCard from "@components/ErrorCard";
import * as CFlex from "@components/Flex";
import * as CFormSwitch from "@components/FormSwitch";
import * as CHeading from "@components/Heading";
import * as CIcons from "@components/Icons";
import * as Components from "@components/index";
import * as CLink from "@components/Link";
import * as CParagraph from "@components/Paragraph";
import * as CSpan from "@components/Span";
import * as CSwitch from "@components/Switch";
import * as CText from "@components/Text";
import * as CTooltipContainer from "@components/TooltipContainer";
import * as UClipboard from "@utils/clipboard";
import * as UConstants from "@utils/constants";
import * as UCss from "@utils/css";
import * as UDiscord from "@utils/discord";
import * as UGuards from "@utils/guards";
import * as Utils from "@utils/index";
import * as ULazy from "@utils/lazy";
import * as ULazyReact from "@utils/lazyReact";
import * as ULogger from "@utils/Logger";
import * as UMargins from "@utils/margins";
import * as UMisc from "@utils/misc";
import * as UModal from "@utils/modal";
import * as UPatches from "@utils/patches";
import * as UQueue from "@utils/Queue";
import * as UReact from "@utils/react";
import * as UText from "@utils/text";
import * as UTypes from "@utils/types";
import definePlugin, { OptionType } from "@utils/types";
import * as DiscordEnums from "@vencord/discord-types/enums";
import * as Webpack from "@webpack";
import * as Common from "@webpack/common";

import * as LowHeaderBar from "./headerBar";

/** OptionType / StartAt sont des enums « const » (effacés à la compilation) : on les refait en objets. */
const OPTION_TYPES = {
    STRING: OptionType.STRING,
    NUMBER: OptionType.NUMBER,
    BIGINT: OptionType.BIGINT,
    BOOLEAN: OptionType.BOOLEAN,
    SELECT: OptionType.SELECT,
    SLIDER: OptionType.SLIDER,
    COMPONENT: OptionType.COMPONENT,
    CUSTOM: OptionType.CUSTOM,
};

const START_AT = { Init: "Init", DOMContentLoaded: "DOMContentLoaded", WebpackReady: "WebpackReady" };

// Auteurs inconnus (EquicordDevs, Devs.xxx absent) : un auteur générique plutôt qu'un plantage.
const anyDev = (devs: Record<string, any>) => new Proxy(devs, {
    get: (target, key) => typeof key === "string" ? target[key] ?? { name: key, id: 0n } : undefined,
});

// React n'existe qu'une fois Discord chargé : on le lit à chaque accès.
const LazyReact = new Proxy({}, { get: (_, key) => (Common.React as any)?.[key] });

export { OPTION_TYPES };

let modules: Record<string, any> | undefined;

/** Construit à la première demande : au chargement de low-cord, certains de ces modules ne sont pas encore initialisés. */
export const getUserPluginModules = () => modules ??= {
    "@api/Badges": ApiBadges,
    "@api/ChatButtons": ApiChatButtons,
    "@api/Commands": ApiCommands,
    "@api/ContextMenu": ApiContextMenu,
    // API d'Equicord : même rôle que la barre du haut de low-cord.
    "@api/HeaderBar": {
        ...LowHeaderBar,
        get HeaderBarButton() { return LowHeaderBar.HeaderBarIcon; },
    },
    "@api/DataStore": ApiDataStore,
    "@api/index": Api,
    "@api": Api,
    "@api/MemberListDecorators": ApiMemberListDecorators,
    "@api/MessageAccessories": ApiMessageAccessories,
    "@api/MessageDecorations": ApiMessageDecorations,
    "@api/MessageEvents": ApiMessageEvents,
    "@api/MessagePopover": ApiMessagePopover,
    "@api/MessageUpdater": ApiMessageUpdater,
    "@api/Notices": ApiNotices,
    "@api/Notifications": ApiNotifications,
    "@api/PluginManager": ApiPluginManager,
    "@api/ServerList": ApiServerList,
    "@api/Settings": ApiSettings,
    "@api/Styles": ApiStyles,
    "@api/UserSettings": ApiUserSettings,

    "@components/BaseText": CBaseText,
    "@components/Button": CButton,
    "@components/Card": CCard,
    "@components/CodeBlock": CCodeBlock,
    "@components/Divider": CDivider,
    "@components/ErrorBoundary": CErrorBoundary,
    "@components/ErrorCard": CErrorCard,
    "@components/Flex": CFlex,
    "@components/FormSwitch": CFormSwitch,
    "@components/Heading": CHeading,
    "@components/Icons": CIcons,
    "@components/index": Components,
    "@components": Components,
    "@components/Link": CLink,
    "@components/Paragraph": CParagraph,
    "@components/Span": CSpan,
    "@components/Switch": CSwitch,
    "@components/Text": CText,
    "@components/TooltipContainer": CTooltipContainer,

    "@utils/clipboard": UClipboard,
    "@utils/constants": { ...UConstants, Devs: anyDev(UConstants.Devs), EquicordDevs: anyDev({}) },
    "@utils/css": UCss,
    "@utils/discord": UDiscord,
    "@utils/guards": UGuards,
    "@utils/index": Utils,
    "@utils": Utils,
    "@utils/lazy": ULazy,
    "@utils/lazyReact": ULazyReact,
    "@utils/Logger": ULogger,
    "@utils/margins": UMargins,
    "@utils/misc": UMisc,
    "@utils/modal": UModal,
    "@utils/patches": UPatches,
    "@utils/Queue": UQueue,
    "@utils/react": UReact,
    "@utils/text": UText,
    "@utils/types": { ...UTypes, default: definePlugin, OptionType: OPTION_TYPES, StartAt: START_AT },

    "@webpack": Webpack,
    "@webpack/common": Common,
    "react": LazyReact,
    // Types seulement : rien à l'exécution.
    "@vencord/discord-types": {},
    "@vencord/discord-types/enums": DiscordEnums,
};
