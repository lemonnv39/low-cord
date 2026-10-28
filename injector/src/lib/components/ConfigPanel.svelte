<script lang="ts">
    import { patcherApi } from "../api/patcher";
    import type { InjectorUpdate } from "../api/updater";
    import type { FixResult } from "../types";
    import { BRANCH_NAME } from "../branches";

    let {
        appVersion,
        latestSha,
        pendingUpdate,
        installingUpdate,
        onCheckInjectorUpdate,
        onInstallInjectorUpdate,
    }: {
        appVersion: string;
        latestSha: string | null;
        pendingUpdate: InjectorUpdate | null;
        installingUpdate: boolean;
        onCheckInjectorUpdate: () => Promise<"found" | "none">;
        onInstallInjectorUpdate: () => void;
    } = $props();

    let fixing = $state(false);
    let checking = $state(false);
    let out = $state<{ text: string; cls: string } | null>(null);

    const nameOf = (b: string) => BRANCH_NAME[b] ?? b;

    function summarizeFix(results: FixResult[]) {
        if (results.length === 0) return { text: "aucune install low-cord détectée — rien à réparer", cls: "dim" };
        const failed = results.filter(r => !r.fixed);
        if (failed.length > 0) {
            return { text: `échec sur ${failed.map(r => nameOf(r.branch)).join(", ")} : ${failed[0].message ?? "erreur inconnue"}`, cls: "err" };
        }
        return { text: `réinstallé : ${results.map(r => nameOf(r.branch)).join(", ")} — discord redémarre`, cls: "ok" };
    }

    async function fix() {
        out = null;
        fixing = true;
        try {
            out = summarizeFix(await patcherApi.fixLowCord());
        } catch (e) {
            out = { text: String(e), cls: "err" };
        } finally {
            fixing = false;
        }
    }

    async function check() {
        out = null;
        checking = true;
        try {
            if ((await onCheckInjectorUpdate()) === "none") out = { text: "injecteur déjà à jour", cls: "ok" };
        } catch (e) {
            out = { text: String(e), cls: "err" };
        } finally {
            checking = false;
        }
    }
</script>

<section class="panel">
    <div class="cmdline"><span class="ok">$</span> low-cord config</div>

    <dl class="kv">
        <dt>injecteur</dt><dd class="bright">v{appVersion || "…"}</dd>
        <dt>build</dt><dd>{latestSha ? latestSha.slice(0, 7) : "—"} <span class="dim">(dernière publiée)</span></dd>
        <dt>données</dt><dd class="dim">%APPDATA%\low-cord</dd>
        <dt>source</dt><dd class="dim">github.com/lemonnv39/low-cord</dd>
        <dt>auteur</dt><dd class="ok">shitday</dd>
    </dl>

    <div class="block">
        <div class="dim">// réparation — restaure discord, retélécharge la dernière build, réinjecte</div>
        <button class="cmd" disabled={fixing} onclick={fix}>{fixing ? "réparation…" : "réparer low-cord"}</button>
    </div>

    <div class="block">
        <div class="dim">// injecteur</div>
        {#if pendingUpdate}
            <div class="info">v{pendingUpdate.version} disponible</div>
            <button class="cmd cmd--primary" disabled={installingUpdate} onclick={onInstallInjectorUpdate}>
                {installingUpdate ? "installation…" : "installer & relancer"}
            </button>
        {:else}
            <button class="cmd" disabled={checking} onclick={check}>{checking ? "vérification…" : "vérifier les mises à jour"}</button>
        {/if}
    </div>

    {#if out}
        <div class={out.cls}>&gt; {out.text}</div>
    {/if}

    <div class="sig dim">
        low-cord · open source · gpl-3.0<br />
        signé <span class="ok">shitday</span>
    </div>
</section>

<style>
    .panel {
        display: flex;
        flex-direction: column;
        gap: 18px;
        min-height: 100%;
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
    }
    .bright {
        color: var(--fg-bright);
    }
    .block {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 8px;
    }
    .sig {
        margin-top: auto;
        font-size: var(--fs-xs);
        line-height: 1.7;
    }
</style>
