//! Rééchantillonnage par sinus cardinal fenêtré (Kaiser), polyphase : pas de
//! repliement ni d'aigus rabotés, contrairement à une interpolation linéaire.
//!
//! - `Sinc` : conversion d'un périphérique qui ne tourne pas à 48 kHz
//!   (44,1 kHz, 96 kHz…) vers 48 kHz.
//! - `Follower` : lecture du tampon d'un compte à niveau constant, par de très
//!   petites corrections de vitesse (± 0,5 %).

use std::collections::VecDeque;
use std::sync::OnceLock;

const TAPS: usize = 64;
const PHASES: usize = 256;
/// Indice de l'échantillon « courant » dans l'historique.
const CENTER: usize = TAPS / 2 - 1;

type Table = Vec<[f32; TAPS]>;

/// Fonction de Bessel modifiée I0 (fenêtre de Kaiser).
fn bessel_i0(x: f64) -> f64 {
    let mut sum = 1.0;
    let mut term = 1.0;
    let half = x / 2.0;
    for k in 1..32 {
        term *= (half / f64::from(k)) * (half / f64::from(k));
        sum += term;
        if term < 1e-12 * sum {
            break;
        }
    }
    sum
}

/// Table des filtres : `PHASES + 1` positions entre deux échantillons, `TAPS`
/// coefficients chacune. `cutoff` : fraction de la demi-fréquence d'entrée.
fn design(cutoff: f64) -> Table {
    const BETA: f64 = 9.0;
    let i0_beta = bessel_i0(BETA);
    (0..=PHASES)
        .map(|p| {
            let frac = p as f64 / PHASES as f64;
            let mut h = [0.0f64; TAPS];
            for (i, t) in h.iter_mut().enumerate() {
                // Distance entre l'échantillon i et le point à calculer.
                let x = i as f64 - CENTER as f64 - frac;
                let sinc = if x.abs() < 1e-9 {
                    cutoff
                } else {
                    (std::f64::consts::PI * cutoff * x).sin() / (std::f64::consts::PI * x)
                };
                let r = x / (TAPS / 2) as f64;
                let w = if r.abs() <= 1.0 {
                    bessel_i0(BETA * (1.0 - r * r).sqrt()) / i0_beta
                } else {
                    0.0
                };
                *t = sinc * w;
            }
            // Gain unité en continu.
            let sum: f64 = h.iter().sum();
            let mut out = [0.0f32; TAPS];
            for (o, t) in out.iter_mut().zip(h.iter()) {
                *o = (t / sum) as f32;
            }
            out
        })
        .collect()
}

/// Table pour une vitesse proche de 1 (passe tout jusqu'à ~20 kHz).
fn unity_table() -> &'static Table {
    static T: OnceLock<Table> = OnceLock::new();
    T.get_or_init(|| design(0.94))
}

/// Historique stéréo + position de lecture : le cœur commun aux deux usages.
struct Kernel {
    /// Derniers échantillons d'entrée, par voie (le plus ancien d'abord).
    hist: [[f32; TAPS]; 2],
    /// Position du prochain point de sortie, en échantillons d'entrée, comptée
    /// depuis l'échantillon `CENTER + 1` (≥ 0 : il manque un échantillon).
    pos: f64,
}

impl Kernel {
    fn new() -> Self {
        Kernel {
            hist: [[0.0; TAPS]; 2],
            pos: 0.0,
        }
    }
    fn feed(&mut self, l: f32, r: f32) {
        for (h, x) in self.hist.iter_mut().zip([l, r]) {
            h.copy_within(1.., 0);
            h[TAPS - 1] = x;
        }
        self.pos -= 1.0;
    }
    /// Point de sortie à la position courante (qui doit être < 0).
    fn point(&self, table: &Table) -> [f32; 2] {
        let scaled = (self.pos + 1.0) * PHASES as f64;
        let idx = (scaled as usize).min(PHASES - 1);
        let mix = (scaled - idx as f64) as f32;
        let (a, b) = (&table[idx], &table[idx + 1]);
        let mut out = [0.0f32; 2];
        for (o, h) in out.iter_mut().zip(&self.hist) {
            let mut acc = 0.0f32;
            for i in 0..TAPS {
                acc += h[i] * (a[i] + (b[i] - a[i]) * mix);
            }
            *o = acc;
        }
        out
    }
}

