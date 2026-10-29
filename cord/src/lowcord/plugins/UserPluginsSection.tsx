/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — plugins perso : avertissement, liste des fichiers du dossier
// userplugins, activation (au prochain redémarrage), suppression.

import { hasAnyVisibleSettings } from "@api/PluginManager";
import { CogWheel, DeleteIcon, FolderIcon } from "@components/Icons";
import { I18nKey, t, useLang } from "@lowcord/i18n";
import {
    acceptWarning, getEnabledUserPlugins, isSafeMode, isWarningAccepted, leaveSafeMode,
    setUserPluginEnabled, userPluginState
} from "@lowcord/userPlugins";
import type { UserPluginMeta } from "@main/userPlugins";
import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import { Alerts, Forms, showToast, Text, useEffect, useState } from "@webpack/common";

import Plugins from "~plugins";

import { openLowPluginModal } from "./LowPluginModal";

const cl = classNameFactory("lc-up-");
const logger = new Logger("low-cord", "#d0d0d0");

function Warning() {
    return (
        <div className={cl("warning")}>
            <Text variant="text-md/semibold" className={cl("warning-title")}>{t("userPlugins.warnTitle")}</Text>
            <ul className={cl("warning-list")}>
                <li>{t("userPlugins.warnStability")}</li>
                <li>{t("userPlugins.warnMalware")}</li>
                <li>{t("userPlugins.warnTrust")}</li>
            </ul>
        </div>
    );
}

/** Affiche l'avertissement (à chaque ajout) puis ouvre le sélecteur de fichier. */
export function addUserPlugin(onDone: () => void) {
    const pick = async () => {
        try {
            const meta = await VencordNative.userPlugins.pick(t("userPlugins.add"));
            if (!meta) return;
            showToast({ text: t("userPlugins.added", { name: meta.name }), variant: "success" });
            onDone();
        } catch (e) {
            const code = String((e as Error)?.message ?? e);
            const reason = ["missing-name", "bad-name", "too-big", "bad-file"].find(c => code.includes(c));
            logger.error("Import du plugin perso impossible", e);
            showToast({ text: t(reason ? `userPlugins.err.${reason}` as I18nKey : "userPlugins.err.generic"), variant: "critical" });
        }
    };

    // Avertissement à CHAQUE ajout : c'est le moment où le risque se prend.
    Alerts.show({
        title: t("userPlugins.warnModalTitle"),
        body: <Warning />,
        confirmText: t("userPlugins.accept"),
        cancelText: t("preset.cancel"),
        onConfirm() {
            acceptWarning();
            pick();
        },
    });
}

function Toggle({ on, onChange, label }: { on: boolean; onChange(v: boolean): void; label: string; }) {
    return (
        // Même interrupteur que la section Optimisation de l'onglet low-cord.
        <button role="switch" aria-checked={on} aria-label={label} className={`lc-opt-switch${on ? " lc-opt-switch-on" : ""}`} onClick={() => onChange(!on)}>
            <span className="lc-opt-knob" />
        </button>
    );
}

