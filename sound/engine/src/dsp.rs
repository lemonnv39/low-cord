//! Traitement « fort et propre », sur le modèle des chaînes radio et club :
//! porte anti-souffle → nivellement auto (AGC) → mode stéréo / balance →
//! [8D, largeur + graves en mono, réverbe, égaliseur : dans audio.rs] →
//! Basses+ → Clarté → dé-esseur → compression multibande → compresseur (avec
//! compensation automatique du volume) → saturation → écrêteur doux
//! suréchantillonné → volume général → limiteur à anticipation (crêtes
//! inter-échantillons comprises).
//!
//! Tout est réglé par un seul jeu de paramètres (`Params`), relu à chaque bloc.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};

use crate::audio::OUT_RATE;
use crate::lock;

const FS: f32 = OUT_RATE as f32;

pub fn db_to_lin(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

pub fn lin_to_db(x: f32) -> f32 {
    20.0 * x.max(1e-9).log10()
}

/// Coefficient d'un filtre à un pôle pour une constante de temps en ms.
fn coef(ms: f32) -> f32 {
    (-1.0 / (ms.max(0.01) * FS / 1000.0)).exp()
}

// ── Biquad (formules RBJ) ───────────────────────────────────────────────────

#[derive(Clone, Copy)]
pub struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl Default for Biquad {
    fn default() -> Self {
        Biquad {
            b0: 1.0,
            b1: 0.0,
            b2: 0.0,
            a1: 0.0,
            a2: 0.0,
            z1: 0.0,
            z2: 0.0,
        }
    }
}

impl Biquad {
    fn set(&mut self, b: [f32; 3], a0: f32, a1: f32, a2: f32) {
        self.b0 = b[0] / a0;
        self.b1 = b[1] / a0;
        self.b2 = b[2] / a0;
        self.a1 = a1 / a0;
        self.a2 = a2 / a0;
    }
    pub fn set_peaking(&mut self, f0: f32, fs: f32, q: f32, gain_db: f32) {
        let a = 10f32.powf(gain_db / 40.0);
        let w0 = std::f32::consts::TAU * f0 / fs;
        let alpha = w0.sin() / (2.0 * q);
        let cw = w0.cos();
        self.set(
            [1.0 + alpha * a, -2.0 * cw, 1.0 - alpha * a],
            1.0 + alpha / a,
            -2.0 * cw,
            1.0 - alpha / a,
        );
    }
    /// Passe-bande à gain unitaire au centre.
    pub fn set_bandpass(&mut self, f0: f32, fs: f32, q: f32) {
        let w0 = std::f32::consts::TAU * f0 / fs;
        let alpha = w0.sin() / (2.0 * q);
        self.set(
            [alpha, 0.0, -alpha],
            1.0 + alpha,
            -2.0 * w0.cos(),
            1.0 - alpha,
        );
    }
    pub fn set_lowpass(&mut self, f0: f32, fs: f32, q: f32) {
        let w0 = std::f32::consts::TAU * f0 / fs;
        let alpha = w0.sin() / (2.0 * q);
        let cw = w0.cos();
        self.set(
            [(1.0 - cw) / 2.0, 1.0 - cw, (1.0 - cw) / 2.0],
            1.0 + alpha,
            -2.0 * cw,
            1.0 - alpha,
        );
    }
    pub fn set_highpass_q(&mut self, f0: f32, fs: f32, q: f32) {
        let w0 = std::f32::consts::TAU * f0 / fs;
        let alpha = w0.sin() / (2.0 * q);
        let cw = w0.cos();
        self.set(
            [(1.0 + cw) / 2.0, -(1.0 + cw), (1.0 + cw) / 2.0],
            1.0 + alpha,
            -2.0 * cw,
            1.0 - alpha,
        );
    }
    /// Étagère basse (pente 1) : gain appliqué sous f0.
    pub fn set_lowshelf(&mut self, f0: f32, fs: f32, gain_db: f32) {
        let a = 10f32.powf(gain_db / 40.0);
        let w0 = std::f32::consts::TAU * f0 / fs;
        let cw = w0.cos();
        let alpha = w0.sin() / 2.0 * std::f32::consts::SQRT_2;
        let sa = 2.0 * a.sqrt() * alpha;
        self.set(
            [
                a * ((a + 1.0) - (a - 1.0) * cw + sa),
                2.0 * a * ((a - 1.0) - (a + 1.0) * cw),
                a * ((a + 1.0) - (a - 1.0) * cw - sa),
            ],
            (a + 1.0) + (a - 1.0) * cw + sa,
            -2.0 * ((a - 1.0) + (a + 1.0) * cw),
            (a + 1.0) + (a - 1.0) * cw - sa,
        );
    }
    /// Étagère haute (pente 1) : gain appliqué au-dessus de f0.
    pub fn set_highshelf(&mut self, f0: f32, fs: f32, gain_db: f32) {
        let a = 10f32.powf(gain_db / 40.0);
        let w0 = std::f32::consts::TAU * f0 / fs;
        let cw = w0.cos();
        let alpha = w0.sin() / 2.0 * std::f32::consts::SQRT_2;
        let sa = 2.0 * a.sqrt() * alpha;
        self.set(
            [
                a * ((a + 1.0) + (a - 1.0) * cw + sa),
                -2.0 * a * ((a - 1.0) + (a + 1.0) * cw),
                a * ((a + 1.0) + (a - 1.0) * cw - sa),
            ],
            (a + 1.0) - (a - 1.0) * cw + sa,
            2.0 * ((a - 1.0) - (a + 1.0) * cw),
            (a + 1.0) - (a - 1.0) * cw - sa,
        );
    }
    /// Passe-haut d'ordre 2, Q = 0,707 (Butterworth).
    pub fn set_highpass(&mut self, f0: f32, fs: f32) {
        self.set_highpass_q(f0, fs, std::f32::consts::FRAC_1_SQRT_2);
    }
    pub fn process(&mut self, x: f32) -> f32 {
        // Forme directe II transposée (stable).
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
    fn lowpass(f: f32, q: f32) -> Self {
        let mut b = Biquad::default();
        b.set_lowpass(f, FS, q);
        b
    }
    fn highpass(f: f32, q: f32) -> Self {
        let mut b = Biquad::default();
        b.set_highpass_q(f, FS, q);
        b
    }
}

const BUTTER_Q: f32 = std::f32::consts::FRAC_1_SQRT_2;

/// Filtre Linkwitz-Riley d'ordre 4 (deux Butterworth en cascade) : passe-bas
/// et passe-haut à la même fréquence se somment sans bosse ni creux.
#[derive(Clone, Copy)]
struct Lr4 {
    a: Biquad,
    b: Biquad,
}

impl Lr4 {
    fn lowpass(f: f32) -> Self {
        Lr4 {
            a: Biquad::lowpass(f, BUTTER_Q),
            b: Biquad::lowpass(f, BUTTER_Q),
        }
    }
    fn highpass(f: f32) -> Self {
        Lr4 {
            a: Biquad::highpass(f, BUTTER_Q),
            b: Biquad::highpass(f, BUTTER_Q),
        }
    }
    fn process(&mut self, x: f32) -> f32 {
        self.b.process(self.a.process(x))
    }
}

// ── Réglages ────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Params {
    /// Coupe-bas (Hz, 0 = off).
    pub highpass: f32,
    /// Largeur stéréo (1 = normale, 0 = mono, 2 = très large).
    pub width: f32,
    /// Saturation douce [0..1].
    pub saturation: f32,
    pub compressor: bool,
    /// 0 = Propre, 1 = Fort & propre, 2 = Punch.
    pub comp_mode: u8,
    /// Intensité du compresseur [0..1].
    pub comp_amount: f32,
    pub limiter: bool,
    /// Protection anti-grésillement à 0 dB quand le limiteur est coupé.
    pub protect: bool,
    pub gate: bool,
    /// Seuil de la porte anti-souffle (dB).
    pub gate_threshold: f32,
    pub agc: bool,
    /// Niveau visé par le nivellement auto (dB efficaces).
    pub agc_target: f32,
    /// 0 = stéréo, 1 = mono, 2 = gauche ↔ droite inversés.
    pub stereo_mode: u8,
    /// Balance [-1 (gauche) .. 1 (droite)].
    pub balance: f32,
    /// Graves en mono sous cette fréquence (Hz, 0 = off).
    pub bass_mono: f32,
    /// Basses+ (harmoniques) [0..1].
    pub bass_plus: f32,
    /// Clarté (exciteur d'aigus) [0..1].
    pub clarity: f32,
    /// Dé-esseur [0..1] (0 = off).
    pub deesser: f32,
    pub multiband: bool,
    /// Intensité de la compression multibande [0..1].
    pub mb_amount: f32,
    /// Écrêteur doux [0..1] (0 = off).
    pub clipper: f32,
    /// Molettes de tonalité (dB, ±12) : graves, médiums, aigus.
    pub bass: f32,
    pub mid: f32,
    pub treble: f32,
}

impl Default for Params {
    fn default() -> Self {
        Params {
            highpass: 0.0,
            width: 1.0,
            saturation: 0.0,
            compressor: false,
            comp_mode: 0,
            comp_amount: 0.5,
            limiter: false,
            protect: true,
            gate: false,
            gate_threshold: -60.0,
            agc: false,
            agc_target: -18.0,
            stereo_mode: 0,
            balance: 0.0,
            bass_mono: 0.0,
            bass_plus: 0.0,
            clarity: 0.0,
            deesser: 0.0,
            multiband: false,
            mb_amount: 0.5,
            clipper: 0.0,
            bass: 0.0,
            mid: 0.0,
            treble: 0.0,
        }
    }
}

impl Params {
    /// Lit les réglages envoyés par low-cord ; une valeur absente ou invalide
    /// garde sa valeur par défaut, et tout est borné.
    pub fn from_json(v: &Value) -> Params {
        let d = Params::default();
        let n = |k: &str, def: f32| {
            v.get(k)
                .and_then(Value::as_f64)
                .filter(|x| x.is_finite())
                .map_or(def, |x| x as f32)
        };
        let b = |k: &str, def: bool| v.get(k).and_then(Value::as_bool).unwrap_or(def);
        let hz = |x: f32, max: f32| if x < 20.0 { 0.0 } else { x.min(max) };
        Params {
            highpass: hz(n("highpass", d.highpass), 400.0),
            width: n("width", d.width).clamp(0.0, 2.0),
            saturation: n("saturation", d.saturation).clamp(0.0, 1.0),
            compressor: b("compressor", d.compressor),
            comp_mode: (n("compMode", 0.0) as u8).min(2),
            comp_amount: n("compAmount", d.comp_amount).clamp(0.0, 1.0),
            limiter: b("limiter", d.limiter),
            protect: b("protect", d.protect),
            gate: b("gate", d.gate),
            gate_threshold: n("gateThreshold", d.gate_threshold).clamp(-90.0, -20.0),
            agc: b("agc", d.agc),
            agc_target: n("agcTarget", d.agc_target).clamp(-30.0, -8.0),
            stereo_mode: (n("stereoMode", 0.0) as u8).min(2),
            balance: n("balance", d.balance).clamp(-1.0, 1.0),
            bass_mono: hz(n("bassMono", d.bass_mono), 250.0),
            bass_plus: n("bassPlus", d.bass_plus).clamp(0.0, 1.0),
            clarity: n("clarity", d.clarity).clamp(0.0, 1.0),
            deesser: n("deesser", d.deesser).clamp(0.0, 1.0),
            multiband: b("multiband", d.multiband),
            mb_amount: n("mbAmount", d.mb_amount).clamp(0.0, 1.0),
            clipper: n("clipper", d.clipper).clamp(0.0, 1.0),
            bass: n("bass", d.bass).clamp(-12.0, 12.0),
            mid: n("mid", d.mid).clamp(-12.0, 12.0),
            treble: n("treble", d.treble).clamp(-12.0, 12.0),
        }
    }

    pub fn to_json(self) -> Value {
        json!({
            "highpass": self.highpass, "width": self.width, "saturation": self.saturation,
            "compressor": self.compressor, "compMode": self.comp_mode, "compAmount": self.comp_amount,
            "limiter": self.limiter, "protect": self.protect, "gate": self.gate, "gateThreshold": self.gate_threshold,
            "agc": self.agc, "agcTarget": self.agc_target, "stereoMode": self.stereo_mode,
            "balance": self.balance, "bassMono": self.bass_mono, "bassPlus": self.bass_plus,
            "clarity": self.clarity, "deesser": self.deesser, "multiband": self.multiband,
            "mbAmount": self.mb_amount, "clipper": self.clipper,
            "bass": self.bass, "mid": self.mid, "treble": self.treble,
        })
    }
}

fn params() -> &'static Mutex<Params> {
    static P: OnceLock<Mutex<Params>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(Params::default()))
}

