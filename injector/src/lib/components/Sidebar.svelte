<script lang="ts">
    import type { DiscordInstall, RowPhase } from "../types";
    import { BRANCH_NAME, STATE_TAG, branchState } from "../branches";

    let {
        installs,
        phases,
        latestSha,
        selected,
        onSelect,
    }: {
        installs: DiscordInstall[];
        phases: Record<string, RowPhase>;
        latestSha: string | null;
        selected: string;
        onSelect: (id: string) => void;
    } = $props();
</script>

<nav class="side">
    <div class="group">// discord</div>
    {#each installs as install (install.branch)}
        {@const st = branchState(install, latestSha)}
        {@const busy = phases[install.branch]?.kind === "installing"}
        <button class="item" class:on={selected === install.branch} onclick={() => onSelect(install.branch)}>
            <span class="caret">{selected === install.branch ? ">" : " "}</span>
            <span class="name">{BRANCH_NAME[install.branch] ?? install.branch}</span>
            {#if busy}
                <span class="tag info">..</span>
            {:else}
                <span class="tag {STATE_TAG[st].cls}">[{STATE_TAG[st].text}]</span>
            {/if}
        </button>
    {/each}

    <div class="group">// système</div>
    <button class="item" class:on={selected === "config"} onclick={() => onSelect("config")}>
        <span class="caret">{selected === "config" ? ">" : " "}</span>
        <span class="name">config</span>
    </button>
</nav>

<style>
    .side {
        width: 200px;
        flex: none;
        display: flex;
        flex-direction: column;
        padding: 12px 0;
        border-right: 1px solid var(--line);
        background: var(--panel);
        overflow-y: auto;
    }
    .group {
        padding: 10px 16px 6px;
        font-size: var(--fs-xs);
        color: var(--faint);
    }
    .item {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 6px 16px 6px 12px;
        text-align: left;
        color: var(--dim);
        border-left: 2px solid transparent;
    }
    .item:hover {
        color: var(--fg-bright);
        background: var(--panel-2);
    }
    .item.on {
        color: var(--fg-bright);
        background: var(--accent-bg);
        border-left-color: var(--accent);
    }
    .caret {
        width: 1ch;
        color: var(--accent);
    }
    .name {
        flex: 1;
    }
    .tag {
        font-size: var(--fs-xs);
    }
</style>
