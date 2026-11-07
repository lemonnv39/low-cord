/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-musical — blocs « Signal », « Égaliseur » et « Espace » du panneau.
// Signal : profils de traitement (Naturel, Radio, Club, Ultra fort), les
// interrupteurs principaux, la réduction de gain en direct, et les réglages
// fins repliés par défaut pour garder un panneau épuré.
// Tout s'applique en direct et reste mémorisé pour les prochaines connexions.
//
// Espace : la pièce vue de dessus (toi au centre, devant en haut) ; le point
// montre la position réellement jouée par le moteur.

import { useEffect, useRef, useState } from "@webpack/common";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";

import { Card, Chip, cl, Dropdown, Group, Segmented, Slider, ToggleRow } from "./controls";
import {
    applyEqPreset, applyProfile, DEFAULT_INPUT, devices, EQ_CUSTOM, EQ_LABELS, EQ_PRESETS, getMeter, getPrefs, isActive,
    PREF_DEFAULTS, PROFILES, saveEqCustom, savePrefs, setBitrate, setEq, setGain, setInput, setLatency,
    setProcessing, setSpace, useMusical,
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

const COMP_MODES = [
    { value: 0, label: "Propre", title: "Léger : colle le son sans qu'on l'entende travailler" },
    { value: 1, label: "Fort", title: "Fort et propre : tient le niveau très haut" },
    { value: 2, label: "Punch", title: "Laisse passer les coups de batterie avant de compresser" },
] as const;

const STEREO_MODES = [
    { value: 0, label: "Stéréo" },
    { value: 1, label: "Mono" },
    { value: 2, label: "Inversé" },
] as const;

const off = (v: number, text: string) => v === 0 ? "off" : text;

/** Réduction de gain du compresseur et du limiteur, en direct (barres). */
function ReductionMeter() {
    const compRef = useRef<HTMLSpanElement>(null);
    const limitRef = useRef<HTMLSpanElement>(null);
    const compText = useRef<HTMLSpanElement>(null);
    const limitText = useRef<HTMLSpanElement>(null);

    useEffect(() => {
        const win = compRef.current!.ownerDocument.defaultView!;
        let raf = 0;
        let comp = 0, limit = 0;
        const draw = () => {
            raf = win.requestAnimationFrame(draw);
            const m = getMeter();
            const fresh = m && performance.now() - m.at < 400;
            // Montée immédiate, retour doux : lisible à l'œil.
            const c = fresh ? m!.comp : 0, l = fresh ? m!.limit : 0;
            comp = c > comp ? c : comp + (c - comp) * 0.08;
            limit = l > limit ? l : limit + (l - limit) * 0.08;
            compRef.current!.style.width = `${Math.min(100, comp / 24 * 100)}%`;
            limitRef.current!.style.width = `${Math.min(100, limit / 12 * 100)}%`;
            compText.current!.textContent = `−${comp.toFixed(1)} dB`;
            limitText.current!.textContent = `−${limit.toFixed(1)} dB`;
        };
        raf = win.requestAnimationFrame(draw);
        return () => win.cancelAnimationFrame(raf);
    }, []);

    return (
        <div className={cl("gr")} title="Combien le compresseur et le limiteur baissent le son en ce moment">
            <div className={cl("gr-row")}>
                <span>Compression</span>
                <span className={cl("gr-track")}><span ref={compRef} className={cl("gr-fill")} /></span>
                <span ref={compText} className={cl("gr-value")} />
            </div>
            <div className={cl("gr-row")}>
                <span>Limiteur</span>
                <span className={cl("gr-track")}><span ref={limitRef} className={cl("gr-fill", "gr-fill-limit")} /></span>
                <span ref={limitText} className={cl("gr-value")} />
            </div>
        </div>
    );
}

export function SignalCard({ act }: { act: Act; }) {
    const music = useMusical();
    const p = getPrefs();
    const [inputs, setInputs] = useState<string[] | null>(null);
    const [fine, setFine] = useState(false);

    const loadInputs = () => act(() => devices().then(setInputs));
    useEffect(() => { if (music.running && !inputs) loadInputs(); }, [music.running]);

    const connected = music.running && Object.values(music.accounts).some(isActive);

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

            <Group title="Son">
                <div className={cl("chips", "chips-grid-2")}>
                    {Object.entries(PROFILES).map(([name, profile]) => (
                        <Chip key={name} on={p.profile === name} onClick={() => applyProfile(name)} title={profile.desc}>{name}</Chip>
                    ))}
                </div>
                <div className={cl("chips")}>
                    <Chip on={p.compressor} onClick={() => setProcessing({ compressor: !p.compressor })} title="Rapproche les passages forts et faibles, sans baisser le son">Compresseur</Chip>
                    <Chip on={p.multiband} onClick={() => setProcessing({ multiband: !p.multiband })} title="Compression séparée des graves, médiums et aigus">Multibande</Chip>
                    <Chip on={p.agc} onClick={() => setProcessing({ agc: !p.agc })} title="Monte les morceaux trop faibles, baisse les trop forts">Nivellement</Chip>
                    <Chip on={p.limiter} onClick={() => setProcessing({ limiter: !p.limiter })} title="Le son ne dépasse jamais −1 dB : aucune saturation">Limiteur</Chip>
                    <Chip on={p.gate} onClick={() => setProcessing({ gate: !p.gate })} title="Coupe le léger souffle du câble virtuel quand la musique s'arrête">Anti-souffle</Chip>
                </div>
                {p.compressor && (
                    <>
                        <Segmented label="Mode du compresseur" value={p.compMode} options={COMP_MODES} onChange={m => setProcessing({ compMode: m })} />
                        <Slider
                            label="Intensité" value={p.compAmount} display={pct(p.compAmount)}
                            min={0} max={1} step={0.05} reset={PREF_DEFAULTS.compAmount} onChange={v => setProcessing({ compAmount: v })}
                        />
                    </>
                )}
                <ReductionMeter />
            </Group>

            <button type="button" className={cl("fold", fine && "fold-open")} onClick={() => setFine(!fine)} aria-expanded={fine}>
                <span>Réglages fins</span>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
            </button>
            {fine && (
                <>
                    <Group title="Diffusion">
                        <Slider label="Débit Opus" value={p.bitrate} display={`${p.bitrate} kbps`} min={32} max={512} step={8} reset={PREF_DEFAULTS.bitrate} onChange={v => { savePrefs({ autoBitrate: false }); setBitrate(v); }} />
                        <div className={cl("chips")}>
                            <Chip on={p.autoBitrate} onClick={() => savePrefs({ autoBitrate: !p.autoBitrate })} title="Règle le débit au maximum que permet ta vocale">Débit auto (salon)</Chip>
                        </div>
                    </Group>
                    <Group title="Couleur">
                        <Slider label="Basses+" value={p.bassPlus} display={off(p.bassPlus, pct(p.bassPlus))} min={0} max={1} step={0.05} reset={0} onChange={v => setProcessing({ bassPlus: v })} />
                        <Slider label="Clarté" value={p.clarity} display={off(p.clarity, pct(p.clarity))} min={0} max={1} step={0.05} reset={0} onChange={v => setProcessing({ clarity: v })} />
                        <Slider label="Dé-esseur" value={p.deesser} display={off(p.deesser, pct(p.deesser))} min={0} max={1} step={0.05} reset={0} onChange={v => setProcessing({ deesser: v })} />
                        <Slider label="Saturation" value={p.saturation} display={off(p.saturation, pct(p.saturation))} min={0} max={1} step={0.05} reset={0} onChange={v => setProcessing({ saturation: v })} />
                    </Group>
                    <Group title="Dynamique">
                        <Slider label="Multibande" value={p.mbAmount} display={pct(p.mbAmount)} min={0} max={1} step={0.05} reset={PREF_DEFAULTS.mbAmount} onChange={v => setProcessing({ mbAmount: v })} />
                        <Slider label="Écrêteur doux" value={p.clipper} display={off(p.clipper, pct(p.clipper))} min={0} max={1} step={0.05} reset={0} onChange={v => setProcessing({ clipper: v })} />
                        <Slider label="Niveau visé (nivellement)" value={p.agcTarget} display={`${p.agcTarget} dB`} min={-30} max={-8} step={1} reset={PREF_DEFAULTS.agcTarget} onChange={v => setProcessing({ agcTarget: v })} />
                        <Slider label="Seuil anti-souffle" value={p.gateThreshold} display={`${p.gateThreshold} dB`} min={-90} max={-20} step={1} reset={PREF_DEFAULTS.gateThreshold} onChange={v => setProcessing({ gateThreshold: v })} />
                    </Group>
                    <Group title="Stéréo">
                        <Segmented label="Mode stéréo" value={p.stereoMode} options={STEREO_MODES} onChange={m => setProcessing({ stereoMode: m })} />
                        <Slider label="Balance" value={p.balance} display={p.balance === 0 ? "centre" : p.balance < 0 ? `G ${pct(-p.balance)}` : `D ${pct(p.balance)}`} min={-1} max={1} step={0.05} reset={0} onChange={v => setProcessing({ balance: v })} center />
                        <Slider label="Largeur" value={p.width} display={p.width === 0 ? "mono" : pct(p.width)} min={0} max={2} step={0.05} reset={PREF_DEFAULTS.width} onChange={v => setProcessing({ width: v })} />
                        <Slider label="Graves en mono" value={p.bassMono} display={p.bassMono < 20 ? "off" : `< ${p.bassMono} Hz`} min={0} max={250} step={10} reset={0} onChange={v => setProcessing({ bassMono: v < 20 ? 0 : v })} />
                    </Group>
                    <Group title="Filtre & latence">
                        <Slider label="Coupe-bas" value={p.highpass} display={p.highpass < 20 ? "off" : `${p.highpass} Hz`} min={0} max={300} step={10} reset={0} onChange={v => setProcessing({ highpass: v < 20 ? 0 : v })} />
                        <Slider label="Latence" value={p.latency} display={`${p.latency} ms`} min={40} max={1000} step={10} reset={PREF_DEFAULTS.latency} onChange={setLatency} />
                    </Group>
                </>
            )}
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

// ── Espace (position 360°, mouvement, pièce) ────────────────────────────────

const SPACE_MODES = [
    { value: 0, label: "Off", title: "Le son tel quel, sans position" },
    { value: 1, label: "Auto", title: "Le son se déplace tout seul autour de toi" },
    { value: 2, label: "Manuel", title: "Place le son où tu veux dans la pièce" },
] as const;

const MOTIONS: { value: 0 | 1 | 2 | 3 | 4; label: string; title: string; }[] = [
    { value: 0, label: "Orbite", title: "Tour complet de la tête : devant, droite, derrière, gauche" },
    { value: 1, label: "Ping-pong", title: "Gauche ↔ droite, devant toi" },
    { value: 2, label: "Avant / arrière", title: "Passe devant puis derrière toi" },
    { value: 3, label: "Spirale", title: "Orbite qui s'approche et s'éloigne" },
    { value: 4, label: "Chaos", title: "Trajectoire imprévisible" },
];

const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));