pub fn set_params(p: Params) {
    *lock(params()) = p;
}

pub fn current() -> Params {
    *lock(params())
}

// ── Réduction de gain (pour le vumètre) ─────────────────────────────────────
// Plus forte réduction depuis la dernière lecture, en dB (positif).

fn comp_gr() -> &'static AtomicU32 {
    static G: OnceLock<AtomicU32> = OnceLock::new();
    G.get_or_init(|| AtomicU32::new(0))
}

fn limit_gr() -> &'static AtomicU32 {
    static G: OnceLock<AtomicU32> = OnceLock::new();
    G.get_or_init(|| AtomicU32::new(0))
}

fn note_gr(slot: &AtomicU32, db: f32) {
    let _ = slot.fetch_max(db.max(0.0).to_bits(), Ordering::Relaxed);
}

/// (compression, limiteur) en dB depuis le dernier appel, puis remise à zéro.
pub fn take_reduction() -> (f32, f32) {
    (
        f32::from_bits(comp_gr().swap(0, Ordering::Relaxed)),
        f32::from_bits(limit_gr().swap(0, Ordering::Relaxed)),
    )
}

// ── Suréchantillonnage ×4 ───────────────────────────────────────────────────
// Filtre RIF à fenêtre de Blackman : l'écrêteur travaille à 192 kHz (pas de
// repliement audible) et le limiteur voit les crêtes entre les échantillons.

