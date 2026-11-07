//! Mini APO : exécute un « set » Equalizer APO, préparé par low-cord.
//!
//! low-cord lit le texte du set (Preamp, Filter, GraphicEQ, Channel, Copy,
//! Delay…) et envoie ici une liste d'étapes déjà résolues, dans l'ordre :
//! - `gain`    : gain par canal (Preamp) ;
//! - `iir`     : filtre IIR (coefficients b / a, calculés pour 48 kHz :
//!   les biquads d'APO et `Filter: ON IIR`) ;
//! - `graphic` : égaliseur graphique (points fréquence / dB). Comme APO :
//!   interpolation linéaire en dB sur une échelle de fréquence
//!   logarithmique, valeur des bords gardée au-delà, filtre RIF
//!   à phase minimale de 16384 points ;
//! - `conv`    : convolution par une réponse impulsionnelle importée (IR
//!   wav, flac, ogg ; jusqu'à 6 s). Comme APO : une IR stéréo va gauche →
//!   gauche, droite → droite ; une IR mono s'applique aux deux ;
//! - `vst`     : plugin VST2 (voir vst.rs), dans son propre processus ;
//! - `copy`    : mélange des canaux (sortie = matrice × entrée + constante) ;
//! - `delay`   : retard en échantillons.
//!
//! Chaque étape vise les canaux choisis (`ch` : [gauche, droite]).
//! Les RIF sont appliqués par convolution découpée (FFT) : blocs de 256
//! échantillons (5,3 ms de latence) pour le GraphicEQ et les IR courtes,
//! plus grands pour les IR longues (jusqu'à 85 ms au-delà de 2,7 s).

use std::sync::{Arc, Mutex, OnceLock};

use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};
use serde_json::Value;

use crate::audio::OUT_RATE;
use crate::lock;

const FS: f64 = OUT_RATE as f64;
const MAX_STAGES: usize = 512;
const MAX_ORDER: usize = 8;
const MAX_POINTS: usize = 4096;
const MAX_DELAY: usize = OUT_RATE as usize * 2;
/// Longueur du RIF du GraphicEQ (comme APO).
const FIR_LEN: usize = 16384;
/// Bloc de la convolution découpée (le plus petit).
const BLOCK: usize = 256;
/// Longueur maximale d'une réponse impulsionnelle (6 s).
const MAX_IR: usize = OUT_RATE as usize * 6;

type Ch = [bool; 2];

// ── Description du set (partagée, préparée une fois) ────────────────────────

enum Def {
    Gain([f32; 2]),
    Iir { ch: Ch, b: Vec<f64>, a: Vec<f64> },
    Graphic { ch: Ch, kernel: Arc<Kernel> },
    Conv { ch: Ch, kernels: [Arc<Kernel>; 2] },
    Vst { ch: Ch, plugin: crate::vst::Shared },
    Copy { m: [[f32; 2]; 2], c: [f32; 2] },
    Delay { ch: Ch, samples: usize },
}

pub struct Config {
    defs: Vec<Def>,
    /// plugins VST du set, dans l'ordre (Err = plugin qui n'a pas pu démarrer)
    vst: Vec<Result<crate::vst::Shared, Value>>,
}

struct Slot {
    generation: u64,
    config: Option<Arc<Config>>,
}

fn slot() -> &'static Mutex<Slot> {
    static S: OnceLock<Mutex<Slot>> = OnceLock::new();
    S.get_or_init(|| {
        Mutex::new(Slot {
            generation: 0,
            config: None,
        })
    })
}

/// Nouveau set (ou `enabled: false` pour couper). Renvoie le nombre
/// d'étapes et l'état de chaque plugin VST.
pub fn set(v: &Value) -> Result<Value, String> {
    let enabled = v.get("enabled").and_then(Value::as_bool).unwrap_or(false);
    let stages = v.get("stages").and_then(Value::as_array);
    let config = match (enabled, stages) {
        (true, Some(list)) if !list.is_empty() => Some(Arc::new(parse(list)?)),
        _ => None,
    };
    let n = config.as_ref().map_or(0, |c| c.defs.len());
    let vst = config.as_ref().map_or_else(Vec::new, |c| vst_infos(c));
    // Les plugins qui ne sont plus dans le set s'arrêtent.
    let used: Vec<crate::vst::Shared> = config
        .as_ref()
        .map(|c| {
            c.vst
                .iter()
                .filter_map(|r| r.as_ref().ok().cloned())
                .collect()
        })
        .unwrap_or_default();
    crate::vst::keep_only(&used);
    let mut s = lock(slot());
    s.generation += 1;
    s.config = config;
    Ok(serde_json::json!({ "stages": n, "vst": vst }))
}

