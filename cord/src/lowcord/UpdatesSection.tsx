/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — carte « Mises à jour » de l'onglet low-cord : état, vérifier,
// installer, voir ce qui arrive / les nouveautés de la version installée.

import * as DataStore from "@api/DataStore";
import { Forms } from "@lowcord/compat";
import { classNameFactory } from "@utils/css";
import { useEffect, useState } from "@webpack/common";

import { t, useLang } from "./i18n";
import { checkForUpdates, installAndRestart, PREV_KEY, timeAgo, useUpdateState } from "./update";
import { openWhatsNew } from "./WhatsNew";

const cl = classNameFactory("lc-upd-");

export function UpdatesSection() {
    useLang();
    const { status, checking, installing } = useUpdateState();
    const [, tick] = useState(0);

    useEffect(() => {
        if (!status) checkForUpdates();
        // « vérifié il y a X min » reste à jour.
        const id = setInterval(() => tick(n => n + 1), 30_000);
        return () => clearInterval(id);
    }, []);

    if (status && !status.enabled) {
        return (
            <section>
                <Forms.FormTitle tag="h5">{t("upd.section")}</Forms.FormTitle>
                <div className={cl("card")}>
                    <div className={cl("row")}>
                        <span className={cl("dot")} />
                        <div className={cl("text")}>{t("upd.devBuild")}</div>
                    </div>
                </div>
            </section>
        );
    }

    const ready = !!status?.ready;
    const state = installing ? "installing" : ready ? "ready" : checking && !status ? "checking" : status?.error ? "error" : "upToDate";
    const label = {
        installing: t("upd.installing"),
        ready: t("upd.stateReady"),
        checking: t("upd.checking"),
        error: t("upd.stateError"),
        upToDate: t("upd.upToDate"),
    }[state];

    const showLatestChanges = async () => {
        const prev = await DataStore.get<string>(PREV_KEY);
        openWhatsNew({ since: prev, to: status?.current, mode: "latest" });
    };

    return (
        <section>
            <Forms.FormTitle tag="h5">{t("upd.section")}</Forms.FormTitle>
            <div className={cl("card")}>
                <div className={cl("row")}>
                    <span className={cl("dot", `dot-${state}`)} />
                    <div className={cl("text")}>
                        <div className={cl("state")}>{label}</div>
                        <div className={cl("meta")}>
                            {status?.current && <span className={cl("chip")}>{t("upd.installedChip")} <b>{status.current.slice(0, 7)}</b></span>}
                            {ready && status?.latest && <span className={cl("chip", "chip-new")}>{t("upd.readyChip")} <b>{status.latest.slice(0, 7)}</b></span>}
                            {status?.checkedAt && <span>{t("upd.checked", { when: timeAgo(status.checkedAt) })}</span>}
                        </div>
                    </div>
                    <div className={cl("actions")}>
                        {ready ? (
                            <>
                                <button className={cl("btn")} onClick={() => openWhatsNew({ since: status!.current, to: status!.latest, mode: "upcoming" })}>
                                    {t("upd.seeUpcoming")}
                                </button>
                                <button className={cl("btn", "btn-primary")} disabled={installing} onClick={installAndRestart}>
                                    {t("upd.installNow")}
                                </button>
                            </>
                        ) : (
                            <button className={cl("btn")} disabled={checking} onClick={() => checkForUpdates(true)}>
                                {checking ? t("upd.checking") : t("upd.checkNow")}
                            </button>
                        )}
                    </div>
                </div>
                {state === "error" && status?.error && <div className={cl("error")}>{status.error}</div>}
                <div className={cl("foot")}>
                    <span>{t("upd.autoHint")}</span>
                    {status?.current && (
                        <button className={cl("link")} onClick={showLatestChanges}>{t("upd.seeLatest")}</button>
                    )}
                </div>
            </div>
        </section>
    );
}