const OS: usize = 4;
const OS_TAPS: usize = 96;
const OS_PHASE: usize = OS_TAPS / OS;
/// Retard du filtre, en échantillons à 48 kHz.
const OS_DELAY: usize = (OS_TAPS / 2) / OS;

fn os_taps() -> &'static [f32; OS_TAPS] {
    static T: OnceLock<[f32; OS_TAPS]> = OnceLock::new();
    T.get_or_init(|| {
        let mut h = [0.0; OS_TAPS];
        let fc = 0.46 / OS as f32; // coupure ≈ 22 kHz à 192 kHz
        let m = (OS_TAPS - 1) as f32;
        for (i, t) in h.iter_mut().enumerate() {
            let x = i as f32 - m / 2.0;
            let sinc = if x == 0.0 {
                2.0 * fc
            } else {
                (std::f32::consts::TAU * fc * x).sin() / (std::f32::consts::PI * x)
            };
            let w = 0.42 - 0.5 * (std::f32::consts::TAU * i as f32 / m).cos()
                + 0.08 * (2.0 * std::f32::consts::TAU * i as f32 / m).cos();
            *t = sinc * w;
        }
        let sum: f32 = h.iter().sum();
        h.iter_mut().for_each(|t| *t /= sum);
        h
    })
}

struct Oversampler {
    up: VecDeque<f32>,
    down: VecDeque<f32>,
}

impl Oversampler {
    fn new() -> Self {
        Oversampler {
            up: VecDeque::from(vec![0.0; OS_PHASE]),
            down: VecDeque::from(vec![0.0; OS_TAPS]),
        }
    }
    /// 1 échantillon → 4 (interpolés).
    fn upsample(&mut self, x: f32) -> [f32; OS] {
        let h = os_taps();
        self.up.pop_back();
        self.up.push_front(x);
        let mut out = [0.0; OS];
        for (k, o) in out.iter_mut().enumerate() {
            *o = OS as f32
                * self
                    .up
                    .iter()
                    .enumerate()
                    .map(|(j, v)| h[j * OS + k] * v)
                    .sum::<f32>();
        }
        out
    }
    /// 4 échantillons → 1 (filtrés avant décimation).
    fn downsample(&mut self, xs: [f32; OS]) -> f32 {
        let h = os_taps();
        for x in xs {
            self.down.pop_back();
            self.down.push_front(x);
        }
        self.down.iter().zip(h.iter()).map(|(v, t)| v * t).sum()
    }
}

// ── Suiveur d'enveloppe ─────────────────────────────────────────────────────

#[derive(Clone, Copy)]
struct Env {
    v: f32,
    a: f32,
    r: f32,
}

impl Env {
    fn new(attack_ms: f32, release_ms: f32) -> Self {
        Env {
            v: 0.0,
            a: coef(attack_ms),
            r: coef(release_ms),
        }
    }
    fn next(&mut self, x: f32) -> f32 {
        let c = if x > self.v { self.a } else { self.r };
        self.v = x + c * (self.v - x);
        self.v
    }
}

/// Réduction (dB, positive) d'un compresseur à genou doux de 6 dB.
fn reduction_db(level_db: f32, threshold: f32, ratio: f32) -> f32 {
    let over = level_db - threshold;
    let knee = 6.0;
    let slope = 1.0 - 1.0 / ratio;
    if over <= -knee / 2.0 {
        0.0
    } else if over >= knee / 2.0 {
        over * slope
    } else {
        slope * (over + knee / 2.0).powi(2) / (2.0 * knee)
    }
}

// ── Porte anti-souffle ──────────────────────────────────────────────────────
// Coupe le léger bruit du câble virtuel quand la musique s'arrête.

struct Gate {
    env: Env,
    gain: f32,
    hold: usize,
}

impl Gate {
    fn new() -> Self {
        Gate {
            env: Env::new(1.0, 60.0),
            gain: 1.0,
            hold: 0,
        }
    }
    fn process(&mut self, l: f32, r: f32, threshold_db: f32) -> (f32, f32) {
        let level = self.env.next(l.abs().max(r.abs()));
        if lin_to_db(level) > threshold_db {
            self.hold = (0.15 * FS) as usize;
        } else {
            self.hold = self.hold.saturating_sub(1);
        }
        let target = if self.hold > 0 { 1.0 } else { 0.0 };
        // Ouverture en 1 ms, fermeture en 80 ms (pas de coupure sèche).
        let c = if target > self.gain {
            1.0 - coef(1.0)
        } else {
            1.0 - coef(80.0)
        };
        self.gain += (target - self.gain) * c;
        (l * self.gain, r * self.gain)
    }
}

// ── Nivellement automatique (AGC) ───────────────────────────────────────────
// Mesure le niveau sur ~3 s et rapproche lentement le gain de la cible
// (+1,5 dB/s en montée, −6 dB/s en descente, ±12 dB au plus). Gelé sous
// −50 dB : on ne remonte jamais un silence.

struct Agc {
    power: f32,
    gain_db: f32,
}

impl Agc {
    fn new() -> Self {
        Agc {
            power: 0.0,
            gain_db: 0.0,
        }
    }
    fn process_block(&mut self, buf: &mut [f32], target_db: f32) {
        let frames = buf.len() / 2;
        if frames == 0 {
            return;
        }
        let k = 1.0 - coef(3000.0);
        for [l, r] in buf.as_chunks::<2>().0 {
            let m = (l + r) * 0.5;
            self.power += (m * m - self.power) * k;
        }
        let level = 10.0 * self.power.max(1e-12).log10();
        let start = self.gain_db;
        if level > -50.0 {
            let want = (target_db - level).clamp(-12.0, 12.0);
            let secs = frames as f32 / FS;
            let step = if want > self.gain_db {
                1.5 * secs
            } else {
                6.0 * secs
            };
            self.gain_db += (want - self.gain_db).clamp(-step, step);
        }
        // Gain interpolé sur le bloc : aucun saut audible.
        let (g0, g1) = (db_to_lin(start), db_to_lin(self.gain_db));
        for (i, frame) in buf.as_chunks_mut::<2>().0.iter_mut().enumerate() {
            let g = g0 + (g1 - g0) * (i as f32 / frames as f32);
            frame[0] *= g;
            frame[1] *= g;
        }
    }
}

// ── Stéréo : mode, balance, largeur, graves en mono ─────────────────────────

/// Mode stéréo et balance (début de chaîne).
pub fn stereo_mode(l: f32, r: f32, p: &Params) -> (f32, f32) {
    let (mut l, mut r) = match p.stereo_mode {
        1 => {
            let m = (l + r) * 0.5;
            (m, m)
        }
        2 => (r, l),
        _ => (l, r),
    };
    // Balance : on n'atténue que le côté opposé (le côté choisi garde son niveau).
    if p.balance > 0.0 {
        l *= 1.0 - p.balance;
    } else if p.balance < 0.0 {
        r *= 1.0 + p.balance;
    }
    (l, r)
}