/// Convertisseur stéréo d'une fréquence d'échantillonnage vers une autre.
pub struct Sinc {
    table: Table,
    kernel: Kernel,
    /// Pas d'avancée par échantillon de sortie (fréquence d'entrée / sortie).
    step: f64,
}

impl Sinc {
    pub fn new(in_rate: u32, out_rate: u32) -> Self {
        let step = f64::from(in_rate) / f64::from(out_rate);
        // En descente (96 → 48 kHz), le filtre coupe sous la nouvelle demi-fréquence.
        Sinc {
            table: design((1.0 / step).min(1.0) * 0.94),
            kernel: Kernel::new(),
            step,
        }
    }

    /// Ajoute un échantillon d'entrée ; écrit les échantillons de sortie prêts
    /// (0, 1 ou plusieurs) dans `out`, entrelacés L, R.
    pub fn push(&mut self, l: f32, r: f32, out: &mut Vec<f32>) {
        self.kernel.feed(l, r);
        while self.kernel.pos < 0.0 {
            out.extend(self.kernel.point(&self.table));
            self.kernel.pos += self.step;
        }
    }
}

// ── Lecture d'un tampon à niveau constant ────────────────────────────────────

/// Trames (paires L, R) données au plus par lecture : 20 ms à 48 kHz.
pub const READ_FRAMES: usize = 960;
/// Correction maximale de la vitesse de lecture.
const MAX_TRIM: f64 = 0.005;

/// Lit un tampon de trames stéréo en gardant sa réserve au niveau visé : la
/// vitesse de lecture est ajustée de ±0,5 % au plus (inaudible). Si le tampon
/// se vide, la lecture attend qu'il soit revenu à sa cible au lieu de hacher.
pub struct Follower {
    kernel: Kernel,
    /// Vitesse de lecture (1 = normale).
    ratio: f64,
    /// Réserve moyenne, en trames (lissée sur ~1 s : les blocs de 10 ms de la
    /// capture et les lectures de 20 ms ne doivent pas faire varier la vitesse).
    level: f64,
    /// Le tampon a atteint sa cible : la lecture peut commencer.
    primed: bool,
}

impl Follower {
    pub fn new() -> Self {
        Follower {
            kernel: Kernel::new(),
            ratio: 1.0,
            level: 0.0,
            primed: false,
        }
    }

