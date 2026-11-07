//! Soundboard : des sons importés (mp3, wav, ogg, flac), décodés une fois en
//! mémoire. Chaque lecture ajoute une « voix » par-dessus les autres : on peut
//! spammer sans couper le son d'avant (32 voix au plus, la plus ancienne
//! s'arrête si on dépasse). Les voix sont mélangées au son traité, juste
//! avant le volume général et la protection anti-saturation.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use crate::audio::OUT_RATE;
use crate::lock;

const MAX_VOICES: usize = 32;
const MAX_SECONDS: usize = 60;
const MAX_FILE_BYTES: u64 = 25 * 1024 * 1024;

type Clip = Arc<Vec<f32>>;

struct Voice {
    clip: Clip,
    pos: usize,
    gain: f32,
}

fn clips() -> &'static Mutex<HashMap<String, Clip>> {
    static C: OnceLock<Mutex<HashMap<String, Clip>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

fn voices() -> &'static Mutex<Vec<Voice>> {
    static V: OnceLock<Mutex<Vec<Voice>>> = OnceLock::new();
    V.get_or_init(|| Mutex::new(Vec::new()))
}

fn volume() -> &'static AtomicU32 {
    static V: OnceLock<AtomicU32> = OnceLock::new();
    V.get_or_init(|| AtomicU32::new(1.0f32.to_bits()))
}

fn check_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 64 {
        return Err("identifiant de son invalide".into());
    }
    Ok(())
}

/// Charge (ou recharge) un son ; renvoie sa durée en ms.
pub fn load(id: &str, path: &str) -> Result<u32, String> {
    check_id(id)?;
    let clip = decode(path)?;
    let ms = (clip.len() / 2 * 1000 / OUT_RATE as usize) as u32;
    lock(clips()).insert(id.to_string(), Arc::new(clip));
    Ok(ms)
}

pub fn unload(id: &str) {
    lock(clips()).remove(id);
}

/// Lance le son par-dessus ceux en cours.
pub fn play(id: &str, gain: f32) -> Result<(), String> {
    let clip = lock(clips()).get(id).cloned().ok_or("son introuvable")?;
    let mut v = lock(voices());
    if v.len() >= MAX_VOICES {
        v.remove(0);
    }
    v.push(Voice {
        clip,
        pos: 0,
        gain: gain.clamp(0.0, 2.0),
    });
    drop(v);
    crate::audio::wake_pump();
    Ok(())
}

pub fn stop_all() {
    lock(voices()).clear();
}

pub fn set_volume(v: f32) {
    volume().store(v.clamp(0.0, 2.0).to_bits(), Ordering::Relaxed);
}

/// Des sons sont en cours.
pub fn playing() -> bool {
    !lock(voices()).is_empty()
}

/// Mélange de toutes les voix pour `frames` échantillons stéréo (None = silence).
pub fn mix(frames: usize) -> Option<Vec<f32>> {
    let mut v = lock(voices());
    if v.is_empty() {
        return None;
    }
    let master = f32::from_bits(volume().load(Ordering::Relaxed));
    let mut out = vec![0.0f32; frames * 2];
    for voice in v.iter_mut() {
        let left = (voice.clip.len() - voice.pos).min(out.len());
        let g = voice.gain * master;
        for (o, s) in out[..left]
            .iter_mut()
            .zip(&voice.clip[voice.pos..voice.pos + left])
        {
            *o += s * g;
        }
        voice.pos += left;
    }
    v.retain(|voice| voice.pos < voice.clip.len());
    Some(out)
}

