/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-musical — volet « Mini APO », ouvert par l'onglet sur le côté du
// panneau. On y colle (ou importe) un set Equalizer APO tel quel : il est lu
// en direct, sa courbe s'affiche, et le moteur le joue avant la dynamique et
// la protection. Les sets se gardent comme les préréglages.

import { copyToClipboard } from "@utils/clipboard";
import { useEffect, useMemo, useRef, useState } from "@webpack/common";

import { APO_EXAMPLE, APO_FREQS as FREQS, apoResponse, type ApoStage, parseApo, removeLine, toggleFilterLine } from "./apo";
import { cl, Dropdown, Toggle } from "./controls";
import {
    deleteApoSet, deleteIr, getApoError, getApoVst, getIrResponse, getPrefs, getVstFiles, importIrs, loadApoSet, openVstFolder,
    refreshVstFiles, saveApoSet, setApoOn, setApoText, setVstParam, useMusical, type VstInfo,
} from "./engine";

type Act = (fn: () => Promise<unknown>) => void;

const icon = (d: string, size = 15) => (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={d} />
    </svg>
);

const GRID_HZ = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
const hzLabel = (f: number) => f >= 1000 ? `${f / 1000}k` : `${f}`;

/** Courbe de réponse du set (gauche en clair, droite en pointillés si elle diffère). */
function ApoGraph({ stages }: { stages: ApoStage[]; }) {
    const ref = useRef<HTMLCanvasElement>(null);
    // Les IR sont analysées à part : la courbe se met à jour quand c'est prêt.
    const irsReady = stages.filter(s => s.t === "conv").map(s => (s.t === "conv" && getIrResponse(s.ir) ? 1 : 0)).join("");
    const [l, r] = useMemo(() => apoResponse(stages, FREQS, getIrResponse), [stages, irsReady]);

    useEffect(() => {
        const canvas = ref.current!;
        const win = canvas.ownerDocument.defaultView!;
        const draw = () => {
            const dpr = win.devicePixelRatio || 1;
            const w = canvas.clientWidth, h = canvas.clientHeight;
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(h * dpr);
            const g = canvas.getContext("2d")!;
            g.setTransform(dpr, 0, 0, dpr, 0, 0);
            g.clearRect(0, 0, w, h);

            // Échelle : ±12 dB au moins, élargie par pas de 6 dB si besoin.
            const peak = Math.max(12, ...l.map(Math.abs), ...r.map(Math.abs));
            const range = Math.min(60, Math.ceil(peak / 6) * 6);
            const pad = { l: 30, r: 8, t: 8, b: 18 };
            const x = (f: number) => pad.l + Math.log(f / 20) / Math.log(1000) * (w - pad.l - pad.r);
            const y = (db: number) => pad.t + (1 - (Math.max(-range, Math.min(range, db)) + range) / (2 * range)) * (h - pad.t - pad.b);

            g.font = "9px ui-monospace, Consolas, monospace";
            g.fillStyle = "rgba(255,255,255,0.32)";
            g.strokeStyle = "rgba(255,255,255,0.06)";
            g.lineWidth = 1;
            for (const f of GRID_HZ) {
                g.beginPath();
                g.moveTo(Math.round(x(f)) + 0.5, pad.t);
                g.lineTo(Math.round(x(f)) + 0.5, h - pad.b);
                g.stroke();
                g.textAlign = "center";
                g.fillText(hzLabel(f), x(f), h - 5);
            }
            for (const db of [range, range / 2, 0, -range / 2, -range]) {
                g.strokeStyle = db === 0 ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.06)";
                g.beginPath();
                g.moveTo(pad.l, Math.round(y(db)) + 0.5);
                g.lineTo(w - pad.r, Math.round(y(db)) + 0.5);
                g.stroke();
                g.textAlign = "right";
                g.fillText(`${db > 0 ? "+" : ""}${db}`, pad.l - 5, y(db) + 3);
            }

            const curve = (vals: number[], color: string, dash: number[], fill: boolean) => {
                g.beginPath();
                vals.forEach((v, i) => (i ? g.lineTo(x(FREQS[i]), y(v)) : g.moveTo(x(FREQS[i]), y(v))));
                g.setLineDash(dash);
                g.strokeStyle = color;
                g.lineWidth = 1.8;
                g.stroke();
                g.setLineDash([]);
                if (fill) {
                    g.lineTo(x(FREQS[FREQS.length - 1]), y(0));
                    g.lineTo(x(FREQS[0]), y(0));
                    g.closePath();
                    g.fillStyle = "rgba(214,224,240,0.07)";
                    g.fill();
                }
            };
            const differs = l.some((v, i) => Math.abs(v - r[i]) > 0.05);
            if (differs) curve(r, "rgba(214,224,240,0.55)", [4, 3], false);
            curve(l, "#eef1f7", [], true);
        };
        draw();
        const obs = new win.ResizeObserver(draw);
        obs.observe(canvas);
        return () => obs.disconnect();
    }, [l, r]);

    const differs = l.some((v, i) => Math.abs(v - r[i]) > 0.05);
    return (
        <div className={cl("apo-graph")}>
            <canvas ref={ref} aria-label="Courbe de réponse du set" />
            {differs && <span className={cl("apo-legend")}><i /> G <i className={cl("apo-legend-r")} /> D</span>}
        </div>
    );
}

