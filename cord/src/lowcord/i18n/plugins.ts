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
        SilentTyping: {
            description: "Cache le fait que tu écris (l'indicateur « … est en train d'écrire » n'est plus envoyé)",
            settings: {
                showIcon: { name: "Bouton dans la barre de chat", description: "Afficher un bouton pour activer / désactiver" },
                contextMenu: { name: "Menu clic droit", description: "Ajouter l'option dans le menu clic droit de la zone de texte" },
                isEnabled: { name: "Activée", description: "Frappe silencieuse active" },
            },
        },
        ShowHiddenChannels: {
            description: "Affiche les salons auxquels tu n'as pas accès, avec leurs infos (sujet, membres autorisés, connectés en vocal…)",
            settings: {
                hideUnreads: { name: "Masquer les non-lus", description: "Ne pas afficher les salons cachés comme non lus" },
                showMode: {
                    name: "Affichage",
                    description: "Comment afficher les salons cachés",
                    options: { "0": "Style normal avec un cadenas", "1": "Style atténué avec un œil barré à droite" },
                },
                defaultAllowedUsersAndRolesDropdownState: {
                    name: "Membres autorisés dépliés",
                    description: "Déplier par défaut la liste des membres et rôles autorisés sur un salon caché",
                },
            },
        },
        ShowHiddenThings: {
            description: "Affiche des éléments réservés aux modérateurs : exclusions temporaires, invitations en pause, vue modération",
            settings: {
                showTimeouts: { name: "Exclusions temporaires", description: "Afficher l'icône d'exclusion temporaire des membres dans le chat" },
                showInvitesPaused: { name: "Invitations en pause", description: "Afficher l'info « invitations en pause » dans la liste des serveurs" },
                showModView: { name: "Vue modération", description: "Afficher « vue modération » sur les membres de tous les serveurs" },
            },
        },
        UserVoiceShow: {
            description: "Affiche une icône quand un utilisateur est en vocal (salon, serveur, muet / sourd / live / caméra, nombre de connectés)",
            settings: {
                showInUserProfileModal: { name: "Dans les profils", description: "Afficher l'indicateur à côté du nom dans le profil" },
                showInMemberList: { name: "Dans les listes", description: "Afficher l'indicateur dans la liste des membres, des MP et des amis" },
                showInMessages: { name: "Dans les messages", description: "Afficher l'indicateur à côté du nom dans les messages" },
            },
        },
        FollowUser: {
            description: "Suit un utilisateur en vocal : quand il change de salon, tu le rejoins",
            settings: {
                inactivityMinutes: {
                    name: "Arrêt automatique",
                    description: "Arrêter le suivi après cette durée sans activité vocale de l'utilisateur suivi",
                    options: { "5": "5 minutes", "15": "15 minutes", "30": "30 minutes", "60": "1 heure", "180": "3 heures", "0": "Jamais" },
                },
            },
        },
        RelationshipNotifier: {
            description: "Te prévient quand un ami te retire, qu'une demande d'ami est annulée ou que tu perds un serveur / groupe. Journal daté dans les réglages",
            settings: {
                friends: { name: "Amis", description: "Pop-up quand un ami te retire (ou te bloque)" },
                friendRequestCancels: { name: "Demandes d'ami", description: "Pop-up quand une demande d'ami reçue est annulée" },
                servers: { name: "Serveurs", description: "Pop-up quand tu n'es plus sur un serveur" },
                groups: { name: "Groupes", description: "Pop-up quand tu es retiré d'un groupe" },
                offlineRemovals: { name: "Pendant ton absence", description: "Au démarrage, signaler ce qui s'est passé pendant que tu étais hors ligne" },
                notices: { name: "Bandeau en plus", description: "Afficher aussi un bandeau en haut de Discord (pour ne rien rater)" },
            },
        },
        RoleColorEverywhere: {
            description: "Affiche la couleur du rôle le plus haut partout : mentions, liste des membres, vocal, réactions, sondages",
            settings: {
                chatMentions: { name: "Mentions", description: "Couleur du rôle dans les mentions (messages et zone de saisie)" },
                memberList: { name: "Liste des membres", description: "Couleur des titres de rôle dans la liste des membres" },
                voiceUsers: { name: "Vocal", description: "Couleur du rôle dans la liste des membres en vocal" },
                reactorsList: { name: "Réactions", description: "Couleur du rôle dans la liste de qui a réagi" },
                pollResults: { name: "Sondages", description: "Couleur du rôle dans les résultats des sondages" },
                colorChatMessages: { name: "Messages colorés", description: "Teinter le texte des messages avec la couleur du rôle de l'auteur" },
                messageSaturation: { name: "Intensité", description: "Force de la teinte des messages colorés" },
            },
        },
        MessageLogger: {
            description: "Garde les messages supprimés et modifiés, avec un journal permanent sur ton PC et les médias des MP archivés",
            settings: {
                deleteStyle: { name: "Style des messages supprimés", description: "Comment afficher un message supprimé dans le chat", options: { text: "Texte rouge", overlay: "Fond rouge" } },
                logDeletes: { name: "Messages supprimés", description: "Garder les messages supprimés" },
                collapseDeleted: { name: "Replier les supprimés", description: "Regrouper les messages supprimés comme les messages bloqués" },
                logEdits: { name: "Messages modifiés", description: "Garder l'ancien texte des messages modifiés" },
                logDeletedAttachments: { name: "Pièces jointes retirées", description: "Garder les pièces jointes retirées d'un message" },
                inlineEdits: { name: "Historique sous le message", description: "Afficher les anciennes versions directement sous le message" },
                journal: { name: "Journal permanent", description: "Enregistrer sur ton PC (garde tout, même après un redémarrage)" },
                journalServers: { name: "Journal des serveurs", description: "Enregistrer aussi les serveurs (les MP et groupes le sont toujours)" },
                archiveMedia: { name: "Archiver les médias", description: "Télécharger les médias dès leur réception pour les garder même s'ils sont supprimés", options: { dm: "MP et groupes", all: "MP, groupes et serveurs", off: "Désactivé" } },
                maxMediaMB: { name: "Taille max d'un média (Mo)", description: "Les fichiers plus gros ne sont pas archivés" },
                snapshotDays: { name: "Mémoire des MP (jours)", description: "Durée pendant laquelle les MP reçus sont gardés en copie, pour retrouver un message supprimé qui n'était pas affiché" },
                ignoreBots: { name: "Ignorer les bots", description: "Ne pas garder les messages des bots" },
                ignoreSelf: { name: "Ignorer mes messages", description: "Ne pas garder tes propres messages" },
                ignoreUsers: { name: "Utilisateurs ignorés", description: "ID séparés par des virgules" },
                ignoreChannels: { name: "Salons ignorés", description: "ID séparés par des virgules" },
                ignoreGuilds: { name: "Serveurs ignorés", description: "ID séparés par des virgules" },
            },
        },
        MessageCleaner: {
            description: "Supprime tes propres messages en masse : MP, groupes, serveurs, salons. Bouton dans la barre du haut et clic droit",
            settings: {
                delayMs: { name: "Pause entre deux suppressions (ms)", description: "Plus bas = plus rapide. Si c'est trop rapide, Discord ralentit et low-cord s'adapte tout seul" },
            },
        },
        ClearFriends: {
            description: "Retire plusieurs amis d'un coup, depuis une liste à cocher dans la barre du haut",
            settings: {
                delayMs: { name: "Pause entre deux retraits (ms)", description: "Plus bas = plus rapide ; low-cord ralentit tout seul si Discord le demande" },
            },
        },
        WhosWatching: {
            description: "Montre qui regarde ton live : liste au survol de l'icône et barre des spectateurs sous ton stream",
            settings: {
                showPanel: { name: "Barre des spectateurs", description: "Afficher les spectateurs sous le panneau de ton stream" },
                notify: { name: "Arrivées / départs", description: "Pop-up quand quelqu'un rejoint ou quitte ton live" },
            },
        },
        AntiMoveDeco: {
            description: "Verrouille ton salon vocal : si quelqu'un te déplace ou te déconnecte, tu y reviens. Tes propres changements sont respectés",
            settings: {
                notify: { name: "Pop-ups", description: "Prévenir quand tu es ramené dans ton salon" },
            },
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
