//! Chaîne audio : capture live (cpal) → tampon → source lue par songbird, qui
//! applique les effets (gain → 8D → réverbe → égaliseur) au moment d'émettre.
//! Tous les réglages sont des atomiques lus à chaque bloc : ils s'appliquent à
//! chaud, sans couper la diffusion.

use std::collections::VecDeque;
use std::io::{Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde_json::{json, Map, Value};

use crate::lock;

pub const OUT_RATE: u32 = 48000;
pub type Ring = Arc<Mutex<VecDeque<f32>>>;

/// Tampon partagé (vit toute la session) : la capture pousse du f32 stéréo
/// 48 kHz entrelacé, la source songbird le consomme.
pub fn ring() -> &'static Ring {
    static R: OnceLock<Ring> = OnceLock::new();
    R.get_or_init(|| Arc::new(Mutex::new(VecDeque::new())))
}

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

// Gain linéaire (0 dB = 1.0).
global!(gain: AtomicU32 = f32_atomic(1.0));
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
}

// ── Réglages ────────────────────────────────────────────────────────────────

pub fn set_gain(db: f32) {
    store_f32(gain(), 10f32.powf(db.clamp(-60.0, 24.0) / 20.0));
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

// ── Source lue par songbird ────────────────────────────────────────────────
// Renvoie du silence quand le tampon est vide, pour que la piste ne s'arrête
// jamais.

pub struct LiveSource {
    eq: Eq,
    reverb: Reverb,
    lfo: f32,
}

impl LiveSource {
    pub fn new() -> Self {
        LiveSource {
            eq: Eq::new(),
            reverb: Reverb::new(),
            lfo: 0.0,
        }
    }
}

impl Read for LiveSource {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        let n = out.len() / 4; // échantillons f32 entrelacés L,R
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

        let mut q = lock(ring());
        let mut i = 0;
        while i + 1 < n {
            let l = q.pop_front().unwrap_or(0.0) * g;
            let r = q.pop_front().unwrap_or(0.0) * g;
            let (mut sl, mut sr) = spatialize(l, r, &mut self.lfo);
            if rvb {
                (sl, sr) = self.reverb.process(sl, sr);
            }
            if eq_active {
                sl = self.eq.process(sl, 0);
                sr = self.eq.process(sr, 1);
            }
            out[i * 4..i * 4 + 4].copy_from_slice(&sl.to_le_bytes());
            out[(i + 1) * 4..(i + 1) * 4 + 4].copy_from_slice(&sr.to_le_bytes());
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
    lock(ring()).clear();
}

fn capture_error(msg: impl Into<String>) {
    crate::engine::emit(json!({ "captureError": msg.into() }));
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
        crate::engine::emit(json!({ "captureError": Value::Null }));
        while running.load(Ordering::Relaxed) {
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        // running = false → le stream est libéré, la capture s'arrête.
    });
}

/// Conversion f32, passage en stéréo, rééchantillonnage vers 48 kHz, puis
/// signal BRUT dans le tampon (les effets s'appliquent dans `LiveSource`).
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
    let ring = ring().clone();
    let mut pos = 0.0f32;
    let mut last_l = 0.0f32;
    let mut last_r = 0.0f32;
    device.build_input_stream(
        &scfg,
        move |data: &[T], _: &cpal::InputCallbackInfo| {
            let in_ch = in_ch.max(1);
            let mut q = lock(&ring);
            for frame in data.chunks_exact(in_ch) {
                let l = conv(frame[0]);
                let r = if in_ch == 1 { l } else { conv(frame[1]) };
                pos += ratio;
                while pos >= 1.0 {
                    pos -= 1.0;
                    let frac = 1.0 - pos;
                    q.push_back(last_l + (l - last_l) * frac);
                    q.push_back(last_r + (r - last_r) * frac);
                }
                last_l = l;
                last_r = r;
            }
            // Plafond du tampon = latence cible : borne le retard capture → émission.
            let ms = latency_ms().load(Ordering::Relaxed) as usize;
            let cap = (OUT_RATE as usize * 2 * ms / 1000).max(1920);
            let excess = q.len().saturating_sub(cap);
            q.drain(..excess);
        },
        |e| capture_error(format!("Capture interrompue : {e}")),
        None,
    )
}
