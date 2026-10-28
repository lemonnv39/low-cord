/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — textes des plugins par langue. Si une entrée manque, on affiche
// le texte d'origine du plugin (anglais). Chaque nouveau plugin low-cord
// ajoute ici sa description FR (et EN si son code est écrit en français).

import type { Lang } from ".";

export interface PluginStrings {
    description?: string;
    settings?: Record<string, {
        name?: string;
        description?: string;
        /** valeur de l'option -> libellé */
        options?: Record<string, string>;
    }>;
}

export const PLUGIN_STRINGS: Record<Lang, Record<string, PluginStrings>> = {
    fr: {
        Settings: {
            description: "Ajoute l'interface de réglages low-cord et les infos de débogage",
            settings: {
                settingsLocation: {
                    name: "Position de la section",
                    description: "Où placer la section low-cord dans les paramètres Discord",
                    options: {
                        top: "Tout en haut",
                        aboveNitro: "Au-dessus de Nitro",
                        belowNitro: "Sous Nitro",
                        aboveActivity: "Au-dessus des paramètres d'activité",
                        belowActivity: "Sous les paramètres d'activité",
                        bottom: "Tout en bas",
                    },
                },
                includeVencordInfoWhenCopying: {
                    name: "Infos de version à la copie",
                    description: "En cliquant sur la version en bas à gauche des paramètres, copie aussi les infos low-cord (Vencord, Electron, Chromium)",
                },
            },
        },
        NoTrack: {
            description: "Bloque le pistage de Discord (analytics, métriques) et l'envoi des rapports de crash Sentry",
            settings: {
                disableAnalytics: {
                    name: "Bloquer les analytics",
                    description: "Bloque les analytics de Discord. Désactive-le si tu veux que les badges suivent ta progression (ex : heures de stream).",
                },
            },
        },
        FixDiscordCss: {
            description: "Corrige les ralentissements liés au CSS de Discord",
        },
        ConcatenatedComponentExtractor: {
            description: "Extrait les composants regroupés par le bundler de Discord (usage interne)",
        },
        PermissionsViewer: {
            description: "Voir les permissions d'un membre, d'un salon ou de tous les rôles d'un serveur, avec le rôle qui accorde chaque permission",
            settings: {
                permissionsSortOrder: {
                    name: "Ordre de tri",
                    description: "Quel rôle afficher comme source d'une permission quand plusieurs l'accordent",
                    options: { "0": "Rôle le plus haut", "1": "Rôle le plus bas" },
                },
            },
        },
        ServerInfo: {
            description: "Fiche complète d'un serveur : infos, membres, contenu, sécurité, boosts, fonctionnalités, et tes amis / bloqués / ignorés présents",
        },
        PlainFolderIcon: {
            description: "Affiche une icône de dossier simple au lieu des mini-icônes des serveurs qu'il contient",
        },
        PlatformIndicators: {
            description: "Affiche les plateformes (ordinateur, mobile, navigateur…) des utilisateurs, amis ou non",
            settings: {
                list: { name: "Liste des membres", description: "Afficher les plateformes dans la liste des membres" },
                badges: { name: "Profils", description: "Afficher les plateformes dans les profils, sous forme de badges" },
                messages: { name: "Messages", description: "Afficher les plateformes à côté du nom dans les messages" },
                colorMobileIndicator: {
                    name: "Couleur de l'indicateur mobile",
                    description: "Colorer l'indicateur mobile selon le statut de l'utilisateur (nécessite un redémarrage)",
                },
            },
        },
    },
    en: {
        Settings: {
            description: "Adds the low-cord settings UI and debug info",
            settings: {
                settingsLocation: {
                    description: "Where to put the low-cord section in Discord settings",
                },
                includeVencordInfoWhenCopying: {
                    description: "Also copy low-cord info (Vencord, Electron, Chromium) when clicking the version in the bottom left of Settings",
                },
            },
        },
    },
};
