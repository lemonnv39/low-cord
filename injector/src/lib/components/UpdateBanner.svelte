<script lang="ts">
    let {
        version,
        installing,
        onInstall,
    }: {
        version: string;
        installing: boolean;
        onInstall: () => void;
    } = $props();
</script>

<div class="banner">
    <span class="ic" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 20v-9" /><path d="M8 8l4-4 4 4" /><path d="M6 20h12" />
        </svg>
    </span>
    <div class="txt">
        <div class="t1">Mise à jour de l'injecteur</div>
        <div class="t2">Version {version} disponible</div>
    </div>
    <button class="btn" disabled={installing} onclick={onInstall}>
        {#if installing}
            <span class="spinner"></span>Installation…
        {:else}
            Installer &amp; relancer
        {/if}
    </button>
</div>

<style>
    .banner {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        padding: 12px 14px;
        border: 1px solid var(--accent-line);
        border-radius: var(--radius-md);
        background: linear-gradient(180deg, var(--accent-soft), transparent), var(--surface);
    }

    .ic {
        flex-shrink: 0;
        width: 34px;
        height: 34px;
        border-radius: 10px;
        display: grid;
        place-items: center;
        color: var(--accent-hover);
        background: var(--accent-soft);
    }
    .ic svg { width: 18px; height: 18px; }

    .txt { flex: 1; min-width: 0; }
    .t1 { font-size: 13px; font-weight: 650; color: var(--text); }
    .t2 { font-size: 11.5px; color: var(--text-dim); margin-top: 1px; }

    .btn {
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        border: none;
        background: var(--accent);
        color: var(--on-accent);
        padding: 9px 15px;
        border-radius: var(--radius-sm);
        font-size: 12.5px;
        font-weight: 600;
        box-shadow: 0 2px 12px var(--accent-glow);
        transition: background var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
    }
    .btn:hover:not(:disabled) { background: var(--accent-hover); }
    .btn:active:not(:disabled) { transform: scale(0.97); }
    .btn:disabled { opacity: 0.75; cursor: default; }

    .spinner {
        width: 13px;
        height: 13px;
        border-radius: 50%;
        border: 2px solid rgba(255, 255, 255, 0.4);
        border-top-color: #fff;
        animation: spin 0.7s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
</style>
