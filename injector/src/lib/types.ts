// Miroir des structs Rust exposées par src-tauri (voir discord.rs / settings.rs).
// Les noms de champs restent en snake_case : Tauri ne les convertit PAS pour
// les objets sérialisés en retour de commande (seuls les *arguments* passés
// à `invoke()` sont convertis camelCase -> snake_case).

export type PatchOwner = "none" | "low_cord" | "foreign";

export interface DiscordInstall {
    id: string;
    branch: "stable" | "canary" | "ptb";
    installed: boolean;
    base_path: string | null;
    resources_path: string | null;
    version: string | null;
    patch_owner: PatchOwner;
    build_sha: string | null;
    foreign_name: string | null;
    needs_reinject: boolean;
}

export interface InjectorSettings {
    repo_path?: string | null;
}

/// Miroir de patcher::FixResult (voir fix_lowcord).
export interface FixResult {
    branch: string;
    was_broken: boolean;
    fixed: boolean;
    message?: string | null;
}

/// Miroir de patcher::UpdateResult (voir update_lowcord_build).
export interface UpdateResult {
    branch: string;
    updated: boolean;
    message?: string | null;
}

/// Miroir de l'événement Tauri "install-progress" (voir patcher.rs).
export interface InstallProgressEvent {
    branch: string;
    step: "cleaning" | "checking" | "checked" | "installing" | "installed" | "restarting" | "finalizing" | "ready";
    status: "ok" | "error";
    message?: string | null;
}

/// Miroir de l'événement Tauri "install-log" (voir log.rs) : une opération
/// réelle faite sur le Discord de l'utilisateur.
export type LogKind = "info" | "ok" | "warn" | "err" | "add" | "del" | "mod" | "proc" | "net";

export interface InstallLogEvent {
    branch: string;
    kind: LogKind;
    message: string;
    ts: number;
}

/// État d'affichage d'une branche Discord, piloté depuis App.svelte et rendu
/// par BranchPanel.svelte.
export type RowPhase =
    | { kind: "idle" }
    | { kind: "installing"; step: InstallProgressEvent["step"] }
    | { kind: "uninstalling" }
    | { kind: "error"; message: string }
    | { kind: "confirm-uninstall" };
