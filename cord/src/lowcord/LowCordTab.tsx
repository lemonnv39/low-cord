/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — onglet général des réglages (build, langue, actions rapides).

import "./styles.css";

import { Divider } from "@components/Divider";
import { FolderIcon, GithubIcon, RestartIcon } from "@components/Icons";
import { QuickAction, QuickActionCard } from "@components/settings/QuickAction";
import { SettingsTab, wrapTab } from "@components/settings/tabs/BaseTab";
import { classNameFactory } from "@utils/css";
import { Margins } from "@utils/margins";
import { relaunch } from "@utils/native";
import { Forms } from "@webpack/common";

import gitHash from "~git-hash";

import { Banner } from "./Banner";
import { LOWCORD_REPO_URL } from "./constants";
import { LANGS, setLang, t, useLang } from "./i18n";
import { OptimizeSection } from "./OptimizeSection";

const cl = classNameFactory("lc-");

function LanguagePicker() {
    const lang = useLang();

    return (
        <div className={cl("segmented")} role="radiogroup" aria-label={t("tab.language")}>
            {LANGS.map(l => (
                <button
                    key={l.value}
                    role="radio"
                    aria-checked={lang === l.value}
                    className={cl("segment", { "segment-on": lang === l.value })}
                    onClick={() => setLang(l.value)}
                >
                    {l.label}
                </button>
            ))}
        </div>
    );
}

function LowCordSettings() {
    useLang();

    return (
        <SettingsTab>
            <Banner hash={gitHash} />

            <Divider className={Margins.top16} />

            <section className={Margins.top16}>
                <Forms.FormTitle tag="h5">{t("tab.language")}</Forms.FormTitle>
                <Forms.FormText className={Margins.bottom8} style={{ color: "var(--text-muted)" }}>
                    {t("tab.languageHint")}
                </Forms.FormText>
                <LanguagePicker />
            </section>

            <Divider className={Margins.top16} />

            <div className={Margins.top16}>
                <OptimizeSection />
            </div>

            <Divider className={Margins.top16} />

            <section className={Margins.top16}>
                <Forms.FormTitle tag="h5">{t("tab.quickActions")}</Forms.FormTitle>
                <QuickActionCard>
                    {!IS_WEB && (
                        <>
                            <QuickAction
                                Icon={RestartIcon}
                                text={t("tab.restart")}
                                action={relaunch}
                            />
                            <QuickAction
                                Icon={FolderIcon}
                                text={t("tab.settingsFolder")}
                                action={() => VencordNative.settings.openFolder()}
                            />
                        </>
                    )}
                    <QuickAction
                        Icon={GithubIcon}
                        text={t("tab.source")}
                        action={() => VencordNative.native.openExternal(LOWCORD_REPO_URL)}
                    />
                </QuickActionCard>
            </section>
        </SettingsTab>
    );
}

export default wrapTab(LowCordSettings, "low-cord");
