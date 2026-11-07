/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-musical — blocs « Signal », « Égaliseur » et « Espace » du panneau.
// Tout s'applique en direct et reste mémorisé pour les prochaines connexions.
//
// Le carré de l'espace règle deux choses avec un seul point :
//  - gauche → droite : position du son (Manuel ; il tourne seul en Auto) ;
//  - haut → bas : distance de la réverbe (haut = loin, bas = proche).

import { useEffect, useRef, useState } from "@webpack/common";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";

import { Card, Chip, cl, Dropdown, Group, Segmented, Slider, ToggleRow } from "./controls";
import {
    applyEqPreset, DEFAULT_INPUT, devices, EQ_CUSTOM, EQ_LABELS, EQ_PRESETS, getPrefs, isActive, PREF_DEFAULTS,
    saveEqCustom, set8d, setBitrate, setEq, setGain, setInput, setLatency, setProcessing, setReverb, setReverbParams,
    useMusical,
} from "./engine";

type Act = (fn: () => Promise<unknown>) => void;

const pct = (v: number) => `${Math.round(v * 100)} %`;
const round2 = (v: number) => Math.round(v * 100) / 100;
const signed = (v: number, unit: string) => `${v > 0 ? "+" : ""}${v} ${unit}`;

const icon = (d: string) => (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={d} />
    </svg>
);

const RefreshIcon = () => icon("M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6");

// ── Signal ──────────────────────────────────────────────────────────────────

export function SignalCard({ act }: { act: Act; }) {
    const music = useMusical();
    const p = getPrefs();
    const [inputs, setInputs] = useState<string[] | null>(null);

    const loadInputs = () => act(() => devices().then(setInputs));
    useEffect(() => { if (music.running && !inputs) loadInputs(); }, [music.running]);

    const connected = music.running && Object.values(music.accounts).some(isActive);
    const resetProcessing = () => setProcessing({
        highpass: PREF_DEFAULTS.highpass, width: PREF_DEFAULTS.width, saturation: PREF_DEFAULTS.saturation,
        compressor: PREF_DEFAULTS.compressor, compAmount: PREF_DEFAULTS.compAmount, limiter: PREF_DEFAULTS.limiter,
    });

    return (
        <Card
            title="Signal"
            className={cl("card-signal")}
            icon={icon("M2 12h3l3-8 4 16 3-8h7")}
            extra={<button type="button" className={cl("icon-btn", "icon-btn-sm")} disabled={!music.running} onClick={loadInputs} title="Rafraîchir les sources"><RefreshIcon /></button>}
        >
            <Group title="Source">
                <Dropdown
                    value={p.source ?? ""}
                    placeholder={connected ? "Aucune source (silence)" : "Connecte un compte d'abord"}
                    disabled={!connected || !inputs}
                    choices={[
                        { value: DEFAULT_INPUT, label: "Entrée par défaut" },
                        ...(inputs ?? []).map(n => ({ value: n, label: n })),
                        ...(p.source && p.source !== DEFAULT_INPUT && inputs && !inputs.includes(p.source)
                            ? [{ value: p.source, label: `${p.source} (absent)`, disabled: true }]
                            : []),
                    ]}
                    onChange={v => act(() => setInput(v))}
                />
                {music.captureError && <p className={cl("error-line")}>{music.captureError}</p>}
                <Slider label="Gain" value={p.gain} display={signed(p.gain, "dB")} min={-64} max={64} step={1} reset={PREF_DEFAULTS.gain} onChange={setGain} center />
            </Group>

            <Group title="Diffusion">
                <Slider label="Débit Opus" value={p.bitrate} display={`${p.bitrate} kbps`} min={32} max={512} step={8} reset={PREF_DEFAULTS.bitrate} onChange={setBitrate} />
                <Slider label="Latence" value={p.latency} display={`${p.latency} ms`} min={40} max={1000} step={10} reset={PREF_DEFAULTS.latency} onChange={setLatency} />
            </Group>

            <Group title="Traitement">
                <Slider
                    label="Coupe-bas" value={p.highpass} display={p.highpass < 20 ? "off" : `${p.highpass} Hz`}
                    min={0} max={300} step={10} reset={PREF_DEFAULTS.highpass} onChange={v => setProcessing({ highpass: v < 20 ? 0 : v })}
                />
                <Slider
                    label="Largeur stéréo" value={p.width} display={p.width === 0 ? "mono" : pct(p.width)}
                    min={0} max={2} step={0.05} reset={PREF_DEFAULTS.width} onChange={v => setProcessing({ width: v })}
                />
                <Slider
                    label="Saturation" value={p.saturation} display={p.saturation === 0 ? "off" : pct(p.saturation)}
                    min={0} max={1} step={0.05} reset={PREF_DEFAULTS.saturation} onChange={v => setProcessing({ saturation: v })}
                />
                <div className={cl("chips")}>
                    <Chip on={p.compressor} onClick={() => setProcessing({ compressor: !p.compressor })} title="Rapproche les passages forts et faibles">Compresseur</Chip>
                    <Chip on={p.limiter} onClick={() => setProcessing({ limiter: !p.limiter })} title="Empêche le son de saturer (plafond à −1 dB)">Limiteur</Chip>
                    <Chip onClick={resetProcessing} title="Remettre le traitement par défaut">Reset</Chip>
                </div>
                {p.compressor && (
                    <Slider
                        label="Intensité du compresseur" value={p.compAmount} display={pct(p.compAmount)}
                        min={0} max={1} step={0.05} reset={PREF_DEFAULTS.compAmount} onChange={v => setProcessing({ compAmount: v })}
                    />
                )}
            </Group>
        </Card>
    );
}

