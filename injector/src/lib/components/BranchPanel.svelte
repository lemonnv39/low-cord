<script lang="ts" module>
    import type { InstallProgressEvent } from "../types";

    export interface LogLine {
        step: InstallProgressEvent["step"];
        status: "ok" | "error";
        message?: string | null;
    }
</script>

<script lang="ts">
    import type { DiscordInstall, RowPhase } from "../types";
    import { BRANCH_NAME, STEP_LABEL, STEP_PCT, asciiBar, branchState } from "../branches";

    let {
        install,
        phase,
        log,
        latestSha,
        onInstall,
        onUninstall,
        onConfirmUninstall,
        onCancelConfirm,
    }: {
        install: DiscordInstall;
        phase: RowPhase;
        log: LogLine[];
        latestSha: string | null;
        onInstall: () => void;
        onUninstall: () => void;
        onConfirmUninstall: () => void;
        onCancelConfirm: () => void;
    } = $props();

    const name = $derived(BRANCH_NAME[install.branch] ?? install.branch);
    const st = $derived(branchState(install, latestSha));
    const busy = $derived(phase.kind === "installing");
    const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "—");

    const STATE_LINE = {
        absent: { text: "non installé sur ce pc", cls: "dim" },
        ready: { text: "discord d'origine — prêt à installer", cls: "dim" },
        foreign: { text: "autre mod détecté — sera remplacé", cls: "warn" },
        active: { text: "low-cord actif · à jour", cls: "ok" },
        outdated: { text: "low-cord actif · nouvelle build dispo", cls: "info" },
        reinject: { text: "discord s'est mis à jour · low-cord à réappliquer", cls: "warn" },
    } as const;

    const stateLine = $derived(
        st === "foreign" && install.foreign_name
            ? { text: `${install.foreign_name} détecté — sera remplacé`, cls: "warn" }
            : STATE_LINE[st]
    );

    const primaryLabel = $derived(
        st === "outdated" ? "mettre à jour" : st === "reinject" ? "réappliquer" : st === "active" ? "réinstaller" : "installer"
    );

    const pct = $derived(phase.kind === "installing" ? STEP_PCT[phase.step] : 0);
</script>

<section class="panel">
    <div class="cmdline"><span class="ok">$</span> low-cord status <span class="dim">--branch</span> {install.branch}</div>

    <dl class="kv">
        <dt>cible</dt><dd class="bright">{name}</dd>
        <dt>état</dt><dd class={stateLine.cls}>{stateLine.text}</dd>
        {#if install.installed}
            <dt>version</dt><dd>{install.version ?? "—"}</dd>
            <dt>build</dt><dd>{short(install.build_sha)} <span class="dim">/ dernière</span> {short(latestSha)}</dd>
            <dt>chemin</dt><dd class="path" title={install.resources_path ?? ""}>{install.resources_path ?? "—"}</dd>
        {/if}
    </dl>

    {#if install.installed}
        <div class="actions">
            {#if phase.kind === "confirm-uninstall"}
                <span class="warn">retirer low-cord de {name} ?</span>
                <button class="cmd cmd--danger" onclick={onUninstall}>oui, retirer</button>
                <button class="cmd" onclick={onCancelConfirm}>annuler</button>
            {:else}
                <button class="cmd cmd--primary" disabled={busy} onclick={onInstall}>{primaryLabel}</button>
                {#if install.patch_owner === "low_cord"}
                    <button class="cmd cmd--danger" disabled={busy} onclick={onConfirmUninstall}>désinstaller</button>
                {/if}
            {/if}
        </div>
    {/if}

    {#if busy || log.length > 0 || phase.kind === "error"}
        <div class="log">
            <div class="log-head dim">// journal</div>
            {#each log as line, i (i)}
                <div>
                    {#if line.status === "error"}
                        <span class="err">[err]</span> {STEP_LABEL[line.step]} <span class="err">— {line.message ?? "erreur inconnue"}</span>
                    {:else}
                        <span class="ok">[ok]</span> {STEP_LABEL[line.step]}{#if line.message}<span class="dim"> — {line.message}</span>{/if}
                    {/if}
                </div>
            {/each}
            {#if phase.kind === "error" && !log.some(l => l.status === "error")}
                <div><span class="err">[err] {phase.message}</span></div>
            {/if}
            {#if busy}
                <div><span class="ok">[{asciiBar(pct)}]</span> {pct}%<span class="cursor"></span></div>
            {/if}
        </div>
    {/if}
</section>

<style>
    .panel {
        display: flex;
        flex-direction: column;
        gap: 16px;
    }
    .cmdline {
        color: var(--fg-bright);
    }
    .kv {
        display: grid;
        grid-template-columns: max-content 1fr;
        gap: 4px 14px;
        margin: 0;
    }
    .kv dt {
        color: var(--dim);
    }
    .kv dt::after {
        content: " :";
        color: var(--faint);
    }
    .kv dd {
        margin: 0;
        min-width: 0;
    }
    .bright {
        color: var(--fg-bright);
    }
    .path {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--dim);
        user-select: text;
    }
    .actions {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 10px;
    }
    .log {
        border-top: 1px dashed var(--line-strong);
        padding-top: 10px;
        font-size: var(--fs-sm);
        display: flex;
        flex-direction: column;
        gap: 2px;
        user-select: text;
    }
    .log-head {
        margin-bottom: 4px;
    }
</style>
