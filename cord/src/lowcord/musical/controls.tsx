/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// low-musical — petits composants du panneau (curseurs, interrupteurs, sections).

import { classNameFactory } from "@utils/css";
import type { ReactNode } from "react";

export const cl = classNameFactory("lc-mp-");

export function Slider({ label, value, display, min, max, step, reset, onChange }: {
    label: string; value: number; display: string; min: number; max: number; step: number; reset: number;
    onChange(v: number): void;
}) {
    return (
        <label className={cl("slider")}>
            <span className={cl("slider-head")}>
                <span>{label}</span>
                <span className={cl("value")}>{display}</span>
            </span>
            <input
                type="range" min={min} max={max} step={step} value={value}
                onChange={e => onChange(Number(e.currentTarget.value))}
                onDoubleClick={() => onChange(reset)}
                title="Double-clic : valeur par défaut"
            />
        </label>
    );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange(v: boolean): void; label: string; }) {
    return (
        <button role="switch" aria-checked={on} aria-label={label} className={cl("switch", on && "switch-on")} onClick={() => onChange(!on)}>
            <span className={cl("knob")} />
        </button>
    );
}

export function Section({ title, children, extra }: { title: string; children: ReactNode; extra?: ReactNode; }) {
    return (
        <div className={cl("sec")}>
            <div className={cl("sec-head")}>
                <span>{title}</span>
                {extra}
            </div>
            {children}
        </div>
    );
}

