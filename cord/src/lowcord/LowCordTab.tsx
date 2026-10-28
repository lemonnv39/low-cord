/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — onglet général des réglages (infos de build + actions rapides).

import { Divider } from "@components/Divider";
import { FolderIcon, GithubIcon, RestartIcon } from "@components/Icons";
import { QuickAction, QuickActionCard } from "@components/settings/QuickAction";
import { SettingsTab, wrapTab } from "@components/settings/tabs/BaseTab";
import { Margins } from "@utils/margins";
import { relaunch } from "@utils/native";
import { Forms } from "@webpack/common";

import gitHash from "~git-hash";

import { LOWCORD_NAME, LOWCORD_REPO_URL } from "./constants";

function LowCordSettings() {
    return (
        <SettingsTab>
            <section>
                <Forms.FormTitle tag="h5">{LOWCORD_NAME}</Forms.FormTitle>
                <Forms.FormText className={Margins.bottom8}>
                    Build <code>{gitHash}</code> · basé sur Vencord {VERSION}
                </Forms.FormText>
                <Forms.FormText style={{ color: "var(--text-muted)" }}>
                    Projet open source : tout le code est public. Les mises à jour passent par l'injecteur low-cord.
                </Forms.FormText>
            </section>

            <Divider className={Margins.top16} />

            <section className={Margins.top16}>
                <Forms.FormTitle tag="h5">Actions rapides</Forms.FormTitle>
                <QuickActionCard>
                    {!IS_WEB && (
                        <>
                            <QuickAction
                                Icon={RestartIcon}
                                text="Redémarrer Discord"
                                action={relaunch}
                            />
                            <QuickAction
                                Icon={FolderIcon}
                                text="Dossier des réglages"
                                action={() => VencordNative.settings.openFolder()}
                            />
                        </>
                    )}
                    <QuickAction
                        Icon={GithubIcon}
                        text="Code source"
                        action={() => VencordNative.native.openExternal(LOWCORD_REPO_URL)}
                    />
                </QuickActionCard>
            </section>
        </SettingsTab>
    );
}

export default wrapTab(LowCordSettings, "low-cord");
