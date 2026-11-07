//! Espace : spatialisation à 360° autour de la tête, façon dearVR.
//!
//! La source est placée sur un plan vu de dessus (toi au centre, devant en
//! haut). Sa position donne :
//!  - l'azimut : décalage de temps entre les oreilles (jusqu'à 0,66 ms),
//!    écart de niveau, et ombre de la tête (l'oreille opposée perd ses aigus) ;
//!  - devant / derrière : derrière, le son est assourdi (comme par le pavillon
//!    de l'oreille) ;
//!  - la distance : plus loin = moins fort, plus feutré (l'air absorbe les
//!    aigus) et la pièce s'entend davantage.
//!
//! La pièce = réflexions précoces (taille de la pièce) + réverbe tardive.
//! Mouvements automatiques : orbite, ping-pong, avant / arrière, spirale, chaos.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};

use crate::audio::OUT_RATE;
use crate::dsp::{db_to_lin, Biquad};
use crate::lock;

const FS: f32 = OUT_RATE as f32;
const TAU: f32 = std::f32::consts::TAU;

// ── Réglages ────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct SpaceParams {
    /// 0 = off (stéréo d'origine), 1 = mouvement auto, 2 = position manuelle.
    pub mode: u8,
    /// 0 orbite, 1 ping-pong, 2 avant / arrière, 3 spirale, 4 chaos.
    pub motion: u8,
    /// Vitesse du mouvement (tours ou allers-retours par seconde).
    pub speed: f32,
    /// Position manuelle : x = gauche (−1) → droite (1), y = derrière (−1) → devant (1).
    pub x: f32,
    pub y: f32,
    /// Distance du mouvement auto (rayon) [0..1].
    pub radius: f32,
    /// Largeur stéréo gardée de la source [0..1].
    pub spread: f32,
    pub reverb: bool,
    /// Taille de la pièce [0..1].
    pub room: f32,
    /// Quantité de pièce [0..1].
    pub mix: f32,
}

impl Default for SpaceParams {
    fn default() -> Self {
        SpaceParams {
            mode: 0,
            motion: 0,
            speed: 0.15,
            x: 0.0,
            y: 0.5,
            radius: 0.6,
            spread: 0.3,
            reverb: false,
            room: 0.5,
            mix: 0.5,
        }
    }
}

impl SpaceParams {
    pub fn from_json(v: &Value) -> SpaceParams {
        let d = SpaceParams::default();
        let n = |k: &str, def: f32| {
            v.get(k)
                .and_then(Value::as_f64)
                .filter(|x| x.is_finite())
                .map_or(def, |x| x as f32)
        };
        SpaceParams {
            mode: (n("mode", 0.0) as u8).min(2),
            motion: (n("motion", 0.0) as u8).min(4),
            speed: n("speed", d.speed).clamp(0.01, 2.0),
            x: n("x", d.x).clamp(-1.0, 1.0),
            y: n("y", d.y).clamp(-1.0, 1.0),
            radius: n("radius", d.radius).clamp(0.0, 1.0),
            spread: n("spread", d.spread).clamp(0.0, 1.0),
            reverb: v.get("reverb").and_then(Value::as_bool).unwrap_or(d.reverb),
            room: n("room", d.room).clamp(0.0, 1.0),
            mix: n("mix", d.mix).clamp(0.0, 1.0),
        }
    }

    pub fn to_json(self) -> Value {
        json!({
            "mode": self.mode, "motion": self.motion, "speed": self.speed, "x": self.x, "y": self.y,
            "radius": self.radius, "spread": self.spread, "reverb": self.reverb, "room": self.room, "mix": self.mix,
        })
    }
}

fn params() -> &'static Mutex<SpaceParams> {
    static P: OnceLock<Mutex<SpaceParams>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(SpaceParams::default()))
}

pub fn set_params(p: SpaceParams) {
    *lock(params()) = p;
}

pub fn current() -> SpaceParams {
    *lock(params())
}

// Position réellement jouée (pour l'affichage du panneau).
fn pos_slot() -> &'static [AtomicU32; 2] {
    static P: OnceLock<[AtomicU32; 2]> = OnceLock::new();
    P.get_or_init(|| [AtomicU32::new(0), AtomicU32::new(0)])
}

/// Position actuelle de la source (x, y), ou None quand l'espace est coupé.
pub fn position() -> Option<(f32, f32)> {
    if current().mode == 0 {
        return None;
    }
    let [x, y] = pos_slot();
    Some((
        f32::from_bits(x.load(Ordering::Relaxed)),
        f32::from_bits(y.load(Ordering::Relaxed)),
    ))
}

