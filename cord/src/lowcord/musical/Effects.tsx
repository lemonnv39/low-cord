/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-musical — blocs « Signal », « Égaliseur » et « Espace » du panneau.
// Signal : tout est visible, rangé par catégorie (Source, Profil, Dynamique,
// Couleur, Stéréo, Nettoyage, Diffusion). Égaliseur : 10 bandes et, dessous,
// 3 molettes de tonalité avec leurs préréglages rapides.
// Tout s'applique en direct et reste mémorisé pour les prochaines connexions.
//
// Espace : la pièce vue de dessus (toi au centre, devant en haut) ; le point
// montre la position réellement jouée par le moteur.

import { useEffect, useRef, useState } from "@webpack/common";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";

import { Card, Chip, cl, Dropdown, Group, Knob, Segmented, Slider, ToggleRow } from "./controls";
import {
    applyEqPreset, applyProfile, DEFAULT_INPUT, devices, EQ_CUSTOM, EQ_LABELS, EQ_PRESETS, getMeter, getPrefs, isActive,
    PREF_DEFAULTS, PROFILES, resetSound, saveEqCustom, savePrefs, setBitrate, setEq, setGain, setInput, setLatency,
    setProcessing, setSpace, setTone, TONE_PRESETS, useMusical,
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
function ReductionMeter({ limiter }: { limiter: boolean; }) {
    const compRef = useRef<HTMLSpanElement>(null);
    const hotRef = useRef<HTMLParagraphElement>(null);
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
            // Plus de 6 dB retirés en permanence : le son arrive bien trop fort.
            hotRef.current!.hidden = limit < 6;
        };
        raf = win.requestAnimationFrame(draw);
        return () => win.cancelAnimationFrame(raf);
    }, []);

    return (
        <div className={cl("gr")} title={limiter
            ? "Combien le compresseur et le limiteur baissent le son en ce moment"
            : "Limiteur coupé : une protection empêche quand même le son de dépasser 0 dB (sinon il grésille dans Discord)"}>
            <div className={cl("gr-row")}>
                <span>Compression</span>
                <span className={cl("gr-track")}><span ref={compRef} className={cl("gr-fill")} /></span>
                <span ref={compText} className={cl("gr-value")} />
            </div>
            <div className={cl("gr-row")}>
                <span>{limiter ? "Limiteur" : "Protection"}</span>
                <span className={cl("gr-track")}><span ref={limitRef} className={cl("gr-fill", "gr-fill-limit")} /></span>
                <span ref={limitText} className={cl("gr-value")} />
            </div>
            <p ref={hotRef} className={cl("gr-hot")} hidden>Son trop fort : baisse le gain ou le volume.</p>
        </div>
    );
}

/** Lien « Reset all » : un premier clic demande confirmation, le second remet tout à zéro. */
function ResetAll() {
    const [ask, setAsk] = useState(false);
    useEffect(() => {
        if (!ask) return;
        const timer = setTimeout(() => setAsk(false), 3000);
        return () => clearTimeout(timer);
    }, [ask]);
    return (
        <button
            type="button"
            className={cl("link", ask && "link-danger")}
            onClick={() => { if (ask) { resetSound(); setAsk(false); } else setAsk(true); }}
            title="Remet tout le son à zéro : gain, traitement, égaliseur, tonalité, espace"
        >{ask ? "Confirmer ?" : "Reset all"}</button>
    );
}

