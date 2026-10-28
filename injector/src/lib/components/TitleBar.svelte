<script lang="ts">
    import { getCurrentWindow } from "@tauri-apps/api/window";

    const win = getCurrentWindow();
</script>

<!-- Barre de titre custom (decorations:false) : toute la bande est déplaçable. -->
<header class="bar" data-tauri-drag-region>
    <span class="prompt" data-tauri-drag-region>
        <span class="ok">low-cord</span><span class="cursor"></span>
    </span>
    <div class="ctl">
        <button title="Réduire" onclick={(e) => { e.stopPropagation(); win.minimize(); }}>_</button>
        <button class="close" title="Fermer" onclick={(e) => { e.stopPropagation(); win.close(); }}>x</button>
    </div>
</header>

<style>
    .bar {
        height: 34px;
        flex: none;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding-left: 14px;
        border-bottom: 1px solid var(--line);
        background: var(--panel);
    }
    .prompt {
        font-size: var(--fs-sm);
        font-weight: 700;
        letter-spacing: 0.02em;
    }
    .ctl {
        display: flex;
        height: 100%;
    }
    .ctl button {
        width: 44px;
        height: 100%;
        color: var(--dim);
        font-size: var(--fs);
        transition: background 140ms var(--ease), color 140ms var(--ease);
    }
    .ctl button:hover {
        background: var(--panel-2);
        color: var(--fg-bright);
    }
    .ctl .close:hover {
        background: var(--err);
        color: #000;
    }
</style>
