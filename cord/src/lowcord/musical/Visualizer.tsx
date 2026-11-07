/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-musical — visualisation du son en direct derrière le titre : un
// faisceau de fibres lumineuses horizontales (argent, légèrement froid). Il
// suit les vraies mesures du moteur (le son que les comptes diffusent) :
// graves au centre, aigus vers les bords. Plus le son est fort, plus les
// fibres s'écartent, ondulent et s'épaississent. Sans son, elles restent un
// faisceau fin qui respire doucement.

import { useEffect, useRef } from "@webpack/common";

import { getMeter } from "./engine";

const FIBRES = 26;
const POINTS = 80;
/** Lissage : montée rapide, descente douce (comme un vumètre). */
const ATTACK = 0.5;
const RELEASE = 0.08;
/** Argent froid. */
const TINT = "214, 224, 240";

/** Valeur d'une bande à une position 0..1 (interpolation douce entre les 24 bandes). */
function sample(bands: number[], t: number) {
    const x = t * (bands.length - 1);
    const i = Math.floor(x);
    const f = x - i;
    const a = bands[Math.max(0, i - 1)], b = bands[i], c = bands[Math.min(bands.length - 1, i + 1)], d = bands[Math.min(bands.length - 1, i + 2)];
    // Catmull-Rom
    const v = b + 0.5 * f * (c - a + f * (2 * a - 5 * b + 4 * c - d + f * (3 * (b - c) + d - a)));
    return Math.max(0, Math.min(1, v));
}

export function Visualizer() {
    const ref = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = ref.current!;
        // La fenêtre du panneau, pas celle de Discord (qui peut être réduite).
        const win = canvas.ownerDocument.defaultView!;
        const ctx = canvas.getContext("2d")!;
        const energy = new Float32Array(POINTS);
        // Forme du faisceau : pincé aux bords, ouvert au centre.
        const env = Float32Array.from({ length: POINTS }, (_, i) => Math.pow(Math.sin(Math.PI * i / (POINTS - 1)), 1.4));
        let level = 0;
        let raf = 0;
        const start = performance.now();

        const draw = (now: number) => {
            raf = win.requestAnimationFrame(draw);
            const dpr = win.devicePixelRatio || 1;
            const w = canvas.clientWidth, h = canvas.clientHeight;
            if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
                canvas.width = Math.round(w * dpr);
                canvas.height = Math.round(h * dpr);
            }
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, h);

            const m = getMeter();
            const fresh = m && performance.now() - m.at < 400;
            for (let i = 0; i < POINTS; i++) {
                // Miroir gauche / droite : graves au centre, aigus aux bords.
                const t = Math.abs(i / (POINTS - 1) - 0.5) * 2;
                const target = fresh ? Math.pow(sample(m!.bands, t), 1.3) : 0;
                energy[i] += (target - energy[i]) * (target > energy[i] ? ATTACK : RELEASE);
            }
            const lv = fresh ? m!.level : 0;
            level += (lv - level) * (lv > level ? 0.3 : 0.05);

            const time = (now - start) / 1000;
            const mid = h / 2;
            const step = w / (POINTS - 1);

            // Fondu aux bords, et un peu moins de lumière derrière le titre.
            const fade = ctx.createLinearGradient(0, 0, w, 0);
            fade.addColorStop(0, `rgba(${TINT},0)`);
            fade.addColorStop(0.16, `rgba(${TINT},1)`);
            fade.addColorStop(0.4, `rgba(${TINT},0.6)`);
            fade.addColorStop(0.6, `rgba(${TINT},0.6)`);
            fade.addColorStop(0.84, `rgba(${TINT},1)`);
            fade.addColorStop(1, `rgba(${TINT},0)`);
            ctx.strokeStyle = fade;
            ctx.lineCap = "round";
            ctx.lineJoin = "round";
            ctx.globalCompositeOperation = "lighter";

            for (let j = 0; j < FIBRES; j++) {
                // Place de la fibre dans le faisceau : −1 (haut) … 1 (bas).
                const o = (j / (FIBRES - 1)) * 2 - 1;
                const phase = j * 0.42;
                const speed = 0.6 + (j % 5) * 0.11;
                ctx.beginPath();
                for (let i = 0; i < POINTS; i++) {
                    const t = i / (POINTS - 1);
                    const e = energy[i];
                    const spread = (0.05 + e * 0.85) * h * 0.44;
                    const wave = Math.sin(t * 7.5 + time * speed * 2 + phase) * (1.5 + e * h * 0.09)
                        + Math.sin(t * 13 - time * 1.3 + phase * 1.7) * e * h * 0.035;
                    const y = mid + env[i] * (o * spread + wave);
                    if (i === 0) ctx.moveTo(0, y);
                    else ctx.lineTo(i * step, y);
                }
                // Les fibres du cœur sont plus vives ; tout s'allume avec le son.
                const core = 1 - Math.abs(o) * 0.55;
                // Halo large et doux, puis la fibre fine et nette.
                ctx.globalAlpha = (0.025 + level * 0.07) * core;
                ctx.lineWidth = 3 + level * 4;
                ctx.stroke();
                ctx.globalAlpha = (0.14 + level * 0.6) * core;
                ctx.lineWidth = 0.6 + level * 1.4 * core;
                ctx.stroke();
            }
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = "source-over";
        };
        raf = win.requestAnimationFrame(draw);
        return () => win.cancelAnimationFrame(raf);
    }, []);

    return <canvas ref={ref} className="lc-mp-visualizer" aria-hidden="true" />;
}
