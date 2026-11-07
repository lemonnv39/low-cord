/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-musical — visualisation du son en direct derrière le titre. Elle montre
// les vraies mesures du moteur (le son traité, celui que les comptes
// diffusent) : graves au centre, aigus vers les bords, en miroir haut / bas.
// Sans son (pas de source, silence), elle reste une ligne plate.

import { useEffect, useRef } from "@webpack/common";

import { getMeter } from "./engine";

const BARS = 112;
/** Lissage : montée rapide, descente douce (comme un vumètre). */
const ATTACK = 0.55;
const RELEASE = 0.12;

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
        const heights = new Float32Array(BARS);
        let raf = 0;

        const draw = () => {
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
            const half = BARS / 2;
            for (let i = 0; i < BARS; i++) {
                // Miroir gauche / droite : graves au centre, aigus aux bords.
                const t = Math.abs(i - half + 0.5) / half;
                const target = fresh ? Math.pow(sample(m!.bands, t), 1.6) * (0.35 + 0.65 * m!.level) : 0;
                const k = target > heights[i] ? ATTACK : RELEASE;
                heights[i] += (target - heights[i]) * k;
            }

            const mid = h / 2;
            const gap = w / BARS;
            const barW = Math.max(1, gap * 0.42);
            ctx.lineCap = "round";
            ctx.lineWidth = barW;
            ctx.shadowColor = "rgba(255,255,255,0.55)";
            ctx.shadowBlur = 10;
            for (let i = 0; i < BARS; i++) {
                const x = gap * (i + 0.5);
                // Les bords s'effacent pour fondre la forme dans le fond, et le
                // centre s'atténue derrière le titre pour qu'il reste lisible.
                const d = Math.abs(i - half + 0.5) / half;
                const edge = (1 - Math.pow(d, 3)) * (0.35 + 0.65 * Math.min(1, d / 0.42));
                const amp = Math.max(0.6, heights[i] * mid * 0.92);
                ctx.strokeStyle = `rgba(255,255,255,${(0.16 + heights[i] * 0.84) * edge})`;
                ctx.beginPath();
                ctx.moveTo(x, mid - amp);
                ctx.lineTo(x, mid + amp);
                ctx.stroke();
            }
        };
        raf = win.requestAnimationFrame(draw);
        return () => win.cancelAnimationFrame(raf);
    }, []);

    return <canvas ref={ref} className="lc-mp-visualizer" aria-hidden="true" />;
}
