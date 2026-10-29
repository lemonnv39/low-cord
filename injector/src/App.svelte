<script lang="ts">
    import { onMount } from "svelte";
    import { fly } from "svelte/transition";
    import { cubicOut } from "svelte/easing";
    import { listen } from "@tauri-apps/api/event";
    import { getVersion } from "@tauri-apps/api/app";

    import TitleBar from "./lib/components/TitleBar.svelte";
    import Sidebar from "./lib/components/Sidebar.svelte";
    import BranchPanel from "./lib/components/BranchPanel.svelte";
    import ConfigPanel from "./lib/components/ConfigPanel.svelte";
    import StatusBar from "./lib/components/StatusBar.svelte";
    import Spinner from "./lib/components/Spinner.svelte";
    import { patcherApi } from "./lib/api/patcher";
    import { checkForUpdate, installUpdate, type InjectorUpdate } from "./lib/api/updater";
    import type { DiscordInstall, FixResult, InstallLogEvent, InstallProgressEvent, RowPhase } from "./lib/types";

    let installs = $state<DiscordInstall[]>([]);
    let phases = $state<Record<string, RowPhase>>({});
    let logs = $state<Record<string, InstallLogEvent[]>>({});
    let selected = $state<string>("stable");
    let latestBuildSha = $state<string | null>(null);
    let globalError = $state<string | null>(null);
    let appVersion = $state("");

    let pendingUpdate = $state<InjectorUpdate | null>(null);
    let installingUpdate = $state(false);

    let pickedInitial = false;

    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    const phaseOf = (branch: string): RowPhase => phases[branch] ?? { kind: "idle" };
    const setPhase = (branch: string, phase: RowPhase) => (phases = { ...phases, [branch]: phase });
    const current = $derived(installs.find(i => i.branch === selected) ?? null);
    const busyBranch = $derived(
        Object.entries(phases).find(([, p]) => p.kind === "installing" || p.kind === "checking")?.[0] ?? null
    );

    async function refreshInstalls() {
        try {
            installs = await patcherApi.listInstalls();
            // Au premier chargement, sélectionne le premier Discord réellement installé.
            if (!pickedInitial) {
                pickedInitial = true;
                selected = installs.find(i => i.installed)?.branch ?? "stable";
            }
        } catch (e) {
            globalError = String(e);
        }
    }

    async function runInstall(install: DiscordInstall) {
        if (!install.resources_path || !install.base_path) return;
        globalError = null;
        logs = { ...logs, [install.branch]: [] };
        setPhase(install.branch, { kind: "installing", step: "cleaning" });
        try {
            await patcherApi.patch(install.resources_path, install.base_path, install.branch);
            await sleep(800);
            setPhase(install.branch, { kind: "idle" });
        } catch (e) {
            setPhase(install.branch, { kind: "error", message: String(e) });
        } finally {
            await refreshInstalls();
        }
    }

    async function runUninstall(install: DiscordInstall) {
        if (!install.resources_path || !install.base_path) return;
        globalError = null;
        logs = { ...logs, [install.branch]: [] };
        setPhase(install.branch, { kind: "installing", step: "stopping" });
        try {
            await patcherApi.unpatch(install.resources_path, install.base_path, install.branch);
            setPhase(install.branch, { kind: "idle" });
        } catch (e) {
            setPhase(install.branch, { kind: "error", message: String(e) });
        } finally {
            await refreshInstalls();
        }
    }

    function endBatch(results: { branch: string; ok: boolean; message?: string | null }[]) {
        for (const r of results) {
            setPhase(r.branch, r.ok ? { kind: "idle" } : { kind: "error", message: r.message ?? "échec inconnu" });
        }
    }

    /** "Vérifier les mises à jour" : demande la dernière build à GitHub, et
     *  l'installe sur cette branche seulement si elle est différente. */
    async function checkAndUpdate(install: DiscordInstall) {
        if (!install.resources_path || !install.base_path) return;
        const branch = install.branch;
        globalError = null;
        setPhase(branch, { kind: "checking" });

        let sha: string;
        try {
            // Délai minimal : sinon la vérification "clignote" quand GitHub répond vite.
            [sha] = await Promise.all([patcherApi.fetchLatestBuildSha(), sleep(450)]);
            latestBuildSha = sha;
        } catch (e) {
            setPhase(branch, { kind: "error", message: String(e) });
            return;
        }

        if (install.build_sha && install.build_sha === sha) {
            setPhase(branch, { kind: "up-to-date", sha, at: Date.now() });
            return;
        }

        logs = { ...logs, [branch]: [] };
        setPhase(branch, { kind: "installing", step: "stopping" });
        try {
            await patcherApi.updateBranch(install.resources_path, install.base_path, branch);
            await sleep(800);
            setPhase(branch, { kind: "idle" });
        } catch (e) {
            setPhase(branch, { kind: "error", message: String(e) });
        } finally {
            await refreshInstalls();
        }
    }

    /** Réparation (panneau config) : même journal que l'installation, branche par branche. */
    async function fixLowCord(): Promise<FixResult[]> {
        const targets = installs.filter(i => i.patch_owner === "low_cord" || i.needs_reinject).map(i => i.branch);
        for (const b of targets) {
            logs = { ...logs, [b]: [] };
            setPhase(b, { kind: "installing", step: "stopping" });
        }
        try {
            const results = await patcherApi.fixLowCord();
            endBatch(results.map(r => ({ branch: r.branch, ok: r.fixed, message: r.message })));
            return results;
        } catch (e) {
            endBatch(targets.map(b => ({ branch: b, ok: false, message: String(e) })));
            throw e;
        } finally {
            await refreshInstalls();
        }
    }

    async function doInstallUpdate() {
        if (!pendingUpdate) return;
        installingUpdate = true;
        try {
            await installUpdate(pendingUpdate);
        } catch (e) {
            globalError = String(e);
            installingUpdate = false;
        }
    }

    async function checkInjectorUpdate(): Promise<"found" | "none"> {
        const u = await checkForUpdate();
        if (u) {
            pendingUpdate = u;
            return "found";
        }
        return "none";
    }

    onMount(() => {
        refreshInstalls();
        getVersion().then(v => (appVersion = v)).catch(() => {});
        patcherApi.getLatestBuildSha().then(sha => (latestBuildSha = sha)).catch(() => {});

        const unlisteners = [
            listen<InjectorUpdate>("injector-update-available", e => {
                pendingUpdate = e.payload;
            }),
            listen<{ sha: string }>("latest-build-sha", e => {
                latestBuildSha = e.payload.sha;
            }),
            listen<InstallLogEvent>("install-log", e => {
                const line = e.payload;
                logs = { ...logs, [line.branch]: [...(logs[line.branch] ?? []), line] };
            }),
            listen<InstallProgressEvent>("install-progress", e => {
                const { branch, step, status, message } = e.payload;
                setPhase(
                    branch,
                    status === "error" ? { kind: "error", message: message ?? "erreur inconnue" } : { kind: "installing", step }
                );
            }),
        ];

        return () => unlisteners.forEach(u => u.then(f => f()));
    });
