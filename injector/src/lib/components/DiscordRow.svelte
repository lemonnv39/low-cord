<script lang="ts">
    import type { DiscordInstall, InstallProgressEvent, RowPhase } from "../types";

    let {
        install,
        needsUpdate,
        phase,
        onInstall,
        onUninstall,
        onConfirmUninstall,
        onCancelConfirm,
    }: {
        install: DiscordInstall;
        needsUpdate: boolean;
        phase: RowPhase;
        onInstall: () => void;
        onUninstall: () => void;
        onConfirmUninstall: () => void;
        onCancelConfirm: () => void;
    } = $props();

    const BRANCH_LABEL: Record<string, string> = {
        stable: "Discord",
        canary: "Discord Canary",
        ptb: "Discord PTB",
    };
    // Monochrome : trois nuances de gris distinctes pour différencier les tuiles
    // sans introduire de couleur (le libellé reste la source de vérité).
    const BRANCH_COLOR: Record<string, string> = {
        stable: "#f4f4f5",
        canary: "#a1a1aa",
        ptb: "#71717a",
    };

    const label = $derived(BRANCH_LABEL[install.branch] ?? install.branch);
    const color = $derived(BRANCH_COLOR[install.branch] ?? "#f4f4f5");

    const injected = $derived(install.patch_owner === "low_cord");
    const foreign = $derived(install.patch_owner === "foreign");
    const installing = $derived(phase.kind === "installing");
    // Discord s'est auto-mis à jour et a perdu low-cord (un ancien dossier l'avait).
    const needsReinject = $derived(install.needs_reinject);
    // "Version" de low-cord = SHA court de la build injectée.
    const shortSha = $derived(install.build_sha ? install.build_sha.slice(0, 7) : null);

    // Étapes d'installation → libellé court.
    const STEP: Record<InstallProgressEvent["step"], string> = {
        cleaning: "Suppression des anciens mods…",
        checking: "Vérification de l'environnement…",
        checked: "Environnement validé",
        installing: "Installation de low-cord…",
        installed: "Installation réussie",
        restarting: "Redémarrage de Discord…",
        finalizing: "Configuration des plugins…",
        ready: "Discord prêt",
    };

    // Progression approximative pour la barre (ordre des étapes).
    const STEP_PCT: Record<InstallProgressEvent["step"], number> = {
        cleaning: 15, checking: 30, checked: 45, installing: 62,
        installed: 78, restarting: 88, finalizing: 95, ready: 100,
    };
</script>