fn vst_infos(c: &Config) -> Vec<Value> {
    c.vst
        .iter()
        .map(|r| match r {
            Ok(b) => lock(b).info(),
            Err(e) => e.clone(),
        })
        .collect()
}

/// Réglage d'un paramètre du n-ième plugin du set ; renvoie son nouvel état
/// (dont le ChunkData, pour réécrire le set).
pub fn vst_param(slot_index: usize, index: i64, value: f64) -> Result<Value, String> {
    let config = lock(slot()).config.clone().ok_or("aucun set actif")?;
    let plugin = match config.vst.get(slot_index) {
        Some(Ok(b)) => b.clone(),
        _ => return Err("plugin introuvable".into()),
    };
    let mut b = lock(&plugin);
    b.set_param(index, value)
}

fn parse(list: &[Value]) -> Result<Config, String> {
    if list.len() > MAX_STAGES {
        return Err(format!("set APO trop long ({MAX_STAGES} étapes au plus)"));
    }
    let num = |v: &Value| v.as_f64().filter(|x| x.is_finite());
    let ch = |s: &Value| -> Ch {
        let a = s.get("ch").and_then(Value::as_array);
        let at = |i: usize| {
            a.and_then(|a| a.get(i))
                .and_then(Value::as_bool)
                .unwrap_or(true)
        };
        [at(0), at(1)]
    };
    let nums = |s: &Value, k: &str| -> Result<Vec<f64>, String> {
        s.get(k)
            .and_then(Value::as_array)
            .ok_or_else(|| format!("APO : « {k} » manquant"))?
            .iter()
            .map(|x| num(x).ok_or_else(|| "APO : nombre invalide".to_string()))
            .collect()
    };

    let mut defs = Vec::with_capacity(list.len());
    let mut vst = Vec::new();
    let mut ranks: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for s in list {
        let kind = s.get("t").and_then(Value::as_str).unwrap_or("");
        defs.push(match kind {
            "gain" => {
                let db = |i: usize| {
                    s.get("db")
                        .and_then(Value::as_array)
                        .and_then(|a| a.get(i))
                        .and_then(num)
                        .unwrap_or(0.0)
                        .clamp(-200.0, 200.0)
                };
                Def::Gain([
                    10f64.powf(db(0) / 20.0) as f32,
                    10f64.powf(db(1) / 20.0) as f32,
                ])
            }
            "iir" => {
                let (b, a) = (nums(s, "b")?, nums(s, "a")?);
                if b.is_empty() || b.len() != a.len() || a.len() > MAX_ORDER + 1 {
                    return Err("APO : filtre IIR invalide".into());
                }
                if a[0].abs() < 1e-12 {
                    return Err("APO : filtre IIR invalide (a0 = 0)".into());
                }
                let a0 = a[0];
                Def::Iir {
                    ch: ch(s),
                    b: b.iter().map(|x| x / a0).collect(),
                    a: a.iter().map(|x| x / a0).collect(),
                }
            }
            "graphic" => {
                let raw = s
                    .get("points")
                    .and_then(Value::as_array)
                    .ok_or("APO : GraphicEQ sans points")?;
                if raw.len() > MAX_POINTS {
                    return Err(format!(
                        "APO : GraphicEQ trop long ({MAX_POINTS} points au plus)"
                    ));
                }
                let mut points: Vec<(f64, f64)> = raw
                    .iter()
                    .filter_map(|p| {
                        let p = p.as_array()?;
                        Some((num(p.first()?)?, num(p.get(1)?)?.clamp(-200.0, 200.0)))
                    })
                    .filter(|(f, _)| *f > 0.0)
                    .collect();
                points.sort_by(|a, b| a.0.total_cmp(&b.0));
                Def::Graphic {
                    ch: ch(s),
                    kernel: Arc::new(Kernel::design(&points)),
                }
            }
            "conv" => {
                let path = s
                    .get("path")
                    .and_then(Value::as_str)
                    .ok_or("APO : réponse impulsionnelle introuvable")?;
                Def::Conv {
                    ch: ch(s),
                    kernels: impulse(path)?,
                }
            }
            "vst" => {
                let path = s
                    .get("path")
                    .and_then(Value::as_str)
                    .ok_or("APO : plugin VST introuvable")?;
                let chunk = s.get("chunk").and_then(Value::as_str).map(str::to_string);
                let params = s
                    .get("params")
                    .and_then(Value::as_object)
                    .map(|m| {
                        m.iter()
                            .filter_map(|(k, v)| Some((k.clone(), num(v)? as f32)))
                            .collect()
                    })
                    .unwrap_or_default();
                let rank = ranks.entry(path.to_string()).or_insert(0);
                let found = crate::vst::plugin_for(path, *rank, chunk, params);
                *rank += 1;
                match found {
                    Ok(plugin) => {
                        vst.push(Ok(plugin.clone()));
                        Def::Vst { ch: ch(s), plugin }
                    }
                    Err(e) => {
                        vst.push(Err(serde_json::json!({ "error": e })));
                        continue;
                    }
                }
            }
            "copy" => {
                let m = nums(s, "m")?;
                let c = nums(s, "c")?;
                if m.len() != 4 || c.len() != 2 || m.iter().chain(&c).any(|x| x.abs() > 1e4) {
                    return Err("APO : Copy invalide".into());
                }
                Def::Copy {
                    m: [[m[0] as f32, m[1] as f32], [m[2] as f32, m[3] as f32]],
                    c: [c[0] as f32, c[1] as f32],
                }
            }
            "delay" => Def::Delay {
                ch: ch(s),
                samples: s
                    .get("samples")
                    .and_then(num)
                    .unwrap_or(0.0)
                    .round()
                    .clamp(0.0, MAX_DELAY as f64) as usize,
            },
            other => return Err(format!("APO : étape inconnue « {other} »")),
        });
    }
    Ok(Config { defs, vst })
}

