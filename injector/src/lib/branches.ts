import type { DiscordInstall, InstallProgressEvent } from "./types";

export const BRANCH_NAME: Record<string, string> = {
    stable: "discord",
    canary: "canary",
    ptb: "ptb",
};

/** Libellé d'une étape d'install (événement Rust "install-progress"). */
export const STEP_LABEL: Record<InstallProgressEvent["step"], string> = {
    cleaning: "nettoyage des anciens mods",
    checking: "vérification de l'environnement",
    checked: "environnement ok",
    installing: "téléchargement + injection de low-cord",
    installed: "low-cord injecté",
    restarting: "redémarrage de discord",
    finalizing: "configuration des plugins",
    ready: "discord prêt",
};

/** Avancement approximatif (ordre des étapes) pour la barre ASCII. */
export const STEP_PCT: Record<InstallProgressEvent["step"], number> = {
    cleaning: 12, checking: 28, checked: 40, installing: 60,
    installed: 78, restarting: 90, finalizing: 96, ready: 100,
};

export type BranchState = "absent" | "ready" | "foreign" | "active" | "outdated" | "reinject";

export function branchState(install: DiscordInstall, latestSha: string | null): BranchState {
    if (!install.installed) return "absent";
    if (install.needs_reinject) return "reinject";
    if (install.patch_owner === "foreign") return "foreign";
    if (install.patch_owner === "low_cord") {
        if (install.build_sha && latestSha && install.build_sha !== latestSha) return "outdated";
        return "active";
    }
    return "ready";
}

/** Tag court affiché dans la sidebar. */
export const STATE_TAG: Record<BranchState, { text: string; cls: string }> = {
    absent: { text: "--", cls: "dim" },
    ready: { text: "prêt", cls: "dim" },
    foreign: { text: "mod", cls: "warn" },
    active: { text: "ok", cls: "ok" },
    outdated: { text: "maj", cls: "info" },
    reinject: { text: "!", cls: "warn" },
};

export function asciiBar(pct: number, width = 24): string {
    const filled = Math.round((pct / 100) * width);
    return "#".repeat(filled) + "-".repeat(width - filled);
}
