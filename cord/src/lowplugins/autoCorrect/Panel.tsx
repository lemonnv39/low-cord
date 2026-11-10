/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// AutoCorrect — panneau de réglages, ouvert au clic droit sur le bouton,
// juste au-dessus. Tout ce qui y est changé est enregistré tout de suite
// (réglages du plugin, gardés après redémarrage).

import ErrorBoundary from "@components/ErrorBoundary";
import { t, useLang } from "@lowcord/i18n";
import { createRoot, useEffect, useRef, useState } from "@webpack/common";

import { ensureEngine } from "./engine";
import { addWord, removeWord, settings, useEngineState, userWords } from "./settings";

let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
let anchorRect: DOMRect | null = null;

export const isPanelOpen = () => host != null;

export function closePanel() {
    if (!host) return;
    root?.unmount();
    host.remove();
    host = root = null;
    document.removeEventListener("mousedown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
}

function onOutside(e: MouseEvent) {
    if (host && !host.contains(e.target as Node)) closePanel();
}

function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
        e.stopPropagation();
        closePanel();
    }
}

export function openPanel(anchor: DOMRect) {
    closePanel();
    anchorRect = anchor;
    host = document.createElement("div");
    host.className = "lc-ac-host";
    document.body.appendChild(host);
    root = createRoot(host);
    root.render(<ErrorBoundary noop><Panel /></ErrorBoundary>);
    // Après ce clic droit : un clic ailleurs ou Échap ferme le panneau.
    setTimeout(() => {
        document.addEventListener("mousedown", onOutside, true);
        document.addEventListener("keydown", onKey, true);
    });
}

function Switch({ on, onChange, label }: { on: boolean; onChange(v: boolean): void; label: string; }) {
    return (
        <button role="switch" aria-checked={on} aria-label={label} className={`lc-ac-switch${on ? " lc-ac-switch-on" : ""}`} onClick={() => onChange(!on)}>
            <span />
        </button>
    );
}

function Check({ checked, onChange, label, hint }: { checked: boolean; onChange(v: boolean): void; label: string; hint: string; }) {
    return (
        <label className="lc-ac-check">
            <input type="checkbox" checked={checked} onChange={e => onChange(e.currentTarget.checked)} />
            <span className="lc-ac-box" aria-hidden="true" />
            <span className="lc-ac-check-text">
                <span>{label}</span>
                <small>{hint}</small>
            </span>
        </label>
    );
}

function Words() {
    useLang();
    settings.use(["words"]);
    const [draft, setDraft] = useState("");
    const words = userWords();
    const add = () => {
        for (const w of draft.split(/[,\s]+/)) addWord(w);
        setDraft("");
    };
    return (
        <div className="lc-ac-words">
            <div className="lc-ac-chips">
                {words.length === 0 && <span className="lc-ac-muted">{t("ac.wordsEmpty")}</span>}
                {words.map(w => (
                    <span key={w} className="lc-ac-chip">
                        {w}
                        <button aria-label={t("ac.wordRemove", { word: w })} onClick={() => removeWord(w)}>×</button>
                    </span>
                ))}
            </div>
            <input
                className="lc-ac-input"
                value={draft}
                placeholder={t("ac.wordsPlaceholder")}
                onChange={e => setDraft(e.currentTarget.value)}
                onKeyDown={e => {
                    // Entrée ajoute le mot (et ne doit pas atteindre Discord).
                    e.stopPropagation();
                    if (e.key === "Enter") add();
                }}
            />
        </div>
    );
}