export function SignalCard({ act }: { act: Act; }) {
    const music = useMusical();
    const p = getPrefs();
    const [inputs, setInputs] = useState<string[] | null>(null);

    // Liste rechargée à chaque ouverture du menu (casque branché entre-temps…).
    const loadInputs = () => { devices().then(setInputs).catch(() => { }); };
    useEffect(() => { if (music.running && !inputs) loadInputs(); }, [music.running]);

    const connected = music.running && Object.values(music.accounts).some(isActive);

    return (
        <Card
            title="Signal"
            className={cl("card-signal")}
            icon={icon("M2 12h3l3-8 4 16 3-8h7")}
            extra={<ResetAll />}
        >
            <Group title="Source">
                <Dropdown
                    value={p.source ?? ""}
                    placeholder={connected ? "Aucune source (silence)" : "Connecte un compte d'abord"}
                    disabled={!connected}
                    onOpen={loadInputs}
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

            <Group title="Profil">
                <div className={cl("chips", "chips-grid-2")}>
                    {Object.entries(PROFILES).map(([name, profile]) => (
                        <Chip key={name} on={p.profile === name} onClick={() => applyProfile(name)} title={profile.desc}>{name}</Chip>
                    ))}
                </div>
            </Group>

            <Group title="Dynamique">
                <div className={cl("chips")}>
                    <Chip on={p.compressor} onClick={() => setProcessing({ compressor: !p.compressor })} title="Rapproche les passages forts et faibles, sans baisser le son">Compresseur</Chip>
                    <Chip on={p.multiband} onClick={() => setProcessing({ multiband: !p.multiband })} title="Compression séparée des graves, médiums et aigus">Multibande</Chip>
                    <Chip on={p.agc} onClick={() => setProcessing({ agc: !p.agc })} title="Monte les morceaux trop faibles, baisse les trop forts">Nivellement</Chip>
                    <Chip on={p.limiter} onClick={() => setProcessing({ limiter: !p.limiter })} title="Le son ne dépasse jamais −1 dB. Coupé, une protection à 0 dB reste active pour éviter le grésillement">Limiteur</Chip>
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
                {p.multiband && <Slider label="Multibande" value={p.mbAmount} display={pct(p.mbAmount)} min={0} max={1} step={0.05} reset={PREF_DEFAULTS.mbAmount} onChange={v => setProcessing({ mbAmount: v })} />}
                {p.agc && <Slider label="Niveau visé" value={p.agcTarget} display={`${p.agcTarget} dB`} min={-30} max={-8} step={1} reset={PREF_DEFAULTS.agcTarget} onChange={v => setProcessing({ agcTarget: v })} />}
                <Slider label="Écrêteur doux" value={p.clipper} display={off(p.clipper, pct(p.clipper))} min={0} max={1} step={0.05} reset={0} onChange={v => setProcessing({ clipper: v })} />
                <ReductionMeter limiter={p.limiter} />
            </Group>

            <Group title="Couleur">
                <Slider label="Basses+" value={p.bassPlus} display={off(p.bassPlus, pct(p.bassPlus))} min={0} max={1} step={0.05} reset={0} onChange={v => setProcessing({ bassPlus: v })} />
                <Slider label="Clarté" value={p.clarity} display={off(p.clarity, pct(p.clarity))} min={0} max={1} step={0.05} reset={0} onChange={v => setProcessing({ clarity: v })} />
                <Slider label="Saturation" value={p.saturation} display={off(p.saturation, pct(p.saturation))} min={0} max={1} step={0.05} reset={0} onChange={v => setProcessing({ saturation: v })} />
            </Group>

            <Group title="Stéréo">
                <Segmented label="Mode stéréo" value={p.stereoMode} options={STEREO_MODES} onChange={m => setProcessing({ stereoMode: m })} />
                <Slider label="Balance" value={p.balance} display={p.balance === 0 ? "centre" : p.balance < 0 ? `G ${pct(-p.balance)}` : `D ${pct(p.balance)}`} min={-1} max={1} step={0.05} reset={0} onChange={v => setProcessing({ balance: v })} center />
                <Slider label="Largeur" value={p.width} display={p.width === 0 ? "mono" : pct(p.width)} min={0} max={2} step={0.05} reset={PREF_DEFAULTS.width} onChange={v => setProcessing({ width: v })} />
                <Slider label="Graves en mono" value={p.bassMono} display={p.bassMono < 20 ? "off" : `< ${p.bassMono} Hz`} min={0} max={250} step={10} reset={0} onChange={v => setProcessing({ bassMono: v < 20 ? 0 : v })} />
            </Group>

            <Group title="Nettoyage">
                <div className={cl("chips")}>
                    <Chip on={p.gate} onClick={() => setProcessing({ gate: !p.gate })} title="Coupe le léger souffle du câble virtuel quand la musique s'arrête">Anti-souffle</Chip>
                </div>
                {p.gate && <Slider label="Seuil anti-souffle" value={p.gateThreshold} display={`${p.gateThreshold} dB`} min={-90} max={-20} step={1} reset={PREF_DEFAULTS.gateThreshold} onChange={v => setProcessing({ gateThreshold: v })} />}
                <Slider label="Dé-esseur" value={p.deesser} display={off(p.deesser, pct(p.deesser))} min={0} max={1} step={0.05} reset={0} onChange={v => setProcessing({ deesser: v })} />
                <Slider label="Coupe-bas" value={p.highpass} display={p.highpass < 20 ? "off" : `${p.highpass} Hz`} min={0} max={300} step={10} reset={0} onChange={v => setProcessing({ highpass: v < 20 ? 0 : v })} />
            </Group>

            <Group title="Diffusion">
                <Slider label="Débit Opus" value={p.bitrate} display={`${p.bitrate} kbps`} min={32} max={512} step={8} reset={PREF_DEFAULTS.bitrate} onChange={v => { savePrefs({ autoBitrate: false }); setBitrate(v); }} />
                <div className={cl("chips")}>
                    <Chip on={p.autoBitrate} onClick={() => savePrefs({ autoBitrate: !p.autoBitrate })} title="Règle le débit au maximum que permet ta vocale">Débit auto (salon)</Chip>
                </div>
                <Slider label="Latence" value={p.latency} display={`${p.latency} ms`} min={40} max={1000} step={10} reset={PREF_DEFAULTS.latency} onChange={setLatency} />
            </Group>
        </Card>
    );
}

