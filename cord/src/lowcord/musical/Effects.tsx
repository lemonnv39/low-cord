/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-musical — effets : spatialisation 8D, réverbe, égaliseur 10 bandes.
// Tout s'applique en direct et reste mémorisé pour les prochaines connexions.
//
// Le carré de la 8D règle deux choses avec un seul point :
//  - gauche → droite : position du son (mode Manuel ; il tourne seul en Auto) ;
//  - haut → bas : distance de la réverbe (haut = loin, bas = proche).

import { useEffect, useRef, useState } from "@webpack/common";
import type { PointerEvent as ReactPointerEvent } from "react";

import { cl, Section, Slider, Toggle } from "./controls";
import {
    applyEqPreset, EQ_CUSTOM, EQ_LABELS, EQ_PRESETS, getPrefs, PREF_DEFAULTS,
    saveEqCustom, set8d, setEq, setReverb, setReverbParams, useMusical,
} from "./engine";

const MODES = [
    { value: 0, label: "Off" },
    { value: 1, label: "Auto" },
    { value: 2, label: "Manuel" },
] as const;

const pct = (v: number) => `${Math.round(v * 100)}%`;
const round2 = (v: number) => Math.round(v * 100) / 100;

/** Angle du point en mode Auto : purement visuel, à la même vitesse que le moteur. */
function useOrbit(active: boolean, speed: number) {
    const [angle, setAngle] = useState(0);
    useEffect(() => {
        if (!active) return;
        let raf = 0;
        let last = performance.now();
        const tick = (now: number) => {
            setAngle(a => a + 2 * Math.PI * speed * (now - last) / 1000);
            last = now;
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [active, speed]);
    return angle;
}

export function SpatialSection() {
    useMusical();
    const p = getPrefs();
    const padRef = useRef<HTMLDivElement>(null);
    const angle = useOrbit(p.eightdMode === 1, p.eightdSpeed);

    function fromPointer(e: ReactPointerEvent) {
        const r = padRef.current!.getBoundingClientRect();
        const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
        const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
        setReverbParams({ reverbDistance: round2(1 - y) });
        if (p.eightdMode === 2) set8d({ eightdPos: round2(x) });
    }

    function resetPad() {
        setReverbParams({ reverbDistance: PREF_DEFAULTS.reverbDistance });
        if (p.eightdMode === 2) set8d({ eightdPos: 0.5 });
    }

    const dotX = p.eightdMode === 1 ? 50 + 42 * Math.sin(angle) : p.eightdMode === 2 ? p.eightdPos * 100 : 50;
    const dotY = (1 - p.reverbDistance) * 100;

    return (
        <Section title="Spatialisation 8D">
            <div className={cl("chips")} role="radiogroup" aria-label="Mode 8D">
                {MODES.map(m => (
                    <button
                        key={m.value}
                        role="radio"
                        aria-checked={p.eightdMode === m.value}
                        className={cl("chip", p.eightdMode === m.value && "chip-on")}
                        onClick={() => set8d({ eightdMode: m.value })}
                    >{m.label}</button>
                ))}
            </div>

            <div
                ref={padRef}
                className={cl("pad", p.eightdMode === 2 && "pad-manual")}
                onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); fromPointer(e); }}
                onPointerMove={e => { if (e.buttons) fromPointer(e); }}
                onDoubleClick={resetPad}
                title="Glisser le point · double-clic pour recentrer"
            >
                <span className={cl("pad-x")} />
                <span className={cl("pad-y")} />
                <span className={cl("pad-label", "pad-l")}>G</span>
                <span className={cl("pad-label", "pad-r")}>D</span>
                <span className={cl("pad-label", "pad-t")}>loin</span>
                <span className={cl("pad-label", "pad-b")}>proche</span>
                <span className={cl("pad-dot")} style={{ left: `${dotX}%`, top: `${dotY}%` }} />
            </div>

            {p.eightdMode === 1 && (
                <Slider
                    label="Vitesse de rotation" value={p.eightdSpeed} display={`${p.eightdSpeed.toFixed(2)} Hz`}
                    min={0.02} max={1} step={0.01} reset={PREF_DEFAULTS.eightdSpeed}
                    onChange={v => set8d({ eightdSpeed: v })}
                />
            )}
            {p.eightdMode === 2 && (
                <Slider
                    label="Position" value={p.eightdPos}
                    display={p.eightdPos < 0.45 ? "gauche" : p.eightdPos > 0.55 ? "droite" : "centre"}
                    min={0} max={1} step={0.01} reset={0.5}
                    onChange={v => set8d({ eightdPos: v })}
                />
            )}
            <p className={cl("note")}>
                Gauche → droite : position du son (Auto le fait tourner, Manuel le place au point).
                Haut → bas : distance de la réverbe. Double-clic dans le carré pour recentrer.
            </p>

            <div className={cl("toggle-row")}>
                <div>
                    <div className={cl("toggle-name")}>Réverbe</div>
                    <div className={cl("toggle-desc")}>Ambiance de salle stéréo</div>
                </div>
                <span className={cl("head-actions")}>
                    {p.reverb && (
                        <button className={cl("mini")} onClick={() => setReverbParams({ reverbRoom: PREF_DEFAULTS.reverbRoom, reverbDistance: PREF_DEFAULTS.reverbDistance })}>
                            Reset
                        </button>
                    )}
                    <Toggle on={p.reverb} label="Réverbe" onChange={setReverb} />
                </span>
            </div>
            {p.reverb && (
                <>
                    <Slider
                        label="Taille de la salle" value={p.reverbRoom} display={pct(p.reverbRoom)}
                        min={0} max={1} step={0.01} reset={PREF_DEFAULTS.reverbRoom}
                        onChange={v => setReverbParams({ reverbRoom: v })}
                    />
                    <Slider
                        label="Distance" value={p.reverbDistance} display={pct(p.reverbDistance)}
                        min={0} max={1} step={0.01} reset={PREF_DEFAULTS.reverbDistance}
                        onChange={v => setReverbParams({ reverbDistance: v })}
                    />
                </>
            )}
        </Section>
    );
}

