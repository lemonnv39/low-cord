/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — mises à jour automatiques (côté Discord). Le processus principal
// (src/main/lowcordUpdater.ts) vérifie et télécharge ; ici, dès qu'une
// version est prête, une flèche verte apparaît dans la zone temporaire de la
// barre du haut : un clic installe et redémarre Discord. Sans clic, la mise à
// jour s'installe à la prochaine fermeture de Discord.

import * as DataStore from "@api/DataStore";
import { HeaderBarIcon, hideTempHeaderButton, showTempHeaderButton } from "@lowcord/headerBar";
import { t, useLang } from "@lowcord/i18n";
import { openWhatsNew } from "@lowcord/WhatsNew";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { showToast } from "@webpack/common";

const logger = new Logger("LowCordUpdater");
const FIRST_CHECK = 20_000;
const EVERY = 30 * 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let firstTimer: ReturnType<typeof setTimeout> | null = null;
let announced: string | null = null;
let restarting = false;

function DownloadIcon() {
    return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--status-positive, #23a55a)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3v12" />
            <path d="m7 10 5 5 5-5" />
            <path d="M5 21h14" />
        </svg>
    );
}

function restart() {
    if (restarting) return;
    restarting = true;
    showToast({ text: t("upd.restarting") });
    VencordNative.lowcordUpdate.restart().catch(e => {
        restarting = false;
        logger.error("Redémarrage impossible", e);
        showToast({ text: t("upd.failed"), variant: "critical" });
    });
}

function UpdateButton() {
    useLang();
    return <HeaderBarIcon icon={DownloadIcon} tooltip={t("upd.tooltip")} onClick={restart} />;
}

async function check() {
    try {
        const status = await VencordNative.lowcordUpdate.check();
        if (!status.enabled) {
            stop();
            return;
        }
        if (status.error) logger.warn("Vérification :", status.error);
        if (!status.ready) {
            hideTempHeaderButton("LowCordUpdater");
            return;
        }
        showTempHeaderButton("LowCordUpdater", UpdateButton, 0);
        // Une seule notification par version.
        if (status.latest && announced !== status.latest) {
            announced = status.latest;
            showToast({ text: t("upd.ready"), variant: "success" });
        }
    } catch (e) {
        logger.error("Vérification impossible", e);
    }
}

// ── Quoi de neuf ─────────────────────────────────────────────────────────────
// Version vue la dernière fois : si celle installée est différente, c'est
// qu'une mise à jour vient d'être installée → on montre ce qui a changé.
const SEEN_KEY = "lowcord-last-seen-build";

async function showWhatsNew() {
    try {
        const last = await DataStore.get<string>(SEEN_KEY);
        const changes = await VencordNative.lowcordUpdate.changes(last);
        if (!changes.current || changes.current === last) return;
        // GitHub injoignable : on garde l'ancienne version vue, réessai au prochain démarrage.
        if (changes.error) return;
        // Première fois (pas de version vue) : rien à comparer, on retient juste la version.
        if (last) openWhatsNew(changes);
        await DataStore.set(SEEN_KEY, changes.current);
    } catch (e) {
        logger.error("Quoi de neuf impossible", e);
    }
}

function stop() {
    if (timer) clearInterval(timer);
    if (firstTimer) clearTimeout(firstTimer);
    timer = firstTimer = null;
}

export default definePlugin({
    name: "LowCordUpdater",
    description: "Downloads new low-cord versions automatically and installs them on restart",
    authors: [{ name: "shitday", id: 0n }],
    required: true,
    hidden: true,

    start() {
        // Laisse Discord finir de démarrer avant la première vérification.
        firstTimer = setTimeout(check, FIRST_CHECK);
        setTimeout(showWhatsNew, 5000);
        timer = setInterval(check, EVERY);
    },

    stop() {
        stop();
        hideTempHeaderButton("LowCordUpdater");
    },
});