// ── GraphicEQ : conception du RIF à phase minimale ──────────────────────────

/// Gain (dB) à une fréquence : linéaire en dB sur une échelle logarithmique,
/// valeur des bords gardée au-delà (comme APO).
fn gain_at(points: &[(f64, f64)], f: f64) -> f64 {
    let (Some(first), Some(last)) = (points.first(), points.last()) else {
        return 0.0;
    };
    if f <= first.0 {
        return first.1;
    }
    if f >= last.0 {
        return last.1;
    }
    let i = points.partition_point(|p| p.0 <= f);
    let (a, b) = (points[i - 1], points[i]);
    if a.1 == b.1 || b.0 <= a.0 {
        return a.1;
    }
    let t = (f.ln() - a.0.ln()) / (b.0.ln() - a.0.ln());
    a.1 + (b.1 - a.1) * t
}

/// RIF découpé en blocs, déjà passé en fréquentiel (prêt pour la convolution).
pub struct Kernel {
    block: usize,
    parts: Vec<Vec<Complex<f32>>>,
    fft: Arc<dyn Fft<f32>>,
    ifft: Arc<dyn Fft<f32>>,
}

impl Kernel {
    fn design(points: &[(f64, f64)]) -> Kernel {
        Kernel::from_taps(&min_phase(points), BLOCK)
    }

    /// Découpe le RIF en blocs de `block` échantillons, passés en fréquentiel.
    fn from_taps(taps: &[f32], block: usize) -> Kernel {
        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(block * 2);
        let ifft = planner.plan_fft_inverse(block * 2);
        let parts = taps
            .chunks(block)
            .map(|chunk| {
                let mut buf = vec![Complex::new(0.0, 0.0); block * 2];
                for (d, &s) in buf.iter_mut().zip(chunk) {
                    d.re = s;
                }
                fft.process(&mut buf);
                buf
            })
            .collect();
        Kernel {
            block,
            parts,
            fft,
            ifft,
        }
    }
}

