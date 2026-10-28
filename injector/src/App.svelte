<script lang="ts">
    import { onMount } from "svelte";
    import { fade } from "svelte/transition";
    import { listen } from "@tauri-apps/api/event";
    import { getVersion } from "@tauri-apps/api/app";

    import TitleBar from "./lib/components/TitleBar.svelte";
    import Backdrop from "./lib/components/Backdrop.svelte";
    import DiscordRow from "./lib/components/DiscordRow.svelte";
    import UpdateBanner from "./lib/components/UpdateBanner.svelte";
    import Settings from "./lib/components/Settings.svelte";
    import { patcherApi } from "./lib/api/patcher";
    import { checkForUpdate, installUpdate, type InjectorUpdate } from "./lib/api/updater";
    import type { DiscordInstall, InstallProgressEvent, RowPhase } from "./lib/types";

    let screen = $state<"list" | "settings">("list");

    let installs = $state<DiscordInstall[]>([]);
    let phases = $state<Record<string, RowPhase>>({});
    let latestBuildSha = $state<string | null>(null);
    let globalError = $state<string | null>(null);
    let appVersion = $state("");

    let pendingUpdate = $state<InjectorUpdate | null>(null);
    let installingUpdate = $state(false);

    let buildUpdating = $state(false);
    let buildUpdateAvailable = $state(false);

    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    const phaseOf = (branch: string): RowPhase => phases[branch] ?? { kind: "idle" };
    const anyInstalling = $derived(Object.values(phases).some(p => p.kind === "installing"));

    function needsUpdate(install: DiscordInstall): boolean {
        return (
            install.patch_owner === "low_cord" &&
            !!install.build_sha &&
            !!latestBuildSha &&
            install.build_sha !== latestBuildSha
        );
    }

    async function refreshInstalls() {
        try {
            installs = await patcherApi.listInstalls();
        } catch (e) {
            globalError = String(e);
        }
    }

    async function runInstall(install: DiscordInstall) {
        if (!install.resources_path || !install.base_path) return;
        globalError = null;
        phases = { ...phases, [install.branch]: { kind: "installing", step: "cleaning" } };
        try {
            await patcherApi.patch(install.resources_path, install.base_path, install.branch);
            await sleep(1000);
        } catch (e) {
            if (phaseOf(install.branch).kind !== "error") {
                phases = { ...phases, [install.branch]: { kind: "error", message: String(e) } };
            }
            await sleep(2600);
        } finally {
            phases = { ...phases, [install.branch]: { kind: "idle" } };
            await refreshInstalls();
        }
    }

    async function runUninstall(install: DiscordInstall) {
        if (!install.resources_path || !install.base_path) return;
        globalError = null;
        try {
            await patcherApi.unpatch(install.resources_path, install.base_path, install.branch);
        } catch (e) {
            globalError = String(e);
        } finally {
            phases = { ...phases, [install.branch]: { kind: "idle" } };
            await refreshInstalls();
        }
    }

    async function updateLowCordBuild() {
        buildUpdating = true;
        globalError = null;
        try {
            const results = await patcherApi.updateLowCordBuild();
            const failures = results.filter(r => !r.updated);
            if (failures.length > 0) {
                globalError = failures.map(r => `${r.branch} : ${r.message ?? "échec inconnu"}`).join(" — ");
            }
            buildUpdateAvailable = false;
            await refreshInstalls();
        } catch (e) {
            globalError = String(e);
        } finally {
            buildUpdating = false;
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

        const unlistenUpdate = listen<InjectorUpdate>("injector-update-available", e => {
            pendingUpdate = e.payload;
        });
        const unlistenBuild = listen<{ sha: string }>("lowcord-build-update-available", () => {
            buildUpdateAvailable = true;
        });
        const unlistenLatestSha = listen<{ sha: string }>("latest-build-sha", e => {
            latestBuildSha = e.payload.sha;
        });
        const unlistenProgress = listen<InstallProgressEvent>("install-progress", e => {
            const { branch, step, status, message } = e.payload;
            phases = {
                ...phases,
                [branch]:
                    status === "error"
                        ? { kind: "error", message: message ?? "erreur inconnue" }
                        : { kind: "installing", step },
            };
        });

        return () => {
            unlistenUpdate.then(u => u());
            unlistenBuild.then(u => u());
            unlistenLatestSha.then(u => u());
            unlistenProgress.then(u => u());
        };
    });
</script>