<div class="card" class:busy={installing}>
    <div class="tile" style={`--c:${color}`} aria-hidden="true">
        <svg viewBox="0 0 245 240" fill="currentColor" width="22" height="22">
            <path d="M104.4 103.9c-5.7 0-10.2 5-10.2 11.1s4.6 11.1 10.2 11.1c5.7 0 10.2-5 10.2-11.1.1-6.1-4.5-11.1-10.2-11.1zM140.9 103.9c-5.7 0-10.2 5-10.2 11.1s4.6 11.1 10.2 11.1c5.7 0 10.3-5 10.3-11.1s-4.6-11.1-10.3-11.1z" />
            <path d="M189.5 20h-134C44.2 20 35 29.2 35 40.6v135.2c0 11.4 9.2 20.6 20.5 20.6h113.4l-5.3-18.5 12.8 11.9 12.1 11.2 21.5 19V40.6c0-11.4-9.2-20.6-20.5-20.6zm-38.6 130.6s-3.6-4.3-6.6-8.1c13.1-3.7 18.1-11.9 18.1-11.9-4.1 2.7-8 4.6-11.5 5.9-5 2.1-9.8 3.5-14.5 4.3-9.6 1.8-18.4 1.3-25.9-.1-5.7-1.1-10.6-2.6-14.7-4.3-2.3-.9-4.8-2-7.3-3.4-.3-.2-.6-.3-.9-.5-.2-.1-.3-.2-.4-.3-1.8-1-2.8-1.7-2.8-1.7s4.8 8 17.5 11.8c-3 3.8-6.7 8.3-6.7 8.3-22.1-.7-30.5-15.2-30.5-15.2 0-32.2 14.4-58.3 14.4-58.3 14.4-10.8 28.1-10.5 28.1-10.5l1 1.2c-18 5.2-26.3 13.1-26.3 13.1s2.2-1.2 5.9-2.9c10.7-4.7 19.2-6 22.7-6.3.6-.1 1.1-.2 1.7-.2 6.1-.8 13-1 20.2-.2 9.5 1.1 19.7 3.9 30.1 9.6 0 0-7.9-7.5-24.9-12.7l1.4-1.6s13.7-.3 28.1 10.5c0 0 14.4 26.1 14.4 58.3z" />
        </svg>
    </div>

    <div class="body">
        <div class="name">{label}</div>

        {#if phase.kind === "installing"}
            <div class="status"><span class="spinner"></span>{STEP[phase.step]}</div>
        {:else if phase.kind === "error"}
            <div class="status status--err">Échec — {phase.message}</div>
        {:else if phase.kind === "confirm-uninstall"}
            <div class="status">Retirer low-cord de {label} ?</div>
        {:else if !install.installed}
            <div class="status status--dim">Non installé sur ce PC</div>
        {:else if injected && needsUpdate}
            <div class="status"><span class="dot dot--warn"></span>low-cord actif · mise à jour dispo{#if shortSha} · build {shortSha}{/if}</div>
        {:else if injected}
            <div class="status"><span class="dot dot--ok"></span>low-cord actif · à jour{#if shortSha} · build {shortSha}{/if}</div>
        {:else if needsReinject}
            <div class="status"><span class="dot dot--warn"></span>Discord mis à jour · low-cord à réappliquer</div>
        {:else if foreign}
            <div class="status"><span class="dot dot--warn"></span>Autre mod détecté{install.foreign_name ? ` (${install.foreign_name})` : ""}</div>
        {:else}
            <div class="status status--dim">Prêt à installer</div>
        {/if}

        {#if phase.kind === "installing"}
            <div class="bar"><div class="bar-fill" style={`width:${STEP_PCT[phase.step]}%`}></div></div>
        {/if}
    </div>

    <div class="action">
        {#if installing}
            <!-- pas de bouton pendant l'installation -->
        {:else if phase.kind === "confirm-uninstall"}
            <button class="btn btn--danger" onclick={onUninstall}>Retirer</button>
            <button class="btn btn--ghost" onclick={onCancelConfirm}>Annuler</button>
        {:else if !install.installed}
            <span class="tag">—</span>
        {:else if injected && needsUpdate}
            <button class="btn btn--primary" onclick={onInstall}>Mettre à jour</button>
        {:else if injected}
            <button class="btn btn--ghost" onclick={onConfirmUninstall}>Désinstaller</button>
        {:else if needsReinject}
            <button class="btn btn--primary" onclick={onInstall}>Réappliquer</button>
        {:else}
            <button class="btn btn--primary" onclick={onInstall}>Installer</button>
        {/if}
    </div>
</div>

<style>
    .card {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        padding: 12px 14px;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        transition: border-color var(--duration-fast) var(--ease-out),
            background var(--duration-fast) var(--ease-out),
            transform var(--duration-fast) var(--ease-out);
    }
    .card:hover {
        border-color: var(--border-strong);
        background: var(--surface-2);
    }
    .card.busy { border-color: var(--accent-line); }

    .tile {
        flex-shrink: 0;
        width: 40px;
        height: 40px;
        border-radius: 11px;
        display: grid;
        place-items: center;
        color: var(--c);
        background: color-mix(in srgb, var(--c) 16%, var(--surface-2));
        border: 1px solid color-mix(in srgb, var(--c) 30%, transparent);
    }

    .body {
        flex: 1;
        min-width: 0;
    }
    .name {
        font-size: 13.5px;
        font-weight: 650;
        color: var(--text);
    }
    .status {
        margin-top: 3px;
        font-size: 12px;
        color: var(--text-dim);
        display: flex;
        align-items: center;
        gap: 7px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .status--dim { color: var(--text-faint); }
    .status--err { color: var(--danger); }

    .dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        flex-shrink: 0;
    }
    .dot--ok { background: var(--ok); box-shadow: 0 0 8px color-mix(in srgb, var(--ok) 60%, transparent); }
    .dot--warn { background: var(--warning); box-shadow: 0 0 8px color-mix(in srgb, var(--warning) 60%, transparent); }

    .spinner {
        width: 12px;
        height: 12px;
        flex-shrink: 0;
        border-radius: 50%;
        border: 2px solid var(--accent-soft);
        border-top-color: var(--accent-hover);
        animation: spin 0.7s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .bar {
        margin-top: 8px;
        height: 3px;
        border-radius: 2px;
        background: rgba(255, 255, 255, 0.07);
        overflow: hidden;
    }
    .bar-fill {
        height: 100%;
        border-radius: 2px;
        background: linear-gradient(90deg, var(--accent), var(--accent-hover));
        transition: width var(--duration-base) var(--ease-out);
    }

    .action {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-shrink: 0;
    }

    .btn {
        border: 1px solid transparent;
        border-radius: var(--radius-sm);
        padding: 8px 14px;
        font-size: 12.5px;
        font-weight: 600;
        transition: background var(--duration-fast) var(--ease-out),
            border-color var(--duration-fast) var(--ease-out),
            transform var(--duration-fast) var(--ease-out);
    }
    .btn:active { transform: scale(0.96); }

    .btn--primary {
        background: var(--accent);
        color: var(--on-accent);
        box-shadow: 0 2px 14px var(--accent-glow);
    }
    .btn--primary:hover { background: var(--accent-hover); }

    .btn--ghost {
        background: rgba(255, 255, 255, 0.05);
        border-color: var(--border-strong);
        color: var(--text-dim);
    }
    .btn--ghost:hover { background: rgba(255, 255, 255, 0.1); color: var(--text); }

    /* Destructif : contour blanc (et non pleine surface) pour le distinguer
       nettement du bouton primaire plein, sans recourir à une couleur. */
    .btn--danger {
        background: transparent;
        border-color: var(--border-strong);
        color: var(--text);
    }
    .btn--danger:hover { background: #fff; border-color: #fff; color: #000; }

    .tag {
        font-size: 12px;
        color: var(--text-faint);
        padding: 0 6px;
    }
</style>
