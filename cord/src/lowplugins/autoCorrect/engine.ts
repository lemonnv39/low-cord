/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// AutoCorrect — installation et préparation du moteur (voir native.ts).

import { t } from "@lowcord/i18n";
import { Logger } from "@utils/Logger";
import { PluginNative } from "@utils/types";
import { showToast } from "@webpack/common";

import { getEngineState, setEngineState, settings } from "./settings";

const logger = new Logger("AutoCorrect");
export const Native = VencordNative.pluginHelpers.AutoCorrect as PluginNative<typeof import("./native")>;

export async function refreshEngine() {
    try {
        setEngineState(await Native.getStatus());
    } catch (e) {
        logger.error("État du moteur", e);
    }
}

let installing: Promise<void> | null = null;

/** Télécharge le moteur au premier usage (une fois pour toutes). */
export function ensureEngine(notify = false) {
    if (getEngineState()?.installed) return Promise.resolve();
    return installing ??= (async () => {
        setEngineState({ ...(getEngineState() ?? { installed: false, version: "", loaded: false }), busy: true, error: undefined });
        if (notify) showToast({ text: t("ac.downloading") });
        try {
            setEngineState(await Native.install());
            if (notify) showToast({ text: t("ac.installed"), variant: "success" });
        } catch (e: any) {
            logger.error("Installation du moteur impossible", e);
            await refreshEngine();
            if (notify) showToast({ text: t("ac.installFailed"), variant: "critical" });
        } finally {
            installing = null;
        }
    })();
}

let lastWarmup = 0;
/** Prépare le moteur quand une zone de texte apparaît : la correction est prête à l'envoi. */
export function warmup() {
    if (!settings.store.isEnabled || Date.now() - lastWarmup < 60_000) return;
    lastWarmup = Date.now();
    if (getEngineState()?.installed) Native.warmup().then(() => refreshEngine()).catch(() => { });
}
