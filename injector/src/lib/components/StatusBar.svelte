<script lang="ts">
    let {
        appVersion,
        latestSha,
        injectorUpdate,
        buildUpdate,
        buildUpdating,
        onUpdateBuild,
        onOpenConfig,
    }: {
        appVersion: string;
        latestSha: string | null;
        injectorUpdate: string | null;
        buildUpdate: boolean;
        buildUpdating: boolean;
        onUpdateBuild: () => void;
        onOpenConfig: () => void;
    } = $props();
</script>

<footer class="status">
    <span class="left">
        <span>build <span class="ok">{latestSha ? latestSha.slice(0, 7) : "—"}</span></span>
        <span>v{appVersion || "…"}</span>
        {#if buildUpdate}
            <button class="alert" disabled={buildUpdating} onclick={onUpdateBuild}>
                {buildUpdating ? "mise à jour…" : "nouvelle build → tout mettre à jour"}
            </button>
        {/if}
        {#if injectorUpdate}
            <button class="alert" onclick={onOpenConfig}>injecteur v{injectorUpdate} dispo</button>
        {/if}
    </span>
</footer>

<style>
    .status {
        height: 26px;
        flex: none;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 14px;
        border-top: 1px solid var(--line);
        background: var(--panel);
        font-size: var(--fs-xs);
        color: var(--dim);
    }
    .left {
        display: flex;
        align-items: center;
        gap: 14px;
    }
    .alert {
        color: #000;
        background: var(--info);
        padding: 0 8px;
        font-size: var(--fs-xs);
    }
    .alert:hover:not(:disabled) {
        background: var(--fg-bright);
    }
</style>