/// Position d'un mouvement automatique à la phase `t` (en tours).
pub fn motion_at(motion: u8, t: f32, radius: f32) -> (f32, f32) {
    let a = TAU * t;
    let (x, y) = match motion {
        // Ping-pong : gauche ↔ droite, devant toi.
        1 => (a.sin(), 0.25),
        // Avant ↔ arrière, au centre.
        2 => (0.0, a.sin()),
        // Spirale : orbite dont la distance respire.
        3 => {
            let r = 0.45 + 0.55 * (0.5 + 0.5 * (a * 0.25).sin());
            (a.sin() * r, a.cos() * r)
        }
        // Chaos : trajectoire qui ne se répète presque jamais.
        4 => (
            (a * 1.3).sin() * (a * 0.7).cos(),
            (a * 0.9).cos() * (a * 1.7 + 1.0).sin(),
        ),
        // Orbite : tour complet de la tête (devant → droite → derrière → gauche).
        _ => (a.sin(), a.cos()),
    };
    (x * radius, y * radius)
}

// ── Réverbe (Freeverb) ─────────────────────────────────────────────────────

struct Comb {
    buf: Vec<f32>,
    idx: usize,
    filt: f32,
    damp: f32,
    feedback: f32,
}

impl Comb {
    fn new(len: usize) -> Self {
        Comb {
            buf: vec![0.0; len.max(1)],
            idx: 0,
            filt: 0.0,
            damp: 0.25,
            feedback: 0.84,
        }
    }
    fn process(&mut self, input: f32) -> f32 {
        let out = self.buf[self.idx];
        self.filt = out * (1.0 - self.damp) + self.filt * self.damp;
        self.buf[self.idx] = input + self.filt * self.feedback;
        self.idx = (self.idx + 1) % self.buf.len();
        out
    }
}

struct Allpass {
    buf: Vec<f32>,
    idx: usize,
}

impl Allpass {
    fn new(len: usize) -> Self {
        Allpass {
            buf: vec![0.0; len.max(1)],
            idx: 0,
        }
    }
    fn process(&mut self, input: f32) -> f32 {
        let buf = self.buf[self.idx];
        self.buf[self.idx] = input + buf * 0.5;
        self.idx = (self.idx + 1) % self.buf.len();
        buf - input
    }
}

struct LateReverb {
    cl: Vec<Comb>,
    cr: Vec<Comb>,
    al: Vec<Allpass>,
    ar: Vec<Allpass>,
}

