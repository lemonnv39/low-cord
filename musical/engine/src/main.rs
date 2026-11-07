//! low-musical — moteur audio (reprise du moteur WalkerCord).
//!
//! Un compte se connecte au gateway Discord avec son token, rejoint un salon
//! vocal et y DIFFUSE de l'audio (émission seule) : capture d'un périphérique
//! d'entrée → gain → 8D → réverbe → égaliseur → Opus (songbird, chiffrement
//! DAVE inclus).
//!
//! Protocole avec low-cord, par l'entrée/sortie standard, une ligne JSON par
//! message :
//!   entrée  : {"id": 1, "cmd": "join", "guild": "…", "channel": "…"}
//!   réponse : {"id": 1, "ok": true, "result": …} ou {"id": 1, "ok": false, "error": "…"}
//!   événement : {"event": "status", "data": {…}}   (état du compte, erreurs)
//! Le token n'est jamais écrit ni renvoyé. Entrée fermée (Discord fermé ou
//! planté) = on quitte le vocal et on s'arrête.
//!
//! Client tiers en token utilisateur : à utiliser avec des comptes dédiés.

mod audio;
mod engine;
mod proto;

use serde_json::{json, Value};
use std::io::BufRead;
use std::sync::{Mutex, MutexGuard};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Verrou qui survit à un fil planté (un panic ne doit pas bloquer tout le moteur).
pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn main() {
    if std::env::args().any(|a| a == "--version") {
        println!("{VERSION}");
        return;
    }

    proto::event(json!({ "event": "hello", "version": VERSION }));

    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let req: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                proto::reply(Value::Null, Err(format!("JSON invalide : {e}")));
                continue;
            }
        };
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        let cmd = req
            .get("cmd")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if cmd == "shutdown" {
            proto::reply(id, Ok(Value::Null));
            break;
        }
        let res = std::panic::catch_unwind(|| dispatch(&cmd, &req))
            .unwrap_or_else(|_| Err("erreur interne du moteur".into()));
        proto::reply(id, res);
    }

    // Entrée fermée ou arrêt demandé : on quitte proprement le vocal.
    engine::shutdown_and_wait(std::time::Duration::from_secs(2));
    audio::stop_capture();
}

fn text(r: &Value, k: &str) -> Option<String> {
    r.get(k)
        .and_then(Value::as_str)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn need(r: &Value, k: &str) -> Result<String, String> {
    text(r, k).ok_or_else(|| format!("paramètre manquant : {k}"))
}

fn num(r: &Value, k: &str) -> Result<f64, String> {
    match r.get(k).and_then(Value::as_f64) {
        Some(x) if x.is_finite() => Ok(x),
        _ => Err(format!("nombre attendu : {k}")),
    }
}

fn flag(r: &Value, k: &str) -> Result<bool, String> {
    r.get(k)
        .and_then(Value::as_bool)
        .ok_or_else(|| format!("booléen attendu : {k}"))
}

fn dispatch(cmd: &str, r: &Value) -> Result<Value, String> {
    let done = |res: Result<(), String>| res.map(|_| Value::Null);
    match cmd {
        "version" => Ok(json!(VERSION)),
        "status" => Ok(engine::status()),
        "devices" => Ok(json!(audio::devices())),

        // Compte
        "connect" => done(engine::connect(
            need(r, "token")?,
            r.get("properties").cloned(),
        )),
        "disconnect" => done(engine::disconnect()),
        "join" => done(engine::join(need(r, "guild")?, need(r, "channel")?)),
        "leave" => done(engine::leave()),
        "set_follow" => done(engine::set_follow(text(r, "target"))),
        "set_fake_deafen" => done(engine::set_fake_deafen(flag(r, "on")?)),
        "set_presence" => done(engine::set_presence(flag(r, "on")?)),
        "set_bitrate" => done(engine::set_bitrate(num(r, "kbps")? as u32)),

        // Audio
        "set_input" => done(audio::set_input(text(r, "name"))),
        "set_gain" => {
            audio::set_gain(num(r, "db")? as f32);
            Ok(Value::Null)
        }
        "set_latency" => {
            audio::set_latency(num(r, "ms")? as u32);
            Ok(Value::Null)
        }
        "set_8d" => {
            audio::set_8d(
                num(r, "mode")? as u8,
                num(r, "speed")? as f32,
                num(r, "position")? as f32,
            );
            Ok(Value::Null)
        }
        "set_reverb" => {
            audio::set_reverb(flag(r, "on")?);
            Ok(Value::Null)
        }
        "set_reverb_params" => {
            audio::set_reverb_params(num(r, "room")? as f32, num(r, "distance")? as f32);
            Ok(Value::Null)
        }
        "set_eq" => {
            let bands = r
                .get("bands")
                .and_then(Value::as_array)
                .ok_or("tableau attendu : bands")?
                .iter()
                .map(|v| {
                    v.as_f64()
                        .filter(|x| x.is_finite())
                        .map(|x| x as f32)
                        .ok_or("bande invalide")
                })
                .collect::<Result<Vec<f32>, _>>()?;
            audio::set_eq(bands);
            Ok(Value::Null)
        }

        _ => Err(format!("commande inconnue : {cmd}")),
    }
}
