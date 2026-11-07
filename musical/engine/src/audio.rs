//! Chaîne audio : capture live (cpal) → effets (gain → 8D → réverbe →
//! égaliseur), calculés UNE fois → copiés dans le tampon de chaque compte en
//! vocal → lus par songbird. Tous les comptes diffusent donc le même son.
//! Tous les réglages sont des atomiques lus à chaque bloc : ils s'appliquent à
//! chaud, sans couper la diffusion.

use std::collections::VecDeque;
use std::io::{Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde_json::{json, Map, Value};

use crate::dsp::{self, Biquad, Chain, Params, StereoWidth};
use crate::lock;
use crate::space::{self, Space};

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
// Gains des 10 bandes de l'égaliseur, en dB [-12..12].
global!(eq_gains: Mutex<[f32; 10]> = Mutex::new([0.0; 10]));
// Périphérique choisi (None = entrée par défaut).
global!(current_input: Mutex<Option<String>> = Mutex::new(None));
// Drapeau d'arrêt de la capture en cours.
global!(capture_stop: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None));
// Mesures du son envoyées au panneau (seulement quand il est ouvert).
global!(meter_on: AtomicBool = AtomicBool::new(false));

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
    map.insert("space".into(), space::current().to_json());
    map.insert("eq".into(), json!(lock(eq_gains()).to_vec()));
    map.insert("volume".into(), json!(load_f32(volume())));
    map.insert("processing".into(), dsp::current().to_json());
}

// ── Réglages ────────────────────────────────────────────────────────────────

pub fn set_gain(db: f32) {
    store_f32(gain(), 10f32.powf(db.clamp(-64.0, 128.0) / 20.0));
}

/// Active ou coupe l'envoi des mesures du son (niveau, spectre) au panneau.
pub fn set_meter(on: bool) {
    meter_on().store(on, Ordering::Relaxed);
    if on {
        wake_pump();
    }
}

/// Volume général (0 à 2, soit 0 à 200 %), commun à tous les comptes.
pub fn set_volume(v: f32) {
    store_f32(volume(), v.clamp(0.0, 2.0));
}

pub fn set_latency(ms: u32) {
    latency_ms().store(ms.clamp(40, 2000), Ordering::Relaxed);
}

pub fn set_eq(bands: Vec<f32>) {
    let mut g = lock(eq_gains());
    for (i, slot) in g.iter_mut().enumerate() {
        *slot = bands.get(i).copied().unwrap_or(0.0).clamp(-12.0, 12.0);
    }
}

// ── Égaliseur 10 bandes (biquads « peaking », formules RBJ) ─────────────────

const EQ_FREQS: [f32; 10] = [
    31.0, 62.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0,
];

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

// ── Chaîne d'effets ─────────────────────────────────────────────────────────
// Vit dans la capture : une seule par source, quel que soit le nombre de comptes.

struct Dsp {
    eq: Eq,
    space: Space,
    highpass: [Biquad; 2],
    highpass_hz: f32,
    width: StereoWidth,
    chain: Chain,
}

impl Dsp {
    fn new() -> Self {
        Dsp {
            eq: Eq::new(),
            space: Space::new(),
            highpass: [Biquad::default(); 2],
            highpass_hz: 0.0,
            width: StereoWidth::new(),
            chain: Chain::new(),
        }
    }

    /// Applique les effets à un bloc stéréo entrelacé (réglages relus à chaque bloc).
    fn process(&mut self, buf: &mut [f32]) {
        let p: Params = dsp::current();
        let g = load_f32(gain());
        let gains = *lock(eq_gains());
        let eq_active = gains.iter().any(|g| g.abs() > 0.01);
        if eq_active {
            self.eq.update(&gains);
        }
        if p.highpass != self.highpass_hz {
            self.highpass_hz = p.highpass;
            for b in self.highpass.iter_mut() {
                b.set_highpass(p.highpass.max(20.0), OUT_RATE as f32);
            }
        }
        let vol = load_f32(volume());

        // Entrée : gain, coupe-bas, puis porte / nivellement / mode stéréo.
        for frame in buf.as_chunks_mut::<2>().0 {
            let (mut l, mut r) = (frame[0] * g, frame[1] * g);
            if p.highpass > 0.0 {
                l = self.highpass[0].process(l);
                r = self.highpass[1].process(r);
            }
            frame[0] = l;
            frame[1] = r;
        }
        self.chain.front(buf, &p);

        // Espace (position 360°, pièce), puis couleur et traitement « fort et propre ».
        self.space.process(buf, &space::current());
        self.chain.begin_block(&p);
        let sb = crate::sound::mix(buf.len() / 2);
        for (i, frame) in buf.as_chunks_mut::<2>().0.iter_mut().enumerate() {
            let (mut l, mut r) = self.width.process(frame[0], frame[1], &p);
            if eq_active {
                l = self.eq.process(l, 0);
                r = self.eq.process(r, 1);
            }
            (frame[0], frame[1]) = self.chain.back(l, r, &p, vol, sb_frame(&sb, i));
        }
    }
}

