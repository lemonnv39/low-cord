//! Chaîne audio : capture live (cpal) → effets (gain → 8D → réverbe →
//! égaliseur), calculés UNE fois → copiés dans le tampon de chaque compte en
//! vocal → lus par songbird. Tous les comptes diffusent donc le même son.
//! Tous les réglages sont des atomiques lus à chaque bloc : ils s'appliquent à
//! chaud, sans couper la diffusion.

use std::collections::VecDeque;
use std::io::{Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde_json::{json, Map, Value};

use crate::lock;

pub const OUT_RATE: u32 = 48000;
type Ring = Arc<Mutex<VecDeque<f32>>>;

fn f32_atomic(init: f32) -> AtomicU32 {
    AtomicU32::new(init.to_bits())
}
fn load_f32(a: &AtomicU32) -> f32 {
    f32::from_bits(a.load(Ordering::Relaxed))
}
fn store_f32(a: &AtomicU32, v: f32) {
    a.store(v.to_bits(), Ordering::Relaxed)
}

macro_rules! global {
    ($name:ident : $ty:ty = $init:expr) => {
        fn $name() -> &'static $ty {
            static S: OnceLock<$ty> = OnceLock::new();
            S.get_or_init(|| $init)
        }
    };
}

// Gain d'entrée linéaire (0 dB = 1.0).
global!(gain: AtomicU32 = f32_atomic(1.0));
// Volume général de sortie (1.0 = 100 %), juste avant le limiteur.
global!(volume: AtomicU32 = f32_atomic(1.0));
// Latence cible (ms) = taille max du tampon. Plus bas = plus réactif, mais
// risque de micro-coupures.
global!(latency_ms: AtomicU32 = AtomicU32::new(200));
// 8D : 0 = off (stéréo directe), 1 = auto (rotation), 2 = manuel.
global!(eightd_mode: AtomicU32 = AtomicU32::new(0));
// Vitesse de rotation auto (Hz). 0.15 Hz ≈ 7 s par tour.
global!(eightd_speed: AtomicU32 = f32_atomic(0.15));
// Position panoramique manuelle [0..1], 0.5 = centre.
global!(eightd_pos: AtomicU32 = f32_atomic(0.5));
global!(reverb_on: AtomicBool = AtomicBool::new(false));
// Taille de la salle [0..1] : longueur de la réverbe.
global!(reverb_room: AtomicU32 = f32_atomic(0.5));
// Distance [0..1] : dosage son direct / réverbéré.
global!(reverb_distance: AtomicU32 = f32_atomic(0.4));
// Gains des 10 bandes de l'égaliseur, en dB [-12..12].
global!(eq_gains: Mutex<[f32; 10]> = Mutex::new([0.0; 10]));
// Périphérique choisi (None = entrée par défaut).
global!(current_input: Mutex<Option<String>> = Mutex::new(None));
// Drapeau d'arrêt de la capture en cours.
global!(capture_stop: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None));
// Traitement : coupe-bas (Hz, 0 = off), largeur stéréo (1 = normale),
// saturation [0..1], compresseur (on + intensité [0..1]), limiteur.
global!(highpass_hz: AtomicU32 = f32_atomic(0.0));
global!(width: AtomicU32 = f32_atomic(1.0));
global!(saturation: AtomicU32 = f32_atomic(0.0));
global!(comp_on: AtomicBool = AtomicBool::new(false));
global!(comp_amount: AtomicU32 = f32_atomic(0.5));
global!(limiter_on: AtomicBool = AtomicBool::new(false));

