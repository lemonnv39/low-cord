<script lang="ts">
    import { getCurrentWindow } from "@tauri-apps/api/window";

    const win = getCurrentWindow();
    let { onBack, onSettings }: { onBack?: () => void; onSettings?: () => void } = $props();
</script>

<!-- Barre de titre custom (decorations:false). Toute la bande est déplaçable
     via data-tauri-drag-region, sauf les boutons (stopPropagation). -->
<header class="titlebar" data-tauri-drag-region>
    <div class="left">
        {#if onBack}
            <button class="ctl back" title="Retour" onclick={(e) => { e.stopPropagation(); onBack?.(); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
            </button>
            <span class="title">Paramètres</span>
        {:else}
            <span class="title">low-cord <span class="title-dim">Injecteur</span></span>
        {/if}
    </div>

    <div class="right">
        {#if onSettings}
            <button class="ctl" title="Paramètres" onclick={(e) => { e.stopPropagation(); onSettings?.(); }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
            </button>
            <span class="sep"></span>
        {/if}
        <button class="ctl" title="Réduire" onclick={(e) => { e.stopPropagation(); win.minimize(); }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 12h12" /></svg>
        </button>
        <button class="ctl ctl--close" title="Fermer" onclick={(e) => { e.stopPropagation(); win.close(); }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
    </div>
</header>

<style>
    .titlebar {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: 44px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 10px 0 14px;
        z-index: 20;
    }

    .left {
        display: flex;
        align-items: center;
        gap: 10px;
    }

    .title {
        font-size: 12.5px;
        font-weight: 600;
        letter-spacing: 0.01em;
        color: var(--text);
    }
    .title-dim { color: var(--text-faint); font-weight: 500; }

    .right {
        display: flex;
        align-items: center;
        gap: 2px;
    }

    .sep {
        width: 1px;
        height: 16px;
        background: var(--border);
        margin: 0 6px;
    }

    .ctl {
        width: 30px;
        height: 30px;
        border: none;
        background: transparent;
        color: var(--text-dim);
        border-radius: var(--radius-sm);
        display: grid;
        place-items: center;
        transition: background var(--duration-fast) var(--ease-out),
            color var(--duration-fast) var(--ease-out);
    }
    .ctl svg { width: 16px; height: 16px; }
    .ctl:hover { background: rgba(255, 255, 255, 0.08); color: var(--text); }
    .ctl--close:hover { background: #ffffff; color: #000000; }

    .back:hover { transform: none; }
</style>
