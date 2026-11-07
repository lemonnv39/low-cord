/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-musical — visualisation du son en direct derrière le titre : un
// faisceau de fibres lumineuses horizontales (argent, légèrement froid). Il
// suit les vraies mesures du moteur (le son que les comptes diffusent) :
// graves au centre, aigus vers les bords.
//  - Sensible partout : chaque bande se cale sur son propre niveau récent,
//    donc les aigus discrets bougent autant que les basses.
//  - Lumière : un halo qui respire avec les graves, et un éclair à chaque
//    coup de basse qui parcourt le faisceau du centre vers les bords.
//  - Fluide : le lissage dépend du temps écoulé, pas du nombre d'images.

import { useEffect, useRef } from "@webpack/common";

import { getMeter } from "./engine";

const FIBRES = 28;
const POINTS = 96;
/** Argent froid. */
const TINT = "214, 224, 240";

/** Valeur d'une bande à une position 0..1 (interpolation douce entre les bandes). */
function sample(bands: ArrayLike<number>, t: number) {
    const n = bands.length;
    const x = t * (n - 1);
    const i = Math.floor(x);
    const f = x - i;
    const a = bands[Math.max(0, i - 1)], b = bands[i], c = bands[Math.min(n - 1, i + 1)], d = bands[Math.min(n - 1, i + 2)];
    // Catmull-Rom
    const v = b + 0.5 * f * (c - a + f * (2 * a - 5 * b + 4 * c - d + f * (3 * (b - c) + d - a)));
    return Math.max(0, Math.min(1, v));
}

/** Lissage indépendant du nombre d'images : `tau` = temps de réponse (s). */
const ease = (dt: number, tau: number) => 1 - Math.exp(-dt / tau);

