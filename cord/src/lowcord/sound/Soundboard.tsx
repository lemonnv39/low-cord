/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-sound — bloc « Soundboard » (sous la spatialisation). Tes sons
// importés (mp3, wav, ogg, flac), gardés d'une session à l'autre. Chaque clic
// lance le son par-dessus les autres : on peut spammer sans couper celui
// d'avant. Clic droit sur un son : renommer, découper, supprimer.
// Les sons passent dans la diffusion des comptes, juste avant le volume général.

import { ReactDOM, useRef, useState } from "@webpack/common";

import { Card, cl, ContextMenu, Slider } from "./controls";
import {
    deleteSound, getPrefs, getSoundErrors, importSounds, playSound, PREF_DEFAULTS, renameSound, setSbVolume, type SoundPad,
    stopSounds, useLowSound,
} from "./engine";
import { SoundEditor } from "./SoundEditor";

type Act = (fn: () => Promise<unknown>) => void;

const icon = (d: string, size = 15) => (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={d} />
    </svg>
);

const PadIcon = () => icon("M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z");
const TrashIcon = () => icon("M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3", 13);
const CutIcon = () => icon("M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12", 11);

export function SoundboardCard({ act }: { act: Act; }) {
    const music = useLowSound();
    const p = getPrefs();
    const errors = getSoundErrors();
    const fileRef = useRef<HTMLInputElement>(null);
    const cardRef = useRef<HTMLDivElement>(null);
    const [editing, setEditing] = useState(false);
    // Bouton qui vient d'être cliqué : petit flash (le son part tout de suite).
    const [hit, setHit] = useState<string | null>(null);
    const [menu, setMenu] = useState<{ pad: SoundPad; x: number; y: number; } | null>(null);
    const [renaming, setRenaming] = useState<string | null>(null);
    const [trimming, setTrimming] = useState<SoundPad | null>(null);

    function play(id: string) {
        setHit(id);
        setTimeout(() => setHit(h => (h === id ? null : h)), 180);
        act(() => playSound(id));
    }

    // L'éditeur s'ouvre par-dessus tout le panneau.
    const panel = cardRef.current?.closest(".lc-ls-panel");

    return (
        <div ref={cardRef} className={cl("card-sb-wrap")}>
            <Card
                title="Soundboard"
                className={cl("card-sb")}
                icon={<PadIcon />}
                extra={
                    <span className={cl("card-actions")}>
                        {p.sounds.length > 0 && (
                            <button type="button" className={cl("link", editing && "link-on")} onClick={() => setEditing(!editing)}>
                                {editing ? "Terminé" : "Gérer"}
                            </button>
                        )}
                        <button type="button" className={cl("link", "link-danger")} disabled={!music.running} onClick={() => act(stopSounds)}>Stop tout</button>
                    </span>
                }
            >
                {p.sounds.length ? (
                    <div className={cl("sb-grid", "scroll")}>
                        {p.sounds.map(s => (
                            <div key={s.id} className={cl("sb-pad-wrap")}>
                                {renaming === s.id ? (
                                    <form onSubmit={e => { e.preventDefault(); renameSound(s.id, (e.currentTarget.elements[0] as HTMLInputElement).value); setRenaming(null); }}>
                                        <input
                                            className={cl("sb-rename")}
                                            autoFocus
                                            maxLength={32}
                                            defaultValue={s.name}
                                            onFocus={e => e.currentTarget.select()}
                                            onBlur={e => { renameSound(s.id, e.currentTarget.value); setRenaming(null); }}
                                            onKeyDown={e => { if (e.key === "Escape") setRenaming(null); }}
                                        />
                                    </form>
                                ) : (
                                    <button
                                        type="button"
                                        className={cl("sb-pad", hit === s.id && "sb-pad-hit", errors[s.id] && "sb-pad-bad")}
                                        disabled={editing}
                                        onClick={() => play(s.id)}
                                        onContextMenu={e => { e.preventDefault(); setMenu({ pad: s, x: e.clientX, y: e.clientY }); }}
                                        title={errors[s.id] ?? `${s.name} — clique autant que tu veux, les sons se superposent · clic droit : options`}
                                    >
                                        {(s.start || s.end) ? <span className={cl("sb-cut")} title="Son découpé"><CutIcon /></span> : null}
                                        <span className={cl("sb-name")}>{s.name}</span>
                                    </button>
                                )}
                                {editing && (
                                    <button type="button" className={cl("sb-del")} onClick={() => act(() => deleteSound(s.id))} title={`Supprimer « ${s.name} »`} aria-label={`Supprimer ${s.name}`}>
                                        <TrashIcon />
                                    </button>
                                )}
                            </div>
                        ))}
                    </div>
                ) : (
                    <p className={cl("hint")}>Importe tes sons (mp3, wav, ogg, flac — 60 s au plus). Ils restent enregistrés. Clic droit sur un son pour le découper.</p>
                )}

                <button type="button" className={cl("btn", "btn-block")} onClick={() => fileRef.current?.click()}>+ Importer des sons</button>
                <input
                    ref={fileRef}
                    type="file"
                    accept=".mp3,.wav,.ogg,.flac,audio/*"
                    multiple
                    hidden
                    onChange={e => {
                        const files = [...(e.currentTarget.files ?? [])];
                        e.currentTarget.value = "";
                        if (files.length) act(() => importSounds(files));
                    }}
                />
                <Slider
                    label="Volume des sons" value={p.sbVolume} display={`${Math.round(p.sbVolume * 100)} %`}
                    min={0} max={2} step={0.01} reset={PREF_DEFAULTS.sbVolume} onChange={setSbVolume}
                />
            </Card>

            {menu && (
                <ContextMenu
                    x={menu.x}
                    y={menu.y}
                    onClose={() => setMenu(null)}
                    actions={[
                        { label: "Jouer", onClick: () => play(menu.pad.id) },
                        { label: "Découper…", onClick: () => setTrimming(menu.pad) },
                        { label: "Renommer", onClick: () => setRenaming(menu.pad.id) },
                        { label: `Supprimer « ${menu.pad.name} »`, danger: true, onClick: () => act(() => deleteSound(menu.pad.id)) },
                    ]}
                />
            )}
            {trimming && panel && ReactDOM.createPortal(
                <SoundEditor pad={trimming} onClose={() => setTrimming(null)} />,
                panel,
            )}
        </div>
    );
}
