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

import "./style.css";

import { addMemberListDecorator, removeMemberListDecorator } from "@api/MemberListDecorators";
import { addMessageDecoration, removeMessageDecoration } from "@api/MessageDecorations";
import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";

import { VoiceChannelIndicator } from "./components";

const settings = definePluginSettings({
    showInUserProfileModal: {
        type: OptionType.BOOLEAN,
        description: "Show a user's Voice Channel indicator in their profile next to the name",
        default: true,
        restartNeeded: true
    },
    showInMemberList: {
        type: OptionType.BOOLEAN,
        description: "Show a user's Voice Channel indicator in the member and DMs list",
        default: true,
        restartNeeded: true
    },
    showInMessages: {
        type: OptionType.BOOLEAN,
        description: "Show a user's Voice Channel indicator in messages",
        default: true,
        restartNeeded: true
    }
});

export default definePlugin({
    name: "UserVoiceShow",
    description: "Shows an indicator when a user is in a Voice Channel",
    tags: ["Voice", "Appearance", "Friends"],
    authors: [Devs.Nuckyz, Devs.LordElias],
    dependencies: ["MemberListDecoratorsAPI", "MessageDecorationsAPI"],
    settings,

    patches: [
        // Popout utilisateur, profil complet, profil latéral des MP
        {
            find: "#{intl::USER_PROFILE_PRONOUNS}",
            replacement: {
                match: /(user:(\i).{0,100}onClickDisplayName:\i,trailing:)(\i)/,
                replace: "$1[$self.VoiceChannelIndicator({userId:$2.id,isProfile:true}),$3]"
            },
            predicate: () => settings.store.showInUserProfileModal
        },
        // Liste d'amis : boutons d'action de la ligne (ancré sur le bouton
        // « Message » pour ne pas tomber sur la carte cadeau du même module)
        {
            find: "null!=this.peopleListItemRef.current",
            replacement: {
                match: /(\.isProvisional\}\),\(0,\i\.jsxs\)\("div",\{className:\i\.\i,children:\[)(?=.{0,300}?onClick:this\.handleMessageClick,shouldHighlight:(\i))/,
                replace: "$1$self.VoiceChannelIndicator({userId:this?.props?.user?.id,isActionButton:true,shouldHighlight:$2}),"
            },
            predicate: () => settings.store.showInMemberList
        }
    ],

    start() {
        if (settings.store.showInMemberList) {
            addMemberListDecorator("UserVoiceShow", ({ user }) => user == null ? null : <VoiceChannelIndicator userId={user.id} />);
        }
        if (settings.store.showInMessages) {
            addMessageDecoration("UserVoiceShow", ({ message }) => message?.author == null ? null : <VoiceChannelIndicator userId={message.author.id} isMessage={true} />);
        }
    },

    stop() {
        removeMemberListDecorator("UserVoiceShow");
        removeMessageDecoration("UserVoiceShow");
    },

    VoiceChannelIndicator
});
