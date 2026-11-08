/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-sound — découpe d'un son de la soundboard, façon Audacity : forme
// d'onde, on glisse pour choisir la partie gardée, poignées de début et de
// fin, zoom à la molette, écoute de la sélection (sur ton PC seulement).
// La découpe n'abîme jamais le fichier : seuls le début et la fin sont gardés.

import { useEffect, useRef, useState } from "@webpack/common";
import type { PointerEvent as ReactPointerEvent } from "react";

import { cl } from "./controls";
import { errorText, readSound, type SoundPad, trimSound } from "./engine";

/** Écart minimal entre début et fin (s). */
const MIN_LEN = 0.02;
/** Distance (px) à laquelle on attrape une poignée. */
const GRAB = 8;

const fmt = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s - m * 60;
    return `${m}:${sec.toFixed(3).padStart(6, "0")}`;
};

export function SoundEditor({ pad, onClose }: { pad: SoundPad; onClose(): void; }) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [sel, setSel] = useState<[number, number]>([0, 0]);
    /** partie affichée (zoom) */
    const [view, setView] = useState<[number, number]>([0, 0]);
    const [playing, setPlaying] = useState(false);
    const [saving, setSaving] = useState(false);

    const ctxRef = useRef<AudioContext | null>(null);
    const srcRef = useRef<AudioBufferSourceNode | null>(null);
    const playFrom = useRef<{ at: number; from: number; } | null>(null);
    const peaksRef = useRef<Float32Array | null>(null);
    const drag = useRef<{ mode: "start" | "end" | "new"; anchor: number; } | null>(null);
    // Valeurs à jour pour l'animation (hors React).
    const live = useRef({ sel, view });
    live.current = { sel, view };

    // Chargement et décodage du son.
    useEffect(() => {
        const win = canvasRef.current!.ownerDocument.defaultView as Window & typeof globalThis;
        const ctx = new win.AudioContext();
        ctxRef.current = ctx;
        let dead = false;
        (async () => {
            try {
                const bytes = await readSound(pad);
                const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
                const buf = await ctx.decodeAudioData(copy);
                if (dead) return;
                // Crêtes (min / max) par tranche : 4000 points suffisent pour zoomer.
                const n = 4000, data = buf.getChannelData(0), other = buf.numberOfChannels > 1 ? buf.getChannelData(1) : data;
                const per = Math.max(1, Math.floor(data.length / n));
                const peaks = new Float32Array(n * 2);
                for (let i = 0; i < n; i++) {
                    let lo = 0, hi = 0;
                    const end = Math.min(data.length, (i + 1) * per);
                    for (let j = i * per; j < end; j++) {
                        const v = (data[j] + other[j]) * 0.5;
                        if (v < lo) lo = v;
                        if (v > hi) hi = v;
                    }
                    peaks[i * 2] = lo;
                    peaks[i * 2 + 1] = hi;
                }
                peaksRef.current = peaks;
                const d = buf.duration;
                setBuffer(buf);
                setView([0, d]);
                setSel([Math.min((pad.start ?? 0) / 1000, d), Math.min((pad.end ?? d * 1000) / 1000, d)]);
            } catch (e) {
                if (!dead) setError(`Impossible de lire ce son : ${errorText(e)}`);
            }
        })();
        return () => {
            dead = true;
            try { srcRef.current?.stop(); } catch { }
            ctx.close().catch(() => { });
        };
    }, []);

    // Dessin (forme d'onde, sélection, tête de lecture) à chaque image.
    useEffect(() => {
        if (!buffer) return;
        const canvas = canvasRef.current!;
        const win = canvas.ownerDocument.defaultView!;
        const g = canvas.getContext("2d")!;
        let raf = 0;
        const draw = () => {
            raf = win.requestAnimationFrame(draw);
            const dpr = win.devicePixelRatio || 1;
            const w = canvas.clientWidth, h = canvas.clientHeight;
            if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
                canvas.width = Math.round(w * dpr);
                canvas.height = Math.round(h * dpr);
            }
            g.setTransform(dpr, 0, 0, dpr, 0, 0);
            g.clearRect(0, 0, w, h);
            const { sel: [a, b], view: [v0, v1] } = live.current;
            const dur = buffer.duration;
            const x = (t: number) => (t - v0) / (v1 - v0) * w;
            const mid = h / 2;

            // Sélection
            g.fillStyle = "rgba(214,224,240,0.08)";
            g.fillRect(x(a), 0, x(b) - x(a), h);

            // Forme d'onde : claire dans la sélection, sombre autour.
            const peaks = peaksRef.current!;
            const n = peaks.length / 2;
            for (let px = 0; px < w; px++) {
                const t0 = v0 + (px / w) * (v1 - v0), t1 = v0 + ((px + 1) / w) * (v1 - v0);
                const i0 = Math.floor(t0 / dur * n), i1 = Math.max(i0 + 1, Math.ceil(t1 / dur * n));
                let lo = 0, hi = 0;
                for (let i = Math.max(0, i0); i < Math.min(n, i1); i++) {
                    if (peaks[i * 2] < lo) lo = peaks[i * 2];
                    if (peaks[i * 2 + 1] > hi) hi = peaks[i * 2 + 1];
                }
                const inside = t1 > a && t0 < b;
                g.fillStyle = inside ? "rgba(236,240,248,0.92)" : "rgba(255,255,255,0.18)";
                g.fillRect(px, mid - hi * mid * 0.92, 1, Math.max(1, (hi - lo) * mid * 0.92));
            }
            // Ligne du zéro
            g.fillStyle = "rgba(255,255,255,0.08)";
            g.fillRect(0, mid, w, 1);

            // Poignées de début et de fin
            for (const t of [a, b]) {
                const hx = Math.round(x(t)) + 0.5;
                g.fillStyle = "#f4f4f6";
                g.fillRect(hx - 0.5, 0, 1.5, h);
                g.beginPath();
                g.roundRect(hx - 4, mid - 12, 8, 24, 3);
                g.fill();
            }

            // Tête de lecture
            const pf = playFrom.current;
            if (pf && ctxRef.current) {
                const t = pf.from + (ctxRef.current.currentTime - pf.at);
                if (t <= b) {
                    g.fillStyle = "rgba(61,220,132,0.95)";
                    g.fillRect(Math.round(x(t)), 0, 1.5, h);
                }
            }
        };
        raf = win.requestAnimationFrame(draw);
        return () => win.cancelAnimationFrame(raf);
    }, [buffer]);

    // Molette : zoom autour de la souris ; Maj + molette : défilement.
    useEffect(() => {
        if (!buffer) return;
        const canvas = canvasRef.current!;
        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            const [v0, v1] = live.current.view;
            const dur = buffer.duration, span = v1 - v0;
            const r = canvas.getBoundingClientRect();
            if (e.shiftKey) {
                const shift = span * 0.1 * Math.sign(e.deltaY || e.deltaX);
                const s0 = Math.max(0, Math.min(dur - span, v0 + shift));
                setView([s0, s0 + span]);
                return;
            }
            const at = v0 + ((e.clientX - r.left) / r.width) * span;
            const next = Math.max(Math.min(dur, 0.05), Math.min(dur, span * (e.deltaY < 0 ? 0.8 : 1.25)));
            const f = (at - v0) / span;
            let s0 = at - f * next;
            s0 = Math.max(0, Math.min(dur - next, s0));
            setView([s0, s0 + next]);
        };
        canvas.addEventListener("wheel", onWheel, { passive: false });
        return () => canvas.removeEventListener("wheel", onWheel);
    }, [buffer]);

    function timeAt(e: ReactPointerEvent) {
        const r = canvasRef.current!.getBoundingClientRect();
        const [v0, v1] = view;
        return Math.max(0, Math.min(buffer!.duration, v0 + ((e.clientX - r.left) / r.width) * (v1 - v0)));
    }

    function onDown(e: ReactPointerEvent<HTMLCanvasElement>) {
        if (!buffer || e.button !== 0) return;
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { }
        const r = e.currentTarget.getBoundingClientRect();
        const px = (t: number) => r.left + (t - view[0]) / (view[1] - view[0]) * r.width;
        if (Math.abs(e.clientX - px(sel[0])) <= GRAB) drag.current = { mode: "start", anchor: sel[1] };
        else if (Math.abs(e.clientX - px(sel[1])) <= GRAB) drag.current = { mode: "end", anchor: sel[0] };
        else {
            const t = timeAt(e);
            drag.current = { mode: "new", anchor: t };
            setSel([t, Math.min(buffer.duration, t + MIN_LEN)]);
        }
    }

    function onMove(e: ReactPointerEvent<HTMLCanvasElement>) {
        const d = drag.current;
        const canvas = e.currentTarget;
        if (!d) {
            // Curseur « redimensionner » au-dessus d'une poignée.
            if (!buffer) return;
            const r = canvas.getBoundingClientRect();
            const px = (t: number) => r.left + (t - view[0]) / (view[1] - view[0]) * r.width;
            const near = Math.abs(e.clientX - px(sel[0])) <= GRAB || Math.abs(e.clientX - px(sel[1])) <= GRAB;
            canvas.style.cursor = near ? "ew-resize" : "text";
            return;
        }
        const t = timeAt(e);
        const dur = buffer!.duration;
        if (d.mode === "start") setSel([Math.min(t, d.anchor - MIN_LEN), d.anchor]);
        else if (d.mode === "end") setSel([d.anchor, Math.max(t, d.anchor + MIN_LEN)]);
        else {
            const lo = Math.min(t, d.anchor), hi = Math.max(t, d.anchor);
            setSel(hi - lo < MIN_LEN ? [lo, Math.min(dur, lo + MIN_LEN)] : [lo, hi]);
        }
    }

    function stop() {
        try { srcRef.current?.stop(); } catch { }
        srcRef.current = null;
        playFrom.current = null;
        setPlaying(false);
    }

    function play() {
        if (!buffer || !ctxRef.current) return;
        if (playing) return stop();
        const ctx = ctxRef.current;
        ctx.resume().catch(() => { });
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        src.onended = () => { if (srcRef.current === src) stop(); };
        src.start(0, sel[0], sel[1] - sel[0]);
        srcRef.current = src;
        playFrom.current = { at: ctx.currentTime, from: sel[0] };
        setPlaying(true);
    }

    async function save() {
        if (!buffer) return;
        setSaving(true);
        try {
            const whole = sel[0] <= 0.0005 && sel[1] >= buffer.duration - 0.0005;
            await trimSound(pad.id, whole ? 0 : sel[0] * 1000, whole ? buffer.duration * 1000 + 1 : sel[1] * 1000);
            stop();
            onClose();
        } catch (e) {
            setError(errorText(e));
            setSaving(false);
        }
    }

    // Échap ferme, Espace écoute.
    useEffect(() => {
        const doc = canvasRef.current!.ownerDocument;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") { e.stopPropagation(); onClose(); }
            else if (e.key === " " && (e.target as HTMLElement).tagName !== "INPUT") { e.preventDefault(); playRef.current(); }
        };
        doc.addEventListener("keydown", onKey, true);
        return () => doc.removeEventListener("keydown", onKey, true);
    }, []);
    const playRef = useRef(play);
    playRef.current = play;

    const dur = buffer?.duration ?? 0;
    const zoomed = buffer && (view[1] - view[0]) < dur - 0.001;

    return (
        <div className={cl("modal-back")} onPointerDown={e => { if (e.target === e.currentTarget) onClose(); }}>
            <div className={cl("modal")} role="dialog" aria-label={`Découper ${pad.name}`}>
                <header className={cl("modal-head")}>
                    <span className={cl("card-title")}>Découper</span>
                    <span className={cl("modal-name")}>{pad.name}</span>
                    <button type="button" className={cl("icon-btn", "icon-btn-sm")} onClick={onClose} aria-label="Fermer" title="Fermer (Échap)">
                        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
                    </button>
                </header>

                <div className={cl("wave")}>
                    <canvas
                        ref={canvasRef}
                        className={cl("wave-canvas")}
                        onPointerDown={onDown}
                        onPointerMove={onMove}
                        onPointerUp={() => { drag.current = null; }}
                        onPointerCancel={() => { drag.current = null; }}
                    />
                    {!buffer && <div className={cl("wave-msg")}>{error ?? "Chargement…"}</div>}
                    {zoomed && (
                        <div className={cl("wave-zoom")}>
                            <span style={{ left: `${view[0] / dur * 100}%`, width: `${(view[1] - view[0]) / dur * 100}%` }} />
                        </div>
                    )}
                </div>

                <div className={cl("trim-times")}>
                    <span><em>Début</em>{fmt(sel[0])}</span>
                    <span><em>Fin</em>{fmt(sel[1])}</span>
                    <span><em>Durée</em>{fmt(sel[1] - sel[0])}</span>
                    <span className={cl("trim-hint")}>Glisse pour choisir · molette : zoom · Maj + molette : défiler</span>
                </div>
                {buffer && error && <p className={cl("error-line")}>{error}</p>}

                <div className={cl("row")}>
                    <button type="button" className={cl("btn", playing && "btn-on")} disabled={!buffer} onClick={play}>
                        {playing ? "■ Stop" : "▶ Écouter"}
                    </button>
                    <button type="button" className={cl("btn")} disabled={!buffer} onClick={() => { setSel([0, dur]); setView([0, dur]); }}>Tout le son</button>
                    {zoomed && <button type="button" className={cl("btn")} onClick={() => setView([0, dur])}>Dézoomer</button>}
                    <span className={cl("row-grow")} />
                    <button type="button" className={cl("btn")} onClick={onClose}>Annuler</button>
                    <button type="button" className={cl("btn", "btn-primary")} disabled={!buffer || saving} onClick={save}>Enregistrer</button>
                </div>
            </div>
        </div>
    );
}