/// Réponse impulsionnelle à phase minimale ayant le module voulu
/// (méthode du cepstre, comme APO), tronquée avec un fondu en fin.
fn min_phase(points: &[(f64, f64)]) -> Vec<f32> {
    let m = FIR_LEN * 2;
    let mut planner = FftPlanner::<f64>::new();
    let fwd = planner.plan_fft_forward(m);
    let inv = planner.plan_fft_inverse(m);

    // Log du module, spectre symétrique (≥ −100 dB).
    let mut buf: Vec<Complex<f64>> = (0..m)
        .map(|k| {
            let bin = if k <= m / 2 { k } else { m - k };
            let f = bin as f64 * FS / m as f64;
            let db = gain_at(points, f.max(1.0)).max(-100.0);
            Complex::new(db / 20.0 * std::f64::consts::LN_10, 0.0)
        })
        .collect();
    // Cepstre réel, replié sur les temps positifs.
    inv.process(&mut buf);
    for (n, c) in buf.iter_mut().enumerate() {
        let w = if n == 0 || n == m / 2 {
            1.0
        } else if n < m / 2 {
            2.0
        } else {
            0.0
        };
        *c = Complex::new(c.re / m as f64 * w, 0.0);
    }
    fwd.process(&mut buf);
    for c in buf.iter_mut() {
        *c = c.exp();
    }
    inv.process(&mut buf);
    (0..FIR_LEN)
        .map(|n| {
            // Fondu (demi-cosinus) : pas de coupure sèche en fin de réponse.
            let w = 0.5 * (1.0 + (std::f64::consts::PI * n as f64 / FIR_LEN as f64).cos());
            (buf[n].re / m as f64 * w) as f32
        })
        .collect()
}

/// Convolution découpée uniforme (overlap-save), un canal.
struct Conv {
    kernel: Arc<Kernel>,
    /// Spectres des derniers blocs d'entrée (le plus récent en tête).
    history: Vec<Vec<Complex<f32>>>,
    head: usize,
    prev: Vec<f32>,
    input: Vec<f32>,
    output: Vec<f32>,
    out_pos: usize,
    work: Vec<Complex<f32>>,
    acc: Vec<Complex<f32>>,
}

impl Conv {
    fn new(kernel: Arc<Kernel>) -> Conv {
        let parts = kernel.parts.len().max(1);
        let block = kernel.block;
        Conv {
            history: vec![vec![Complex::new(0.0, 0.0); block * 2]; parts],
            head: 0,
            prev: vec![0.0; block],
            input: Vec::with_capacity(block),
            // Un bloc de silence : la latence de la convolution.
            output: vec![0.0; block],
            out_pos: 0,
            work: vec![Complex::new(0.0, 0.0); block * 2],
            acc: vec![Complex::new(0.0, 0.0); block * 2],
            kernel,
        }
    }

    fn process(&mut self, x: f32) -> f32 {
        self.input.push(x);
        let y = self.output[self.out_pos];
        self.out_pos += 1;
        if self.input.len() == self.kernel.block {
            self.block();
        }
        y
    }

    fn block(&mut self) {
        let n = self.history.len();
        let block = self.kernel.block;
        // [bloc précédent | bloc actuel] → spectre, rangé en tête de l'historique.
        self.head = (self.head + n - 1) % n;
        for (i, w) in self.work.iter_mut().enumerate() {
            let s = if i < block {
                self.prev[i]
            } else {
                self.input[i - block]
            };
            *w = Complex::new(s, 0.0);
        }
        self.kernel.fft.process(&mut self.work);
        self.history[self.head].copy_from_slice(&self.work);
        // Somme des produits avec chaque morceau du RIF.
        self.acc.fill(Complex::new(0.0, 0.0));
        for (p, part) in self.kernel.parts.iter().enumerate() {
            let x = &self.history[(self.head + p) % n];
            for ((a, &xv), &hv) in self.acc.iter_mut().zip(x).zip(part) {
                *a += xv * hv;
            }
        }
        self.kernel.ifft.process(&mut self.acc);
        let scale = 1.0 / (block * 2) as f32;
        self.output.clear();
        self.output
            .extend(self.acc[block..].iter().map(|c| c.re * scale));
        self.out_pos = 0;
        self.prev.copy_from_slice(&self.input);
        self.input.clear();
    }
}