/**
 * La pièce vue de dessus : toi au centre, devant en haut. Le point montre la
 * position RÉELLEMENT jouée par le moteur (mesures en direct) ; en Manuel on
 * le place, en Auto on règle la distance du mouvement en tirant.
 */
function RoomPad() {
    useMusical();
    const p = getPrefs();
    const padRef = useRef<HTMLDivElement>(null);
    const dotRef = useRef<HTMLSpanElement>(null);

    // Point animé hors React (20 mesures/s lissées à l'écran).
    useEffect(() => {
        const pad = padRef.current!;
        const win = pad.ownerDocument.defaultView!;
        let raf = 0;
        let x = 0, y = 0.5;
        const draw = () => {
            raf = win.requestAnimationFrame(draw);
            const prefs = getPrefs();
            const m = getMeter();
            const live = m?.pos && performance.now() - m.at < 400 ? m.pos : null;
            const target = live ?? (prefs.spaceMode === 2 ? [prefs.posX, prefs.posY] : prefs.spaceMode === 1 ? [0, prefs.radius] : [0, 0]);
            x += (target[0] - x) * 0.25;
            y += (target[1] - y) * 0.25;
            const dot = dotRef.current!;
            dot.style.left = `${50 + x * 46}%`;
            dot.style.top = `${50 - y * 46}%`;
            dot.style.opacity = prefs.spaceMode === 0 ? "0.25" : "1";
        };
        raf = win.requestAnimationFrame(draw);
        return () => win.cancelAnimationFrame(raf);
    }, []);

    function fromPointer(e: ReactPointerEvent) {
        const r = padRef.current!.getBoundingClientRect();
        const x = clamp1(((e.clientX - r.left) / r.width - 0.5) / 0.46);
        const y = clamp1((0.5 - (e.clientY - r.top) / r.height) / 0.46);
        if (getPrefs().spaceMode === 1) setSpace({ radius: round2(Math.min(1, Math.hypot(x, y))) });
        else setSpace({ spaceMode: 2, posX: round2(x), posY: round2(y) });
    }

    return (
        <div
            ref={padRef}
            className={cl("pad", p.spaceMode === 2 && "pad-manual")}
            onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); fromPointer(e); }}
            onPointerMove={e => { if (e.buttons) fromPointer(e); }}
            onDoubleClick={() => setSpace({ posX: PREF_DEFAULTS.posX, posY: PREF_DEFAULTS.posY, radius: PREF_DEFAULTS.radius })}
            title={p.spaceMode === 1 ? "Tirer pour régler la distance · double-clic pour revenir" : "Placer le son · double-clic pour revenir devant"}
        >
            <span className={cl("pad-ring", "pad-ring-1")} />
            <span className={cl("pad-ring", "pad-ring-2")} />
            {p.spaceMode === 1 && <span className={cl("pad-orbit")} style={{ width: `${p.radius * 92}%`, height: `${p.radius * 92}%` }} />}
            <span className={cl("pad-x")} />
            <span className={cl("pad-y")} />
            <span className={cl("pad-label", "pad-t")}>devant</span>
            <span className={cl("pad-label", "pad-b")}>derrière</span>
            <span className={cl("pad-label", "pad-l")}>G</span>
            <span className={cl("pad-label", "pad-r")}>D</span>
            {/* Toi, vu de dessus (le nez vers l'avant). */}
            <svg className={cl("pad-head")} viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 3.5 14.2 7H9.8z" fill="currentColor" />
                <circle cx="12" cy="13" r="6" fill="none" stroke="currentColor" strokeWidth="1.8" />
            </svg>
            <span ref={dotRef} className={cl("pad-dot")} />
        </div>
    );
}