</script>

<div class="shell">
    <TitleBar />

    <div class="main">
        <Sidebar {installs} {phases} latestSha={latestBuildSha} {selected} onSelect={id => (selected = id)} />

        <main class="content">
            {#if globalError}
                <div class="err global">&gt; {globalError}</div>
            {/if}

            {#if selected === "config"}
                <div class="view" in:fly={{ y: 8, duration: 260, easing: cubicOut }}>
                <ConfigPanel
                    {appVersion}
                    latestSha={latestBuildSha}
                    {pendingUpdate}
                    {installingUpdate}
                    onCheckInjectorUpdate={checkInjectorUpdate}
                    onFix={fixLowCord}
                    onInstallInjectorUpdate={doInstallUpdate}
                />
                </div>
            {:else if current}
                {#key current.branch}
                    <div class="view" in:fly={{ y: 8, duration: 260, easing: cubicOut }}>
                    <BranchPanel
                        install={current}
                        phase={phaseOf(current.branch)}
                        log={logs[current.branch] ?? []}
                        latestSha={latestBuildSha}
                        locked={busyBranch !== null && busyBranch !== current.branch}
                        onInstall={() => runInstall(current)}
                        onCheckUpdate={() => checkAndUpdate(current)}
                        onUninstall={() => runUninstall(current)}
                        onConfirmUninstall={() => setPhase(current.branch, { kind: "confirm-uninstall" })}
                        onCancelConfirm={() => setPhase(current.branch, { kind: "idle" })}
                    />
                    </div>
                {/key}
            {:else}
                <div class="dim">&gt; détection des installations discord<Spinner /></div>
            {/if}
        </main>
    </div>

    <StatusBar
        {appVersion}
        latestSha={latestBuildSha}
        injectorUpdate={pendingUpdate?.version ?? null}
        onOpenConfig={() => (selected = "config")}
    />
</div>

<style>
    .shell {
        display: flex;
        flex-direction: column;
        width: 100vw;
        height: 100vh;
        border: 1px solid var(--line-strong);
    }
    .main {
        flex: 1;
        display: flex;
        min-height: 0;
    }
    .content {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        padding: 22px 28px;
        overflow-y: auto;
    }
    .view {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
    }
    .global {
        margin-bottom: 14px;
        font-size: var(--fs-sm);
        user-select: text;
    }
</style>
