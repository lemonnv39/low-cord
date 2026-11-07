/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-musical — composants du panneau : carte, curseur, interrupteur,
// pastilles, sélecteur segmenté, menu déroulant.

import { classNameFactory } from "@utils/css";
import { useEffect, useRef, useState } from "@webpack/common";
import type { CSSProperties, ReactNode } from "react";

export const cl = classNameFactory("lc-mp-");

/** Bloc du panneau : titre (avec actions à droite) et contenu. */
export function Card({ title, icon, extra, className, children }: {
    title: string; icon?: ReactNode; extra?: ReactNode; className?: string; children: ReactNode;
}) {
    return (
        <section className={cl("card") + (className ? " " + className : "")}>
            <header className={cl("card-head")}>
                {icon && <span className={cl("card-icon")}>{icon}</span>}
                <span className={cl("card-title")}>{title}</span>
                {extra && <span className={cl("card-extra")}>{extra}</span>}
            </header>
            {children}
        </section>
    );
}

/** Sous-titre à l'intérieur d'un bloc. */
export const Group = ({ title, children }: { title: string; children: ReactNode; }) => (
    <div className={cl("group")}>
        <div className={cl("group-title")}>{title}</div>
        {children}
    </div>
);

/** Curseur horizontal : la partie remplie suit la valeur. Double-clic = valeur par défaut. */
export function Slider({ label, value, display, min, max, step, reset, onChange, center }: {
    label: string; value: number; display: string; min: number; max: number; step: number; reset: number;
    onChange(v: number): void;
    /** remplissage depuis le centre (valeurs ±) au lieu de la gauche */
    center?: boolean;
}) {
    const pct = ((value - min) / (max - min)) * 100;
    const zero = center ? ((0 - min) / (max - min)) * 100 : 0;
    const style = { "--from": `${Math.min(zero, pct)}%`, "--to": `${Math.max(zero, pct)}%` } as CSSProperties;
    return (
        <label className={cl("slider")}>
            <span className={cl("slider-head")}>
                <span>{label}</span>
                <span className={cl("value", value !== reset && "value-on")}>{display}</span>
            </span>
            <input
                type="range" min={min} max={max} step={step} value={value} style={style}
                onChange={e => onChange(Number(e.currentTarget.value))}
                onDoubleClick={() => onChange(reset)}
                title="Double-clic : valeur par défaut"
            />
        </label>
    );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange(v: boolean): void; label: string; }) {
    return (
        <button type="button" role="switch" aria-checked={on} aria-label={label} className={cl("switch", on && "switch-on")} onClick={() => onChange(!on)}>
            <span className={cl("knob")} />
        </button>
    );
}

/** Ligne titre + description + interrupteur. */
export function ToggleRow({ name, desc, on, onChange, extra }: {
    name: string; desc?: string; on: boolean; onChange(v: boolean): void; extra?: ReactNode;
}) {
    return (
        <div className={cl("toggle-row")}>
            <div className={cl("toggle-text")}>
                <div className={cl("toggle-name")}>{name}</div>
                {desc && <div className={cl("toggle-desc")}>{desc}</div>}
            </div>
            {extra}
            <Toggle on={on} label={name} onChange={onChange} />
        </div>
    );
}

/** Choix exclusif sur une ligne (Off / Auto / Manuel…). */
export function Segmented<T extends string | number>({ value, options, onChange, label }: {
    value: T; options: readonly { value: T; label: string; title?: string; }[]; onChange(v: T): void; label: string;
}) {
    return (
        <div className={cl("segmented")} role="radiogroup" aria-label={label}>
            {options.map(o => (
                <button
                    key={String(o.value)}
                    type="button"
                    role="radio"
                    aria-checked={o.value === value}
                    className={cl("segment", o.value === value && "segment-on")}
                    title={o.title}
                    onClick={() => onChange(o.value)}
                >{o.label}</button>
            ))}
        </div>
    );
}

/** Pastille cliquable (préréglage, effet à activer…). */
export function Chip({ on, children, onClick, title, disabled }: {
    on?: boolean; children: ReactNode; onClick(): void; title?: string; disabled?: boolean;
}) {
    return (
        <button type="button" className={cl("chip", on && "chip-on")} aria-pressed={!!on} onClick={onClick} title={title} disabled={disabled}>
            {children}
        </button>
    );
}