<div class="shell">
    <Backdrop dimmed={anyInstalling} />
    <TitleBar
        onBack={screen === "settings" ? () => (screen = "list") : undefined}
        onSettings={screen === "list" ? () => (screen = "settings") : undefined}
    />

    <div class="content">
        {#key screen}
            <div class="view" in:fade={{ duration: 220 }}>
                {#if screen === "settings"}
                    <Settings
                        {pendingUpdate}
                        {installingUpdate}
                        onCheckInjectorUpdate={checkInjectorUpdate}
                        onInstallInjectorUpdate={doInstallUpdate}
                    />
                {:else}
                    <div class="list">
                        <header class="head">
                            <div class="head-top">
                                <h1>Installe <span class="grad">low-cord</span></h1>
                                {#if latestBuildSha}
                                    <span class="build-chip" title="Dernière build low-cord disponible">low-cord · build {latestBuildSha.slice(0, 7)}</span>
                                {/if}
                            </div>
                            <p>Choisis un Discord et installe ou mets à jour le client mod.</p>
                        </header>

                        {#if pendingUpdate}
                            <UpdateBanner version={pendingUpdate.version} installing={installingUpdate} onInstall={doInstallUpdate} />
                        {/if}

                        {#if buildUpdateAvailable}
                            <div class="mini-banner">
                                <span><span class="dot"></span>Nouvelle version de low-cord disponible</span>
                                <button disabled={buildUpdating} onclick={updateLowCordBuild}>
                                    {buildUpdating ? "Mise à jour…" : "Tout mettre à jour"}
                                </button>
                            </div>
                        {/if}

                        {#if globalError}
                            <p class="error">{globalError}</p>
                        {/if}

                        <div class="rows">
                            {#each installs as install, i (install.branch)}
                                <div class="row-in" style={`animation-delay:${i * 60}ms`}>
                                    <DiscordRow
                                        {install}
                                        needsUpdate={needsUpdate(install)}
                                        phase={phaseOf(install.branch)}
                                        onInstall={() => runInstall(install)}
                                        onUninstall={() => runUninstall(install)}
                                        onConfirmUninstall={() => (phases = { ...phases, [install.branch]: { kind: "confirm-uninstall" } })}
                                        onCancelConfirm={() => (phases = { ...phases, [install.branch]: { kind: "idle" } })}
                                    />
                                </div>
                            {/each}
                        </div>

                        <footer class="foot">
                            <span>low-cord Injecteur{appVersion ? ` v${appVersion}` : ""}</span>
                            <span class="credit">
                                <svg class="credit-star" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5l1.9 4.6L18.5 9l-4.6 1.9L12 15.5l-1.9-4.6L5.5 9l4.6-1.9L12 2.5z" /></svg>
                                Développé par <span class="credit-name">mxxq</span>
                            </span>
                        </footer>
                    </div>
                {/if}
            </div>
        {/key}
    </div>
</div>

<style>
    .shell {
        position: relative;
        width: 100vw;
        height: 100vh;
        overflow: hidden;
    }

    .content {
        position: relative;
        z-index: 1;
        width: 100%;
        height: 100%;
    }

    .view {
        width: 100%;
        height: 100%;
    }

    .list {
        display: flex;
        flex-direction: column;
        gap: 12px;
        height: 100%;
        padding: 56px 26px 18px;
        box-sizing: border-box;
        overflow-y: auto;
    }

    .head-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
    }
    .head h1 {
        margin: 0;
        font-size: 21px;
        font-weight: 700;
        letter-spacing: -0.01em;
        color: var(--text);
    }
    .build-chip {
        flex-shrink: 0;
        font-size: 10.5px;
        font-weight: 600;
        letter-spacing: 0.02em;
        color: var(--text-dim);
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid var(--border);
        border-radius: 999px;
        padding: 3px 9px;
        font-family: var(--font-mono);
    }
    .grad {
        background: linear-gradient(120deg, #ffffff 0%, #ffffff 40%, #86868b 100%);
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
    }
    .head p {
        margin: 4px 0 0;
        font-size: 12.5px;
        color: var(--text-dim);
    }

    .rows {
        display: flex;
        flex-direction: column;
        gap: 10px;
    }

    .row-in {
        animation: row-in var(--duration-base) var(--ease-out) both;
    }
    @keyframes row-in {
        from { opacity: 0; transform: translateY(8px); }
        to { opacity: 1; transform: translateY(0); }
    }

    .mini-banner {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
        padding: 9px 12px 9px 14px;
        border: 1px solid var(--border-strong);
        border-radius: var(--radius-md);
        background: var(--surface);
        font-size: 12.5px;
        color: var(--text);
    }
    .mini-banner span { display: flex; align-items: center; gap: 8px; }
    .mini-banner .dot {
        width: 7px; height: 7px; border-radius: 50%;
        background: var(--accent-hover);
        box-shadow: 0 0 8px var(--accent-line);
    }
    .mini-banner button {
        border: 1px solid var(--accent-line);
        background: var(--accent-soft);
        color: var(--accent-hover);
        padding: 7px 12px;
        border-radius: var(--radius-sm);
        font-size: 12px;
        font-weight: 600;
        flex-shrink: 0;
        transition: background var(--duration-fast) var(--ease-out);
    }
    .mini-banner button:hover:not(:disabled) { background: rgba(255, 255, 255, 0.2); }
    .mini-banner button:disabled { opacity: 0.6; cursor: default; }

    .error {
        margin: 0;
        padding: 9px 12px;
        border-radius: var(--radius-sm);
        border: 1px solid rgba(255, 255, 255, 0.26);
        border-left: 3px solid #ffffff;
        background: rgba(255, 255, 255, 0.06);
        color: var(--text);
        font-size: 12px;
    }

    .foot {
        margin-top: auto;
        padding-top: 10px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 11px;
        color: var(--text-faint);
    }
    .credit {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        letter-spacing: 0.01em;
    }
    .credit-star {
        width: 11px;
        height: 11px;
        color: var(--text-dim);
    }
    .credit-name {
        font-weight: 700;
        letter-spacing: 0.02em;
        background: linear-gradient(120deg, #ffffff 0%, #ffffff 45%, #8a8a8f 100%);
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
    }
</style>