// ── Réponses impulsionnelles (Convolution) ──────────────────────────────────

type IrKernels = [Arc<Kernel>; 2];

/// IR déjà préparées, par fichier : le set est renvoyé à chaque modification,
/// on ne relit pas le fichier à chaque fois.
fn ir_cache() -> &'static Mutex<std::collections::HashMap<String, IrKernels>> {
    static C: OnceLock<Mutex<std::collections::HashMap<String, IrKernels>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// Taille de bloc selon la longueur : latence courte pour les IR courtes,
/// calcul raisonnable pour les longues.
fn block_for(len: usize) -> usize {
    match len {
        0..=32_768 => BLOCK,
        32_769..=131_072 => 1024,
        _ => 4096,
    }
}

fn impulse(path: &str) -> Result<IrKernels, String> {
    if let Some(k) = lock(ir_cache()).get(path) {
        return Ok(k.clone());
    }
    let pcm = crate::sound::decode(path)?;
    let frames = pcm.len() / 2;
    if frames > MAX_IR {
        return Err("réponse impulsionnelle trop longue (6 s au plus)".into());
    }
    let block = block_for(frames);
    let channel = |c: usize| -> Vec<f32> { pcm.iter().skip(c).step_by(2).copied().collect() };
    let kernels = [
        Arc::new(Kernel::from_taps(&channel(0), block)),
        Arc::new(Kernel::from_taps(&channel(1), block)),
    ];
    let mut cache = lock(ir_cache());
    if cache.len() >= 16 {
        cache.clear();
    }
    cache.insert(path.to_string(), kernels.clone());
    Ok(kernels)
}

// ── Exécution (une par chaîne de traitement) ────────────────────────────────

/// Filtre IIR, forme directe II transposée, en f64.
struct Iir {
    b: Vec<f64>,
    a: Vec<f64>,
    z: Vec<f64>,
}

impl Iir {
    fn process(&mut self, x: f32) -> f32 {
        let x = x as f64;
        let n = self.b.len();
        let y = self.b[0] * x + self.z.first().copied().unwrap_or(0.0);
        for i in 1..n {
            let next = if i < n - 1 { self.z[i] } else { 0.0 };
            self.z[i - 1] = self.b[i] * x - self.a[i] * y + next;
        }
        if !y.is_finite() {
            // Filtre instable : on repart de zéro plutôt que de saturer.
            self.z.fill(0.0);
            return 0.0;
        }
        y as f32
    }
}

struct DelayLine {
    buf: Vec<f32>,
    pos: usize,
}

impl DelayLine {
    fn process(&mut self, x: f32) -> f32 {
        if self.buf.is_empty() {
            return x;
        }
        let y = self.buf[self.pos];
        self.buf[self.pos] = x;
        self.pos = (self.pos + 1) % self.buf.len();
        y
    }
}

enum Run {
    Gain([f32; 2]),
    Iir(Ch, [Iir; 2]),
    Conv(Ch, Box<[Conv; 2]>),
    Vst(Ch, crate::vst::Shared, Vec<f32>),
    Copy([[f32; 2]; 2], [f32; 2]),
    Delay(Ch, [DelayLine; 2]),
}

/// Le set en cours d'exécution, avec ses états (filtres, retards…).
pub struct Apo {
    generation: u64,
    runs: Vec<Run>,
}

impl Apo {
    pub fn new() -> Apo {
        Apo {
            generation: 0,
            runs: Vec::new(),
        }
    }

    /// Reprend le set s'il a changé (états remis à zéro).
    fn sync(&mut self) {
        let Ok(s) = slot().try_lock() else {
            return;
        };
        if s.generation == self.generation {
            return;
        }
        self.generation = s.generation;
        let config = s.config.clone();
        drop(s);
        self.runs = config.map_or_else(Vec::new, |c| c.defs.iter().map(build).collect());
    }