export function SpaceCard() {
    useMusical();
    const p = getPrefs();

    return (
        <Card title="Espace" className={cl("card-space")} icon={icon("M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z")}>
            <Segmented label="Espace" value={p.spaceMode} options={SPACE_MODES} onChange={m => setSpace({ spaceMode: m })} />

            {p.spaceMode === 1 && (
                <div className={cl("chips")}>
                    {MOTIONS.map(m => (
                        <Chip key={m.value} on={p.motion === m.value} onClick={() => setSpace({ motion: m.value })} title={m.title}>{m.label}</Chip>
                    ))}
                </div>
            )}

            <RoomPad />

            {p.spaceMode === 1 && (
                <>
                    <Slider
                        label="Vitesse" value={p.speed} display={`${p.speed.toFixed(2)} tour/s`}
                        min={0.02} max={1} step={0.01} reset={PREF_DEFAULTS.speed} onChange={v => setSpace({ speed: v })}
                    />
                    <Slider
                        label="Distance" value={p.radius} display={pct(p.radius)}
                        min={0} max={1} step={0.01} reset={PREF_DEFAULTS.radius} onChange={v => setSpace({ radius: v })}
                    />
                </>
            )}
            {p.spaceMode !== 0 && (
                <Slider
                    label="Largeur de la source" value={p.spread} display={pct(p.spread)}
                    min={0} max={1} step={0.05} reset={PREF_DEFAULTS.spread} onChange={v => setSpace({ spread: v })}
                />
            )}

            <ToggleRow name="Pièce" desc="Réflexions et réverbe : plus le son est loin, plus elle s'entend" on={p.reverb} onChange={on => setSpace({ reverb: on })} />
            {p.reverb && (
                <>
                    <Slider
                        label="Taille de la pièce" value={p.room} display={pct(p.room)}
                        min={0} max={1} step={0.01} reset={PREF_DEFAULTS.room} onChange={v => setSpace({ room: v })}
                    />
                    <Slider
                        label="Quantité" value={p.mix} display={pct(p.mix)}
                        min={0} max={1} step={0.01} reset={PREF_DEFAULTS.mix} onChange={v => setSpace({ mix: v })}
                    />
                    {p.spaceMode === 0 && (
                        <Slider
                            label="Distance" value={p.radius} display={pct(p.radius)}
                            min={0} max={1} step={0.01} reset={PREF_DEFAULTS.radius} onChange={v => setSpace({ radius: v })}
                        />
                    )}
                </>
            )}
        </Card>
    );
}
