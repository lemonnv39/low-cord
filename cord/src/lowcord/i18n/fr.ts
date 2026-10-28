/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — textes de l'interface en français (langue par défaut).
// Toute clé ajoutée ici DOIT exister dans en.ts (sinon la compilation échoue).
// `{nom}` = variable remplacée par t(clé, { nom }).

export const fr = {
    // Onglet low-cord
    "tab.build": "Build {hash} · basé sur Vencord {vencord}",
    "tab.about": "Projet open source : tout le code est public. Les mises à jour passent par l'injecteur low-cord.",
    "tab.language": "Langue",
    "tab.languageHint": "Langue de l'interface low-cord (réglages, plugins). Discord garde sa propre langue.",
    "tab.quickActions": "Actions rapides",
    "tab.restart": "Redémarrer Discord",
    "tab.settingsFolder": "Dossier des réglages",
    "tab.source": "Code source",
    "tab.signature": "low-cord {version} · by shitday",

    // Onglet Plugins
    "plugins.summary": "{active} actif(s) sur {total}",
    "plugins.section": "Plugins",
    "plugins.empty": "Aucun plugin pour l'instant. Les plugins low-cord arriveront ici, un par un : peu, mais efficaces.",
    "plugins.core": "Cœur",
    "plugins.coreHint": "Toujours actifs : ils font tourner low-cord.",
    "plugins.restartTitle": "Redémarrage nécessaire",
    "plugins.restartText": "Redémarre Discord pour appliquer : {names}",
    "plugins.restartButton": "Redémarrer",
    "plugins.depsFailed": "Impossible de démarrer les dépendances : {names}",
    "plugins.toggleFailed": "Erreur au {action} de {name}",
    "plugins.starting": "démarrage",
    "plugins.stopping": "arrêt",
    "plugins.settings": "Réglages",
    "plugins.info": "Infos",

    // Fenêtre d'un plugin
    "modal.settings": "Réglages",
    "modal.noSettings": "Ce plugin n'a pas de réglages.",
    "modal.close": "Fermer",
    "modal.alwaysOn": "Plugin du cœur — toujours actif.",
} as const;
