/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — onglet Plugins. En-tête (titre, compteurs), puis une barre :
// filtres par catégorie (Vocal, Messages, Outils…) à gauche, recherche à droite.
// Deux blocs : nos plugins (activables) et le cœur (toujours actif, discret).

import "@lowcord/styles.css";

import { isPluginEnabled } from "@api/PluginManager";
import { useSettings } from "@api/Settings";
import { SettingsTab, wrapTab } from "@components/settings/tabs/BaseTab";
import { Button, Forms, Text } from "@lowcord/compat";
import { pluginDescription, t, useLang } from "@lowcord/i18n";
import { classNameFactory } from "@utils/css";
import { Plugin } from "@utils/types";
import { useMemo, useState } from "@webpack/common";

import Plugins, { PluginMeta } from "~plugins";

import { CATEGORIES, type Category, categoryOf } from "./categories";
import { LowPluginCard } from "./LowPluginCard";
import { PresetPanel } from "./PresetPanel";
import { UserPluginsSection } from "./UserPluginsSection";

const cl = classNameFactory("lc-");

const isCore = (p: Plugin) => p.required || PluginMeta[p.name]?.folderName.startsWith("_core/");
// Les plugins *API sont des briques internes, activées automatiquement par dépendance.
// Les plugins perso ont leur propre section (activation au redémarrage).
const isListed = (p: Plugin) => !p.hidden && !p.name.endsWith("API") && !PluginMeta[p.name]?.userPlugin;

// Recherche sans tenir compte des majuscules ni des accents (« deco » trouve « déco »).
const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const matches = (p: Plugin, q: string) => !q || fold(`${p.name} ${pluginDescription(p)}`).includes(q);

function PuzzleIcon() {
    return (
        <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M10 2a3 3 0 0 0-3 3v1H4a2 2 0 0 0-2 2v3h1.5a2.5 2.5 0 0 1 0 5H2v3a2 2 0 0 0 2 2h3v-1.5a2.5 2.5 0 0 1 5 0V22h3a2 2 0 0 0 2-2v-3h1a3 3 0 1 0 0-6h-1V8a2 2 0 0 0-2-2h-3V5a3 3 0 0 0-3-3Z" />
        </svg>
    );
}

function SearchIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
        </svg>
    );
}

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

    const [query, setQuery] = useState("");
    const [category, setCategory] = useState<Category | "all">("all");
    const q = fold(query.trim());
    const inCategory = (p: Plugin) => category === "all" || categoryOf(p.name) === category;
    const shownMine = mine.filter(p => inCategory(p) && matches(p, q));
    // Le cœur n'appartient à aucune catégorie : visible seulement avec « Tous ».
    const shownCore = category === "all" ? core.filter(p => matches(p, q)) : [];
    // Catégories présentes (avec leur nombre de plugins), « Autres » seulement s'il sert.
    const counts = CATEGORIES.map(c => ({ ...c, count: mine.filter(p => categoryOf(p.name) === c.id).length })).filter(c => c.count > 0);

    return (
        <SettingsTab>
            <div className={cl("plugins-header")}>
                <div className={cl("plugins-header-icon")}><PuzzleIcon /></div>
                <div className={cl("plugins-header-text")}>
                    <h2 className={cl("plugins-header-title")}>{t("plugins.title")}</h2>
                    <span className={cl("plugins-header-sub")}>{t("plugins.subtitle")}</span>
                </div>
                <div className={cl("plugins-header-stats")}>
                    <div><b>{active}</b><span>{t("plugins.statActive")}</span></div>
                    <div><b>{mine.length}</b><span>{t("plugins.statTotal")}</span></div>
                </div>
            </div>

            <div className={cl("plugins-toolbar")}>
                {/* Filtres par catégorie */}
                <div className={cl("plugins-cats")} role="radiogroup" aria-label={t("plugins.cat.label")}>
                    <button
                        role="radio"
                        aria-checked={category === "all"}
                        className={cl("plugins-cat", category === "all" && "plugins-cat-on")}
                        onClick={() => setCategory("all")}
                        title={t("plugins.cat.count", { count: mine.length })}
                    >
                        {t("plugins.cat.all")}
                    </button>
                    {counts.map(c => (
                        <button
                            key={c.id}
                            role="radio"
                            aria-checked={category === c.id}
                            className={cl("plugins-cat", category === c.id && "plugins-cat-on")}
                            onClick={() => setCategory(category === c.id ? "all" : c.id)}
                            title={t("plugins.cat.count", { count: c.count })}
                        >
                            {t(c.label)}
                        </button>
                    ))}
                </div>

                {/* Recherche, collée à droite */}
                <div className={cl("plugins-search")}>
                    <SearchIcon />
                    <input
                        value={query}
                        onChange={e => setQuery(e.currentTarget.value)}
                        onKeyDown={e => { if (e.key === "Escape") setQuery(""); }}
                        placeholder={t("plugins.search")}
                        aria-label={t("plugins.search")}
                        spellCheck={false}
                    />
                    {query && (
                        <button className={cl("plugins-search-clear")} onClick={() => setQuery("")} aria-label={t("plugins.clearSearch")} title={t("plugins.clearSearch")}>×</button>
                    )}
                </div>
            </div>

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
                {(q || category !== "all") && mine.length > 0 && (
                    <Text variant="text-sm/normal" className={cl("muted")}>
                        {t("plugins.results", { count: shownMine.length })}
                    </Text>
                )}
            </div>

            {mine.length === 0
                ? <div className={cl("empty")}>{t("plugins.empty")}</div>
                : shownMine.length > 0
                    ? (
                        <div className={cl("grid")}>
                            {shownMine.map(p => <LowPluginCard key={p.name} plugin={p} onRestartNeeded={onRestartNeeded} />)}
                        </div>
                    )
                    : <div className={cl("empty")}>{q ? t("plugins.noMatch", { query: query.trim() }) : t("plugins.noMatchCat")}</div>}

            <UserPluginsSection refreshKey={userPluginsKey} onRestartNeeded={onRestartNeeded} onChanged={refreshUserPlugins} />

            {shownCore.length > 0 && (
                <>
                    <div className={cl("section-head", "core-head")}>
                        <Forms.FormTitle tag="h5">{t("plugins.core")}</Forms.FormTitle>
                        <Text variant="text-sm/normal" className={cl("muted")}>{t("plugins.coreHint")}</Text>
                    </div>
                    <div className={cl("grid", "grid-core")}>
                        {shownCore.map(p => <LowPluginCard key={p.name} plugin={p} onRestartNeeded={onRestartNeeded} />)}
                    </div>
                </>
            )}
        </SettingsTab>
    );
}

export default wrapTab(LowPluginsSettings, "Plugins");
