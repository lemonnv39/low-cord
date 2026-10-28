/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — carte d'un plugin (activation + accès aux réglages), traduite.
// La logique d'activation est celle de Vencord (PluginCard) : dépendances,
// redémarrage si le plugin a des patches, start/stop à chaud sinon.

import { showNotice } from "@api/Notices";
import { hasAnyVisibleSettings, isPluginEnabled, pluginRequiresRestart, startDependenciesRecursive, startPlugin, stopPlugin } from "@api/PluginManager";
import { Settings } from "@api/Settings";
import { CogWheel, InfoIcon } from "@components/Icons";
import { AddonCard } from "@components/settings/AddonCard";
import { pluginDescription, t } from "@lowcord/i18n";
import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import { Plugin } from "@utils/types";
import { showToast, Tooltip } from "@webpack/common";

import { openLowPluginModal } from "./LowPluginModal";

const cl = classNameFactory("lc-");
const logger = new Logger("low-cord", "#d0d0d0");

interface Props {
    plugin: Plugin;
    onRestartNeeded(name: string, key: string): void;
}

export function LowPluginCard({ plugin, onRestartNeeded }: Props) {
    const settings = Settings.plugins[plugin.name];
    const isEnabled = () => isPluginEnabled(plugin.name);

    function toggleEnabled() {
        const wasEnabled = isEnabled();

        if (!wasEnabled) {
            const { restartNeeded, failures } = startDependenciesRecursive(plugin);
            if (failures.length) {
                logger.error(`Failed to start dependencies for ${plugin.name}: ${failures.join(", ")}`);
                showNotice(t("plugins.depsFailed", { names: failures.join(", ") }), "OK", () => null);
                return;
            }
            if (restartNeeded) {
                settings.enabled = true;
                onRestartNeeded(plugin.name, "enabled");
                return;
            }
        }

        if (pluginRequiresRestart(plugin)) {
            settings.enabled = !wasEnabled;
            onRestartNeeded(plugin.name, "enabled");
            return;
        }

        if (wasEnabled && !plugin.started) {
            settings.enabled = !wasEnabled;
            return;
        }

        const ok = wasEnabled ? stopPlugin(plugin) : startPlugin(plugin);
        if (!ok) {
            settings.enabled = false;
            const action = t(wasEnabled ? "plugins.stopping" : "plugins.starting");
            showToast({ text: t("plugins.toggleFailed", { action, name: plugin.name }), variant: "critical", position: "bottom" });
            return;
        }
        settings.enabled = !wasEnabled;
    }

    const hasSettings = hasAnyVisibleSettings(plugin);

    return (
        <AddonCard
            name={plugin.name}
            description={pluginDescription(plugin)}
            enabled={plugin.required || isEnabled()}
            setEnabled={toggleEnabled}
            disabled={plugin.required}
            infoButton={
                <Tooltip text={t(hasSettings ? "plugins.settings" : "plugins.info")}>
                    {tooltip => (
                        <button
                            {...tooltip}
                            className={cl("info-button")}
                            onClick={() => openLowPluginModal(plugin, onRestartNeeded)}
                        >
                            {hasSettings ? <CogWheel className={cl("info-icon")} /> : <InfoIcon className={cl("info-icon")} />}
                        </button>
                    )}
                </Tooltip>
            }
        />
    );
}