// ── Égaliseur ───────────────────────────────────────────────────────────────

/**
 * Spectre du son en direct derrière les bandes, aux mêmes fréquences (échelle
 * logarithmique de 31 Hz à 16 kHz) : on voit ce que chaque bande touche.
 */
function EqSpectrum() {
    const ref = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = ref.current!;
        const win = canvas.ownerDocument.defaultView!;
        const ctx = canvas.getContext("2d")!;
        const smooth = new Float32Array(24);
        // Fréquence de chaque mesure (24 bandes de 40 Hz à 16 kHz) → position 0..1 sur les colonnes.
        const xs = Array.from({ length: 24 }, (_, i) => {
            const f = 40 * Math.pow(400, i / 23);
            const t = Math.log(f / 31) / Math.log(16000 / 31);
            return (0.5 + t * 9) / 10;
        });
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
            for (let i = 0; i < 24; i++) {
                const v = fresh ? m!.bands[i] ?? 0 : 0;
                smooth[i] += (v - smooth[i]) * (v > smooth[i] ? 0.5 : 0.1);
            }
            if (smooth.every(v => v < 0.01)) return;
            const y = (v: number) => h - v * h * 0.92;
            ctx.beginPath();
            ctx.moveTo(xs[0] * w, h);
            ctx.lineTo(xs[0] * w, y(smooth[0]));
            for (let i = 1; i < 24; i++) {
                const cx = (xs[i - 1] + xs[i]) / 2 * w;
                ctx.quadraticCurveTo(xs[i - 1] * w, y(smooth[i - 1]), cx, (y(smooth[i - 1]) + y(smooth[i])) / 2);
            }
            ctx.lineTo(xs[23] * w, y(smooth[23]));
            ctx.lineTo(xs[23] * w, h);
            ctx.closePath();
            const grad = ctx.createLinearGradient(0, 0, 0, h);
            grad.addColorStop(0, "rgba(255,255,255,0.16)");
            grad.addColorStop(1, "rgba(255,255,255,0.02)");
            ctx.fillStyle = grad;
            ctx.fill();
        };
        raf = win.requestAnimationFrame(draw);
        return () => win.cancelAnimationFrame(raf);
    }, []);

    return <canvas ref={ref} className={cl("eq-spectrum")} aria-hidden="true" />;
}

/** Module de tonalité sous l'égaliseur : 3 molettes, préréglages rapides, reset. */
function ToneModule() {
    useMusical();
    const p = getPrefs();
    const current = Object.entries(TONE_PRESETS).find(([, v]) => v[0] === p.bass && v[1] === p.mid && v[2] === p.treble)?.[0];
    const flat = p.bass === 0 && p.mid === 0 && p.treble === 0;

    return (
        <div className={cl("tone")}>
            <div className={cl("tone-head")}>
                <span className={cl("group-title")}>Tonalité</span>
                <button type="button" className={cl("link")} disabled={flat} onClick={() => setTone({ bass: 0, mid: 0, treble: 0 })}>Reset</button>
            </div>
            <div className={cl("tone-knobs")}>
                <Knob label="Graves" value={p.bass} min={-12} max={12} step={0.5} reset={0} onChange={v => setTone({ bass: v })} />
                <Knob label="Médiums" value={p.mid} min={-12} max={12} step={0.5} reset={0} onChange={v => setTone({ mid: v })} />
                <Knob label="Aigus" value={p.treble} min={-12} max={12} step={0.5} reset={0} onChange={v => setTone({ treble: v })} />
            </div>
            <div className={cl("chips", "chips-grid")}>
                {Object.entries(TONE_PRESETS).map(([name, [bass, mid, treble]]) => (
                    <Chip key={name} on={current === name} onClick={() => setTone({ bass, mid, treble })}>{name}</Chip>
                ))}
            </div>
        </div>
    );
}

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
                <EqSpectrum />
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
                            <span className={cl("eq-value", p.eq[i] !== 0 && "eq-value-on")}>{p.eq[i] > 0 ? "+" : ""}{Number.isInteger(p.eq[i]) ? p.eq[i] : p.eq[i].toFixed(1)}</span>
                            <input
                                type="range" min={-12} max={12} step={0.5} value={p.eq[i]} style={style}
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
            <ToneModule />
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