/// Décode un fichier audio en stéréo 48 kHz entrelacé.
fn decode(path: &str) -> Result<Vec<f32>, String> {
    use symphonia::core::audio::SampleBuffer;
    use symphonia::core::codecs::DecoderOptions;
    use symphonia::core::formats::FormatOptions;
    use symphonia::core::io::MediaSourceStream;
    use symphonia::core::meta::MetadataOptions;
    use symphonia::core::probe::Hint;

    let size = std::fs::metadata(path)
        .map_err(|e| format!("fichier illisible : {e}"))?
        .len();
    if size > MAX_FILE_BYTES {
        return Err("fichier trop lourd (25 Mo au plus)".into());
    }
    let file = std::fs::File::open(path).map_err(|e| format!("fichier illisible : {e}"))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
    {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|_| "format non pris en charge (mp3, wav, ogg, flac)".to_string())?;
    let mut format = probed.format;
    let track = format.default_track().ok_or("aucune piste audio")?;
    let track_id = track.id;
    let rate = track.codec_params.sample_rate.unwrap_or(OUT_RATE);
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|_| "codec non pris en charge".to_string())?;

    let max = MAX_SECONDS * rate as usize * 2;
    let mut pcm: Vec<f32> = Vec::new();
    while let Ok(packet) = format.next_packet() {
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(symphonia::core::errors::Error::DecodeError(_)) => continue,
            Err(_) => break,
        };
        let spec = *decoded.spec();
        let ch = spec.channels.count().max(1);
        let mut buf = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        buf.copy_interleaved_ref(decoded);
        for frame in buf.samples().chunks_exact(ch) {
            let l = frame[0];
            let r = if ch == 1 { l } else { frame[1] };
            pcm.push(l);
            pcm.push(r);
        }
        if pcm.len() >= max {
            return Err(format!("son trop long ({MAX_SECONDS} s au plus)"));
        }
    }
    if pcm.is_empty() {
        return Err("fichier vide ou illisible".into());
    }
    Ok(resample(&pcm, rate))
}

/// Rééchantillonnage linéaire stéréo vers 48 kHz (suffisant pour des sons courts).
fn resample(pcm: &[f32], rate: u32) -> Vec<f32> {
    if rate == OUT_RATE || rate == 0 {
        return pcm.to_vec();
    }
    let ratio = rate as f64 / OUT_RATE as f64;
    let frames_in = pcm.len() / 2;
    let frames_out = (frames_in as f64 / ratio) as usize;
    let mut out = Vec::with_capacity(frames_out * 2);
    for i in 0..frames_out {
        let pos = i as f64 * ratio;
        let a = pos.floor() as usize;
        let b = (a + 1).min(frames_in - 1);
        let f = (pos - a as f64) as f32;
        for ch in 0..2 {
            out.push(pcm[a * 2 + ch] + (pcm[b * 2 + ch] - pcm[a * 2 + ch]) * f);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn voix_superposées_sans_couper() {
        lock(clips()).insert("bip".into(), Arc::new(vec![0.25; 4800 * 2]));
        play("bip", 1.0).unwrap();
        let a = mix(1000).unwrap();
        assert!((a[0] - 0.25).abs() < 1e-6);
        // Deuxième lecture : la première continue, les deux s'additionnent.
        play("bip", 1.0).unwrap();
        let b = mix(1000).unwrap();
        assert!((b[0] - 0.5).abs() < 1e-6);
        // La première finit (4800 échantillons), la deuxième continue seule.
        let c = mix(3000).unwrap();
        assert!((c[2 * 2900] - 0.25).abs() < 1e-6);
        stop_all();
        assert!(mix(10).is_none());
        unload("bip");
        assert!(play("bip", 1.0).is_err());
    }

    #[test]
    fn rééchantillonnage_44k() {
        let pcm: Vec<f32> = (0..44100).flat_map(|_| [0.5, -0.5]).collect();
        let out = resample(&pcm, 44100);
        assert_eq!(out.len() / 2, 48000);
        assert!(out.iter().step_by(2).all(|&x| (x - 0.5).abs() < 1e-6));
    }

    #[test]
    fn fichier_absent_refusé() {
        assert!(load("x", "C:/n_existe_pas.wav").is_err());
        assert!(load("", "a.wav").is_err());
    }
}