impl LateReverb {
    fn new() -> Self {
        // Accordages Freeverb (44,1 kHz) ré-échelonnés vers 48 kHz, décalage stéréo de 23.
        let s = |n: usize| ((n as f32) * FS / 44100.0) as usize;
        let combs = [1116usize, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
        let aps = [556usize, 441, 341, 225];
        let spread = s(23);
        LateReverb {
            cl: combs.iter().map(|&n| Comb::new(s(n))).collect(),
            cr: combs.iter().map(|&n| Comb::new(s(n) + spread)).collect(),
            al: aps.iter().map(|&n| Allpass::new(s(n))).collect(),
            ar: aps.iter().map(|&n| Allpass::new(s(n) + spread)).collect(),
        }
    }
    fn configure(&mut self, room: f32) {
        // Grande pièce = réverbe plus longue et plus sombre.
        let fb = 0.7 + 0.28 * room;
        let damp = 0.15 + 0.3 * room;
        for c in self.cl.iter_mut().chain(self.cr.iter_mut()) {
            c.feedback = fb;
            c.damp = damp;
        }
    }
    /// Partie réverbérée seule.
    fn wet(&mut self, input: f32) -> (f32, f32) {
        let input = input * 0.03;
        let mut wl: f32 = self.cl.iter_mut().map(|c| c.process(input)).sum();
        let mut wr: f32 = self.cr.iter_mut().map(|c| c.process(input)).sum();
        for a in self.al.iter_mut() {
            wl = a.process(wl);
        }
        for a in self.ar.iter_mut() {
            wr = a.process(wr);
        }
        (wl, wr)
    }
}

// ── Réflexions précoces ─────────────────────────────────────────────────────
// Les premiers échos sur les murs : leur écartement dit la taille de la pièce.

const ER_TAPS: [(f32, f32, bool); 8] = [
    // (retard ms à taille moyenne, gain, côté droit ?)
    (7.0, 0.62, false),
    (9.5, 0.58, true),
    (13.0, 0.5, true),
    (16.5, 0.46, false),
    (21.0, 0.4, false),
    (26.0, 0.36, true),
    (31.0, 0.3, true),
    (37.0, 0.26, false),
];

struct EarlyReflections {
    buf: Vec<f32>,
    idx: usize,
    taps: [usize; 8],
    tone: Biquad,
}

impl EarlyReflections {
    fn new() -> Self {
        let mut tone = Biquad::default();
        tone.set_lowpass(6000.0, FS, std::f32::consts::FRAC_1_SQRT_2);
        EarlyReflections {
            buf: vec![0.0; (FS * 0.1) as usize],
            idx: 0,
            taps: [1; 8],
            tone,
        }
    }
    fn configure(&mut self, room: f32) {
        let scale = 0.35 + 1.65 * room;
        for (t, &(ms, _, _)) in self.taps.iter_mut().zip(ER_TAPS.iter()) {
            *t = ((ms * scale * FS / 1000.0) as usize).clamp(1, self.buf.len() - 1);
        }
    }
    fn process(&mut self, input: f32) -> (f32, f32) {
        let n = self.buf.len();
        self.buf[self.idx] = self.tone.process(input);
        let (mut l, mut r) = (0.0, 0.0);
        for (&t, &(_, g, right)) in self.taps.iter().zip(ER_TAPS.iter()) {
            let v = self.buf[(self.idx + n - t) % n] * g;
            if right {
                r += v;
            } else {
                l += v;
            }
        }
        self.idx = (self.idx + 1) % n;
        (l * 0.5, r * 0.5)
    }
}

// ── Spatialiseur ────────────────────────────────────────────────────────────

/// Décalage maximal entre les oreilles (tête moyenne) : 0,66 ms.
const ITD_MAX: f32 = 0.00066 * FS;
const DELAY_LEN: usize = 64;

struct FracDelay {
    buf: [f32; DELAY_LEN],
    idx: usize,
}

impl FracDelay {
    fn new() -> Self {
        FracDelay {
            buf: [0.0; DELAY_LEN],
            idx: 0,
        }
    }
    /// Écrit `x` et lit avec un retard fractionnaire (interpolation linéaire).
    fn process(&mut self, x: f32, delay: f32) -> f32 {
        self.buf[self.idx] = x;
        let d = delay.clamp(0.0, (DELAY_LEN - 2) as f32);
        let i = d.floor() as usize;
        let f = d - i as f32;
        let a = self.buf[(self.idx + DELAY_LEN - i) % DELAY_LEN];
        let b = self.buf[(self.idx + DELAY_LEN - i - 1) % DELAY_LEN];
        self.idx = (self.idx + 1) % DELAY_LEN;
        a + (b - a) * f
    }
}

pub struct Space {
    phase: f32,
    cur: (f32, f32),
    delay: [FracDelay; 2],
    /// Ombre de la tête sur chaque oreille (passe-bas à un pôle).
    shadow: [f32; 2],
    back: [Biquad; 2],
    air: [Biquad; 2],
    filters_at: (f32, f32),
    early: EarlyReflections,
    late: LateReverb,
    room: f32,
}

impl Space {
    pub fn new() -> Self {
        let mut s = Space {
            phase: 0.0,
            cur: (0.0, 0.5),
            delay: [FracDelay::new(), FracDelay::new()],
            shadow: [0.0; 2],
            back: [Biquad::default(); 2],
            air: [Biquad::default(); 2],
            filters_at: (-1.0, -1.0),
            early: EarlyReflections::new(),
            late: LateReverb::new(),
            room: -1.0,
        };
        s.update_filters(0.0, 0.0);
        s
    }

    /// Filtres « derrière » et « air » : recalculés quand la position a bougé.
    fn update_filters(&mut self, back: f32, dist: f32) {
        if (back - self.filters_at.0).abs() < 0.02 && (dist - self.filters_at.1).abs() < 0.02 {
            return;
        }
        self.filters_at = (back, dist);
        for b in self.back.iter_mut() {
            b.set_highshelf(3500.0, FS, -9.0 * back);
        }
        let cutoff = 19000.0 * 0.28f32.powf(dist);
        for a in self.air.iter_mut() {
            a.set_lowpass(cutoff, FS, std::f32::consts::FRAC_1_SQRT_2);
        }
    }

