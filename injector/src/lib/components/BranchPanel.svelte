<script lang="ts">
    import { tick } from "svelte";
    import type { DiscordInstall, InstallLogEvent, LogKind, RowPhase } from "../types";
    import { BRANCH_NAME, STEP_LABEL, STEP_PCT, branchState } from "../branches";

    let {
        install,
        phase,
        log,
        latestSha,
        locked,
        onInstall,
        onUninstall,
        onConfirmUninstall,
        onCancelConfirm,
    }: {
        install: DiscordInstall;
        phase: RowPhase;
        log: InstallLogEvent[];
        latestSha: string | null;
        /** Une autre branche est en cours d'opération : on bloque les actions ici. */
        locked: boolean;
        onInstall: () => void;
        onUninstall: () => void;
        onConfirmUninstall: () => void;
        onCancelConfirm: () => void;
    } = $props();

    const name = $derived(BRANCH_NAME[install.branch] ?? install.branch);
    const st = $derived(branchState(install, latestSha));
    const busy = $derived(phase.kind === "installing" || phase.kind === "uninstalling");
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

    // ── Activité ────────────────────────────────────────────────────────
    const SYMBOL: Record<LogKind, string> = {
        info: "·", ok: "✓", warn: "!", err: "x", add: "+", del: "-", mod: "~", proc: "»", net: "↓",
    };

    const pct = $derived(
        phase.kind === "installing" ? STEP_PCT[phase.step] : phase.kind === "uninstalling" ? 50 : log.length > 0 ? 100 : 0
    );
    const stepText = $derived(
        phase.kind === "installing"
            ? STEP_LABEL[phase.step]
            : phase.kind === "uninstalling"
              ? "désinstallation"
              : phase.kind === "error"
                ? "échec"
                : "terminé"
    );
    const counts = $derived({
        add: log.filter(l => l.kind === "add").length,
        del: log.filter(l => l.kind === "del").length,
        mod: log.filter(l => l.kind === "mod").length,
    });

    // Chrono depuis la première ligne du journal (tic toutes les 100 ms pendant l'opération).
    let now = $state(Date.now());
    $effect(() => {
        if (!busy) return;
        const t = setInterval(() => (now = Date.now()), 100);
        return () => clearInterval(t);
    });
    const elapsed = $derived.by(() => {
        if (log.length === 0) return null;
        const end = busy ? now : log[log.length - 1].ts;
        return ((end - log[0].ts) / 1000).toFixed(1);
    });

    function clock(ts: number) {
        const d = new Date(ts);
        const p = (n: number, w = 2) => String(n).padStart(w, "0");
        return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
    }

    // Auto-scroll en bas à chaque nouvelle ligne.
    let consoleEl = $state<HTMLDivElement | null>(null);
    $effect(() => {
        void log.length;
        tick().then(() => consoleEl?.scrollTo({ top: consoleEl.scrollHeight, behavior: "smooth" }));
    });
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
                <button class="cmd cmd--primary" disabled={busy || locked} onclick={onInstall}>{primaryLabel}</button>
                {#if install.patch_owner === "low_cord"}
                    <button class="cmd cmd--danger" disabled={busy || locked} onclick={onConfirmUninstall}>désinstaller</button>
                {/if}
            {/if}
        </div>
    {/if}

    {#if busy || log.length > 0 || phase.kind === "error"}
        <div class="activity">
            <div class="progress-head">
                <span class:err={phase.kind === "error"} class:bright={phase.kind !== "error"}>
                    {stepText}{#if busy}<span class="cursor"></span>{/if}
                </span>
                <span class="dim">{#if elapsed}{elapsed} s · {/if}{pct}%</span>
            </div>
            <div class="track"><div class="fill" class:fill--err={phase.kind === "error"} style={`width:${pct}%`}></div></div>

            <div class="console" bind:this={consoleEl}>
                {#each log as line, i (i)}
                    <div class="line k-{line.kind}">
                        <span class="ts">{clock(line.ts)}</span>
                        <span class="sym">{SYMBOL[line.kind]}</span>
                        <span class="msg">{line.message}</span>
                    </div>
                {/each}
                {#if phase.kind === "error"}
                    <div class="line k-err">
                        <span class="ts">{clock(now)}</span>
                        <span class="sym">x</span>
                        <span class="msg">{phase.message}</span>
                    </div>
                {/if}
            </div>

            <div class="counters dim">
                <span><span class="c-add">+{counts.add}</span> ajoutés</span>
                <span><span class="c-del">-{counts.del}</span> supprimés</span>
                <span><span class="c-mod">~{counts.mod}</span> modifiés</span>
            </div>
        </div>
    {/if}
</section>

<style>
    .panel {
        display: flex;
        flex-direction: column;
        gap: 18px;
        height: 100%;
        min-height: 0;
    }
    .cmdline {
        color: var(--fg-bright);
    }
    .kv {
        display: grid;
        grid-template-columns: max-content 1fr;
        gap: 5px 16px;
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

    /* ── Activité ───────────────────────────────────────────────────── */
    .activity {
        flex: 1;
        min-height: 160px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        animation: rise 220ms var(--ease);
    }
    .progress-head {
        display: flex;
        justify-content: space-between;
        font-size: var(--fs-sm);
    }
    .track {
        height: 2px;
        background: var(--line);
        overflow: hidden;
    }
    .fill {
        height: 100%;
        background: var(--accent);
        transition: width 420ms var(--ease);
    }
    .fill--err {
        background: var(--err);
    }
    .console {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: 10px 12px;
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: var(--radius);
        font-size: var(--fs-sm);
        line-height: 1.65;
        user-select: text;
    }
    .line {
        display: grid;
        grid-template-columns: max-content 1.6ch 1fr;
        gap: 10px;
        animation: fade-in 160ms var(--ease);
    }
    .ts {
        color: var(--faint);
    }
    .sym {
        text-align: center;
    }
    .msg {
        min-width: 0;
        overflow-wrap: anywhere;
    }
    .k-info { color: var(--dim); }
    .k-ok { color: var(--fg-bright); }
    .k-ok .sym { color: var(--fg-bright); }
    .k-warn { color: var(--warn); }
    .k-err { color: var(--err); }
    .k-add .sym, .c-add { color: var(--fg-bright); }
    .k-add { color: var(--fg); }
    .k-del .sym, .c-del { color: var(--err); }
    .k-del { color: var(--fg); }
    .k-mod .sym, .c-mod { color: var(--info); }
    .k-mod { color: var(--fg); }
    .k-proc { color: var(--fg); }
    .k-proc .sym { color: var(--warn); }
    .k-net { color: var(--fg); }
    .k-net .sym { color: var(--info); }
    .counters {
        display: flex;
        gap: 18px;
        font-size: var(--fs-xs);
    }

    @keyframes rise {
        from { opacity: 0; transform: translateY(4px); }
    }
    @keyframes fade-in {
        from { opacity: 0; }
    }
</style>
