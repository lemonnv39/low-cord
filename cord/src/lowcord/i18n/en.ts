/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — English UI strings. Must cover every key of fr.ts (type-checked).

import type { fr } from "./fr";

export const en = {
    "tab.build": "Build {hash} · based on Vencord {vencord}",
    "tab.about": "Open source project: all the code is public. Updates go through the low-cord injector.",
    "tab.language": "Language",
    "tab.languageHint": "Language of the low-cord interface (settings, plugins). Discord keeps its own language.",
    "tab.quickActions": "Quick actions",
    "tab.restart": "Restart Discord",
    "tab.settingsFolder": "Settings folder",
    "tab.source": "Source code",
    "tab.signature": "low-cord {version} · by shitday",

    "plugins.summary": "{active} of {total} enabled",
    "plugins.section": "Plugins",
    "plugins.empty": "No plugins yet. low-cord plugins will land here one by one: few, but effective.",
    "plugins.core": "Core",
    "plugins.coreHint": "Always on: they run low-cord itself.",
    "plugins.restartTitle": "Restart required",
    "plugins.restartText": "Restart Discord to apply: {names}",
    "plugins.restartButton": "Restart",
    "plugins.depsFailed": "Failed to start dependencies: {names}",
    "plugins.toggleFailed": "Error while {action} {name}",
    "plugins.starting": "starting",
    "plugins.stopping": "stopping",
    "plugins.settings": "Settings",
    "plugins.info": "Info",

    "modal.settings": "Settings",
    "modal.noSettings": "This plugin has no settings.",
    "modal.close": "Close",
    "modal.alwaysOn": "Core plugin — always on.",

    "platform.desktop": "Desktop",
    "platform.web": "Web",
    "platform.mobile": "Mobile",
    "platform.embedded": "Embedded (Console or Game)",
    "platform.vr": "VR",
} satisfies Record<keyof typeof fr, string>;