/// Largeur (mid/side) avec les graves gardés au centre sous `bass_mono` Hz.
pub struct StereoWidth {
    side_hp: [Biquad; 2],
    hz: f32,
}

impl StereoWidth {
    pub fn new() -> Self {
        StereoWidth {
            side_hp: [Biquad::default(); 2],
            hz: 0.0,
        }
    }
    pub fn process(&mut self, l: f32, r: f32, p: &Params) -> (f32, f32) {
        let bass = p.bass_mono > 0.0;
        if !bass && (p.width - 1.0).abs() < 0.01 {
            return (l, r);
        }
        if bass && p.bass_mono != self.hz {
            self.hz = p.bass_mono;
            // 24 dB/octave : les graves de la partie « côtés » disparaissent nettement.
            self.side_hp = [Biquad::highpass(p.bass_mono, BUTTER_Q); 2];
        }
        let mid = (l + r) * 0.5;
        let mut side = (l - r) * 0.5;
        if bass {
            let first = self.side_hp[0].process(side);
            side = self.side_hp[1].process(first);
        }
        side *= p.width;
        (mid + side, mid - side)
    }
}

// ── Basses+ (harmoniques) ───────────────────────────────────────────────────
// Le grave (< 120 Hz) passe dans une non-linéarité qui crée ses harmoniques,
// gardées entre 100 et 400 Hz : l'oreille « entend » la fondamentale même
// sur un téléphone, sans ajouter de vrai grave qui saturerait.

struct BassPlus {
    lp: [Biquad; 2],
    hp: Biquad,
    out_lp: Biquad,
}

impl BassPlus {
    fn new() -> Self {
        BassPlus {
            lp: [Biquad::lowpass(120.0, BUTTER_Q); 2],
            hp: Biquad::highpass(100.0, BUTTER_Q),
            out_lp: Biquad::lowpass(400.0, BUTTER_Q),
        }
    }
    fn process(&mut self, l: f32, r: f32, amount: f32) -> (f32, f32) {
        let first = self.lp[0].process((l + r) * 0.5);
        let low = self.lp[1].process(first);
        // Redressement (harmoniques paires) + tanh (impaires).
        let shaped = low.abs() * 1.2 + (low * 3.0).tanh() * 0.4;
        let h = self.out_lp.process(self.hp.process(shaped));
        let add = h * amount * 1.6;
        (l + add, r + add)
    }
}

// ── Clarté (exciteur d'aigus) ───────────────────────────────────────────────

struct Exciter {
    hp_in: [Biquad; 2],
    hp_out: [Biquad; 2],
}

impl Exciter {
    fn new() -> Self {
        Exciter {
            hp_in: [Biquad::highpass(3000.0, BUTTER_Q); 2],
            hp_out: [Biquad::highpass(3000.0, BUTTER_Q); 2],
        }
    }
    fn channel(&mut self, x: f32, ch: usize, amount: f32) -> f32 {
        let hi = self.hp_in[ch].process(x);
        let harmonics = (hi * 4.0).tanh() * 0.25;
        x + self.hp_out[ch].process(harmonics) * amount * 1.2
    }
}

// ── Dé-esseur ───────────────────────────────────────────────────────────────
// Seule la partie au-dessus de 5 kHz est baissée, et seulement quand elle
// dépasse le seuil : le reste du son n'est pas touché.

struct Deesser {
    lp: [Lr4; 2],
    hp: [Lr4; 2],
    env: Env,
}

impl Deesser {
    fn new() -> Self {
        Deesser {
            lp: [Lr4::lowpass(5000.0); 2],
            hp: [Lr4::highpass(5000.0); 2],
            env: Env::new(1.0, 60.0),
        }
    }
    fn process(&mut self, l: f32, r: f32, amount: f32) -> (f32, f32) {
        // Séparation Linkwitz-Riley : les deux bandes se ressomment sans creux.
        let (ll, lr) = (self.lp[0].process(l), self.lp[1].process(r));
        let (hl, hr) = (self.hp[0].process(l), self.hp[1].process(r));
        let level = lin_to_db(self.env.next(hl.abs().max(hr.abs())));
        let threshold = -14.0 - 22.0 * amount;
        let red = reduction_db(level, threshold, 4.0).min(14.0);
        let g = db_to_lin(-red);
        (ll + hl * g, lr + hr * g)
    }
}

// ── Réduction de gain douce ─────────────────────────────────────────────────
// Le niveau est mesuré en valeur efficace (pas crête par crête) et la
// réduction elle-même varie en douceur : le gain ne suit jamais l'onde, donc
// aucune distorsion « ampli » sur les basses, aucun grésillement.

struct SmoothComp {
    power: f32,
    k: f32,
    red: f32,
    atk: f32,
    rel: f32,
}

impl SmoothComp {
    fn new(attack_ms: f32, release_ms: f32) -> Self {
        SmoothComp {
            power: 0.0,
            k: 1.0 - coef(20.0),
            red: 0.0,
            atk: 1.0 - coef(attack_ms),
            rel: 1.0 - coef(release_ms),
        }
    }
    fn set(&mut self, attack_ms: f32, release_ms: f32) {
        self.atk = 1.0 - coef(attack_ms);
        self.rel = 1.0 - coef(release_ms);
    }
    /// Réduction (dB) pour un échantillon stéréo, stéréo liée.
    fn reduction(&mut self, l: f32, r: f32, threshold: f32, ratio: f32) -> f32 {
        let m = (l * l + r * r) * 0.5;
        self.power += (m - self.power) * self.k;
        // +3 dB : niveau ramené à l'échelle des crêtes (une sinusoïde à 0 dBFS vaut 0 dB).
        let level = 10.0 * self.power.max(1e-12).log10() + 3.0;
        let target = reduction_db(level, threshold, ratio);
        let c = if target > self.red {
            self.atk
        } else {
            self.rel
        };
        self.red += (target - self.red) * c;
        self.red
    }
}

// ── Compression multibande (graves / médiums / aigus) ───────────────────────
// Séparation Linkwitz-Riley à 150 Hz et 3 kHz (les bandes se ressomment sans
// creux), une compression par bande, stéréo liée.

struct Band {
    comp: SmoothComp,
    threshold: f32,
    ratio: f32,
}

struct Multiband {
    lp1: [Lr4; 2],
    hp1: [Lr4; 2],
    lp2: [Lr4; 2],
    hp2: [Lr4; 2],
    // Passe-tout à 3 kHz sur les graves, pour qu'ils restent en phase avec le reste.
    ap_lp: [Lr4; 2],
    ap_hp: [Lr4; 2],
    bands: [Band; 3],
}

const MB_F1: f32 = 150.0;
const MB_F2: f32 = 3000.0;