/// Échantillon stéréo de la soundboard (silence s'il n'y a pas de son en cours).
fn sb_frame(sb: &Option<Vec<f32>>, i: usize) -> (f32, f32) {
    sb.as_ref().map_or((0.0, 0.0), |v| (v[i * 2], v[i * 2 + 1]))
}

/// Traitement complet d'un bloc : effets, mesures, envoi aux comptes.
struct Pipeline {
    dsp: Dsp,
    meter: Meter,
}

impl Pipeline {
    fn new() -> Self {
        Pipeline {
            dsp: Dsp::new(),
            meter: Meter::new(),
        }
    }
    fn run(&mut self, block: &mut [f32]) {
        self.dsp.process(block);
        if meter_on().load(Ordering::Relaxed) {
            for reading in self.meter.feed(block) {
                send_meter(&reading);
            }
        }
        distribute(block);
    }
}

// ── Horloge de secours ──────────────────────────────────────────────────────
// Sans source audio (aucune capture), personne ne fait avancer le son : la
// soundboard resterait muette. Ce fil prend alors le relais, au rythme réel
// (10 ms à la fois), avec du silence en entrée. Il ne travaille que si une
// capture est absente ET que quelqu'un écoute (comptes en vocal, panneau
// ouvert ou sons en cours).

global!(active_captures: AtomicUsize = AtomicUsize::new(0));

pub fn wake_pump() {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        std::thread::Builder::new()
            .name("low-musical-horloge".into())
            .spawn(|| {
                const FRAMES: usize = OUT_RATE as usize / 100;
                let period = std::time::Duration::from_millis(10);
                let mut pipeline = Pipeline::new();
                let mut block = vec![0.0f32; FRAMES * 2];
                let mut next = std::time::Instant::now();
                loop {
                    next += period;
                    let needed = active_captures().load(Ordering::Relaxed) == 0
                        && (crate::sound::playing()
                            || meter_on().load(Ordering::Relaxed)
                            || !lock(consumers()).is_empty());
                    if needed {
                        block.fill(0.0);
                        pipeline.run(&mut block);
                    }
                    let now = std::time::Instant::now();
                    if next > now {
                        std::thread::sleep(next - now);
                    } else if now - next > period * 10 {
                        // Trop de retard (PC en veille…) : on repart de maintenant.
                        next = now;
                    }
                }
            })
            .ok();
    });
}

// ── Mesures du son ──────────────────────────────────────────────────────────
// Toutes les 50 ms, le niveau (efficace et crête) et 24 bandes de 40 Hz à
// 16 kHz (échelle logarithmique, comme l'oreille), mesurés sur le son TRAITÉ :
// le panneau montre ce que les comptes diffusent. Valeurs ramenées à 0..1
// sur une échelle de −60 à 0 dB.

pub const METER_BANDS: usize = 24;
const METER_EVERY: usize = OUT_RATE as usize / 20;

pub struct Meter {
    filters: Vec<Biquad>,
    energy: [f32; METER_BANDS],
    sum_sq: f32,
    peak: f32,
    frames: usize,
}

pub struct Reading {
    pub level: f32,
    pub peak: f32,
    pub bands: [f32; METER_BANDS],
}

fn to_unit(x: f32) -> f32 {
    ((20.0 * x.max(1e-9).log10() + 60.0) / 60.0).clamp(0.0, 1.0)
}

impl Meter {
    pub fn new() -> Self {
        let filters = (0..METER_BANDS)
            .map(|i| {
                let f = 40.0 * (16000.0f32 / 40.0).powf(i as f32 / (METER_BANDS - 1) as f32);
                let mut b = Biquad::default();
                b.set_bandpass(f, OUT_RATE as f32, 3.0);
                b
            })
            .collect();
        Meter {
            filters,
            energy: [0.0; METER_BANDS],
            sum_sq: 0.0,
            peak: 0.0,
            frames: 0,
        }
    }