    pub fn active(&mut self) -> bool {
        self.sync();
        !self.runs.is_empty()
    }

    /// Applique le set à un bloc stéréo entrelacé.
    pub fn process(&mut self, buf: &mut [f32]) {
        for run in self.runs.iter_mut() {
            match run {
                Run::Gain(g) => {
                    for f in buf.as_chunks_mut::<2>().0 {
                        f[0] *= g[0];
                        f[1] *= g[1];
                    }
                }
                Run::Iir(ch, filters) => per_channel(buf, ch, |c, x| filters[c].process(x)),
                Run::Conv(ch, conv) => per_channel(buf, ch, |c, x| conv[c].process(x)),
                Run::Vst(ch, plugin, keep) => {
                    // Canal non choisi : remis tel quel après le plugin.
                    keep.clear();
                    keep.extend_from_slice(buf);
                    lock(plugin).process(buf);
                    for (frame, old) in buf
                        .as_chunks_mut::<2>()
                        .0
                        .iter_mut()
                        .zip(keep.as_chunks::<2>().0)
                    {
                        for c in 0..2 {
                            if !ch[c] {
                                frame[c] = old[c];
                            }
                        }
                    }
                }
                Run::Delay(ch, lines) => per_channel(buf, ch, |c, x| lines[c].process(x)),
                Run::Copy(m, k) => {
                    for f in buf.as_chunks_mut::<2>().0 {
                        let (l, r) = (f[0], f[1]);
                        f[0] = m[0][0] * l + m[0][1] * r + k[0];
                        f[1] = m[1][0] * l + m[1][1] * r + k[1];
                    }
                }
            }
        }
    }
}

fn per_channel(buf: &mut [f32], ch: &Ch, mut f: impl FnMut(usize, f32) -> f32) {
    for frame in buf.as_chunks_mut::<2>().0 {
        for (c, s) in frame.iter_mut().enumerate() {
            if ch[c] {
                *s = f(c, *s);
            }
        }
    }
}