impl Multiband {
    fn new() -> Self {
        Multiband {
            lp1: [Lr4::lowpass(MB_F1); 2],
            hp1: [Lr4::highpass(MB_F1); 2],
            lp2: [Lr4::lowpass(MB_F2); 2],
            hp2: [Lr4::highpass(MB_F2); 2],
            ap_lp: [Lr4::lowpass(MB_F2); 2],
            ap_hp: [Lr4::highpass(MB_F2); 2],
            bands: [
                Band {
                    comp: SmoothComp::new(40.0, 300.0),
                    threshold: -20.0,
                    ratio: 3.0,
                },
                Band {
                    comp: SmoothComp::new(20.0, 200.0),
                    threshold: -22.0,
                    ratio: 3.0,
                },
                Band {
                    comp: SmoothComp::new(10.0, 120.0),
                    threshold: -24.0,
                    ratio: 3.0,
                },
            ],
        }
    }
    fn configure(&mut self, amount: f32) {
        for (i, b) in self.bands.iter_mut().enumerate() {
            b.threshold = -14.0 - 2.0 * i as f32 - 16.0 * amount;
            b.ratio = 1.5 + 2.0 * amount;
        }
    }
    fn split(&mut self, x: f32, ch: usize) -> [f32; 3] {
        let low = self.lp1[ch].process(x);
        let rest = self.hp1[ch].process(x);
        let mid = self.lp2[ch].process(rest);
        let high = self.hp2[ch].process(rest);
        let low = self.ap_lp[ch].process(low) + self.ap_hp[ch].process(low);
        [low, mid, high]
    }
    /// Renvoie aussi la plus forte réduction appliquée (dB).
    fn process(&mut self, l: f32, r: f32) -> (f32, f32, f32) {
        let bl = self.split(l, 0);
        let br = self.split(r, 1);
        let (mut ol, mut or, mut most) = (0.0, 0.0, 0.0f32);
        for (i, band) in self.bands.iter_mut().enumerate() {
            let red = band
                .comp
                .reduction(bl[i], br[i], band.threshold, band.ratio);
            most = most.max(red);
            let g = db_to_lin(-red);
            ol += bl[i] * g;
            or += br[i] * g;
        }
        (ol, or, most)
    }
}

// ── Compresseur (3 modes) ───────────────────────────────────────────────────

struct Compressor {
    comp: SmoothComp,
    mode: u8,
}

/// (seuil à intensité 0, seuil à intensité 1, rapport, attaque ms, relâchement ms)
fn comp_mode(mode: u8) -> (f32, f32, f32, f32, f32) {
    match mode {
        // Fort & propre : tient le niveau haut et régulier.
        1 => (-14.0, -32.0, 3.0, 12.0, 200.0),
        // Punch : attaque lente, les coups de batterie passent avant la compression.
        2 => (-12.0, -28.0, 2.5, 35.0, 150.0),
        // Propre : léger, pour « coller » le son sans qu'on l'entende travailler.
        _ => (-12.0, -30.0, 2.0, 20.0, 250.0),
    }
}

impl Compressor {
    fn new() -> Self {
        Compressor {
            comp: SmoothComp::new(20.0, 250.0),
            mode: 255,
        }
    }
    fn process(&mut self, l: f32, r: f32, p: &Params) -> (f32, f32, f32) {
        let (t0, t1, ratio, attack, release) = comp_mode(p.comp_mode);
        if self.mode != p.comp_mode {
            self.mode = p.comp_mode;
            self.comp.set(attack, release);
        }
        let threshold = t0 + (t1 - t0) * p.comp_amount;
        let red = self.comp.reduction(l, r, threshold, ratio);
        let g = db_to_lin(-red);
        (l * g, r * g, red)
    }
}

// ── Compensation automatique du volume ──────────────────────────────────────
// Compare le niveau avant et après la compression (sur ~2 s) et rattrape la
// différence : activer un compresseur ne baisse plus le son, et ne le monte
// pas non plus (aucune poussée qui ferait saturer).

struct Loudness {
    pre: f32,
    post: f32,
    gain: f32,
}

impl Loudness {
    fn new() -> Self {
        Loudness {
            pre: 0.0,
            post: 0.0,
            gain: 1.0,
        }
    }
    fn measure(slot: &mut f32, l: f32, r: f32) {
        let m = (l * l + r * r) * 0.5;
        *slot += (m - *slot) * (1.0 - coef(2000.0));
    }
    /// Gain de compensation, recalculé une fois par bloc.
    fn update(&mut self) {
        let target = if self.pre > 1e-9 && self.post > 1e-9 {
            (self.pre / self.post).sqrt().clamp(1.0, 32.0)
        } else {
            self.gain
        };
        self.gain += (target - self.gain) * 0.05;
    }
}

// ── Écrêteur doux ───────────────────────────────────────────────────────────

/// Courbe : linéaire jusqu'à 0,7 puis arrondie jusqu'au plafond 0,98.
fn soft_clip(x: f32) -> f32 {
    const KNEE: f32 = 0.7;
    const CEIL: f32 = 0.98;
    let a = x.abs();
    if a <= KNEE {
        x
    } else {
        let y = KNEE + (CEIL - KNEE) * ((a - KNEE) / (CEIL - KNEE)).tanh();
        y.copysign(x)
    }
}

struct Clipper {
    os: [Oversampler; 2],
}

impl Clipper {
    fn new() -> Self {
        Clipper {
            os: [Oversampler::new(), Oversampler::new()],
        }
    }
    fn channel(&mut self, x: f32, ch: usize, amount: f32) -> f32 {
        let drive = db_to_lin(6.0 * amount);
        let up = self.os[ch].upsample(x * drive);
        self.os[ch].downsample(up.map(soft_clip))
    }
}

// ── Limiteur à anticipation ─────────────────────────────────────────────────
// Le son est retardé de 4 ms : le gain commence à baisser AVANT la crête, en
// douceur. Les crêtes sont cherchées sur le signal suréchantillonné ×4 (y
// compris entre les échantillons). Plafond −1 dBFS, jamais dépassé.

pub const CEILING: f32 = 0.891;
/// Protection toujours active quand le limiteur est éteint : jamais au-delà de
/// ~0 dBFS, donc jamais d'écrêtage dur (grésillement) dans Discord.
pub const SAFETY: f32 = 0.98;
const LOOK: usize = (OUT_RATE as usize * 4) / 1000;
const LIMIT_DELAY: usize = LOOK - 1 + OS_DELAY;

struct Limiter {
    ceiling: f32,
    detect: [Oversampler; 2],
    delay: VecDeque<(f32, f32)>,
    // Minimum glissant des gains voulus : (indice, gain), croissant.
    mins: VecDeque<(u64, f32)>,
    avg: VecDeque<f32>,
    avg_sum: f32,
    held: f32,
    n: u64,
    release: f32,
}

