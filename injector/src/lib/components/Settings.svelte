<script lang="ts">
    import { onMount } from "svelte";
    import { getVersion } from "@tauri-apps/api/app";
    import { patcherApi } from "../api/patcher";
    import type { FixResult } from "../types";
    import type { InjectorUpdate } from "../api/updater";
    import UpdateBanner from "./UpdateBanner.svelte";

    let {
        pendingUpdate,
        installingUpdate,
        onCheckInjectorUpdate,
        onInstallInjectorUpdate,
    }: {
        pendingUpdate: InjectorUpdate | null;
        installingUpdate: boolean;
        onCheckInjectorUpdate: () => Promise<"found" | "none">;
        onInstallInjectorUpdate: () => void;
    } = $props();

    let appVersion = $state("");

    let fixing = $state(false);
    let checkingInjector = $state(false);
    let resultMessage = $state<string | null>(null);
    let resultIsError = $state(false);

    onMount(() => {
        getVersion().then(v => (appVersion = v));
    });

    function report(message: string, isError = false) {
        resultMessage = message;
        resultIsError = isError;
    }

    async function handleCheckInjectorUpdate() {
        resultMessage = null;
        checkingInjector = true;
        try {
            const outcome = await onCheckInjectorUpdate();
            if (outcome === "none") report("low-cord Injecteur est déjà à jour.");
        } catch (e) {
            report(String(e), true);
        } finally {
            checkingInjector = false;
        }
    }

    const BRANCH_LABEL: Record<string, string> = {
        stable: "Discord",
        canary: "Canary",
        ptb: "PTB",
    };
    const labelOf = (b: string) => BRANCH_LABEL[b] ?? b;

    function summarizeFix(results: FixResult[]): string {
        if (results.length === 0) return "Aucune install low-cord détectée — rien à réparer.";
        const fixed = results.filter(r => r.fixed);
        const failed = results.filter(r => !r.fixed);
        if (failed.length > 0) {
            return `Échec sur ${failed.map(r => labelOf(r.branch)).join(", ")} : ${failed[0].message ?? "erreur inconnue"}`;
        }
        return `low-cord réinstallé proprement : ${fixed.map(r => labelOf(r.branch)).join(", ")} — Discord redémarre.`;
    }

    async function handleFix() {
        resultMessage = null;
        fixing = true;
        try {
            const results = await patcherApi.fixLowCord();
            const failed = results.some(r => r.was_broken && !r.fixed);
            report(summarizeFix(results), failed);
        } catch (e) {
            report(String(e), true);
        } finally {
            fixing = false;
        }
    }
</script>

<div class="settings">
    <div class="card">
        <div class="card-title">Réparation</div>
        <div class="card-subtitle">Vérifie les fichiers injectés et réinstalle automatiquement ce qui est cassé.</div>
        <div class="card-actions">
            <button class="btn btn--primary" disabled={fixing} onclick={handleFix}>
                {fixing ? "Vérification…" : "Réparer low-cord"}
            </button>
        </div>
    </div>

    {#if resultMessage}
        <p class="hint" class:hint--error={resultIsError}>{resultMessage}</p>
    {/if}

    {#if pendingUpdate}
        <UpdateBanner
            version={pendingUpdate.version}
            installing={installingUpdate}
            onInstall={onInstallInjectorUpdate}
        />
    {/if}

    <div class="card">
        <div class="card-title">low-cord Injecteur</div>
        <div class="card-subtitle">Version {appVersion || "…"}</div>
        <div class="card-actions">
            <button class="btn" disabled={checkingInjector || !!pendingUpdate} onclick={handleCheckInjectorUpdate}>
                {checkingInjector ? "Vérification…" : "Vérifier les mises à jour"}
            </button>
        </div>
        <div class="credit">Développé par mxxq</div>
    </div>
</div>

<style>
    .settings {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        height: 100%;
        padding: 56px 26px 20px;
        box-sizing: border-box;
        overflow-y: auto;
    }

    .card {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        padding: var(--space-4);
        transition: border-color var(--duration-fast) var(--ease-out);
    }
    .card:hover { border-color: var(--border-strong); }

    .card-title {
        font-size: 13.5px;
        font-weight: 650;
        color: var(--text);
    }

    .card-subtitle {
        font-size: 12px;
        color: var(--text-dim);
        margin-top: 3px;
        line-height: 1.45;
    }

    .credit {
        font-size: 11px;
        color: var(--text-faint);
        margin-top: var(--space-3);
    }

    .card-actions {
        display: flex;
        gap: var(--space-2);
        margin-top: var(--space-4);
        flex-wrap: wrap;
    }

    .btn {
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid var(--border-strong);
        color: var(--text);
        padding: 9px 16px;
        border-radius: var(--radius-sm);
        font-size: 12.5px;
        font-weight: 600;
        transition: background var(--duration-fast) var(--ease-out),
            border-color var(--duration-fast) var(--ease-out),
            transform var(--duration-fast) var(--ease-out);
    }
    .btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.1); border-color: var(--border-strong); }
    .btn:active:not(:disabled) { transform: scale(0.97); }
    .btn:disabled { opacity: 0.5; cursor: default; }

    .btn--primary {
        background: var(--accent);
        border-color: transparent;
        color: var(--on-accent);
        box-shadow: 0 2px 12px var(--accent-glow);
    }
    .btn--primary:hover:not(:disabled) { background: var(--accent-hover); }

    .hint {
        margin: 0;
        font-size: 12px;
        color: var(--text);
        padding: 9px 12px;
        border-radius: var(--radius-sm);
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-left: 3px solid rgba(255, 255, 255, 0.55);
    }

    .hint--error {
        color: var(--text);
        background: rgba(255, 255, 255, 0.07);
        border-color: rgba(255, 255, 255, 0.26);
        border-left-color: #ffffff;
    }
</style>