const ADD_LINES = [
    { label: "+ Filtre", text: "Filter: ON PK Fc 1000 Hz Gain 0.0 dB Q 1.41" },
    { label: "+ Preamp", text: "Preamp: -3 dB" },
    { label: "+ GraphicEQ", text: "GraphicEQ: 25 0; 100 0; 1000 0; 10000 0; 20000 0" },
];

export function ApoDrawer({ act, onClose }: { act: Act; onClose(): void; }) {
    useMusical();
    const p = getPrefs();
    const music = useMusical();
    const vstFiles = getVstFiles();
    const parsed = useMemo(() => parseApo(p.apoText, p.apoIrs, vstFiles), [p.apoText, p.apoIrs, vstFiles]);
    // Le dossier VST est relu régulièrement : un plugin déposé apparaît tout seul.
    useEffect(() => {
        refreshVstFiles();
        const timer = setInterval(refreshVstFiles, 3000);
        return () => clearInterval(timer);
    }, []);
    const engineError = getApoError();
    const fileRef = useRef<HTMLInputElement>(null);
    const irRef = useRef<HTMLInputElement>(null);
    const [confirmIr, setConfirmIr] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [name, setName] = useState("");
    const [note, setNote] = useState<string | null>(null);

    const flash = (msg: string) => {
        setNote(msg);
        setTimeout(() => setNote(n => (n === msg ? null : n)), 2500);
    };
    const warnings = parsed.lines.filter(l => l.warning).length;
    const append = (line: string) => setApoText(`${p.apoText.replace(/\s*$/, "")}\n${line}\n`, p.apoName);

    return (
        <aside className={cl("apo")} aria-label="Mini APO">
            <header className={cl("card-head")}>
                <span className={cl("card-icon")}>{icon("M3 12h4l3-8 4 16 3-8h4")}</span>
                <span className={cl("card-title")}>Mini APO</span>
                <span className={cl("apo-state", p.apoOn && "apo-state-on")}>{p.apoOn ? `${parsed.stages.length} étape${parsed.stages.length > 1 ? "s" : ""} actives` : "coupé"}</span>
                <span className={cl("card-extra")}>
                    <Toggle on={p.apoOn} label="Activer le Mini APO" onChange={on => act(async () => setApoOn(on))} />
                </span>
                <button type="button" className={cl("icon-btn", "icon-btn-sm")} onClick={onClose} aria-label="Fermer le Mini APO" title="Fermer">
                    {icon("m15 6-6 6 6 6")}
                </button>
            </header>

            {/* Sets enregistrés */}
            <div className={cl("apo-sets")}>
                <div className={cl("apo-pick")}>
                    <Dropdown
                        value={p.apoName}
                        placeholder={p.apoSets.length ? "Set non enregistré" : "Aucun set enregistré"}
                        choices={p.apoSets.map(s => ({
                            value: s.name,
                            label: s.name,
                            menu: [
                                { label: "Copier le texte", onClick: () => { copyToClipboard(s.text); flash("Set copié."); } },
                                { label: `Supprimer « ${s.name} »`, danger: true, onClick: () => { deleteApoSet(s.name); flash("Set supprimé."); } },
                            ],
                        }))}
                        onChange={loadApoSet}
                    />
                </div>
                <button type="button" className={cl("icon-btn", "icon-btn-glass", saving && "icon-btn-on")} onClick={() => { setSaving(!saving); setName(p.apoName); }} title="Enregistrer ce set" aria-label="Enregistrer">
                    {icon("M5 3h11l3 3v15H5zM8 3v6h8V3M8 21v-7h8v7")}
                </button>
                <button type="button" className={cl("icon-btn", "icon-btn-glass")} onClick={() => act(openVstFolder)} title="Ouvrir le dossier des plugins VST de low-musical (dépose tes .dll ici)" aria-label="Dossier VST">
                    {icon("M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 11v5M9.5 13.5 12 16l2.5-2.5")}
                </button>
                <button type="button" className={cl("icon-btn", "icon-btn-glass")} onClick={() => fileRef.current?.click()} title="Importer un fichier .txt d'Equalizer APO" aria-label="Importer">
                    {icon("M12 3v12M7 10l5 5 5-5M5 21h14")}
                </button>
                <input
                    ref={fileRef}
                    type="file"
                    accept=".txt,text/plain"
                    hidden
                    onChange={e => {
                        const file = e.currentTarget.files?.[0];
                        e.currentTarget.value = "";
                        if (!file) return;
                        act(async () => {
                            if (file.size > 1024 * 1024) throw new Error("fichier trop lourd pour un set APO");
                            setApoText(await file.text(), "");
                            flash(`« ${file.name} » importé.`);
                        });
                    }}
                />
            </div>
            {saving && (
                <form className={cl("apo-save")} onSubmit={e => { e.preventDefault(); act(async () => { saveApoSet(name); setSaving(false); flash("Set enregistré."); }); }}>
                    <input className={cl("text")} autoFocus maxLength={40} placeholder="Nom du set" value={name} onChange={e => setName(e.currentTarget.value)} />
                    <button type="submit" className={cl("btn", "btn-primary", "btn-sm")} disabled={!name.trim()}>Enregistrer</button>
                </form>
            )}
            {note && <div className={cl("apo-note")}>{note}</div>}

            <ApoGraph stages={parsed.stages} />
            {engineError && p.apoOn && <p className={cl("error-line")}>Le moteur garde le set précédent : {engineError}</p>}

            {/* Texte du set, au format d'Equalizer APO */}
            <div className={cl("apo-editor")}>
                <div className={cl("apo-editor-head")}>
                    <span className={cl("group-title")}>config.txt</span>
                    <span className={cl("card-actions")}>
                        {ADD_LINES.map(a => <button key={a.label} type="button" className={cl("link")} onClick={() => append(a.text)}>{a.label}</button>)}
                        <button type="button" className={cl("link")} onClick={() => setApoText(APO_EXAMPLE, "")} title="Remplacer par l'exemple">Exemple</button>
                    </span>
                </div>
                <textarea
                    className={cl("apo-text")}
                    spellCheck={false}
                    value={p.apoText}
                    onChange={e => setApoText(e.currentTarget.value, p.apoName)}
                    placeholder={"Colle ici un set Equalizer APO\nPreamp: -6 dB\nFilter: ON PK Fc 100 Hz Gain 3 dB Q 1.41"}
                />
            </div>

            {/* Plugins VST */}
            <VstSection act={act} files={vstFiles} stages={parsed.stages} append={append} error={music.vstError} />

            {/* Réponses impulsionnelles (Convolution) */}
            <div className={cl("apo-irs")}>
                <div className={cl("apo-editor-head")}>
                    <span className={cl("group-title")}>Réponses impulsionnelles <span className={cl("count")}>{p.apoIrs.length}</span></span>
                    <button type="button" className={cl("link")} onClick={() => irRef.current?.click()} title="wav, flac ou ogg, 6 s au plus">+ Importer IR</button>
                </div>
                <input
                    ref={irRef}
                    type="file"
                    accept=".wav,.flac,.ogg"
                    multiple
                    hidden
                    onChange={e => {
                        const files = [...(e.currentTarget.files ?? [])];
                        e.currentTarget.value = "";
                        if (files.length) act(async () => { await importIrs(files); flash(files.length > 1 ? `${files.length} IR importées.` : `« ${files[0].name} » importée.`); });
                    }}
                />
                {p.apoIrs.length ? (
                    <div className={cl("apo-ir-list")}>
                        {p.apoIrs.map(ir => (
                            <span key={ir.file} className={cl("apo-ir")}>
                                <button type="button" className={cl("apo-ir-name")} onClick={() => append(`Convolution: ${ir.name}`)} title={`Ajouter « Convolution: ${ir.name} » au set`}>{ir.name}</button>
                                <button
                                    type="button"
                                    className={cl("apo-ir-del", confirmIr === ir.name && "apo-ir-del-ask")}
                                    onClick={() => {
                                        if (confirmIr !== ir.name) return setConfirmIr(ir.name);
                                        setConfirmIr(null);
                                        act(() => deleteIr(ir.name));
                                    }}
                                    onBlur={() => setConfirmIr(c => (c === ir.name ? null : c))}
                                    title={confirmIr === ir.name ? "Cliquer encore pour supprimer" : "Supprimer cette IR"}
                                >{confirmIr === ir.name ? "Confirmer ?" : icon("M6 6l12 12M18 6 6 18", 10)}</button>
                            </span>
                        ))}
                    </div>
                ) : (
                    <p className={cl("hint")}>Importe une IR (salle, profil de casque…) puis clique dessus pour l'ajouter au set.</p>
                )}
            </div>

            {/* Ce qui a été compris, ligne par ligne */}
            <div className={cl("apo-lines", "scroll")}>
                <div className={cl("group-title")}>
                    Lignes lues <span className={cl("count")}>{parsed.lines.length}</span>
                    {warnings > 0 && <span className={cl("apo-warn-count")}>{warnings} ignorée{warnings > 1 ? "s" : ""}</span>}
                </div>
                {parsed.lines.map(line => (
                    <div key={line.line} className={cl("apo-line", line.off && "apo-line-off", line.warning && "apo-line-warn")} title={line.warning}>
                        <span className={cl("apo-line-n")}>{line.line}</span>
                        <span className={cl("apo-kind")}>{line.kind}</span>
                        <span className={cl("apo-summary")}>{line.warning ? `${line.summary} — ${line.warning}` : line.summary}</span>
                        {line.kind === "Filter" && !line.warning && (
                            <button
                                type="button"
                                className={cl("apo-onoff", !line.off && "apo-onoff-on")}
                                onClick={() => setApoText(toggleFilterLine(p.apoText, line.line), p.apoName)}
                                title={line.off ? "Activer ce filtre" : "Couper ce filtre"}
                            >{line.off ? "OFF" : "ON"}</button>
                        )}
                        <button type="button" className={cl("apo-del")} onClick={() => setApoText(removeLine(p.apoText, line.line), p.apoName)} title="Supprimer la ligne" aria-label="Supprimer la ligne">
                            {icon("M6 6l12 12M18 6 6 18", 11)}
                        </button>
                    </div>
                ))}
                {!parsed.lines.length && <p className={cl("hint")}>Rien à lire pour l'instant.</p>}
            </div>
        </aside>
    );
}

/** Plugins VST : ceux du dossier (clic = ajout au set) et les réglages de ceux du set. */
function VstSection({ act, files, stages, append, error }: {
    act: Act; files: string[]; stages: ApoStage[]; append(line: string): void; error?: string | null;
}) {
    const p = getPrefs();
    const infos = getApoVst();
    const inSet = stages.filter(s => s.t === "vst");
    const [open, setOpen] = useState<number | null>(0);

    return (
        <div className={cl("apo-irs")}>
            <div className={cl("apo-editor-head")}>
                <span className={cl("group-title")}>Plugins VST <span className={cl("count")}>{files.length}</span></span>
                <button type="button" className={cl("link")} onClick={() => act(openVstFolder)}>Ouvrir le dossier</button>
            </div>
            {files.length ? (
                <div className={cl("apo-ir-list")}>
                    {files.map(f => (
                        <span key={f} className={cl("apo-ir")}>
                            <button type="button" className={cl("apo-ir-name")} onClick={() => append(`VSTPlugin: Library ${/\s/.test(f) ? `"${f}"` : f}`)} title={`Ajouter « ${f} » au set`}>{f.replace(/\.dll$/i, "")}</button>
                        </span>
                    ))}
                </div>
            ) : (
                <p className={cl("hint")}>Dépose tes plugins VST2 64 bits (.dll) dans le dossier, ils apparaissent ici. Chaque plugin tourne à part : s'il plante, la diffusion continue sans lui.</p>
            )}
            {error && p.apoOn && <p className={cl("error-line")}>{error}</p>}
            {p.apoOn && inSet.map((s, slot) => {
                const info: VstInfo | undefined = infos[slot];
                if (s.t !== "vst") return null;
                return (
                    <div key={`${s.line}-${s.lib}`} className={cl("apo-vst")}>
                        <button type="button" className={cl("apo-vst-head")} onClick={() => setOpen(open === slot ? null : slot)} aria-expanded={open === slot}>
                            <span className={cl("apo-vst-name")}>{info?.name || s.lib}</span>
                            {info?.vendor && <span className={cl("apo-vst-vendor")}>{info.vendor}</span>}
                            <span className={cl("apo-vst-count")}>{info?.error ? "erreur" : `${info?.params?.length ?? 0} réglages`}</span>
                        </button>
                        {info?.error && <p className={cl("error-line")}>{info.error}</p>}
                        {open === slot && !info?.error && (
                            <div className={cl("apo-vst-params", "scroll")}>
                                {(info?.params ?? []).map((param, index) => (
                                    <label key={index} className={cl("apo-vst-param")}>
                                        <span className={cl("apo-vst-pname")} title={param.name}>{param.name || `#${index + 1}`}</span>
                                        <input
                                            type="range" min={0} max={1} step={0.001} value={param.value}
                                            onChange={e => {
                                                const v = Number(e.currentTarget.value);
                                                act(() => setVstParam(slot, index, v));
                                            }}
                                        />
                                        <span className={cl("apo-vst-pval")}>{param.display}</span>
                                    </label>
                                ))}
                                {!info?.params?.length && <p className={cl("hint")}>Ce plugin n'a pas de réglage exposé.</p>}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
