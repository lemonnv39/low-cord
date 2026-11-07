/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-musical — bloc « Soundboard » (sous Espace). Tes sons importés (mp3,
// wav, ogg, flac), gardés d'une session à l'autre. Chaque clic lance le son
// par-dessus les autres : on peut spammer sans couper celui d'avant. Les sons
// passent dans la diffusion des comptes, juste avant le volume général.

import { useRef, useState } from "@webpack/common";

import { Card, cl, Slider } from "./controls";
import { deleteSound, getPrefs, getSoundErrors, importSounds, playSound, PREF_DEFAULTS, setSbVolume, stopSounds, useMusical } from "./engine";

type Act = (fn: () => Promise<unknown>) => void;

const icon = (d: string, size = 15) => (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={d} />
    </svg>
);

const PadIcon = () => icon("M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z");
const TrashIcon = () => icon("M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3", 13);

export function SoundboardCard({ act }: { act: Act; }) {
    const music = useMusical();
    const p = getPrefs();
    const errors = getSoundErrors();
    const fileRef = useRef<HTMLInputElement>(null);
    const [editing, setEditing] = useState(false);
    // Bouton qui vient d'être cliqué : petit flash (le son part tout de suite).
    const [hit, setHit] = useState<string | null>(null);

    function play(id: string) {
        setHit(id);
        setTimeout(() => setHit(h => (h === id ? null : h)), 160);
        act(() => playSound(id));
    }

    return (
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
                <div className={cl("sb-grid")}>
                    {p.sounds.map(s => (
                        <div key={s.id} className={cl("sb-pad-wrap")}>
                            <button
                                type="button"
                                className={cl("sb-pad", hit === s.id && "sb-pad-hit", errors[s.id] && "sb-pad-bad")}
                                disabled={editing}
                                onClick={() => play(s.id)}
                                title={errors[s.id] ?? `${s.name} — clique autant que tu veux, les sons se superposent`}
                            >{s.name}</button>
                            {editing && (
                                <button type="button" className={cl("sb-del")} onClick={() => act(() => deleteSound(s.id))} title={`Supprimer « ${s.name} »`} aria-label={`Supprimer ${s.name}`}>
                                    <TrashIcon />
                                </button>
                            )}
                        </div>
                    ))}
                </div>
            ) : (
                <p className={cl("hint")}>Importe tes sons (mp3, wav, ogg, flac — 60 s au plus). Ils restent enregistrés.</p>
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
    );
}