export function EqSection() {
    useMusical();
    const p = getPrefs();
    const presets = [...Object.keys(EQ_PRESETS), ...(p.eqCustom ? [EQ_CUSTOM] : [])];
    const known = presets.includes(p.eqPreset);

    function setBand(i: number, v: number) {
        const bands = [...p.eq];
        bands[i] = v;
        setEq(bands, EQ_CUSTOM);
    }

    return (
        <Section
            title="Égaliseur"
            extra={
                <span className={cl("head-actions")}>
                    <button className={cl("mini")} onClick={saveEqCustom} title="Enregistrer ces bandes comme préréglage « Perso »">Enregistrer</button>
                    <button className={cl("mini")} onClick={() => applyEqPreset("Flat")}>Reset EQ</button>
                </span>
            }
        >
            <select className={cl("select")} value={known ? p.eqPreset : ""} onChange={e => applyEqPreset(e.currentTarget.value)}>
                {!known && <option value="" disabled>Perso (non enregistré)</option>}
                {presets.map(name => <option key={name} value={name}>{name}</option>)}
            </select>
            <div className={cl("eq")}>
                {EQ_LABELS.map((label, i) => (
                    <label key={label} className={cl("eq-band")}>
                        <span className={cl("eq-value")}>{p.eq[i] > 0 ? "+" : ""}{p.eq[i]}</span>
                        <input
                            type="range" min={-12} max={12} step={1} value={p.eq[i]}
                            aria-label={`${label} Hz`}
                            onChange={e => setBand(i, Number(e.currentTarget.value))}
                            onDoubleClick={() => setBand(i, 0)}
                            title="Double-clic : 0 dB"
                        />
                        <span className={cl("eq-freq")}>{label}</span>
                    </label>
                ))}
            </div>
            <p className={cl("note")}>De −12 à +12 dB par bande. Toucher une bande passe en « Perso » ; Enregistrer le garde comme préréglage.</p>
        </Section>
    );
}