function Panel() {
    useLang();
    const s = settings.use(["isEnabled", "mode", "livePreview", "context", "accents", "homophones", "conjugation", "agreement", "hyphens", "common", "previewWidth"]);
    const engine = useEngineState();
    const ref = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState<{ left: number; bottom: number; } | null>(null);

    // Au-dessus du bouton, aligné à droite sur lui, sans sortir de la fenêtre.
    useEffect(() => {
        if (!ref.current || !anchorRect) return;
        const w = ref.current.offsetWidth;
        const left = Math.max(8, Math.min(anchorRect.right - w, window.innerWidth - w - 8));
        setPos({ left, bottom: window.innerHeight - anchorRect.top + 10 });
    }, []);

    const set = (key: keyof typeof s) => (v: any) => { (settings.store as any)[key] = v; };

    let engineText: string;
    if (engine?.busy) engineText = t("ac.engineDownloading");
    else if (engine?.installed) engineText = t(engine.loaded ? "ac.engineReady" : "ac.engineSleeping", { version: engine.version });
    else if (engine?.error) engineText = t("ac.engineError", { error: engine.error });
    else engineText = t("ac.engineMissing");

    return (
        <div
            ref={ref}
            className="lc-ac-panel"
            style={pos ? { left: pos.left, bottom: pos.bottom } : { visibility: "hidden", left: 0, bottom: 0 }}
            role="dialog"
            aria-label={t("ac.title")}
        >
            <div className="lc-ac-head">
                <div className="lc-ac-title">
                    <span>{t("ac.title")}</span>
                    <small>{t("ac.subtitle")}</small>
                </div>
                <Switch on={s.isEnabled} onChange={v => { set("isEnabled")(v); if (v) ensureEngine(true); }} label={t("ac.title")} />
            </div>

            {/* Paysage : trois colonnes côte à côte. */}
            <div className={`lc-ac-body${s.isEnabled ? "" : " lc-ac-dim"}`}>
                <section className="lc-ac-col">
                    <div className="lc-ac-label">{t("ac.mode")}</div>
                    <div className="lc-ac-modes" role="radiogroup">
                        {(["auto", "confirm"] as const).map(m => (
                            <button key={m} role="radio" aria-checked={s.mode === m} className={`lc-ac-mode${s.mode === m ? " lc-ac-mode-on" : ""}`} onClick={() => set("mode")(m)}>
                                <span>{t(m === "auto" ? "ac.modeAuto" : "ac.modeConfirm")}</span>
                                <small>{t(m === "auto" ? "ac.modeAutoHint" : "ac.modeConfirmHint")}</small>
                            </button>
                        ))}
                    </div>
                    <Check checked={s.livePreview} onChange={set("livePreview")} label={t("ac.livePreview")} hint={t("ac.livePreviewHint")} />
                    {s.livePreview && (
                        <div className="lc-ac-seg" role="radiogroup" aria-label={t("ac.previewWidth")}>
                            {(["fit", "full"] as const).map(w => (
                                <button key={w} role="radio" aria-checked={s.previewWidth === w} className={s.previewWidth === w ? "lc-ac-seg-on" : undefined} onClick={() => set("previewWidth")(w)}>
                                    {t(w === "fit" ? "ac.widthFit" : "ac.widthFull")}
                                </button>
                            ))}
                        </div>
                    )}
                </section>

                <section className="lc-ac-col">
                    <div className="lc-ac-label">{t("ac.fixes")}</div>
                    <div className="lc-ac-checks">
                        <Check checked={s.context} onChange={set("context")} label={t("ac.context")} hint={t("ac.contextHint")} />
                        <Check checked={s.accents} onChange={set("accents")} label={t("ac.accents")} hint={t("ac.accentsHint")} />
                        <Check checked={s.homophones} onChange={set("homophones")} label={t("ac.homophones")} hint={t("ac.homophonesHint")} />
                        <Check checked={s.conjugation} onChange={set("conjugation")} label={t("ac.conjugation")} hint={t("ac.conjugationHint")} />
                        <Check checked={s.agreement} onChange={set("agreement")} label={t("ac.agreement")} hint={t("ac.agreementHint")} />
                        <Check checked={s.hyphens} onChange={set("hyphens")} label={t("ac.hyphens")} hint={t("ac.hyphensHint")} />
                        <Check checked={s.common} onChange={set("common")} label={t("ac.common")} hint={t("ac.commonHint")} />
                    </div>
                </section>

                <section className="lc-ac-col">
                    <div className="lc-ac-label">{t("ac.words")}</div>
                    <Words />
                </section>
            </div>

            {/* Moteur : seulement s'il demande de l'attention (téléchargement, erreur). */}
            {!engine?.installed && (
                <div className="lc-ac-foot">
                    <span className={`lc-ac-dot${engine?.busy ? " lc-ac-dot-busy" : ""}`} />
                    <span className="lc-ac-engine">{engineText}</span>
                    {!engine?.busy && <button className="lc-ac-link" onClick={() => ensureEngine(true)}>{t("ac.engineInstall")}</button>}
                </div>
            )}
        </div>
    );
}