    /// Spatialise un bloc stéréo entrelacé.
    pub fn process(&mut self, buf: &mut [f32], p: &SpaceParams) {
        let frames = buf.len() / 2;
        if frames == 0 {
            return;
        }
        if p.reverb && p.room != self.room {
            self.room = p.room;
            self.early.configure(p.room);
            self.late.configure(p.room);
        }

        // Position visée en fin de bloc.
        let target = match p.mode {
            1 => {
                self.phase = (self.phase + p.speed * frames as f32 / FS).fract();
                motion_at(p.motion, self.phase, p.radius)
            }
            2 => (p.x, p.y),
            _ => (0.0, p.radius.max(0.05)),
        };
        // Glissement doux vers la cible (pas de saut quand on déplace le point).
        let k = 1.0 - (-(frames as f32) / (0.03 * FS)).exp();
        let start = self.cur;
        let end = (
            start.0 + (target.0 - start.0) * k,
            start.1 + (target.1 - start.1) * k,
        );
        self.cur = end;
        let [sx, sy] = pos_slot();
        sx.store(end.0.to_bits(), Ordering::Relaxed);
        sy.store(end.1.to_bits(), Ordering::Relaxed);

        let positioned = p.mode != 0;
        let dist_end = (end.0 * end.0 + end.1 * end.1).sqrt().min(1.0);
        if positioned {
            let back = if dist_end > 0.01 {
                (-end.1 / dist_end).max(0.0)
            } else {
                0.0
            };
            self.update_filters(back * dist_end.min(0.3) / 0.3, dist_end);
        }

        for (i, frame) in buf.as_chunks_mut::<2>().0.iter_mut().enumerate() {
            let (l, r) = (frame[0], frame[1]);
            let mid = (l + r) * 0.5;
            let side = (l - r) * 0.5;
            let t = (i + 1) as f32 / frames as f32;
            let (x, y) = (
                start.0 + (end.0 - start.0) * t,
                start.1 + (end.1 - start.1) * t,
            );
            let dist = (x * x + y * y).sqrt().min(1.0);

            let (mut ol, mut or) = if positioned {
                // Azimut : sin = gauche/droite (−1..1). Au centre exact, pas de côté.
                let side_amt = if dist > 1e-4 {
                    (x / dist).clamp(-1.0, 1.0)
                } else {
                    0.0
                };
                let lateral = side_amt.abs() * dist.min(0.25) / 0.25;
                let pan = side_amt.signum() * lateral;
                // Oreille opposée : retard, niveau et aigus en moins ; oreille proche un peu plus fort.
                let far_gain = db_to_lin(-7.0 * lateral);
                let near_gain = db_to_lin(1.5 * lateral);
                let itd = ITD_MAX * lateral;
                let (dl, dr) = if pan > 0.0 { (itd, 0.0) } else { (0.0, itd) };
                let el = self.delay[0].process(mid, dl);
                let er = self.delay[1].process(mid, dr);
                // Passe-bas « ombre » : coupure de ~16 kHz (face) à ~1,4 kHz (oreille cachée).
                let shade = |amt: f32| 1.0 - (-TAU * (16000.0 * 0.088f32.powf(amt)) / FS).exp();
                let (sl, sr) = if pan > 0.0 {
                    (shade(lateral), 1.0)
                } else {
                    (1.0, shade(lateral))
                };
                self.shadow[0] += (el - self.shadow[0]) * sl;
                self.shadow[1] += (er - self.shadow[1]) * sr;
                let (gl, gr) = if pan > 0.0 {
                    (far_gain, near_gain)
                } else {
                    (near_gain, far_gain)
                };
                // Largeur de la source, réduite quand elle s'éloigne.
                let width = side * p.spread * (1.0 - 0.6 * dist);
                let level = db_to_lin(-9.0 * dist);
                let bl = self.back[0].process(self.shadow[0] * gl + width);
                let br = self.back[1].process(self.shadow[1] * gr - width);
                (
                    self.air[0].process(bl) * level,
                    self.air[1].process(br) * level,
                )
            } else {
                (l, r)
            };

            if p.reverb {
                // Plus la source est loin, plus la pièce s'entend.
                let d = if positioned { dist } else { p.radius };
                let (el, er) = self.early.process(mid);
                let (ll, lr) = self.late.wet(mid);
                let er_gain = p.mix * (0.25 + 0.75 * d);
                let late_gain = p.mix * (0.15 + 0.85 * d);
                ol += el * er_gain + ll * late_gain;
                or += er * er_gain + lr * late_gain;
            }
            frame[0] = ol;
            frame[1] = or;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(p: &SpaceParams, hz: f32, secs: f32) -> Vec<f32> {
        let mut s = Space::new();
        let mut buf: Vec<f32> = (0..(FS * secs) as usize)
            .flat_map(|i| {
                let v = 0.5 * (TAU * hz * i as f32 / FS).sin();
                [v, v]
            })
            .collect();
        for block in buf.chunks_mut(960) {
            s.process(block, p);
        }
        buf
    }

    /// Niveau efficace (gauche, droite) sur la seconde moitié.
    fn levels(buf: &[f32]) -> (f32, f32) {
        let half = &buf[buf.len() / 2..];
        let n = half.len() as f32 / 2.0;
        let (mut l, mut r) = (0.0, 0.0);
        for [a, b] in half.as_chunks::<2>().0 {
            l += a * a;
            r += b * b;
        }
        ((l / n).sqrt(), (r / n).sqrt())
    }

    fn manual(x: f32, y: f32) -> SpaceParams {
        SpaceParams {
            mode: 2,
            x,
            y,
            spread: 0.0,
            ..SpaceParams::default()
        }
    }

    #[test]
    fn off_ne_touche_pas_au_son() {
        let p = SpaceParams::default();
        let out = run(&p, 440.0, 0.2);
        let (l, r) = levels(&out);
        assert!((l - 0.3536).abs() < 0.001 && (r - 0.3536).abs() < 0.001);
    }

    #[test]
    fn à_droite_l_oreille_droite_domine() {
        let (l, r) = levels(&run(&manual(0.5, 0.0), 2000.0, 0.5));
        assert!(r > l * 3.0, "g {l} d {r}");
        let (l, r) = levels(&run(&manual(-0.5, 0.0), 2000.0, 0.5));
        assert!(l > r * 3.0, "g {l} d {r}");
    }

    #[test]
    fn derrière_plus_sourd_que_devant() {
        let front = levels(&run(&manual(0.0, 0.5), 8000.0, 0.5));
        let back = levels(&run(&manual(0.0, -0.5), 8000.0, 0.5));
        assert!(
            front.0 > back.0 * 1.8,
            "devant {} derrière {}",
            front.0,
            back.0
        );
        // En grave, pas de différence notable.
        let front = levels(&run(&manual(0.0, 0.5), 200.0, 0.5));
        let back = levels(&run(&manual(0.0, -0.5), 200.0, 0.5));
        assert!((front.0 / back.0 - 1.0).abs() < 0.1);
    }

    #[test]
    fn loin_moins_fort_et_plus_feutré() {
        let near = levels(&run(&manual(0.0, 0.15), 6000.0, 0.5));
        let far = levels(&run(&manual(0.0, 1.0), 6000.0, 0.5));
        assert!(near.0 > far.0 * 3.0, "proche {} loin {}", near.0, far.0);
    }

    #[test]
    fn orbite_fait_le_tour_de_la_tête() {
        let mut seen = [false; 4];
        for i in 0..100 {
            let (x, y) = motion_at(0, i as f32 / 100.0, 1.0);
            seen[usize::from(x > 0.0) * 2 + usize::from(y > 0.0)] = true;
        }
        assert!(seen.iter().all(|&s| s), "les 4 quarts : {seen:?}");
        // La position jouée suit bien le mouvement.
        let p = SpaceParams {
            mode: 1,
            speed: 1.0,
            radius: 1.0,
            ..SpaceParams::default()
        };
        let mut s = Space::new();
        let mut xs = Vec::new();
        for _ in 0..100 {
            let mut block = vec![0.0; 960];
            s.process(&mut block, &p);
            xs.push(s.cur.0);
        }
        assert!(xs.iter().any(|&x| x > 0.5) && xs.iter().any(|&x| x < -0.5));
    }

    #[test]
    fn pièce_laisse_une_traîne() {
        let p = SpaceParams {
            reverb: true,
            mix: 1.0,
            radius: 1.0,
            ..SpaceParams::default()
        };
        let mut s = Space::new();
        let mut buf: Vec<f32> = (0..(FS * 0.3) as usize)
            .flat_map(|i| {
                let v = 0.5 * (TAU * 440.0 * i as f32 / FS).sin();
                [v, v]
            })
            .collect();
        buf.extend(std::iter::repeat_n(0.0, (FS * 0.4) as usize * 2));
        for block in buf.chunks_mut(960) {
            s.process(block, &p);
        }
        let tail = &buf[(FS * 0.35) as usize * 2..(FS * 0.5) as usize * 2];
        assert!(
            tail.iter().any(|x| x.abs() > 0.005),
            "la réverbe continue après le son"
        );
        assert!(buf.iter().all(|x| x.is_finite() && x.abs() < 4.0));
    }

    #[test]
    fn réglages_bornés() {
        let p = SpaceParams::from_json(
            &json!({ "mode": 9, "motion": 9, "x": 5, "speed": -1, "room": "x" }),
        );
        assert_eq!(
            (p.mode, p.motion, p.x, p.speed, p.room),
            (2, 4, 1.0, 0.01, 0.5)
        );
        assert_eq!(SpaceParams::from_json(&p.to_json()), p);
    }
}
