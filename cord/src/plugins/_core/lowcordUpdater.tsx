/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-cord — mises à jour automatiques (côté Discord). Le processus principal
// (src/main/lowcordUpdater.ts) vérifie dès le lancement et télécharge ; ici,
// dès qu'une version est prête, une flèche verte apparaît dans la zone
// temporaire de la barre du haut : clic = installer et redémarrer Discord,
// clic droit = voir ce qui arrive. Sans clic, la mise à jour s'installe à la
// prochaine fermeture de Discord.

import * as DataStore from "@api/DataStore";
import { HeaderBarIcon, hideTempHeaderButton, showTempHeaderButton } from "@lowcord/headerBar";
import { t, useLang } from "@lowcord/i18n";
import { checkForUpdates, installAndRestart, PREV_KEY, SEEN_KEY, useUpdateState } from "@lowcord/update";
import { openWhatsNew } from "@lowcord/WhatsNew";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { showToast } from "@webpack/common";

const logger = new Logger("LowCordUpdater");
/** Vérification régulière côté fenêtre (le processus principal en fait aussi). */
const EVERY = 10 * 60_000;
/** Retour sur Discord : nouvelle vérification si la dernière date d'au moins ça. */
const ON_FOCUS = 3 * 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let whatsNewTimer: ReturnType<typeof setTimeout> | null = null;
let announced: string | null = null;
let lastCheck = 0;

function DownloadIcon() {
    return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--status-positive, #23a55a)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3v12" />
            <path d="m7 10 5 5 5-5" />
            <path d="M5 21h14" />
        </svg>
    );
}

function InstallingIcon() {
    return (
        <svg className="lc-upd-spin" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--status-positive, #23a55a)" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-6.2-8.56" />
        </svg>
    );
}

function UpdateButton() {
    useLang();
    const { installing, status } = useUpdateState();
    return (
        <div
            style={{ display: "contents" }}
            onContextMenu={e => {
                e.preventDefault();
                if (status?.latest) openWhatsNew({ since: status.current, to: status.latest, mode: "upcoming" });
            }}
        >
            <HeaderBarIcon
                icon={installing ? InstallingIcon : DownloadIcon}
                tooltip={t(installing ? "upd.installing" : "upd.tooltip")}
                onClick={installAndRestart}
            />
        </div>
    );
}

async function check() {
    lastCheck = Date.now();
    const status = await checkForUpdates();
    if (!status) return;
    if (!status.enabled) {
        stop();
        return;
    }
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
}

function onFocus() {
    if (Date.now() - lastCheck > ON_FOCUS) check();
}

// ── Quoi de neuf ─────────────────────────────────────────────────────────────
// Version vue la dernière fois : si celle installée est différente, c'est
// qu'une mise à jour vient d'être installée → on montre ce qui a changé.
async function showWhatsNew() {
    try {
        const last = await DataStore.get<string>(SEEN_KEY);
        const status = await checkForUpdates();
        const current = status?.current;
        if (!current || current === last) return;
        // Première fois (pas de version vue) : rien à comparer, on retient juste la version.
        if (!last) return void await DataStore.set(SEEN_KEY, current);
        // GitHub injoignable : on garde l'ancienne version vue, réessai au prochain démarrage.
        const opened = await openWhatsNew({ since: last, to: current, mode: "installed", onlyIfContent: true });
        if (opened === "error") return;
        await DataStore.setMany([[SEEN_KEY, current], [PREV_KEY, last]]);
    } catch (e) {
        logger.error("Quoi de neuf impossible", e);
    }
}

function stop() {
    if (timer) clearInterval(timer);
    if (whatsNewTimer) clearTimeout(whatsNewTimer);
    timer = whatsNewTimer = null;
    window.removeEventListener("focus", onFocus);
}

export default definePlugin({
    name: "LowCordUpdater",
    description: "Downloads new low-cord versions automatically and installs them on restart",
    authors: [],
    required: true,
    hidden: true,

    start() {
        // Tout de suite : le processus principal a déjà commencé à vérifier au
        // lancement de Discord, la réponse arrive dès que la version est prête.
        check();
        timer = setInterval(check, EVERY);
        window.addEventListener("focus", onFocus);
        // Laisse l'interface de Discord s'afficher avant la fenêtre.
        whatsNewTimer = setTimeout(showWhatsNew, 3000);
    },

    stop() {
        stop();
        hideTempHeaderButton("LowCordUpdater");
    },
});
