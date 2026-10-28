/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — fenêtre de réglages d'un plugin, traduite. Réutilise les
// composants de réglage de Vencord (bool, select, slider…) en leur passant
// une copie traduite de chaque définition : le comportement reste celui de
// Vencord, seul l'affichage change.

import { isSettingHidden } from "@api/PluginManager";
import { useSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { OptionComponentMap } from "@components/settings/tabs/plugins/components";
import { localizeSetting, pluginDescription, t, useLang } from "@lowcord/i18n";
import { debounce } from "@shared/debounce";
import { classNameFactory } from "@utils/css";
import { OptionType, Plugin } from "@utils/types";
import { RenderModalProps } from "@vencord/discord-types";
import { Forms, Modal, openModal, Text } from "@webpack/common";

const cl = classNameFactory("lc-");

interface Props extends RenderModalProps {
    plugin: Plugin;
    onRestartNeeded(key: string): void;
}

function LowPluginModal({ plugin, onRestartNeeded, onClose, transitionState }: Props) {
    useLang();
    const pluginSettings = useSettings([`plugins.${plugin.name}.*`]).plugins[plugin.name];
    const defined = plugin.settings;

    const options = defined
        ? Object.entries(defined.def).map(([key, setting]) => {
            if (setting.type === OptionType.CUSTOM || isSettingHidden(defined, setting)) return null;

            function onChange(value: any) {
                pluginSettings[key] = value;
                if ("restartNeeded" in setting && setting.restartNeeded) onRestartNeeded(key);
            }

            const Component = OptionComponentMap[setting.type];
            return (
                <ErrorBoundary noop key={key}>
                    <Component
                        id={key}
                        setting={localizeSetting(plugin.name, key, setting)}
                        onChange={debounce(onChange)}
                        pluginSettings={pluginSettings}
                        definedSettings={defined}
                        closePluginSettings={onClose}
                    />
                </ErrorBoundary>
            );
        }).filter(Boolean)
        : [];

    return (
        <Modal
            transitionState={transitionState}
            onClose={onClose}
            size="md"
            title={<Text variant="heading-lg/semibold">{plugin.name}</Text>}
            subtitle={<Forms.FormText>{pluginDescription(plugin)}</Forms.FormText>}
        >
            <div className={cl("modal-body")}>
                {plugin.required && <Forms.FormText className={cl("muted")}>{t("modal.alwaysOn")}</Forms.FormText>}
                <Text variant="heading-md/semibold" className={cl("modal-title")}>{t("modal.settings")}</Text>
                {options.length
                    ? <div className={cl("settings")}>{options}</div>
                    : <Forms.FormText className={cl("muted")}>{t("modal.noSettings")}</Forms.FormText>}
            </div>
        </Modal>
    );
}

export function openLowPluginModal(plugin: Plugin, onRestartNeeded?: (pluginName: string, key: string) => void) {
    openModal(props => (
        <ErrorBoundary>
            <LowPluginModal
                {...props}
                plugin={plugin}
                onRestartNeeded={key => onRestartNeeded?.(plugin.name, key)}
            />
        </ErrorBoundary>
    ));
}
