/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-musical — clé de la fenêtre à part et réglage « toujours au premier plan ».

import { PopoutActions, PopoutWindowStore, useStateFromStores } from "@webpack/common";

// Les fenêtres de Discord portent toutes une clé « DISCORD_… ».
export const WINDOW_KEY = "DISCORD_LOWMUSICAL";

export const useDetached = () => useStateFromStores([PopoutWindowStore], () => PopoutWindowStore.getWindowOpen(WINDOW_KEY));
export const useAlwaysOnTop = () => useStateFromStores([PopoutWindowStore], () => PopoutWindowStore.getIsAlwaysOnTop(WINDOW_KEY));
export const setAlwaysOnTop = (on: boolean) => PopoutActions.setAlwaysOnTop(WINDOW_KEY, on);
