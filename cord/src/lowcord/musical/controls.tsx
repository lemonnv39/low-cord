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
    value: T; options: readonly { value: T; label: string; }[]; onChange(v: T): void; label: string;
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
export function Dropdown({ value, choices, placeholder, disabled, onChange }: {
    value: string;
    choices: Choice[];
    placeholder: string;
    disabled?: boolean;
    onChange(value: string): void;
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
