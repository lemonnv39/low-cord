/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — catégories de l'onglet Plugins (filtre au-dessus de la liste).
// Un nouveau plugin sans catégorie ici tombe dans « Autres ».

import type { I18nKey } from "@lowcord/i18n";

export type Category = "voice" | "messages" | "servers" | "social" | "tools" | "interface" | "other";

/** Ordre d'affichage des filtres. */
export const CATEGORIES: { id: Category; label: I18nKey; }[] = [
    { id: "voice", label: "plugins.cat.voice" },
    { id: "messages", label: "plugins.cat.messages" },
    { id: "servers", label: "plugins.cat.servers" },
    { id: "social", label: "plugins.cat.social" },
    { id: "tools", label: "plugins.cat.tools" },
    { id: "interface", label: "plugins.cat.interface" },
    { id: "other", label: "plugins.cat.other" },
];

const BY_PLUGIN: Record<string, Category> = {
    // Vocal
    AntiMoveDeco: "voice",
    FollowUser: "voice",
    UserVoiceShow: "voice",
    WhosWatching: "voice",
    // Messages
    ExportMessages: "messages",
    MessageCleaner: "messages",
    MessageLogger: "messages",
    AutoCorrect: "messages",
    SilentTyping: "messages",
    // Serveurs
    PermissionsViewer: "servers",
    ServerInfo: "servers",
    ShowHiddenChannels: "servers",
    ShowHiddenThings: "servers",
    // Amis & profils
    ClearFriends: "social",
    RelationshipNotifier: "social",
    PlatformIndicators: "social",
    // Outils
    TokenImporter: "tools",
    ImageToolkit: "tools",
    ViewIcons: "tools",
    // Interface
    SmoothType: "interface",
    RoleColorEverywhere: "interface",
    PlainFolderIcon: "interface",
};

export const categoryOf = (pluginName: string): Category => BY_PLUGIN[pluginName] ?? "other";
