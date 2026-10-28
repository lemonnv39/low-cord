import type { DiscordInstall } from "../types";

// Store Svelte 5 "runes" : une classe simple avec des champs $state, importée
// partout où l'état doit être partagé (pas de writable()/get() à la Svelte 4).
class PatchStateStore {
    installs = $state<DiscordInstall[]>([]);
    loading = $state(false);
    error = $state<string | null>(null);

    reset() {
        this.error = null;
    }
}

export const patchState = new PatchStateStore();
