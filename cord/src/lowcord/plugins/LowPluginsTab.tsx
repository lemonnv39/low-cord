/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — onglet Plugins. Pas de recherche ni de filtres : low-cord n'aura
// que peu de plugins, tous utiles. Deux blocs : nos plugins (activables) et
// le cœur (toujours actif, replié dans un bloc discret).

import "@lowcord/styles.css";

import { isPluginEnabled } from "@api/PluginManager";
import { useSettings } from "@api/Settings";
import { SettingsTab, wrapTab } from "@components/settings/tabs/BaseTab";
import { t, useLang } from "@lowcord/i18n";
import { classNameFactory } from "@utils/css";
import { Plugin } from "@utils/types";
import { Button, Forms, Text, useMemo, useState } from "@webpack/common";

import Plugins, { PluginMeta } from "~plugins";

import { LowPluginCard } from "./LowPluginCard";
import { PresetPanel } from "./PresetPanel";
import { UserPluginsSection } from "./UserPluginsSection";

const cl = classNameFactory("lc-");

const isCore = (p: Plugin) => p.required || PluginMeta[p.name]?.folderName.startsWith("_core/");
// Les plugins *API sont des briques internes, activées automatiquement par dépendance.
// Les plugins perso ont leur propre section (activation au redémarrage).
const isListed = (p: Plugin) => !p.hidden && !p.name.endsWith("API") && !PluginMeta[p.name]?.userPlugin;

function LowPluginsSettings() {
    useLang();
    useSettings();

    const [pendingRestart, setPendingRestart] = useState<string[]>([]);
    const [userPluginsKey, setUserPluginsKey] = useState(0);
    const refreshUserPlugins = () => setUserPluginsKey(k => k + 1);
    const onRestartNeeded = (name: string) =>
        setPendingRestart(list => (list.includes(name) ? list : [...list, name]));

    const { mine, core } = useMemo(() => {
        const all = Object.values(Plugins).filter(isListed).sort((a, b) => a.name.localeCompare(b.name));
        return { mine: all.filter(p => !isCore(p)), core: all.filter(isCore) };
    }, []);

    const active = mine.filter(p => isPluginEnabled(p.name)).length;

    return (
        <SettingsTab>
            {pendingRestart.length > 0 && (
                <div className={cl("restart")}>
                    <div>
                        <Text variant="text-md/semibold">{t("plugins.restartTitle")}</Text>
                        <Forms.FormText>{t("plugins.restartText", { names: pendingRestart.join(", ") })}</Forms.FormText>
                    </div>
                    <Button size={Button.Sizes.SMALL} onClick={() => location.reload()}>
                        {t("plugins.restartButton")}
                    </Button>
                </div>
            )}

            <PresetPanel onUserPluginAdded={refreshUserPlugins} />

            <div className={cl("section-head")}>
                <Forms.FormTitle tag="h5">{t("plugins.section")}</Forms.FormTitle>
                {mine.length > 0 && (
                    <Text variant="text-sm/normal" className={cl("muted")}>
                        {t("plugins.summary", { active, total: mine.length })}
                    </Text>
                )}
            </div>

            {mine.length > 0
                ? (
                    <div className={cl("grid")}>
                        {mine.map(p => <LowPluginCard key={p.name} plugin={p} onRestartNeeded={onRestartNeeded} />)}
                    </div>
                )
                : <div className={cl("empty")}>{t("plugins.empty")}</div>}

            <UserPluginsSection refreshKey={userPluginsKey} onRestartNeeded={onRestartNeeded} onChanged={refreshUserPlugins} />

            <div className={cl("section-head", "core-head")}>
                <Forms.FormTitle tag="h5">{t("plugins.core")}</Forms.FormTitle>
                <Text variant="text-sm/normal" className={cl("muted")}>{t("plugins.coreHint")}</Text>
            </div>
            <div className={cl("grid", "grid-core")}>
                {core.map(p => <LowPluginCard key={p.name} plugin={p} onRestartNeeded={onRestartNeeded} />)}
            </div>
        </SettingsTab>
    );
}

export default wrapTab(LowPluginsSettings, "Plugins");