function Row({ meta, onRestartNeeded, onDeleted }: { meta: UserPluginMeta; onRestartNeeded(name: string): void; onDeleted(): void; }) {
    const [enabled, setEnabled] = useState(getEnabledUserPlugins().includes(meta.file));
    const loadedName = userPluginState.loaded.get(meta.file);
    const loaded = loadedName ? Plugins[loadedName] : undefined;
    const failed = userPluginState.failed.get(meta.file);
    const label = meta.name || meta.file;

    function toggle(v: boolean) {
        setUserPluginEnabled(meta.file, v);
        setEnabled(v);
        onRestartNeeded(label);
    }

    function remove() {
        Alerts.show({
            title: t("userPlugins.deleteTitle", { name: label }),
            body: t("userPlugins.deleteBody"),
            confirmText: t("userPlugins.delete"),
            cancelText: t("preset.cancel"),
            confirmColor: "red",
            async onConfirm() {
                try {
                    await VencordNative.userPlugins.delete(meta.file);
                    if (getEnabledUserPlugins().includes(meta.file)) {
                        setUserPluginEnabled(meta.file, false);
                        onRestartNeeded(label);
                    }
                    onDeleted();
                } catch (e) {
                    logger.error(e);
                    showToast({ text: t("userPlugins.err.generic"), variant: "critical" });
                }
            },
        });
    }

    const status = meta.error
        ? t(`userPlugins.err.${meta.error}` as I18nKey)
        : failed
            ? t("userPlugins.loadFailed", { reason: failed })
            : enabled && !loaded ? t("userPlugins.pendingRestart") : null;

    return (
        <div className={cl("row")}>
            <div className={cl("main")}>
                <div className={cl("name")}>
                    {label}
                    {meta.version && <span className={cl("tag")}>v{meta.version}</span>}
                    {meta.author && <span className={cl("muted")}>{t("userPlugins.by", { author: meta.author })}</span>}
                </div>
                {meta.description && <div className={cl("desc")}>{meta.description}</div>}
                <div className={cl("file")}>
                    {meta.file}
                    {status && <span className={cl("status", (meta.error || failed) && "status-err")}>{status}</span>}
                </div>
            </div>
            <div className={cl("actions")}>
                {loaded && hasAnyVisibleSettings(loaded) && (
                    <button className={cl("icon")} title={t("plugins.settings")} onClick={() => openLowPluginModal(loaded, onRestartNeeded)}>
                        <CogWheel width={18} height={18} />
                    </button>
                )}
                <button className={cl("icon", "icon-danger")} title={t("userPlugins.delete")} onClick={remove}>
                    <DeleteIcon width={18} height={18} />
                </button>
                <Toggle on={enabled} onChange={toggle} label={label} />
            </div>
        </div>
    );
}

export function UserPluginsSection({ refreshKey, onRestartNeeded, onChanged }: {
    refreshKey: number;
    onRestartNeeded(name: string): void;
    onChanged(): void;
}) {
    useLang();
    const [list, setList] = useState<UserPluginMeta[] | null>(null);
    const [safeMode, setSafeMode] = useState(isSafeMode());

    useEffect(() => {
        VencordNative.userPlugins.list().then(setList).catch(e => {
            logger.error(e);
            setList([]);
        });
    }, [refreshKey]);

    if (IS_WEB || !list) return null;
    // Rien à montrer tant que l'utilisateur n'a jamais ouvert la porte.
    if (!list.length && !isWarningAccepted() && !safeMode) return null;

    return (
        <section className={cl("section")}>
            <div className="lc-section-head lc-core-head">
                <Forms.FormTitle tag="h5">{t("userPlugins.title")}</Forms.FormTitle>
                <button className={cl("link")} onClick={() => VencordNative.userPlugins.openFolder()}>
                    <FolderIcon width={14} height={14} /> {t("userPlugins.openFolder")}
                </button>
            </div>

            {safeMode && (
                <div className={cl("safe")}>
                    <div>
                        <Text variant="text-md/semibold">{t("userPlugins.safeTitle")}</Text>
                        <Forms.FormText>{t("userPlugins.safeText")}</Forms.FormText>
                    </div>
                    <button
                        className={cl("btn")}
                        onClick={() => {
                            leaveSafeMode();
                            setSafeMode(false);
                            onRestartNeeded(t("userPlugins.title"));
                        }}
                    >
                        {t("userPlugins.safeLeave")}
                    </button>
                </div>
            )}

            <Warning />

            {list.length
                ? <div className={cl("list")}>{list.map(m => <Row key={m.file} meta={m} onRestartNeeded={onRestartNeeded} onDeleted={onChanged} />)}</div>
                : <div className="lc-empty">{t("userPlugins.empty")}</div>}
        </section>
    );
}