export function Visualizer() {
    const ref = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = ref.current!;
        // La fenêtre du panneau, pas celle de Discord (qui peut être réduite).
        const win = canvas.ownerDocument.defaultView!;
        const ctx = canvas.getContext("2d")!;
        const bands = new Float32Array(24);
        // Niveau récent de chaque bande (calibrage automatique).
        const norm = new Float32Array(24).fill(0.3);
        const energy = new Float32Array(POINTS);
        // Forme du faisceau : pincé aux bords, ouvert au centre.
        const env = Float32Array.from({ length: POINTS }, (_, i) => Math.pow(Math.sin(Math.PI * i / (POINTS - 1)), 1.4));
        let level = 0, bass = 0, bassAvg = 0.2, flash = 0, pulse = 1;
        let last = performance.now();
        const start = last;
        let raf = 0;

        const draw = (now: number) => {
            raf = win.requestAnimationFrame(draw);
            const dt = Math.min(0.1, (now - last) / 1000);
            last = now;
            const dpr = win.devicePixelRatio || 1;
            const w = canvas.clientWidth, h = canvas.clientHeight;
            if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
                canvas.width = Math.round(w * dpr);
                canvas.height = Math.round(h * dpr);
            }
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, h);

            // ── Mesures → bandes calibrées ───────────────────────────────
            const m = getMeter();
            const fresh = !!m && performance.now() - m.at < 400;
            for (let i = 0; i < 24; i++) {
                const raw = fresh ? m!.bands[i] ?? 0 : 0;
                // Le repère monte vite et redescend en ~4 s, jamais sous un plancher.
                norm[i] = raw > norm[i] ? raw : Math.max(0.12, norm[i] + (raw - norm[i]) * ease(dt, 4));
                // Mélange : relatif (sensible) + absolu (garde les écarts réels).
                const target = fresh ? Math.min(1, 0.65 * Math.pow(raw / norm[i], 1.5) + 0.35 * raw) : 0;
                bands[i] += (target - bands[i]) * ease(dt, target > bands[i] ? 0.035 : 0.16);
            }
            for (let i = 0; i < POINTS; i++) {
                // Miroir gauche / droite : graves au centre, aigus aux bords.
                const t = Math.abs(i / (POINTS - 1) - 0.5) * 2;
                energy[i] += (sample(bands, t) - energy[i]) * ease(dt, 0.05);
            }
            const lv = fresh ? m!.level : 0;
            level += (lv - level) * ease(dt, lv > level ? 0.05 : 0.35);

            // Coups de basse : graves au-dessus de leur moyenne récente.
            const b = (bands[0] + bands[1] + bands[2] + bands[3]) / 4;
            bass += (b - bass) * ease(dt, 0.03);
            bassAvg += (bass - bassAvg) * ease(dt, 0.6);
            if (bass > bassAvg * 1.25 + 0.06 && flash < 0.35) {
                flash = 1;
                pulse = 0;
            }
            flash *= Math.exp(-dt / 0.28);
            pulse = Math.min(1.2, pulse + dt * 1.8);

            const time = (now - start) / 1000;
            const mid = h / 2;
            const step = w / (POINTS - 1);
            const glow = Math.min(1, level * 0.8 + bass * 0.5 + flash * 0.5);

            // ── Halo central qui respire avec les graves ────────────────
            if (glow > 0.01) {
                const r = h * (0.7 + bass * 0.9 + flash * 0.4);
                const halo = ctx.createRadialGradient(w / 2, mid, 0, w / 2, mid, r * 2.2);
                halo.addColorStop(0, `rgba(${TINT},${0.12 * glow})`);
                halo.addColorStop(1, `rgba(${TINT},0)`);
                ctx.fillStyle = halo;
                ctx.save();
                ctx.translate(w / 2, mid);
                ctx.scale(2.4, 0.5);
                ctx.translate(-w / 2, -mid);
                ctx.fillRect(0, mid - r * 2.2, w, r * 4.4);
                ctx.restore();
            }

            // ── Fibres ──────────────────────────────────────────────────
            const fade = ctx.createLinearGradient(0, 0, w, 0);
            fade.addColorStop(0, `rgba(${TINT},0)`);
            fade.addColorStop(0.15, `rgba(${TINT},1)`);
            fade.addColorStop(0.38, `rgba(${TINT},0.6)`);
            fade.addColorStop(0.62, `rgba(${TINT},0.6)`);
            fade.addColorStop(0.85, `rgba(${TINT},1)`);
            fade.addColorStop(1, `rgba(${TINT},0)`);
            ctx.strokeStyle = fade;
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            ctx.globalCompositeOperation = "lighter";

            const lit = 0.14 + level * 0.55 + flash * 0.25;
            for (let j = 0; j < FIBRES; j++) {
                // Place de la fibre dans le faisceau : −1 (haut) … 1 (bas).
                const o = (j / (FIBRES - 1)) * 2 - 1;
                const phase = j * 0.41;
                const speed = 0.55 + (j % 5) * 0.12;
                ctx.beginPath();
                for (let i = 0; i < POINTS; i++) {
                    const t = i / (POINTS - 1);
                    const e = energy[i];
                    const spread = (0.06 + e * 0.86 + flash * 0.06) * h * 0.44;
                    const wave = Math.sin(t * 7.5 + time * speed * 2 + phase) * (1.5 + e * h * 0.085)
                        + Math.sin(t * 13 - time * 1.3 + phase * 1.7) * e * h * 0.035;
                    const y = mid + env[i] * (o * spread + wave);
                    if (i === 0) ctx.moveTo(0, y);
                    else ctx.lineTo(i * step, y);
                }
                // Les fibres du cœur sont plus vives ; tout s'allume avec le son.
                const core = 1 - Math.abs(o) * 0.55;
                ctx.globalAlpha = (0.025 + level * 0.07 + flash * 0.05) * core;
                ctx.lineWidth = 3 + level * 4 + flash * 2;
                ctx.stroke();
                ctx.globalAlpha = Math.min(1, lit * core);
                ctx.lineWidth = 0.6 + (level * 1.3 + flash * 0.6) * core;
                ctx.stroke();
            }

            // ── Éclair : une onde de lumière part du centre vers les bords ─
            if (pulse < 1.1) {
                const a = Math.max(0, 1 - pulse) * 0.9;
                for (const side of [-1, 1]) {
                    const x = w / 2 + side * pulse * w * 0.46;
                    const spot = ctx.createRadialGradient(x, mid, 0, x, mid, h * 0.55);
                    spot.addColorStop(0, `rgba(${TINT},${0.35 * a})`);
                    spot.addColorStop(1, `rgba(${TINT},0)`);
                    ctx.globalAlpha = 1;
                    ctx.fillStyle = spot;
                    ctx.fillRect(x - h * 0.55, 0, h * 1.1, h);
                }
            }
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = "source-over";
        };
        raf = win.requestAnimationFrame(draw);
        return () => win.cancelAnimationFrame(raf);
    }, []);

    return <canvas ref={ref} className="lc-mp-visualizer" aria-hidden="true" />;
}