    /// Écrit jusqu'à `out.len() / 2` trames (20 ms au plus) tirées de `q` ;
    /// renvoie le nombre de trames écrites. `target` : réserve visée, en trames.
    pub fn pull(&mut self, q: &mut VecDeque<f32>, target: usize, out: &mut [f32]) -> usize {
        let frames = (out.len() / 2).min(READ_FRAMES);
        let target = target.max(READ_FRAMES);
        let fill = q.len() / 2;

        if !self.primed {
            if fill < target {
                // Réserve pas encore prête : silence, sans toucher au tampon.
                out[..frames * 2].fill(0.0);
                return frames;
            }
            self.primed = true;
            self.ratio = 1.0;
            self.level = fill as f64;
        }
        // Très en retard (lecture restée bloquée) : retour direct à la cible.
        if fill > target * 3 + READ_FRAMES * 2 {
            q.drain(..(fill - target) * 2);
            self.level = target as f64;
        }

        // Vitesse : un peu plus vite si la réserve dépasse la cible, un peu
        // moins vite sinon.
        self.level += ((q.len() / 2) as f64 - self.level) * 0.02;
        let error = (self.level - target as f64) / target as f64;
        let want = 1.0 + (error * 2.0 * MAX_TRIM).clamp(-MAX_TRIM, MAX_TRIM);
        self.ratio += (want - self.ratio) * 0.02;

        let table = unity_table();
        for i in 0..frames {
            while self.kernel.pos >= 0.0 {
                let (Some(l), Some(r)) = (q.pop_front(), q.pop_front()) else {
                    // Tampon vide : fin en silence, puis on reconstitue la réserve.
                    out[i * 2..frames * 2].fill(0.0);
                    *self = Follower::new();
                    return frames;
                };
                self.kernel.feed(l, r);
            }
            let [l, r] = self.kernel.point(table);
            out[i * 2] = l;
            out[i * 2 + 1] = r;
            self.kernel.pos += self.ratio;
        }
        frames
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn convert(in_rate: u32, hz: f64, secs: f64) -> Vec<f32> {
        let mut rs = Sinc::new(in_rate, 48000);
        let mut out = Vec::new();
        for i in 0..(f64::from(in_rate) * secs) as usize {
            let x = (std::f64::consts::TAU * hz * i as f64 / f64::from(in_rate)).sin() as f32 * 0.5;
            rs.push(x, x, &mut out);
        }
        out.chunks(2).map(|c| c[0]).collect()
    }

    fn rms(x: &[f32]) -> f32 {
        (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt()
    }

    /// Part du signal qui n'est PAS une sinusoïde pure à `hz` (48 kHz) : bruit
    /// et distorsion ajoutés, par rapport au niveau du signal. Ajustement par
    /// moindres carrés (amplitude et phase libres).
    fn error(body: &[f32], hz: f64) -> f32 {
        let (mut ss, mut cc, mut sc, mut vs, mut vc) = (0.0f64, 0.0f64, 0.0f64, 0.0f64, 0.0f64);
        for (i, &v) in body.iter().enumerate() {
            let (s, c) = (std::f64::consts::TAU * hz * i as f64 / 48000.0).sin_cos();
            ss += s * s;
            cc += c * c;
            sc += s * c;
            vs += f64::from(v) * s;
            vc += f64::from(v) * c;
        }
        let det = ss * cc - sc * sc;
        let (a, b) = ((vs * cc - vc * sc) / det, (vc * ss - vs * sc) / det);
        let resid: f64 = body
            .iter()
            .enumerate()
            .map(|(i, &v)| {
                let (s, c) = (std::f64::consts::TAU * hz * i as f64 / 48000.0).sin_cos();
                (f64::from(v) - a * s - b * c).powi(2)
            })
            .sum();
        (resid / body.len() as f64).sqrt() as f32 / rms(body)
    }

    #[test]
    fn nombre_d_échantillons_exact() {
        for rate in [44100, 96000, 32000] {
            let out = convert(rate, 1000.0, 1.0);
            assert!(
                (out.len() as i64 - 48000).abs() <= 2,
                "{rate} : {}",
                out.len()
            );
        }
    }

    #[test]
    fn conversion_44_1_transparente() {
        // Graves, médiums et aigus : niveau gardé, bruit ajouté < −70 dB.
        for hz in [100.0, 1000.0, 10000.0, 18000.0] {
            let out = convert(44100, hz, 1.0);
            let body = &out[2000..out.len() - 2000];
            let level = rms(body) / (0.5 / std::f32::consts::SQRT_2);
            assert!((level - 1.0).abs() < 0.01, "{hz} Hz : niveau {level}");
            let e = error(body, hz);
            assert!(e < 0.0003, "{hz} Hz : erreur {e}");
        }
    }

    #[test]
    fn descente_96_sans_repliement() {
        // 30 kHz à 96 kHz n'existe pas à 48 kHz : il doit disparaître, pas se replier en 18 kHz.
        let out = convert(96000, 30000.0, 0.5);
        assert!(rms(&out[2000..]) < 0.0005, "{}", rms(&out[2000..]));
        // Un 10 kHz passe intact.
        let out = convert(96000, 10000.0, 0.5);
        let e = error(&out[2000..out.len() - 2000], 10000.0);
        assert!(e < 0.0003, "{e}");
    }

    /// Simule `secs` secondes : la capture produit des blocs de 10 ms à une
    /// horloge décalée de `drift` (1.001 = 0,1 % trop vite), la lecture prend
    /// 20 ms toutes les 20 ms. Renvoie (coupures après le démarrage, réserve
    /// finale en ms, écart de la vitesse de lecture sur les 10 dernières
    /// secondes, sortie voie gauche).
    fn simulate(drift: f64, hz: f64, target_ms: usize, secs: usize) -> (usize, f32, f64, Vec<f32>) {
        let mut q: VecDeque<f32> = VecDeque::new();
        let mut f = Follower::new();
        let target = 48 * target_ms;
        let (mut produced, mut phase) = (0.0f64, 0.0f64);
        let mut out = Vec::new();
        let mut gaps = 0;
        let mut started = false;
        let (mut lo, mut hi) = (f64::MAX, f64::MIN);
        let mut buf = [0.0f32; READ_FRAMES * 2];
        for tick in 0..secs * 50 {
            // 20 ms de capture (deux blocs de 10 ms), à l'horloge de la carte son.
            for _ in 0..2 {
                produced += 480.0 * drift;
                while produced >= 1.0 {
                    produced -= 1.0;
                    let x = (phase.sin() * 0.5) as f32;
                    phase += std::f64::consts::TAU * hz / 48000.0;
                    q.push_back(x);
                    q.push_back(x);
                }
            }
            assert_eq!(f.pull(&mut q, target, &mut buf), READ_FRAMES);
            let silent = buf.iter().all(|v| *v == 0.0);
            if started && silent {
                gaps += 1;
            }
            started |= !silent;
            if started {
                out.extend(buf.chunks(2).map(|c| c[0]));
            }
            if tick >= (secs - 10) * 50 {
                lo = lo.min(f.ratio);
                hi = hi.max(f.ratio);
            }
        }
        (gaps, q.len() as f32 / 2.0 / 48.0, hi - lo, out)
    }

    #[test]
    fn tampon_tient_sa_cible_malgré_la_dérive() {
        // Carte son 0,1 % trop rapide, trop lente, ou pile à l'heure : jamais
        // de coupure, la réserve reste près de la cible (60 ms) et la vitesse
        // de lecture ne bouge presque plus une fois calée (< 0,02 %).
        for drift in [1.001, 0.999, 1.0, 1.0003] {
            let (gaps, fill, wobble, _) = simulate(drift, 440.0, 60, 120);
            assert_eq!(gaps, 0, "dérive {drift} : {gaps} coupures");
            // `fill` est relevé juste après une lecture de 20 ms.
            let level = fill + 20.0;
            assert!(
                (level - 60.0).abs() < 10.0,
                "dérive {drift} : réserve {level} ms"
            );
            assert!(
                wobble < 0.0002,
                "dérive {drift} : vitesse instable ({wobble})"
            );
        }
    }

    #[test]
    fn son_intact_à_travers_le_tampon() {
        // Horloges identiques : la note ressort telle quelle, graves comme
        // aigus (niveau gardé, bruit ajouté < −50 dB).
        for hz in [440.0, 15000.0] {
            let (_, _, _, out) = simulate(1.0, hz, 60, 30);
            let body = &out[out.len() - 96000..out.len() - 48000];
            let level = rms(body) / (0.5 / std::f32::consts::SQRT_2);
            assert!((level - 1.0).abs() < 0.01, "{hz} Hz : niveau {level}");
            // La vitesse calée peut différer de 1 de quelques millionièmes : on
            // cherche la fréquence exacte autour de la note.
            let best = (0..=200)
                .map(|k| error(body, hz * (1.0 + (f64::from(k) - 100.0) * 2e-7)))
                .fold(f32::MAX, f32::min);
            assert!(best < 0.003, "{hz} Hz : erreur {best}");
        }
    }

    #[test]
    fn tampon_vide_reprend_proprement() {
        let mut q: VecDeque<f32> = VecDeque::new();
        let mut f = Follower::new();
        let mut buf = [0.0f32; READ_FRAMES * 2];
        // Rien dans le tampon : silence, pas de blocage.
        assert_eq!(f.pull(&mut q, 2880, &mut buf), READ_FRAMES);
        assert!(buf.iter().all(|v| *v == 0.0));
        // En dessous de la cible : on attend encore, sans rien consommer.
        q.extend(std::iter::repeat_n(0.25, 2000 * 2));
        f.pull(&mut q, 2880, &mut buf);
        assert!(buf.iter().all(|v| *v == 0.0));
        assert_eq!(q.len(), 4000);
        // Cible atteinte : le son sort.
        q.extend(std::iter::repeat_n(0.25, 1000 * 2));
        f.pull(&mut q, 2880, &mut buf);
        assert!(buf[1900] > 0.2);
        // Gros retard : ramené à la cible d'un coup.
        q.extend(std::iter::repeat_n(0.25, 48000 * 2));
        f.pull(&mut q, 2880, &mut buf);
        assert!(q.len() / 2 < 2880 + 100);
        // Tampon vidé en pleine lecture : fin en silence, puis nouvelle attente.
        q.clear();
        f.pull(&mut q, 2880, &mut buf);
        f.pull(&mut q, 2880, &mut buf);
        assert!(buf.iter().all(|v| *v == 0.0));
    }
}