// ── Égaliseur ───────────────────────────────────────────────────────────────

export function EqCard() {
    useMusical();
    const p = getPrefs();
    const presets = [...Object.keys(EQ_PRESETS), ...(p.eqCustom ? [EQ_CUSTOM] : [])];

    function setBand(i: number, v: number) {
        const bands = [...p.eq];
        bands[i] = v;
        setEq(bands, EQ_CUSTOM);
    }

    return (
        <Card
            title="Égaliseur"
            className={cl("card-eq")}
            icon={icon("M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6")}
            extra={
                <span className={cl("card-actions")}>
                    <button type="button" className={cl("link")} onClick={saveEqCustom} title="Garder ces bandes comme préréglage « Perso »">Enregistrer</button>
                    <button type="button" className={cl("link")} onClick={() => applyEqPreset("Flat")}>Reset</button>
                </span>
            }
        >
            <div className={cl("chips", "chips-grid")}>
                {presets.map(name => (
                    <Chip key={name} on={p.eqPreset === name} onClick={() => applyEqPreset(name)}>{name}</Chip>
                ))}
            </div>

            <div className={cl("eq")}>
                <div className={cl("eq-scale")}>
                    <span>+12</span>
                    <span>0</span>
                    <span>−12</span>
                </div>
                {EQ_LABELS.map((label, i) => {
                    const from = 50, to = ((p.eq[i] + 12) / 24) * 100;
                    const style = { "--from": `${Math.min(from, to)}%`, "--to": `${Math.max(from, to)}%` } as CSSProperties;
                    return (
                        <label key={label} className={cl("eq-band")}>
                            <span className={cl("eq-value", p.eq[i] !== 0 && "eq-value-on")}>{p.eq[i] > 0 ? "+" : ""}{p.eq[i]}</span>
                            <input
                                type="range" min={-12} max={12} step={1} value={p.eq[i]} style={style}
                                aria-label={`${label} Hz`}
                                onChange={e => setBand(i, Number(e.currentTarget.value))}
                                onDoubleClick={() => setBand(i, 0)}
                                title="Double-clic : 0 dB"
                            />
                            <span className={cl("eq-freq")}>{label}</span>
                        </label>
                    );
                })}
            </div>
            <p className={cl("hint")}>
                {p.eqPreset === EQ_CUSTOM && !p.eqCustom ? "Perso — pas encore enregistré." : "Toucher une bande passe en Perso. Double-clic : 0 dB."}
            </p>
        </Card>
    );
}

// ── Espace (8D + réverbe) ───────────────────────────────────────────────────

const MODES = [
    { value: 0, label: "Off" },
    { value: 1, label: "Auto" },
    { value: 2, label: "Manuel" },
] as const;

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

export function SpaceCard() {
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
        <Card title="Espace" className={cl("card-space")} icon={icon("M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z")}>
            <Segmented label="Mode 8D" value={p.eightdMode} options={MODES} onChange={m => set8d({ eightdMode: m })} />

            <div
                ref={padRef}
                className={cl("pad", p.eightdMode === 2 && "pad-manual")}
                onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); fromPointer(e); }}
                onPointerMove={e => { if (e.buttons) fromPointer(e); }}
                onDoubleClick={resetPad}
                title="Glisser le point · double-clic pour recentrer"
            >
                <span className={cl("pad-ring", "pad-ring-1")} />
                <span className={cl("pad-ring", "pad-ring-2")} />
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
                    min={0.02} max={1} step={0.01} reset={PREF_DEFAULTS.eightdSpeed} onChange={v => set8d({ eightdSpeed: v })}
                />
            )}
            {p.eightdMode === 2 && (
                <Slider
                    label="Position" value={p.eightdPos} display={p.eightdPos < 0.45 ? "gauche" : p.eightdPos > 0.55 ? "droite" : "centre"}
                    min={0} max={1} step={0.01} reset={0.5} onChange={v => set8d({ eightdPos: v })}
                />
            )}

            <ToggleRow name="Réverbe" desc="Ambiance de salle stéréo" on={p.reverb} onChange={setReverb} />
            {p.reverb && (
                <>
                    <Slider
                        label="Taille de la salle" value={p.reverbRoom} display={pct(p.reverbRoom)}
                        min={0} max={1} step={0.01} reset={PREF_DEFAULTS.reverbRoom} onChange={v => setReverbParams({ reverbRoom: v })}
                    />
                    <Slider
                        label="Distance" value={p.reverbDistance} display={pct(p.reverbDistance)}
                        min={0} max={1} step={0.01} reset={PREF_DEFAULTS.reverbDistance} onChange={v => setReverbParams({ reverbDistance: v })}
                    />
                </>
            )}
        </Card>
    );
}