impl Limiter {
    fn new(ceiling: f32) -> Self {
        Limiter {
            ceiling,
            detect: [Oversampler::new(), Oversampler::new()],
            delay: VecDeque::from(vec![(0.0, 0.0); LIMIT_DELAY]),
            mins: VecDeque::new(),
            avg: VecDeque::from(vec![1.0; LOOK]),
            avg_sum: LOOK as f32,
            held: 1.0,
            n: 0,
            release: 1.0 - coef(80.0),
        }
    }
    fn process(&mut self, l: f32, r: f32) -> (f32, f32, f32) {
        let peak = self.detect[0]
            .upsample(l)
            .iter()
            .chain(self.detect[1].upsample(r).iter())
            .fold(0.0f32, |m, v| m.max(v.abs()));
        let want = if peak > self.ceiling {
            self.ceiling / peak
        } else {
            1.0
        };

        // Minimum des gains voulus sur la fenêtre d'anticipation.
        self.n += 1;
        while self.mins.back().is_some_and(|&(_, g)| g >= want) {
            self.mins.pop_back();
        }
        self.mins.push_back((self.n, want));
        while self
            .mins
            .front()
            .is_some_and(|&(i, _)| i + (LOOK as u64) <= self.n)
        {
            self.mins.pop_front();
        }
        let min = self.mins.front().map_or(1.0, |&(_, g)| g);

        // Baisse immédiate, remontée douce (80 ms), puis moyenne sur la
        // fenêtre : la baisse est étalée sur les 4 ms qui précèdent la crête.
        self.held = if min < self.held {
            min
        } else {
            self.held + (min - self.held) * self.release
        };
        self.avg_sum += self.held - self.avg.pop_front().unwrap_or(1.0);
        self.avg.push_back(self.held);
        let g = (self.avg_sum / LOOK as f32).min(1.0);

        self.delay.push_back((l, r));
        let (dl, dr) = self.delay.pop_front().unwrap_or((0.0, 0.0));
        // Filet de sécurité : jamais au-delà du plafond.
        let c = self.ceiling;
        ((dl * g).clamp(-c, c), (dr * g).clamp(-c, c), -lin_to_db(g))
    }
}

// ── Tonalité (molettes graves / médiums / aigus) ────────────────────────────

struct Tone {
    low: [Biquad; 2],
    mid: [Biquad; 2],
    high: [Biquad; 2],
    at: (f32, f32, f32),
}

impl Tone {
    fn new() -> Self {
        Tone {
            low: [Biquad::default(); 2],
            mid: [Biquad::default(); 2],
            high: [Biquad::default(); 2],
            at: (0.0, 0.0, 0.0),
        }
    }
    fn update(&mut self, p: &Params) {
        if self.at == (p.bass, p.mid, p.treble) {
            return;
        }
        self.at = (p.bass, p.mid, p.treble);
        for ch in 0..2 {
            self.low[ch].set_lowshelf(120.0, FS, p.bass);
            self.mid[ch].set_peaking(1000.0, FS, 0.8, p.mid);
            self.high[ch].set_highshelf(6000.0, FS, p.treble);
        }
    }
    fn channel(&mut self, x: f32, ch: usize) -> f32 {
        let a = self.low[ch].process(x);
        let b = self.mid[ch].process(a);
        self.high[ch].process(b)
    }
}

// ── Chaîne de fin (après l'égaliseur) ───────────────────────────────────────

pub struct Chain {
    gate: Gate,
    agc: Agc,
    bass_plus: BassPlus,
    exciter: Exciter,
    deesser: Deesser,
    multiband: Multiband,
    comp: Compressor,
    loudness: Loudness,
    clipper: Clipper,
    limiter: Limiter,
    safety: Limiter,
    tone: Tone,
    mb_amount: f32,
}

impl Chain {
    pub fn new() -> Self {
        let mut c = Chain {
            gate: Gate::new(),
            agc: Agc::new(),
            bass_plus: BassPlus::new(),
            exciter: Exciter::new(),
            deesser: Deesser::new(),
            multiband: Multiband::new(),
            comp: Compressor::new(),
            loudness: Loudness::new(),
            clipper: Clipper::new(),
            limiter: Limiter::new(CEILING),
            safety: Limiter::new(SAFETY),
            tone: Tone::new(),
            mb_amount: -1.0,
        };
        c.multiband.configure(0.5);
        c
    }

    /// Début de chaîne, sur tout le bloc : porte, nivellement, mode stéréo.
    pub fn front(&mut self, buf: &mut [f32], p: &Params) {
        if p.gate {
            for frame in buf.as_chunks_mut::<2>().0 {
                (frame[0], frame[1]) = self.gate.process(frame[0], frame[1], p.gate_threshold);
            }
        }
        if p.agc {
            self.agc.process_block(buf, p.agc_target);
        }
        if p.stereo_mode != 0 || p.balance != 0.0 {
            for frame in buf.as_chunks_mut::<2>().0 {
                (frame[0], frame[1]) = stereo_mode(frame[0], frame[1], p);
            }
        }
    }

    /// Une fois par bloc, avant `back`.
    pub fn begin_block(&mut self, p: &Params) {
        if p.mb_amount != self.mb_amount {
            self.mb_amount = p.mb_amount;
            self.multiband.configure(p.mb_amount);
        }
        self.loudness.update();
        self.tone.update(p);
    }