export interface Choice {
    value: string;
    label: string;
    disabled?: boolean;
}

/**
 * Menu déroulant maison. Les menus natifs (<select>) ne s'ouvrent pas dans
 * la fenêtre sans cadre du panneau : celui-ci est dessiné par nous, en
 * position fixe (il n'est jamais coupé par une zone qui défile) et s'ouvre
 * vers le haut s'il manque de place en bas.
 */
export function Dropdown({ value, choices, placeholder, disabled, onChange, onOpen }: {
    value: string;
    choices: Choice[];
    placeholder: string;
    disabled?: boolean;
    onChange(value: string): void;
    /** appelé à chaque ouverture (recharger la liste…) */
    onOpen?(): void;
}) {
    const ref = useRef<HTMLButtonElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const [box, setBox] = useState<{ left: number; width: number; top?: number; bottom?: number; max: number; } | null>(null);
    const current = choices.find(c => c.value === value);

    // Fermeture : clic ailleurs, Échap, défilement, redimensionnement (dans la
    // fenêtre où le menu est affiché, qui n'est pas forcément celle de Discord).
    useEffect(() => {
        if (!box) return;
        const doc = ref.current!.ownerDocument;
        const win = doc.defaultView!;
        const close = () => setBox(null);
        const onDown = (e: MouseEvent) => {
            const t = e.target as Node;
            if (!ref.current?.contains(t) && !listRef.current?.contains(t)) close();
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
        const onScroll = (e: Event) => { if (!listRef.current?.contains(e.target as Node)) close(); };
        doc.addEventListener("mousedown", onDown, true);
        doc.addEventListener("keydown", onKey, true);
        doc.addEventListener("scroll", onScroll, true);
        win.addEventListener("resize", close);
        return () => {
            doc.removeEventListener("mousedown", onDown, true);
            doc.removeEventListener("keydown", onKey, true);
            doc.removeEventListener("scroll", onScroll, true);
            win.removeEventListener("resize", close);
        };
    }, [box]);

    function toggle() {
        if (box) return setBox(null);
        onOpen?.();
        const r = ref.current!.getBoundingClientRect();
        const winH = ref.current!.ownerDocument.defaultView!.innerHeight;
        const below = winH - r.bottom - 8;
        const above = r.top - 8;
        // Vers le bas si la place suffit (ou s'il y en a plus qu'en haut).
        setBox(below >= 220 || below >= above
            ? { left: r.left, width: r.width, top: r.bottom + 4, max: Math.min(320, below) }
            : { left: r.left, width: r.width, bottom: winH - r.top + 4, max: Math.min(320, above) });
    }

    function pick(c: Choice) {
        if (c.disabled) return;
        setBox(null);
        if (c.value !== value) onChange(c.value);
    }

    return (
        <>
            <button
                ref={ref}
                type="button"
                className={cl("dropdown", box && "dropdown-open")}
                disabled={disabled}
                onClick={toggle}
                aria-haspopup="listbox"
                aria-expanded={!!box}
            >
                <span className={cl("dropdown-label", !current && "dropdown-placeholder")}>{current?.label ?? placeholder}</span>
                <svg className={cl("dropdown-chevron")} viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="m6 9 6 6 6-6" />
                </svg>
            </button>
            {box && (
                <div
                    ref={listRef}
                    className={cl("dropdown-list")}
                    role="listbox"
                    style={{ left: box.left, width: box.width, top: box.top, bottom: box.bottom, maxHeight: box.max }}
                >
                    {choices.length ? choices.map(c => (
                        <button
                            key={c.value}
                            type="button"
                            role="option"
                            aria-selected={c.value === value}
                            className={cl("dropdown-item", c.value === value && "dropdown-item-on")}
                            disabled={c.disabled}
                            onClick={() => pick(c)}
                        >{c.label}</button>
                    )) : <div className={cl("dropdown-empty")}>{placeholder}</div>}
                </div>
            )}
        </>
    );
}

/**
 * Molette rotative (Graves, Médiums, Aigus) : tirer vers le haut ou le bas,
 * molette de la souris, flèches du clavier. Double-clic = valeur par défaut.
 * L'arc part du centre (0) vers la valeur.
 */
export function Knob({ label, value, min, max, step, reset, onChange, unit = "dB" }: {
    label: string; value: number; min: number; max: number; step: number; reset: number;
    onChange(v: number): void; unit?: string;
}) {
    const drag = useRef<{ y: number; v: number; } | null>(null);
    const dialRef = useRef<HTMLDivElement>(null);
    const valueRef = useRef(value);
    valueRef.current = value;
    const clampStep = (v: number) => Math.max(min, Math.min(max, Math.round(v / step) * step));
    const set = (v: number) => {
        const next = clampStep(v);
        if (next === valueRef.current) return;
        valueRef.current = next;
        onChange(next);
    };
    const setRef = useRef(set);
    setRef.current = set;

    // Molette de la souris : écoute non passive, sinon le bloc défile en même temps.
    useEffect(() => {
        const el = dialRef.current!;
        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            setRef.current(valueRef.current + (e.deltaY < 0 ? step : -step));
        };
        el.addEventListener("wheel", onWheel, { passive: false });
        return () => el.removeEventListener("wheel", onWheel);
    }, [step]);

    // 270° de course : de −135° (min) à +135° (max).
    const angle = (v: number) => -135 + ((v - min) / (max - min)) * 270;
    const point = (deg: number, r: number) => {
        const a = (deg - 90) * Math.PI / 180;
        return [24 + r * Math.cos(a), 24 + r * Math.sin(a)];
    };
    const arc = (from: number, to: number, r: number) => {
        const [a, b] = from <= to ? [from, to] : [to, from];
        const [x1, y1] = point(a, r), [x2, y2] = point(b, r);
        return `M${x1.toFixed(2)} ${y1.toFixed(2)}A${r} ${r} 0 ${b - a > 180 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
    };
    const zero = angle(Math.max(min, Math.min(max, 0)));
    const now = angle(value);
    const [hx, hy] = point(now, 13);
    const shown = `${value > 0 ? "+" : ""}${Number.isInteger(value) ? value : value.toFixed(1)}`;

    return (
        <div className={cl("knob-wrap")}>
            <div
                ref={dialRef}
                role="slider"
                tabIndex={0}
                aria-label={label}
                aria-valuemin={min}
                aria-valuemax={max}
                aria-valuenow={value}
                className={cl("knob-dial", value !== reset && "knob-dial-on")}
                title="Tirer haut / bas · molette · double-clic : 0"
                onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = { y: e.clientY, v: value }; }}
                onPointerMove={e => {
                    if (!drag.current) return;
                    // 120 px de course = toute la plage (Maj : réglage fin).
                    const range = (max - min) * (e.shiftKey ? 0.25 : 1);
                    set(drag.current.v + (drag.current.y - e.clientY) / 120 * range);
                }}
                onPointerUp={() => { drag.current = null; }}
                onPointerCancel={() => { drag.current = null; }}
                onDoubleClick={() => onChange(reset)}
                onKeyDown={e => {
                    if (e.key === "ArrowUp" || e.key === "ArrowRight") { e.preventDefault(); set(value + step); }
                    else if (e.key === "ArrowDown" || e.key === "ArrowLeft") { e.preventDefault(); set(value - step); }
                }}
            >
                <svg viewBox="0 0 48 48" aria-hidden="true">
                    <path className={cl("knob-track")} d={arc(-135, 135, 20)} />
                    {value !== 0 && <path className={cl("knob-fill")} d={arc(zero, now, 20)} />}
                    <circle className={cl("knob-cap")} cx="24" cy="24" r="15" />
                    <line className={cl("knob-hand")} x1="24" y1="24" x2={hx.toFixed(2)} y2={hy.toFixed(2)} />
                </svg>
            </div>
            <span className={cl("knob-value", value !== reset && "knob-value-on")}>{shown} {unit}</span>
            <span className={cl("knob-label")}>{label}</span>
        </div>
    );
}