fn build(def: &Def) -> Run {
    match def {
        Def::Gain(g) => Run::Gain(*g),
        Def::Iir { ch, b, a } => {
            let one = || Iir {
                b: b.clone(),
                a: a.clone(),
                z: vec![0.0; b.len().saturating_sub(1).max(1)],
            };
            Run::Iir(*ch, [one(), one()])
        }
        Def::Graphic { ch, kernel } => Run::Conv(
            *ch,
            Box::new([Conv::new(kernel.clone()), Conv::new(kernel.clone())]),
        ),
        Def::Conv { ch, kernels } => Run::Conv(
            *ch,
            Box::new([Conv::new(kernels[0].clone()), Conv::new(kernels[1].clone())]),
        ),
        Def::Vst { ch, plugin } => Run::Vst(*ch, plugin.clone(), Vec::new()),
        Def::Copy { m, c } => Run::Copy(*m, *c),
        Def::Delay { ch, samples } => {
            let line = || DelayLine {
                buf: vec![0.0; *samples],
                pos: 0,
            };
            Run::Delay(*ch, [line(), line()])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Passe une sinusoïde dans un set et renvoie (niveau G, niveau D) en
    /// sortie, rapporté à l'entrée, sur la seconde moitié.
    fn run(stages: Value, hz: f64) -> (f64, f64) {
        let config = parse(stages.as_array().unwrap()).unwrap();
        let mut apo = Apo {
            generation: 0,
            runs: config.defs.iter().map(build).collect(),
        };
        let n = OUT_RATE as usize;
        let mut buf: Vec<f32> = (0..n)
            .flat_map(|i| {
                let v = 0.25 * (std::f64::consts::TAU * hz * i as f64 / FS).sin() as f32;
                [v, v]
            })
            .collect();
        for block in buf.chunks_mut(960) {
            apo.process(block);
        }
        let half = &buf[n..];
        let rms = |c: usize| {
            (half
                .iter()
                .skip(c)
                .step_by(2)
                .map(|x| (*x as f64).powi(2))
                .sum::<f64>()
                / (n / 2) as f64)
                .sqrt()
                / (0.25 / 2f64.sqrt())
        };
        (rms(0), rms(1))
    }

    fn db(x: f64) -> f64 {
        20.0 * x.log10()
    }

    #[test]
    fn preamp_par_canal() {
        let (l, r) = run(json!([{ "t": "gain", "db": [-6.0, 0.0] }]), 1000.0);
        assert!((db(l) + 6.0).abs() < 0.05 && db(r).abs() < 0.05, "{l} {r}");
    }

    #[test]
    fn graphic_eq_suit_la_courbe() {
        // 0 dB jusqu'à 100 Hz, −12 dB dès 1 kHz (bords gardés au-delà).
        let set = json!([{ "t": "graphic", "points": [[100.0, 0.0], [1000.0, -12.0]] }]);
        let (low, _) = run(set.clone(), 50.0);
        let (high, _) = run(set.clone(), 4000.0);
        let (mid, _) = run(set, 316.0);
        assert!(db(low).abs() < 0.3, "50 Hz : {} dB", db(low));
        assert!((db(high) + 12.0).abs() < 0.3, "4 kHz : {} dB", db(high));
        // À mi-chemin (en log) : −6 dB.
        assert!((db(mid) + 6.0).abs() < 0.5, "316 Hz : {} dB", db(mid));
    }

    #[test]
    fn iir_et_canaux_choisis() {
        // Filtre « ×0,5 » sur la droite seulement.
        let set = json!([{ "t": "iir", "ch": [false, true], "b": [0.5, 0.0, 0.0], "a": [1.0, 0.0, 0.0] }]);
        let (l, r) = run(set, 1000.0);
        assert!(db(l).abs() < 0.01 && (db(r) + 6.02).abs() < 0.05);
    }

    #[test]
    fn copy_et_delay() {
        // Les deux canaux = gauche ; puis la droite coupée par Copy R=0.0.
        let set = json!([{ "t": "copy", "m": [1.0, 0.0, 0.0, 0.0], "c": [0.0, 0.0] }]);
        let (l, r) = run(set, 1000.0);
        assert!(db(l).abs() < 0.01 && r < 1e-6);
        // Retard de 48 échantillons : le niveau ne change pas.
        let (l, _) = run(json!([{ "t": "delay", "samples": 48 }]), 1000.0);
        assert!(db(l).abs() < 0.05);
    }

    #[test]
    fn convolution_découpée_exacte() {
        // RIF connu (écho à 300 échantillons, ×0,5) : la sortie est exacte,
        // en tenant compte d'un bloc de latence, pour chaque taille de bloc.
        let mut taps = vec![0.0f32; 700];
        taps[0] = 1.0;
        taps[300] = 0.5;
        for block in [256, 1024] {
            let mut conv = Conv::new(Arc::new(Kernel::from_taps(&taps, block)));
            let input: Vec<f32> = (0..5000)
                .map(|i| ((i * 7919) % 101) as f32 / 50.0 - 1.0)
                .collect();
            let out: Vec<f32> = input.iter().map(|&x| conv.process(x)).collect();
            for (n, &got) in out.iter().enumerate().skip(block + 400) {
                let t = n - block;
                let want = input[t] + 0.5 * input[t - 300];
                assert!(
                    (got - want).abs() < 1e-4,
                    "bloc {block} n {n} : {got} au lieu de {want}"
                );
            }
        }
        assert_eq!(block_for(48_000), 1024);
        assert_eq!(block_for(200_000), 4096);
    }

    #[test]
    fn ir_absente_refusée() {
        assert!(parse(&[json!({ "t": "conv", "path": "C:/n_existe_pas.wav" })]).is_err());
        assert!(parse(&[json!({ "t": "conv" })]).is_err());
    }

    #[test]
    fn sets_invalides_refusés() {
        assert!(parse(&[json!({ "t": "iir", "b": [1.0], "a": [0.0] })]).is_err());
        assert!(parse(&[json!({ "t": "inconnu" })]).is_err());
        assert!(parse(&vec![json!({ "t": "gain" }); MAX_STAGES + 1]).is_err());
        // Coupé : aucune étape.
        assert_eq!(set(&json!({ "enabled": false })).unwrap()["stages"], 0);
    }
}