    /// Ajoute un bloc stéréo entrelacé ; renvoie une mesure toutes les 50 ms.
    pub fn feed(&mut self, buf: &[f32]) -> Vec<Reading> {
        let mut out = Vec::new();
        for [l, r] in buf.as_chunks::<2>().0 {
            let mono = (l + r) * 0.5;
            self.sum_sq += mono * mono;
            self.peak = self.peak.max(l.abs()).max(r.abs());
            for (f, e) in self.filters.iter_mut().zip(self.energy.iter_mut()) {
                let y = f.process(mono);
                *e += y * y;
            }
            self.frames += 1;
            if self.frames == METER_EVERY {
                let n = self.frames as f32;
                // ×2 : une sinusoïde d'amplitude A a une valeur efficace A/√2.
                let mut bands = [0.0; METER_BANDS];
                for (b, e) in bands.iter_mut().zip(self.energy.iter()) {
                    *b = to_unit((2.0 * e / n).sqrt());
                }
                out.push(Reading {
                    level: to_unit((self.sum_sq / n).sqrt()),
                    peak: to_unit(self.peak),
                    bands,
                });
                self.energy = [0.0; METER_BANDS];
                self.sum_sq = 0.0;
                self.peak = 0.0;
                self.frames = 0;
            }
        }
        out
    }
}

fn send_meter(r: &Reading) {
    // Réduction de gain (dB) du compresseur et du limiteur depuis la dernière mesure.
    let (comp, limit) = dsp::take_reduction();
    let round = |x: f32| (f64::from(x) * 1000.0).round() / 1000.0;
    crate::proto::event(json!({
        "event": "meter",
        "level": round(r.level),
        "peak": round(r.peak),
        "bands": r.bands.iter().map(|&b| round(b)).collect::<Vec<_>>(),
        "comp": round(comp),
        "limit": round(limit),
        "pos": space::position().map(|(x, y)| [round(x), round(y)]),
    }));
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
        wake_pump();
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
        active_captures().fetch_add(1, Ordering::Relaxed);
        while running.load(Ordering::Relaxed) {
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        // running = false → le stream est libéré, la capture s'arrête.
        drop(stream);
        active_captures().fetch_sub(1, Ordering::Relaxed);
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
    let mut pipeline = Pipeline::new();
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
            pipeline.run(&mut block);
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
        space::set_params(space::SpaceParams::default());
        set_eq(vec![0.0; 10]);
        dsp::set_params(Params::default());
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
    fn mesure_niveau_et_spectre() {
        let mut m = Meter::new();
        let mut buf = Vec::new();
        for i in 0..OUT_RATE as usize {
            let s = 0.5 * (std::f32::consts::TAU * 1000.0 * i as f32 / OUT_RATE as f32).sin();
            buf.push(s);
            buf.push(s);
        }
        let readings = m.feed(&buf);
        assert_eq!(readings.len(), 20); // 1 s = 20 mesures de 50 ms
        let last = readings.last().unwrap();
        // Crête 0,5 → −6 dB → 0,9 ; efficace 0,354 → −9 dB → 0,85.
        assert!((last.peak - 0.9).abs() < 0.01, "crête {}", last.peak);
        assert!((last.level - 0.85).abs() < 0.01, "niveau {}", last.level);
        // La bande la plus forte est celle autour de 1 kHz.
        let best = (0..METER_BANDS)
            .max_by(|&a, &b| last.bands[a].total_cmp(&last.bands[b]))
            .unwrap();
        let f = 40.0 * (16000.0f32 / 40.0).powf(best as f32 / (METER_BANDS - 1) as f32);
        assert!((700.0..1400.0).contains(&f), "bande {f} Hz");
    }

    #[test]
    fn neutre_ne_change_rien() {
        let _g = lock(&SERIAL);
        reset();
        assert!((peak(&run(440.0, 0.5, 0.5)) - 0.5).abs() < 0.01);
    }

    #[test]
    fn volume_general_et_gain_128_db() {
        let _g = lock(&SERIAL);
        reset();
        set_volume(0.5);
        assert!((peak(&run(440.0, 0.8, 0.8)) - 0.4).abs() < 0.01);
        set_volume(1.0);
        // Gain borné à +128 dB : 1e-7 × 2 511 886 ≈ 0.251.
        set_gain(140.0);
        assert!((peak(&run(440.0, 1e-7, 1e-7)) - 0.2512).abs() < 0.01);
        reset();
    }
}
