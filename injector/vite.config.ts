import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Hôte optionnel pour le dev mobile Tauri — sans objet ici (Windows only),
// gardé pour rester sur le layout standard d'un projet Tauri + Svelte.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
    plugins: [svelte()],

    // Empêche Vite de manger les logs d'erreurs Rust au démarrage de `tauri dev`.
    clearScreen: false,
    server: {
        port: 1420,
        strictPort: true,
        host: host || false,
        watch: {
            ignored: ["**/src-tauri/**"],
        },
    },
});