    /// Fin de chaîne, échantillon par échantillon. `extra` = soundboard,
    /// ajoutée juste avant le volume et la protection.
    pub fn back(
        &mut self,
        l: f32,
        r: f32,
        p: &Params,
        volume: f32,
        extra: (f32, f32),
    ) -> (f32, f32) {
        let (mut l, mut r) = (l, r);
        if p.bass != 0.0 || p.mid != 0.0 || p.treble != 0.0 {
            l = self.tone.channel(l, 0);
            r = self.tone.channel(r, 1);
        }
        if p.bass_plus > 0.0 {
            (l, r) = self.bass_plus.process(l, r, p.bass_plus);
        }
        if p.clarity > 0.0 {
            l = self.exciter.channel(l, 0, p.clarity);
            r = self.exciter.channel(r, 1, p.clarity);
        }
        if p.deesser > 0.0 {
            (l, r) = self.deesser.process(l, r, p.deesser);
        }

        let dynamics = p.multiband || p.compressor;
        if dynamics {
            Loudness::measure(&mut self.loudness.pre, l, r);
            let mut most = 0.0f32;
            if p.multiband {
                let (a, b, red) = self.multiband.process(l, r);
                (l, r) = (a, b);
                most = most.max(red);
            }
            if p.compressor {
                let (a, b, red) = self.comp.process(l, r, p);
                (l, r) = (a, b);
                most = most.max(red);
            }
            Loudness::measure(&mut self.loudness.post, l, r);
            note_gr(comp_gr(), most);
            l *= self.loudness.gain;
            r *= self.loudness.gain;
        }

        if p.saturation > 0.001 {
            // Saturation douce, niveau gardé : tanh(k·x) / tanh(k).
            let k = 1.0 + p.saturation * 9.0;
            let norm = k.tanh();
            l = (k * l).tanh() / norm;
            r = (k * r).tanh() / norm;
        }
        if p.clipper > 0.0 {
            l = self.clipper.channel(l, 0, p.clipper);
            r = self.clipper.channel(r, 1, p.clipper);
        }

        l = (l + extra.0) * volume;
        r = (r + extra.1) * volume;
        // Limiteur à −1 dB, ou à défaut la protection à 0 dB : jamais de
        // saturation. Les deux coupés : le son passe tel quel.
        let lim = if p.limiter {
            &mut self.limiter
        } else if p.protect {
            &mut self.safety
        } else {
            return (l, r);
        };
        let (a, b, red) = lim.process(l, r);
        note_gr(limit_gr(), red);
        (a, b)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(hz: f32, amp: f32, secs: f32) -> Vec<f32> {
        (0..(FS * secs) as usize)
            .map(|i| amp * (std::f32::consts::TAU * hz * i as f32 / FS).sin())
            .collect()
    }

    fn rms(x: &[f32]) -> f32 {
        (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt()
    }

    fn peak(x: &[f32]) -> f32 {
        x.iter().fold(0.0, |m, v| m.max(v.abs()))
    }

    /// Passe un signal mono (copié sur L et R) dans `back` ; renvoie la voie gauche.
    fn run_back(p: &Params, input: &[f32]) -> Vec<f32> {
        let mut c = Chain::new();
        let mut out = Vec::with_capacity(input.len());
        for block in input.chunks(480) {
            c.begin_block(p);
            for &x in block {
                out.push(c.back(x, x, p, 1.0, (0.0, 0.0)).0);
            }
        }
        out
    }

    fn tail(x: &[f32]) -> &[f32] {
        &x[x.len() / 2..]
    }

    #[test]
    fn suréchantillonnage_garde_le_signal() {
        let mut os = Oversampler::new();
        let input = sine(1000.0, 0.5, 0.5);
        let out: Vec<f32> = input
            .iter()
            .map(|&x| {
                let up = os.upsample(x);
                os.downsample(up)
            })
            .collect();
        let r = rms(tail(&out)) / rms(tail(&input));
        assert!((r - 1.0).abs() < 0.02, "gain {r}");
    }

    #[test]
    fn limiteur_jamais_au_dessus_du_plafond() {
        let p = Params {
            limiter: true,
            ..Params::default()
        };
        let out = run_back(&p, &sine(1000.0, 2.0, 1.0));
        assert!(peak(&out) <= CEILING + 1e-6);
        // Il limite sans écraser : le niveau reste proche du plafond.
        assert!(peak(tail(&out)) > 0.85);
    }

    #[test]
    fn limiteur_voit_les_crêtes_entre_échantillons() {
        // 12 kHz décalé de 45° : les échantillons valent 0,85 mais la vraie
        // crête est 1,2 (au-dessus du plafond).
        let input: Vec<f32> = (0..FS as usize)
            .map(|i| {
                1.2 * (std::f32::consts::TAU * 12000.0 * i as f32 / FS
                    + std::f32::consts::FRAC_PI_4)
                    .sin()
            })
            .collect();
        assert!(peak(&input) < CEILING);
        let p = Params {
            limiter: true,
            ..Params::default()
        };
        let out = run_back(&p, &input);
        // Vraie crête de sortie = crête des échantillons × √2.
        assert!(
            peak(tail(&out)) * std::f32::consts::SQRT_2 < 0.95,
            "{}",
            peak(tail(&out))
        );
    }

    #[test]
    fn multibande_se_ressomme_sans_creux() {
        for hz in [80.0, 150.0, 1000.0, 3000.0, 8000.0] {
            let mut mb = Multiband::new();
            let input = sine(hz, 0.5, 0.5);
            let out: Vec<f32> = input.iter().map(|&x| mb.split(x, 0).iter().sum()).collect();
            let r = rms(tail(&out)) / rms(tail(&input));
            assert!((r - 1.0).abs() < 0.03, "{hz} Hz : {r}");
        }
    }

    #[test]
    fn compresseur_ne_baisse_pas_le_son() {
        for mode in 0..3 {
            let p = Params {
                compressor: true,
                comp_mode: mode,
                comp_amount: 1.0,
                ..Params::default()
            };
            let input = sine(440.0, 0.5, 6.0);
            let out = run_back(&p, &input);
            let r = rms(&out[out.len() - FS as usize..]) / rms(&input);
            assert!(r > 0.97, "mode {mode} : {r}");
        }
    }

    #[test]
    fn compresseur_sans_distorsion_sur_les_basses() {
        // Une basse à 60 Hz bien compressée ne doit pas gagner d'harmoniques
        // (c'était la saturation « ampli »).
        let p = Params {
            compressor: true,
            comp_mode: 1,
            comp_amount: 1.0,
            ..Params::default()
        };
        let out = run_back(&p, &sine(60.0, 0.8, 3.0));
        // Trois passe-bandes en cascade : la mesure à 180 Hz ne voit plus le 60 Hz.
        let band = |hz: f32| {
            let mut f = [Biquad::default(); 3];
            for b in f.iter_mut() {
                b.set_bandpass(hz, FS, 8.0);
            }
            let filtered: Vec<f32> = out
                .iter()
                .map(|&x| {
                    let a = f[0].process(x);
                    let b = f[1].process(a);
                    f[2].process(b)
                })
                .collect();
            rms(tail(&filtered))
        };
        let (fundamental, third) = (band(60.0), band(180.0));
        assert!(
            third < fundamental * 0.01,
            "harmonique {third} / {fundamental}"
        );
        assert!(peak(tail(&out)) <= SAFETY + 1e-6);
    }

    #[test]
    fn protection_même_sans_limiteur() {
        let p = Params {
            limiter: false,
            ..Params::default()
        };
        let mut c = Chain::new();
        let out: Vec<f32> = sine(300.0, 2.5, 0.5)
            .iter()
            .map(|&x| c.back(x, x, &p, 1.0, (0.0, 0.0)).0)
            .collect();
        assert!(peak(&out) <= SAFETY + 1e-6);
    }

    #[test]
    fn protection_désactivable() {
        let p = Params {
            limiter: false,
            protect: false,
            ..Params::default()
        };
        let mut c = Chain::new();
        // Rien ne touche le son : 2.5 ressort à 2.5.
        let out: Vec<f32> = sine(300.0, 2.5, 0.5)
            .iter()
            .map(|&x| c.back(x, x, &p, 1.0, (0.0, 0.0)).0)
            .collect();
        assert!((peak(&out) - 2.5).abs() < 0.01);
    }

    #[test]
    fn molettes_de_tonalité() {
        let p = Params {
            bass: 12.0,
            treble: -12.0,
            ..Params::default()
        };
        let low = run_back(&p, &sine(50.0, 0.05, 0.5));
        let high = run_back(&p, &sine(12000.0, 0.05, 0.5));
        assert!(rms(tail(&low)) > 0.05 / std::f32::consts::SQRT_2 * 3.0);
        assert!(rms(tail(&high)) < 0.05 / std::f32::consts::SQRT_2 * 0.35);
    }

    #[test]
    fn compresseur_resserre_les_écarts() {
        let p = Params {
            compressor: true,
            comp_mode: 1,
            comp_amount: 1.0,
            ..Params::default()
        };
        let mut c = Chain::new();
        // Fort puis faible, sans laisser la compensation se recaler entre les deux.
        let mut level = |amp: f32| {
            let out: Vec<f32> = sine(440.0, amp, 0.5)
                .iter()
                .map(|&x| c.back(x, x, &p, 1.0, (0.0, 0.0)).0)
                .collect();
            rms(tail(&out))
        };
        let fort = level(0.9);
        let faible = level(0.09);
        assert!(lin_to_db(fort) - lin_to_db(faible) < 12.0);
    }

    #[test]
    fn écrêteur_plafonne() {
        let p = Params {
            clipper: 1.0,
            ..Params::default()
        };
        let out = run_back(&p, &sine(200.0, 1.5, 0.5));
        // Plafond de la courbe 0,98 ; le filtrage du suréchantillonnage peut
        // dépasser de quelques % sur un signal écrêté (le limiteur suit).
        assert!(peak(tail(&out)) < 1.08, "{}", peak(tail(&out)));
    }

    #[test]
    fn dé_esseur_baisse_les_aigus_seulement() {
        let p = Params {
            deesser: 1.0,
            ..Params::default()
        };
        let hi = run_back(&p, &sine(7000.0, 0.5, 0.5));
        let lo = run_back(&p, &sine(500.0, 0.5, 0.5));
        assert!(
            rms(tail(&hi)) < 0.5 / std::f32::consts::SQRT_2 * 0.7,
            "aigus {}",
            rms(tail(&hi))
        );
        assert!((rms(tail(&lo)) / (0.5 / std::f32::consts::SQRT_2) - 1.0).abs() < 0.06);
    }

    #[test]
    fn basses_plus_ajoute_des_harmoniques() {
        let p = Params {
            bass_plus: 1.0,
            ..Params::default()
        };
        let out = run_back(&p, &sine(50.0, 0.5, 1.0));
        let mut bp = Biquad::default();
        bp.set_bandpass(150.0, FS, 1.0);
        let harmonics = rms(tail(
            &out.iter().map(|&x| bp.process(x)).collect::<Vec<_>>(),
        ));
        assert!(harmonics > 0.03, "{harmonics}");
    }

    #[test]
    fn clarté_ajoute_de_la_brillance() {
        let p = Params {
            clarity: 1.0,
            ..Params::default()
        };
        let input = sine(6000.0, 0.3, 0.5);
        let out = run_back(&p, &input);
        assert!(rms(tail(&out)) > rms(tail(&input)) * 1.05);
    }

    #[test]
    fn porte_coupe_le_souffle() {
        let p = Params {
            gate: true,
            gate_threshold: -50.0,
            ..Params::default()
        };
        let mut c = Chain::new();
        let mut noise: Vec<f32> = sine(3000.0, 0.0005, 1.0)
            .iter()
            .flat_map(|&x| [x, x])
            .collect();
        c.front(&mut noise, &p);
        assert!(peak(tail(&noise)) < 0.00002);
        let mut music: Vec<f32> = sine(300.0, 0.3, 0.5).iter().flat_map(|&x| [x, x]).collect();
        c.front(&mut music, &p);
        assert!(peak(tail(&music)) > 0.29);
    }

    #[test]
    fn nivellement_remonte_un_son_faible() {
        let p = Params {
            agc: true,
            agc_target: -18.0,
            ..Params::default()
        };
        let mut c = Chain::new();
        let mut buf: Vec<f32> = sine(300.0, 0.02, 12.0)
            .iter()
            .flat_map(|&x| [x, x])
            .collect();
        for block in buf.chunks_mut(960) {
            c.front(block, &p);
        }
        let gain = lin_to_db(peak(tail(&buf)) / 0.02);
        assert!(gain > 10.0 && gain < 12.5, "{gain} dB");
    }

    #[test]
    fn graves_en_mono_et_modes_stéréo() {
        let p = Params {
            bass_mono: 120.0,
            ..Params::default()
        };
        let mut w = StereoWidth::new();
        // Grave uniquement sur les côtés (L = −R) : il doit disparaître.
        let side: Vec<f32> = sine(50.0, 0.5, 0.5)
            .iter()
            .map(|&x| w.process(x, -x, &p).0)
            .collect();
        assert!(rms(tail(&side)) < 0.5 * 0.1);

        let mono = Params {
            stereo_mode: 1,
            ..Params::default()
        };
        assert_eq!(stereo_mode(1.0, 0.0, &mono), (0.5, 0.5));
        let swap = Params {
            stereo_mode: 2,
            ..Params::default()
        };
        assert_eq!(stereo_mode(1.0, 0.2, &swap), (0.2, 1.0));
        let right = Params {
            balance: 1.0,
            ..Params::default()
        };
        assert_eq!(stereo_mode(1.0, 1.0, &right), (0.0, 1.0));
    }

    #[test]
    fn chaîne_complète_bien_plus_rapide_que_le_temps_réel() {
        let p = Params {
            highpass: 40.0,
            width: 1.3,
            saturation: 0.3,
            compressor: true,
            comp_mode: 1,
            comp_amount: 0.8,
            limiter: true,
            gate: true,
            agc: true,
            stereo_mode: 0,
            balance: 0.1,
            bass_mono: 120.0,
            bass_plus: 0.5,
            clarity: 0.5,
            deesser: 0.5,
            multiband: true,
            mb_amount: 0.7,
            clipper: 0.5,
            ..Params::default()
        };
        let mut c = Chain::new();
        let mut buf: Vec<f32> = sine(440.0, 0.5, 10.0)
            .iter()
            .flat_map(|&x| [x, x * 0.8])
            .collect();
        let start = std::time::Instant::now();
        for block in buf.chunks_mut(960) {
            c.front(block, &p);
            c.begin_block(&p);
            for f in block.as_chunks_mut::<2>().0 {
                (f[0], f[1]) = c.back(f[0], f[1], &p, 1.0, (0.0, 0.0));
            }
        }
        let took = start.elapsed().as_secs_f32();
        println!("10 s de son traités en {took:.3} s");
        // Moins de 20 % du temps réel, même sur une machine de CI.
        assert!(took < 2.0, "{took} s");
        assert!(buf
            .iter()
            .all(|x| x.is_finite() && x.abs() <= CEILING + 1e-6));
    }

    #[test]
    fn réglages_bornés() {
        let p = Params::from_json(
            &json!({ "width": 9, "clipper": -1, "highpass": 10, "bassMono": 9000, "compMode": 7 }),
        );
        assert_eq!(p.width, 2.0);
        assert_eq!(p.clipper, 0.0);
        assert_eq!(p.highpass, 0.0);
        assert_eq!(p.bass_mono, 250.0);
        assert_eq!(p.comp_mode, 2);
        assert_eq!(Params::from_json(&p.to_json()), p);
    }
}
