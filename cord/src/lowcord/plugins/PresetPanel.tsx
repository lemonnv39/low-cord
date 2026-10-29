/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — panneau au-dessus de la liste des plugins : exporter / importer
// un préréglage, ajouter un plugin perso.

import { BackupRestoreIcon, PlusIcon, UploadIcon } from "@components/Icons";
import { QuickAction, QuickActionCard } from "@components/settings/QuickAction";
import { t } from "@lowcord/i18n";
import { exportPreset, pickPresetFile, planPreset } from "@lowcord/presets";
import { Logger } from "@utils/Logger";
import { Alerts, showToast } from "@webpack/common";

import { addUserPlugin } from "./UserPluginsSection";

const logger = new Logger("low-cord", "#d0d0d0");

async function onExport() {
    try {
        await exportPreset();
    } catch (e) {
        logger.error("Export du préréglage impossible", e);
        showToast({ text: t("preset.exportFailed"), variant: "critical" });
    }
}

async function onImport() {
    let raw: string | null;
    try {
        raw = await pickPresetFile();
    } catch (e) {
        logger.error(e);
        return;
    }
    if (!raw) return;

    let plan: ReturnType<typeof planPreset>;
    try {
        plan = planPreset(raw);
    } catch (e) {
        showToast({ text: t("preset.invalid"), variant: "critical" });
        return;
    }

    const on = plan.toggled.filter(p => p.enabled).map(p => p.name);
    const off = plan.toggled.filter(p => !p.enabled).map(p => p.name);
    const nothing = !on.length && !off.length && !plan.tuned.length;

    Alerts.show({
        title: t("preset.importTitle"),
        body: (
            <div className="lc-preset-plan">
                {nothing && <p>{t("preset.nothing")}</p>}
                {on.length > 0 && <p><b>{t("preset.willEnable")}</b> {on.join(", ")}</p>}
                {off.length > 0 && <p><b>{t("preset.willDisable")}</b> {off.join(", ")}</p>}
                {plan.tuned.length > 0 && <p><b>{t("preset.willTune")}</b> {plan.tuned.join(", ")}</p>}
                {plan.ignored.length > 0 && <p className="lc-muted">{t("preset.ignored", { names: plan.ignored.join(", ") })}</p>}
                {plan.needsRestart && <p className="lc-muted">{t("preset.restartNote")}</p>}
            </div>
        ),
        confirmText: t(plan.needsRestart ? "preset.applyRestart" : "preset.apply"),
        cancelText: t("preset.cancel"),
        onConfirm() {
            try {
                plan.apply();
            } catch (e) {
                logger.error("Application du préréglage impossible", e);
                showToast({ text: t("preset.applyFailed"), variant: "critical" });
                return;
            }
            if (plan.needsRestart) {
                showToast({ text: t("preset.restarting"), variant: "success" });
                // Laisse le temps aux réglages d'être enregistrés sur le disque.
                setTimeout(() => location.reload(), 1200);
            } else {
                showToast({ text: t("preset.applied"), variant: "success" });
            }
        },
    });
}

export function PresetPanel({ onUserPluginAdded }: { onUserPluginAdded(): void; }) {
    return (
        <section className="lc-preset-panel">
            <QuickActionCard>
                <QuickAction Icon={UploadIcon} text={t("preset.export")} action={onExport} />
                <QuickAction Icon={BackupRestoreIcon} text={t("preset.import")} action={onImport} />
                {!IS_WEB && <QuickAction Icon={PlusIcon} text={t("userPlugins.add")} action={() => addUserPlugin(onUserPluginAdded)} />}
            </QuickActionCard>
        </section>
    );
}
