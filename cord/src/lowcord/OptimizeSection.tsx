/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — section « Optimisation » de l'onglet low-cord : un interrupteur
// principal, le détail de chaque réglage, et la consommation de Discord en
// direct pour voir l'effet.

import { Forms } from "@lowcord/compat";
import { classNameFactory } from "@utils/css";
import { showToast, useEffect, useState } from "@webpack/common";

import { I18nKey, t } from "./i18n";
import { MODE_KEYS, OptimizeKey, RESTART_KEYS, setMode, setOptimize, trimMemory, trimMessageCache, useOptimize } from "./optimize";

const cl = classNameFactory("lc-opt-");

function Toggle({ on, onChange, label }: { on: boolean; onChange(v: boolean): void; label: string; }) {
    return (
        <button
            role="switch"
            aria-checked={on}
            aria-label={label}
            className={cl("switch", on && "switch-on")}
            onClick={() => onChange(!on)}
        >
            <span className={cl("knob")} />
        </button>
    );
}

const ITEMS: { key: OptimizeKey; gain: I18nKey; }[] = [
    { key: "background", gain: "opt.gain.cpuGpu" },
    { key: "animations", gain: "opt.gain.gpu" },
    { key: "gameMode", gain: "opt.gain.game" },
    { key: "cacheTrim", gain: "opt.gain.ram" },
    { key: "lightProcess", gain: "opt.gain.ram" },
    { key: "quietLogs", gain: "opt.gain.disk" },
    { key: "reducedMotion", gain: "opt.gain.cpu" },
];

/** Consommation de Discord (tous processus), rafraîchie toutes les 2 s. */
function LiveUsage() {
    const [usage, setUsage] = useState<{ memoryKB: number; cpuPercent: number; } | null>(null);

    useEffect(() => {
        if (IS_WEB || !VencordNative.native.getAppMetrics) return;
        let alive = true;
        const tick = () => VencordNative.native.getAppMetrics()
            .then(u => alive && setUsage(u))
            .catch(() => null);
        tick();
        const timer = setInterval(tick, 2000);
        return () => { alive = false; clearInterval(timer); };
    }, []);

    if (!usage) return null;

    const mb = Math.round(usage.memoryKB / 1024);
    const cpu = usage.cpuPercent < 10 ? usage.cpuPercent.toFixed(1) : Math.round(usage.cpuPercent);

    // Libération à la demande : même ménage que celui fait en arrière-plan.
    function trimNow() {
        const before = usage!.memoryKB;
        trimMessageCache();
        trimMemory();
        setTimeout(() => VencordNative.native.getAppMetrics().then(u => {
            setUsage(u);
            const freed = Math.round((before - u.memoryKB) / 1024);
            showToast({ text: freed > 0 ? t("opt.trimDone", { mb: freed }) : t("opt.trimNothing"), variant: "success" });
        }).catch(() => null), 1500);
    }

    return (
        <div className={cl("usage")}>
            <span className={cl("dot")} />
            {t("opt.usage", { mb, cpu })}
            <button className={cl("trim")} onClick={trimNow}>{t("opt.trimNow")}</button>
        </div>
    );
}

export function OptimizeSection() {
    const state = useOptimize();
    const modeOn = MODE_KEYS.every(k => state[k]);

    return (
        <section>
            <Forms.FormTitle tag="h5">{t("opt.title")}</Forms.FormTitle>
            <Forms.FormText className={cl("hint")}>{t("opt.hint")}</Forms.FormText>

            <div className={cl("card")}>
                <div className={cl("row", "main")}>
                    <div className={cl("text")}>
                        <div className={cl("name")}>{t("opt.mode")}</div>
                        <div className={cl("desc")}>{t("opt.modeDesc")}</div>
                    </div>
                    <Toggle on={modeOn} onChange={setMode} label={t("opt.mode")} />
                </div>

                {ITEMS.map(({ key, gain }) => (
                    <div key={key} className={cl("row")}>
                        <div className={cl("text")}>
                            <div className={cl("name")}>
                                {t(`opt.${key}` as I18nKey)}
                                <span className={cl("gain")}>{t(gain)}</span>
                                {!MODE_KEYS.includes(key) && <span className={cl("extra")}>{t("opt.extra")}</span>}
                                {RESTART_KEYS.includes(key) && <span className={cl("extra")}>{t("opt.restart")}</span>}
                            </div>
                            <div className={cl("desc")}>{t(`opt.${key}.desc` as I18nKey)}</div>
                        </div>
                        <Toggle on={state[key]} onChange={v => setOptimize(key, v)} label={t(`opt.${key}` as I18nKey)} />
                    </div>
                ))}

                <div className={cl("foot")}>
                    <LiveUsage />
                    <span className={cl("note")}>{t("opt.alreadyOn")}</span>
                </div>
            </div>
        </section>
    );
}