/// Réglages audio courants, pour un panneau qui se (re)monte.
pub fn snapshot(map: &mut Map<String, Value>) {
    map.insert(
        "input".into(),
        lock(current_input())
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    map.insert(
        "latency".into(),
        json!(latency_ms().load(Ordering::Relaxed)),
    );
    map.insert("reverb".into(), json!(reverb_on().load(Ordering::Relaxed)));
    map.insert("reverbRoom".into(), json!(load_f32(reverb_room())));
    map.insert("reverbDistance".into(), json!(load_f32(reverb_distance())));
    map.insert("eq".into(), json!(lock(eq_gains()).to_vec()));
    map.insert("volume".into(), json!(load_f32(volume())));
    map.insert(
        "processing".into(),
        json!({
            "highpass": load_f32(highpass_hz()),
            "width": load_f32(width()),
            "saturation": load_f32(saturation()),
            "compressor": comp_on().load(Ordering::Relaxed),
            "compAmount": load_f32(comp_amount()),
            "limiter": limiter_on().load(Ordering::Relaxed),
        }),
    );
}

// ── Réglages ────────────────────────────────────────────────────────────────

pub fn set_gain(db: f32) {
    store_f32(gain(), 10f32.powf(db.clamp(-64.0, 64.0) / 20.0));
}

/// Volume général (0 à 2, soit 0 à 200 %), commun à tous les comptes.
pub fn set_volume(v: f32) {
    store_f32(volume(), v.clamp(0.0, 2.0));
}

pub fn set_latency(ms: u32) {
    latency_ms().store(ms.clamp(40, 2000), Ordering::Relaxed);
}

pub fn set_8d(mode: u8, speed: f32, position: f32) {
    eightd_mode().store(u32::from(mode.min(2)), Ordering::Relaxed);
    store_f32(eightd_speed(), speed.clamp(0.0, 5.0));
    store_f32(eightd_pos(), position.clamp(0.0, 1.0));
}

pub fn set_reverb(on: bool) {
    reverb_on().store(on, Ordering::Relaxed);
}

pub fn set_reverb_params(room: f32, distance: f32) {
    store_f32(reverb_room(), room.clamp(0.0, 1.0));
    store_f32(reverb_distance(), distance.clamp(0.0, 1.0));
}

pub fn set_eq(bands: Vec<f32>) {
    let mut g = lock(eq_gains());
    for (i, slot) in g.iter_mut().enumerate() {
        *slot = bands.get(i).copied().unwrap_or(0.0).clamp(-12.0, 12.0);
    }
}

/// Traitement : coupe-bas, largeur stéréo, saturation, compresseur, limiteur.
pub fn set_processing(
    highpass: f32,
    stereo_width: f32,
    drive: f32,
    compressor: bool,
    amount: f32,
    limiter: bool,
) {
    // En dessous de 20 Hz, le coupe-bas est coupé.
    let hz = if highpass < 20.0 {
        0.0
    } else {
        highpass.min(400.0)
    };
    store_f32(highpass_hz(), hz);
    store_f32(width(), stereo_width.clamp(0.0, 2.0));
    store_f32(saturation(), drive.clamp(0.0, 1.0));
    comp_on().store(compressor, Ordering::Relaxed);
    store_f32(comp_amount(), amount.clamp(0.0, 1.0));
    limiter_on().store(limiter, Ordering::Relaxed);
}

// ── 8D ──────────────────────────────────────────────────────────────────────

fn spatialize(l: f32, r: f32, phase: &mut f32) -> (f32, f32) {
    match eightd_mode().load(Ordering::Relaxed) {
        1 => {
            *phase += std::f32::consts::TAU * load_f32(eightd_speed()) / OUT_RATE as f32;
            if *phase > std::f32::consts::TAU {
                *phase -= std::f32::consts::TAU;
            }
            pan_mono((l + r) * 0.5, (phase.sin() + 1.0) * 0.5)
        }
        2 => pan_mono((l + r) * 0.5, load_f32(eightd_pos())),
        _ => (l, r),
    }
}

/// Panoramique à puissance constante d'un signal mono, position p ∈ [0,1].
fn pan_mono(mono: f32, p: f32) -> (f32, f32) {
    let angle = p.clamp(0.0, 1.0) * std::f32::consts::FRAC_PI_2;
    (mono * angle.cos(), mono * angle.sin())
}

// ── Réverbe (Freeverb) ─────────────────────────────────────────────────────
// 8 filtres en peigne + 4 passe-tout par canal, décalage stéréo de 23
// échantillons : la réverbe « classique » de référence.

struct Comb {
    buf: Vec<f32>,
    idx: usize,
    filt: f32,
    damp1: f32,
    damp2: f32,
    feedback: f32,
}
impl Comb {
    fn new(len: usize, feedback: f32, damp: f32) -> Self {
        Comb {
            buf: vec![0.0; len.max(1)],
            idx: 0,
            filt: 0.0,
            damp1: damp,
            damp2: 1.0 - damp,
            feedback,
        }
    }
    fn process(&mut self, input: f32) -> f32 {
        let out = self.buf[self.idx];
        self.filt = out * self.damp2 + self.filt * self.damp1;
        self.buf[self.idx] = input + self.filt * self.feedback;
        self.idx = (self.idx + 1) % self.buf.len();
        out
    }
}

struct Allpass {
    buf: Vec<f32>,
    idx: usize,
    feedback: f32,
}
impl Allpass {
    fn new(len: usize, feedback: f32) -> Self {
        Allpass {
            buf: vec![0.0; len.max(1)],
            idx: 0,
            feedback,
        }
    }
    fn process(&mut self, input: f32) -> f32 {
        let buf = self.buf[self.idx];
        self.buf[self.idx] = input + buf * self.feedback;
        self.idx = (self.idx + 1) % self.buf.len();
        buf - input
    }
}

struct Reverb {
    cl: Vec<Comb>,
    cr: Vec<Comb>,
    al: Vec<Allpass>,
    ar: Vec<Allpass>,
    wet: f32,
    dry: f32,
}
impl Reverb {
    fn new() -> Self {
        // Accordages Freeverb (44,1 kHz) ré-échelonnés vers 48 kHz.
        let scale = OUT_RATE as f32 / 44100.0;
        let s = |n: usize| ((n as f32) * scale) as usize;
        let combs = [1116usize, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
        let aps = [556usize, 441, 341, 225];
        let spread = s(23);
        Reverb {
            cl: combs.iter().map(|&n| Comb::new(s(n), 0.84, 0.2)).collect(),
            cr: combs
                .iter()
                .map(|&n| Comb::new(s(n) + spread, 0.84, 0.2))
                .collect(),
            al: aps.iter().map(|&n| Allpass::new(s(n), 0.5)).collect(),
            ar: aps
                .iter()
                .map(|&n| Allpass::new(s(n) + spread, 0.5))
                .collect(),
            wet: 0.24,
            dry: 0.84,
        }
    }
    fn update(&mut self, room: f32, distance: f32) {
        let fb = room.clamp(0.0, 1.0) * 0.28 + 0.7;
        for c in self.cl.iter_mut().chain(self.cr.iter_mut()) {
            c.feedback = fb;
        }
        let d = distance.clamp(0.0, 1.0);
        self.wet = d * 0.6;
        self.dry = 1.0 - d * 0.4;
    }
    fn process(&mut self, l: f32, r: f32) -> (f32, f32) {
        let input = (l + r) * 0.015; // gain d'entrée Freeverb (stabilité des peignes)
        let mut wl: f32 = self.cl.iter_mut().map(|c| c.process(input)).sum();
        let mut wr: f32 = self.cr.iter_mut().map(|c| c.process(input)).sum();
        for a in self.al.iter_mut() {
            wl = a.process(wl);
        }
        for a in self.ar.iter_mut() {
            wr = a.process(wr);
        }
        (l * self.dry + wl * self.wet, r * self.dry + wr * self.wet)
    }
}

// ── Égaliseur 10 bandes (biquads « peaking », formules RBJ) ─────────────────

const EQ_FREQS: [f32; 10] = [
    31.0, 62.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0,
];

#[derive(Clone, Copy)]
struct Biquad {
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
    fn set_peaking(&mut self, f0: f32, fs: f32, q: f32, gain_db: f32) {
        let a = 10f32.powf(gain_db / 40.0);
        let w0 = std::f32::consts::TAU * f0 / fs;
        let cw = w0.cos();
        let alpha = w0.sin() / (2.0 * q);
        let a0 = 1.0 + alpha / a;
        self.b0 = (1.0 + alpha * a) / a0;
        self.b1 = (-2.0 * cw) / a0;
        self.b2 = (1.0 - alpha * a) / a0;
        self.a1 = (-2.0 * cw) / a0;
        self.a2 = (1.0 - alpha / a) / a0;
    }
    /// Passe-haut (coupe-bas) d'ordre 2, Q = 0,707 (formules RBJ).
    fn set_highpass(&mut self, f0: f32, fs: f32) {
        let w0 = std::f32::consts::TAU * f0 / fs;
        let cw = w0.cos();
        let alpha = w0.sin() / (2.0 * std::f32::consts::FRAC_1_SQRT_2);
        let a0 = 1.0 + alpha;
        self.b0 = (1.0 + cw) / 2.0 / a0;
        self.b1 = -(1.0 + cw) / a0;
        self.b2 = (1.0 + cw) / 2.0 / a0;
        self.a1 = (-2.0 * cw) / a0;
        self.a2 = (1.0 - alpha) / a0;
    }
    fn process(&mut self, x: f32) -> f32 {
        // Forme directe II transposée (stable).
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
}

struct Eq {
    bands: [[Biquad; 10]; 2],
    gains: [f32; 10],
}
impl Eq {
    fn new() -> Self {
        Eq {
            bands: [[Biquad::default(); 10]; 2],
            gains: [0.0; 10],
        }
    }
    /// Recalcule les coefficients seulement si les gains ont changé.
    fn update(&mut self, gains: &[f32; 10]) {
        if &self.gains == gains {
            return;
        }
        self.gains = *gains;
        for ch in self.bands.iter_mut() {
            for (i, b) in ch.iter_mut().enumerate() {
                b.set_peaking(EQ_FREQS[i], OUT_RATE as f32, 1.4, gains[i]);
            }
        }
    }
    fn process(&mut self, x: f32, ch: usize) -> f32 {
        self.bands[ch].iter_mut().fold(x, |y, b| b.process(y))
    }
}

// ── Dynamique (compresseur, limiteur) ───────────────────────────────────────
// Suiveur d'enveloppe sur le maximum des deux canaux (stéréo liée : l'image
// ne bouge pas quand un seul côté tape fort).

struct Follower {
    env: f32,
    attack: f32,
    release: f32,
}

impl Follower {
    fn new(attack_ms: f32, release_ms: f32) -> Self {
        let k = |ms: f32| (-1.0 / (ms * OUT_RATE as f32 / 1000.0)).exp();
        Follower {
            env: 0.0,
            attack: k(attack_ms),
            release: k(release_ms),
        }
    }
    fn next(&mut self, level: f32) -> f32 {
        let c = if level > self.env {
            self.attack
        } else {
            self.release
        };
        self.env = level + c * (self.env - level);
        self.env
    }
}

fn db(x: f32) -> f32 {
    20.0 * x.max(1e-9).log10()
}

fn from_db(d: f32) -> f32 {
    10f32.powf(d / 20.0)
}

// ── Chaîne d'effets ─────────────────────────────────────────────────────────
// Vit dans la capture : une seule par source, quel que soit le nombre de comptes.

struct Dsp {
    eq: Eq,
    reverb: Reverb,
    lfo: f32,
    highpass: [Biquad; 2],
    highpass_hz: f32,
    comp: Follower,
    limit: Follower,
}

impl Dsp {
    fn new() -> Self {
        Dsp {
            eq: Eq::new(),
            reverb: Reverb::new(),
            lfo: 0.0,
            highpass: [Biquad::default(); 2],
            highpass_hz: 0.0,
            comp: Follower::new(10.0, 150.0),
            limit: Follower::new(1.0, 80.0),
        }
    }

    /// Applique les effets à un bloc stéréo entrelacé (réglages relus à chaque bloc).
    fn process(&mut self, buf: &mut [f32]) {
        let g = load_f32(gain());
        let gains = *lock(eq_gains());
        let eq_active = gains.iter().any(|g| g.abs() > 0.01);
        if eq_active {
            self.eq.update(&gains);
        }
        let rvb = reverb_on().load(Ordering::Relaxed);
        if rvb {
            self.reverb
                .update(load_f32(reverb_room()), load_f32(reverb_distance()));
        }
        let hp = load_f32(highpass_hz());
        if hp != self.highpass_hz {
            self.highpass_hz = hp;
            for b in self.highpass.iter_mut() {
                b.set_highpass(hp.max(20.0), OUT_RATE as f32);
            }
        }
        let w = load_f32(width());
        let drive = load_f32(saturation());
        // Saturation douce (tanh), niveau gardé : tanh(k·x) / tanh(k).
        let k = 1.0 + drive * 9.0;
        let norm = k.tanh();
        let comp = comp_on().load(Ordering::Relaxed);
        // Intensité → seuil de −10 à −40 dB, rapport 4:1, compensation de la moitié.
        let threshold = -10.0 - 30.0 * load_f32(comp_amount());
        let makeup = from_db(-threshold * 0.75 * 0.5);
        let vol = load_f32(volume());
        let limit = limiter_on().load(Ordering::Relaxed);
        const CEILING: f32 = 0.891; // −1 dBFS

        for frame in buf.as_chunks_mut::<2>().0 {
            let (mut l, mut r) = (frame[0] * g, frame[1] * g);
            if hp > 0.0 {
                l = self.highpass[0].process(l);
                r = self.highpass[1].process(r);
            }
            (l, r) = spatialize(l, r, &mut self.lfo);
            if (w - 1.0).abs() > 0.01 {
                let mid = (l + r) * 0.5;
                let side = (l - r) * 0.5 * w;
                (l, r) = (mid + side, mid - side);
            }
            if rvb {
                (l, r) = self.reverb.process(l, r);
            }
            if eq_active {
                l = self.eq.process(l, 0);
                r = self.eq.process(r, 1);
            }
            if drive > 0.001 {
                l = (k * l).tanh() / norm;
                r = (k * r).tanh() / norm;
            }
            if comp {
                let env = self.comp.next(l.abs().max(r.abs()));
                let over = db(env) - threshold;
                let reduce = if over > 0.0 {
                    from_db(-over * 0.75)
                } else {
                    1.0
                };
                l *= reduce * makeup;
                r *= reduce * makeup;
            }
            l *= vol;
            r *= vol;
            if limit {
                let env = self.limit.next(l.abs().max(r.abs()));
                if env > CEILING {
                    let reduce = CEILING / env;
                    l *= reduce;
                    r *= reduce;
                }
                // Filet de sécurité : jamais au-delà du plafond.
                l = l.clamp(-CEILING, CEILING);
                r = r.clamp(-CEILING, CEILING);
            }
            frame[0] = l;
            frame[1] = r;
        }
    }
}

// ── Distribution aux comptes ────────────────────────────────────────────────
// Chaque compte en vocal a son tampon ; la capture y copie le son traité. Un
// compte qui quitte le vocal libère sa source : son tampon sort de la liste.

global!(consumers: Mutex<Vec<Weak<Mutex<VecDeque<f32>>>>> = Mutex::new(Vec::new()));

fn distribute(block: &[f32]) {
    let ms = latency_ms().load(Ordering::Relaxed) as usize;
    let cap = (OUT_RATE as usize * 2 * ms / 1000).max(1920);
    lock(consumers()).retain(|weak| {
        let Some(ring) = weak.upgrade() else {
            return false;
        };
        let mut q = lock(&ring);
        q.extend(block.iter().copied());
        // Plafond = latence cible : borne le retard capture → émission.
        let excess = q.len().saturating_sub(cap);
        q.drain(..excess);
        true
    });
}

fn clear_consumers() {
    for weak in lock(consumers()).iter() {
        if let Some(ring) = weak.upgrade() {
            lock(&ring).clear();
        }
    }
}

// ── Source lue par songbird (une par compte en vocal) ──────────────────────
// Renvoie du silence quand le tampon est vide, pour que la piste ne s'arrête
// jamais.

pub struct LiveSource {
    ring: Ring,
}

impl LiveSource {
    pub fn new() -> Self {
        let ring: Ring = Arc::new(Mutex::new(VecDeque::new()));
        lock(consumers()).push(Arc::downgrade(&ring));
        LiveSource { ring }
    }
}

impl Read for LiveSource {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        let n = out.len() / 4; // échantillons f32 entrelacés L,R
        let mut q = lock(&self.ring);
        let mut i = 0;
        while i + 1 < n {
            let l = q.pop_front().unwrap_or(0.0);
            let r = q.pop_front().unwrap_or(0.0);
            out[i * 4..i * 4 + 4].copy_from_slice(&l.to_le_bytes());
            out[(i + 1) * 4..(i + 1) * 4 + 4].copy_from_slice(&r.to_le_bytes());
            i += 2;
        }
        drop(q);
        out[i * 4..].fill(0);
        Ok(out.len())
    }
}

impl Seek for LiveSource {
    fn seek(&mut self, _: SeekFrom) -> std::io::Result<u64> {
        Ok(0)
    }
}

impl symphonia::core::io::MediaSource for LiveSource {
    fn is_seekable(&self) -> bool {
        false
    }
    fn byte_len(&self) -> Option<u64> {
        None
    }
}

// ── Capture ────────────────────────────────────────────────────────────────

/// Noms des périphériques d'entrée.
pub fn devices() -> Vec<String> {
    cpal::default_host()
        .input_devices()
        .map(|it| it.filter_map(|d| d.name().ok()).collect())
        .unwrap_or_default()
}

/// (Re)démarre la capture sur le périphérique nommé (None = entrée par défaut).
pub fn set_input(name: Option<String>) -> Result<(), String> {
    *lock(current_input()) = name.clone();
    stop_capture();
    let running = Arc::new(AtomicBool::new(true));
    *lock(capture_stop()) = Some(running.clone());
    start_capture(name, running);
    Ok(())
}

pub fn stop_capture() {
    if let Some(flag) = lock(capture_stop()).take() {
        flag.store(false, Ordering::Relaxed);
    }
    clear_consumers();
}

fn capture_error(msg: impl Into<String>) {
    crate::engine::emit_global(json!({ "captureError": msg.into() }));
}

/// Fil dédié : `cpal::Stream` n'est pas Send, il vit ici jusqu'à l'arrêt.
fn start_capture(input_name: Option<String>, running: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let host = cpal::default_host();
        let device = match &input_name {
            Some(name) => host
                .input_devices()
                .ok()
                .and_then(|mut it| it.find(|d| d.name().map(|n| &n == name).unwrap_or(false))),
            None => host.default_input_device(),
        };
        let Some(device) = device else {
            return capture_error(match input_name {
                Some(n) => format!("Périphérique introuvable : {n}"),
                None => "Aucune entrée audio par défaut.".into(),
            });
        };
        let cfg = match device.default_input_config() {
            Ok(c) => c,
            Err(e) => return capture_error(format!("Périphérique inutilisable : {e}")),
        };
        let in_ch = cfg.channels() as usize;
        let ratio = OUT_RATE as f32 / cfg.sample_rate().0 as f32;
        let stream = match cfg.sample_format() {
            cpal::SampleFormat::F32 => build_stream::<f32>(&device, &cfg, in_ch, ratio, |x| x),
            cpal::SampleFormat::I16 => {
                build_stream::<i16>(&device, &cfg, in_ch, ratio, |x| x as f32 / 32768.0)
            }
            cpal::SampleFormat::U16 => build_stream::<u16>(&device, &cfg, in_ch, ratio, |x| {
                (x as f32 - 32768.0) / 32768.0
            }),
            f => return capture_error(format!("Format audio non pris en charge : {f:?}")),
        };
        let stream = match stream {
            Ok(s) => s,
            Err(e) => return capture_error(format!("Capture impossible : {e}")),
        };
        if let Err(e) = stream.play() {
            return capture_error(format!("Capture impossible : {e}"));
        }
        crate::engine::emit_global(json!({ "captureError": Value::Null }));
        while running.load(Ordering::Relaxed) {
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        // running = false → le stream est libéré, la capture s'arrête.
    });
}

/// Conversion f32, passage en stéréo, rééchantillonnage vers 48 kHz, effets,
/// puis copie dans le tampon de chaque compte.
fn build_stream<T>(
    device: &cpal::Device,
    cfg: &cpal::SupportedStreamConfig,
    in_ch: usize,
    ratio: f32,
    conv: impl Fn(T) -> f32 + Send + 'static,
) -> Result<cpal::Stream, cpal::BuildStreamError>
where
    T: cpal::SizedSample + Send + 'static,
{
    let scfg: cpal::StreamConfig = cfg.clone().into();
    let mut dsp = Dsp::new();
    let mut block: Vec<f32> = Vec::new();
    let mut pos = 0.0f32;
    let mut last_l = 0.0f32;
    let mut last_r = 0.0f32;
    device.build_input_stream(
        &scfg,
        move |data: &[T], _: &cpal::InputCallbackInfo| {
            block.clear();
            for frame in data.chunks_exact(in_ch.max(1)) {
                let l = conv(frame[0]);
                let r = if in_ch == 1 { l } else { conv(frame[1]) };
                pos += ratio;
                while pos >= 1.0 {
                    pos -= 1.0;
                    let frac = 1.0 - pos;
                    block.push(last_l + (l - last_l) * frac);
                    block.push(last_r + (r - last_r) * frac);
                }
                last_l = l;
                last_r = r;
            }
            dsp.process(&mut block);
            distribute(&block);
        },
        |e| capture_error(format!("Capture interrompue : {e}")),
        None,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // Les réglages sont globaux : les tests partagent un verrou.
    static SERIAL: Mutex<()> = Mutex::new(());

    fn reset() {
        set_gain(0.0);
        set_volume(1.0);
        set_8d(0, 0.15, 0.5);
        set_reverb(false);
        set_eq(vec![0.0; 10]);
        set_processing(0.0, 1.0, 0.0, false, 0.5, false);
    }

    /// Une seconde de sinus stéréo (gauche, droite) passée dans la chaîne d'effets.
    fn run(hz: f32, amp_l: f32, amp_r: f32) -> Vec<f32> {
        let mut buf = Vec::with_capacity(OUT_RATE as usize * 2);
        for i in 0..OUT_RATE as usize {
            let s = (std::f32::consts::TAU * hz * i as f32 / OUT_RATE as f32).sin();
            buf.push(s * amp_l);
            buf.push(s * amp_r);
        }
        Dsp::new().process(&mut buf);
        buf
    }

    /// Crête sur la deuxième moitié (une fois les filtres stabilisés).
    fn peak(buf: &[f32]) -> f32 {
        buf[buf.len() / 2..].iter().fold(0.0, |m, x| m.max(x.abs()))
    }

    #[test]
    fn neutre_ne_change_rien() {
        let _g = lock(&SERIAL);
        reset();
        assert!((peak(&run(440.0, 0.5, 0.5)) - 0.5).abs() < 0.01);
    }

    #[test]
    fn volume_general_et_gain_64_db() {
        let _g = lock(&SERIAL);
        reset();
        set_volume(0.5);
        assert!((peak(&run(440.0, 0.8, 0.8)) - 0.4).abs() < 0.01);
        set_volume(1.0);
        // Gain borné à +64 dB : 0.0001 × 1585 ≈ 0.158.
        set_gain(80.0);
        assert!((peak(&run(440.0, 0.0001, 0.0001)) - 0.1585).abs() < 0.005);
        reset();
    }

    #[test]
    fn limiteur_plafonne_a_moins_1_dbfs() {
        let _g = lock(&SERIAL);
        reset();
        set_processing(0.0, 1.0, 0.0, false, 0.5, true);
        let out = run(440.0, 2.0, 2.0);
        assert!(out.iter().all(|x| x.abs() <= 0.8911));
        reset();
    }

    #[test]
    fn coupe_bas_attenue_les_graves() {
        let _g = lock(&SERIAL);
        reset();
        set_processing(200.0, 1.0, 0.0, false, 0.5, false);
        assert!(peak(&run(30.0, 0.5, 0.5)) < 0.05);
        assert!(peak(&run(2000.0, 0.5, 0.5)) > 0.45);
        reset();
    }

    #[test]
    fn largeur_zero_donne_du_mono() {
        let _g = lock(&SERIAL);
        reset();
        set_processing(0.0, 0.0, 0.0, false, 0.5, false);
        let out = run(440.0, 0.8, 0.0);
        assert!(out
            .as_chunks::<2>()
            .0
            .iter()
            .all(|[l, r]| (l - r).abs() < 1e-6));
        reset();
    }

    #[test]
    fn saturation_garde_le_niveau() {
        let _g = lock(&SERIAL);
        reset();
        set_processing(0.0, 1.0, 1.0, false, 0.5, false);
        let p = peak(&run(440.0, 1.0, 1.0));
        assert!(p <= 1.0001 && p > 0.95);
        reset();
    }

    #[test]
    fn compresseur_resserre_l_ecart() {
        let _g = lock(&SERIAL);
        reset();
        set_processing(0.0, 1.0, 0.0, true, 1.0, false);
        let fort = peak(&run(440.0, 0.9, 0.9));
        let faible = peak(&run(440.0, 0.09, 0.09));
        // Sans compresseur, l'écart serait de 20 dB.
        assert!(db(fort) - db(faible) < 12.0);
        reset();
    }
}
