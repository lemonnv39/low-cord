//! Comptes Discord : gateway (WebSocket) + vocal (songbird, chiffrement DAVE).
//!
//! Plusieurs comptes peuvent tourner en même temps : chacun est une tâche sur
//! un runtime tokio partagé, identifiée par une clé choisie par low-cord
//! (l'id du compte dans le Token Importer). Les commandes visent un compte, ou
//! tous si aucun n'est précisé. L'état remonte par des événements `status`
//! portant la clé du compte (fusionnés dans un instantané par compte).

use std::collections::HashMap;
use std::num::NonZeroU64;
use std::sync::atomic::{AtomicI64, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Map, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use songbird::driver::Driver;
use songbird::id::{ChannelId, GuildId, UserId};
use songbird::input::RawAdapter;
use songbird::{Config, ConnectionInfo};

use crate::audio::{LiveSource, OUT_RATE};
use crate::lock;

const GATEWAY: &str = "wss://gateway.discord.gg/?v=10&encoding=json";
/// Garde-fou : nombre maximal de comptes connectés en même temps.
const MAX_ACCOUNTS: usize = 25;

/// Ordres vers la tâche d'un compte.
#[derive(Clone)]
enum Cmd {
    Join {
        guild: String,
        channel: String,
    },
    Leave,
    SetBitrate(i32),
    /// Compte à suivre (None = arrêter) et délai avant chaque déplacement (ms).
    SetFollow(Option<String>, u64),
    SetFakeDeafen(bool),
    Shutdown,
}

struct Session {
    cmd: mpsc::UnboundedSender<Cmd>,
    task: tokio::task::JoinHandle<()>,
}

/// Runtime partagé par tous les comptes (créé au premier besoin).
fn runtime() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(4)
            .thread_name("low-musical")
            .enable_all()
            .build()
            .expect("runtime tokio")
    })
}

fn sessions() -> &'static Mutex<HashMap<String, Session>> {
    static S: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Dernier état émis par compte, fusionné.
fn last_status() -> &'static Mutex<HashMap<String, Map<String, Value>>> {
    static S: OnceLock<Mutex<HashMap<String, Map<String, Value>>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Dernier état commun (erreurs de capture…), fusionné.
fn global_status() -> &'static Mutex<Map<String, Value>> {
    static S: OnceLock<Mutex<Map<String, Value>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(Map::new()))
}

/// Débit Opus (bits/s), commun à tous les comptes. Défaut 128 kbps.
fn bitrate_bps() -> &'static AtomicU32 {
    static B: OnceLock<AtomicU32> = OnceLock::new();
    B.get_or_init(|| AtomicU32::new(128_000))
}

fn merge(snap: &mut Map<String, Value>, obj: &Map<String, Value>) {
    for (k, v) in obj {
        snap.insert(k.clone(), v.clone());
    }
    // `current` n'existe qu'en vocal : purgé dès qu'on change d'état sans en fournir un neuf.
    if let Some(st) = obj.get("state").and_then(Value::as_str) {
        if st != "in_voice" && !obj.contains_key("current") {
            snap.remove("current");
        }
    }
}

/// État d'un compte.
pub fn emit(account: &str, payload: Value) {
    if let Some(obj) = payload.as_object() {
        merge(
            lock(last_status()).entry(account.to_string()).or_default(),
            obj,
        );
    }
    crate::proto::event(json!({ "event": "status", "account": account, "data": payload }));
}

/// État commun à tous les comptes (capture audio).
pub fn emit_global(payload: Value) {
    if let Some(obj) = payload.as_object() {
        merge(&mut lock(global_status()), obj);
    }
    crate::proto::event(json!({ "event": "status", "data": payload }));
}

pub fn status() -> Value {
    let mut map = lock(global_status()).clone();
    crate::audio::snapshot(&mut map);
    map.insert(
        "bitrate".into(),
        json!(bitrate_bps().load(Ordering::Relaxed) / 1000),
    );
    let live = lock(sessions());
    let accounts: Map<String, Value> = lock(last_status())
        .iter()
        .filter(|(k, _)| live.contains_key(*k))
        .map(|(k, v)| (k.clone(), Value::Object(v.clone())))
        .collect();
    map.insert("accounts".into(), Value::Object(accounts));
    Value::Object(map)
}

// ── Commandes ───────────────────────────────────────────────────────────────

fn check_key(account: &str) -> Result<(), String> {
    if account.is_empty() || account.len() > 64 {
        return Err("clé de compte invalide".into());
    }
    Ok(())
}

/// Connecte un compte (le remplace s'il l'était déjà). `properties` = identité
/// du client Discord à annoncer (celle du vrai Discord, fournie par low-cord).
pub fn connect(account: String, token: String, properties: Option<Value>) -> Result<(), String> {
    check_key(&account)?;
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("Token vide.".into());
    }
    let properties = properties.filter(Value::is_object);

    let mut all = lock(sessions());
    // Les comptes arrêtés d'eux-mêmes (token invalide…) ne comptent pas.
    all.retain(|_, s| !s.task.is_finished());
    if let Some(old) = all.remove(&account) {
        let _ = old.cmd.send(Cmd::Shutdown);
    } else if all.len() >= MAX_ACCOUNTS {
        return Err(format!("{MAX_ACCOUNTS} comptes au maximum"));
    }
    lock(last_status()).remove(&account);

    let (tx, rx) = mpsc::unbounded_channel::<Cmd>();
    let key = account.clone();
    let task = runtime().spawn(async move {
        engine_main(key.clone(), token, properties, rx).await;
        emit(&key, json!({ "state": "disconnected" }));
    });
    all.insert(account, Session { cmd: tx, task });
    Ok(())
}

/// Envoie un ordre à un compte, ou à tous (`None`).
fn send_to(account: Option<&str>, cmd: Cmd) -> Result<(), String> {
    let all = lock(sessions());
    match account {
        Some(key) => match all.get(key) {
            Some(s) => s.cmd.send(cmd).map_err(|_| "compte arrêté".to_string()),
            None => Err("compte non connecté".into()),
        },
        None => {
            let mut sent = false;
            for s in all.values() {
                sent |= s.cmd.send(cmd.clone()).is_ok();
            }
            if sent {
                Ok(())
            } else {
                Err("aucun compte connecté".into())
            }
        }
    }
}

pub fn join(account: Option<String>, guild: String, channel: String) -> Result<(), String> {
    for id in [&guild, &channel] {
        if id.parse::<u64>().map_or(true, |n| n == 0) {
            return Err(format!("identifiant invalide : {id}"));
        }
    }
    send_to(account.as_deref(), Cmd::Join { guild, channel })
}

pub fn leave(account: Option<String>) -> Result<(), String> {
    send_to(account.as_deref(), Cmd::Leave)
}

/// Déconnecte un compte, ou tous.
pub fn disconnect(account: Option<String>) -> Result<(), String> {
    let mut all = lock(sessions());
    let keys: Vec<String> = match account {
        Some(k) => vec![k],
        None => all.keys().cloned().collect(),
    };
    for k in keys {
        if let Some(s) = all.remove(&k) {
            let _ = s.cmd.send(Cmd::Shutdown);
        }
    }
    Ok(())
}

/// Arrêt complet (fin du processus) : laisse aux comptes le temps de quitter le vocal.
pub fn shutdown_and_wait(max: std::time::Duration) {
    let all: Vec<Session> = lock(sessions()).drain().map(|(_, s)| s).collect();
    for s in &all {
        let _ = s.cmd.send(Cmd::Shutdown);
    }
    let deadline = std::time::Instant::now() + max;
    while all.iter().any(|s| !s.task.is_finished()) && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

/// Débit Opus (kbps, borné 8..512), commun à tous les comptes, appliqué à chaud.
pub fn set_bitrate(kbps: u32) -> Result<(), String> {
    let bps = kbps.clamp(8, 512) * 1000;
    bitrate_bps().store(bps, Ordering::Relaxed);
    let _ = send_to(None, Cmd::SetBitrate(bps as i32));
    Ok(())
}

/// Suit un compte (id décimal) : rejoint son salon vocal et le suit
/// (serveurs partagés uniquement). None = on arrête de suivre, on reste sur place.
/// `delay_ms` : attente avant chaque déplacement, pour espacer les comptes.
pub fn set_follow(
    account: Option<String>,
    target: Option<String>,
    delay_ms: u64,
) -> Result<(), String> {
    if let Some(t) = &target {
        if t.parse::<u64>().is_err() {
            return Err(format!("identifiant invalide : {t}"));
        }
    }
    send_to(
        account.as_deref(),
        Cmd::SetFollow(target, delay_ms.min(60_000)),
    )
}

/// Faux sourd : le compte s'annonce sourd (self_deaf) mais continue d'émettre.
pub fn set_fake_deafen(account: Option<String>, on: bool) -> Result<(), String> {
    send_to(account.as_deref(), Cmd::SetFakeDeafen(on))
}

// ── Boucle du moteur ───────────────────────────────────────────────────────

enum Outcome {
    Reconnect,     // reprendre la session (RESUME)
    Reidentify,    // repartir de zéro (IDENTIFY)
    Fatal(String), // arrêt définitif (token invalide…)
    Shutdown,      // arrêt demandé
}

/// État conservé entre reconnexions.
struct Persist {
    our_uid: Option<String>,
    session_id: Option<String>, // session GATEWAY, pour RESUME (≠ session vocale)
    resume_url: Option<String>,
    seq: Arc<AtomicI64>,
    current: Option<(String, String)>, // salon vocal confirmé, à re-rejoindre
    follow: Option<String>,
    follow_delay: u64,
    properties: Option<Value>,
    /// clé du compte (pour ses événements)
    key: String,
    fake_deafen: bool,
}

/// Boucle de reconnexion avec attente exponentielle. Ne s'arrête que sur
/// erreur fatale ou demande.
async fn engine_main(
    key: String,
    token: String,
    properties: Option<Value>,
    mut cmd_rx: mpsc::UnboundedReceiver<Cmd>,
) {
    let mut st = Persist {
        our_uid: None,
        session_id: None,
        resume_url: None,
        seq: Arc::new(AtomicI64::new(-1)),
        current: None,
        follow: None,
        follow_delay: 0,
        properties,
        key,
        fake_deafen: false,
    };
    let mut driver = Driver::new(Config::default());
    let mut backoff_ms: u64 = 1000;
    const BACKOFF_MAX: u64 = 30_000;

    emit(&st.key, json!({ "state": "connecting" }));

    loop {
        let resuming = st.session_id.is_some() && st.resume_url.is_some();
        let url = match (&st.resume_url, resuming) {
            (Some(u), true) => u.clone(),
            _ => GATEWAY.to_string(),
        };

        let outcome = match connect_async(url.as_str()).await {
            Ok((ws, _)) => {
                run_session(
                    &token,
                    &mut cmd_rx,
                    &mut st,
                    &mut driver,
                    ws,
                    resuming,
                    &mut backoff_ms,
                )
                .await
            }
            Err(e) => {
                emit(
                    &st.key,
                    json!({ "state": "reconnecting", "error": format!("connexion : {e}") }),
                );
                Outcome::Reconnect
            }
        };

        match outcome {
            Outcome::Shutdown => break,
            Outcome::Fatal(reason) => {
                emit(&st.key, json!({ "state": "error", "error": reason }));
                break;
            }
            Outcome::Reidentify | Outcome::Reconnect => {
                if matches!(outcome, Outcome::Reidentify) {
                    st.session_id = None;
                    st.resume_url = None;
                    st.seq.store(-1, Ordering::SeqCst);
                }
                emit(&st.key, json!({ "state": "reconnecting" }));
                if wait_backoff(&mut cmd_rx, &mut st, backoff_ms).await {
                    break;
                }
                backoff_ms = backoff_ms.saturating_mul(2).min(BACKOFF_MAX);
            }
        }
    }
    driver.leave();
}

/// Attend avant de reconnecter, sans devenir sourd aux commandes.
/// Renvoie true si l'arrêt a été demandé.
async fn wait_backoff(
    cmd_rx: &mut mpsc::UnboundedReceiver<Cmd>,
    st: &mut Persist,
    ms: u64,
) -> bool {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(ms);
    loop {
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => return false,
            cmd = cmd_rx.recv() => match cmd {
                Some(Cmd::Shutdown) | None => return true,
                Some(Cmd::Join { guild, channel }) => st.current = Some((guild, channel)),
                Some(Cmd::Leave) => st.current = None,
                Some(Cmd::SetFollow(t, delay)) => {
                    st.follow = t;
                    st.follow_delay = delay;
                }
                // Valeurs déjà enregistrées, appliquées à la reconnexion.
                Some(Cmd::SetFakeDeafen(on)) => st.fake_deafen = on,
                Some(Cmd::SetBitrate(_)) => {}
            },
        }
    }
}

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Une session gateway : IDENTIFY ou RESUME, battements de cœur (avec
/// détection de connexion morte), événements, commandes.
#[allow(clippy::too_many_arguments)]
async fn run_session(
    token: &str,
    cmd_rx: &mut mpsc::UnboundedReceiver<Cmd>,
    st: &mut Persist,
    driver: &mut Driver,
    ws: Ws,
    resuming: bool,
    backoff_ms: &mut u64,
) -> Outcome {
    let (mut write, mut read) = ws.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Message>();
    let writer = tokio::spawn(async move {
        while let Some(m) = out_rx.recv().await {
            if write.send(m).await.is_err() {
                break;
            }
        }
        let _ = write.close().await;
    });
    let send = |m: String| {
        let _ = out_tx.send(Message::Text(m));
    };

    let mut hb_period = std::time::Duration::from_secs(3600);
    let mut next_hb = tokio::time::Instant::now() + hb_period;
    let mut awaiting_ack = false;

    // Poignée de main vocale (session VOCALE ≠ session gateway).
    let mut pending: Option<(String, String)> = None;
    let mut voice_session: Option<String> = None;
    let mut vendpoint: Option<String> = None;
    let mut vtoken: Option<String> = None;

    // Qui est dans quel salon (user_id → (serveur, salon)), pour le suivi.
    let mut voice_map: std::collections::HashMap<String, (String, String)> = Default::default();
    let mut guild_ids: Vec<String> = Vec::new();

    // Suivi : déplacement prévu (salon, échéance), après le délai du compte.
    let mut follow_due: Option<((String, String), tokio::time::Instant)> = None;
    let far = || tokio::time::Instant::now() + std::time::Duration::from_secs(3600);

    // Rejoindre un salon : on repart d'une poignée de main vierge.
    macro_rules! go_to {
        ($g:expr, $c:expr) => {{
            let (g, c): (String, String) = ($g, $c);
            send(join_voice(&g, &c, st.fake_deafen));
            pending = Some((g, c));
            voice_session = None;
            vendpoint = None;
            vtoken = None;
        }};
    }

    // Suivre la cible dans un salon : tout de suite, ou après le délai du compte.
    macro_rules! follow_to {
        ($g:expr, $c:expr) => {{
            let tgt: (String, String) = ($g, $c);
            let already = st.current.as_ref() == Some(&tgt)
                || pending.as_ref() == Some(&tgt)
                || follow_due.as_ref().map(|(t, _)| t) == Some(&tgt);
            if !already {
                if st.follow_delay == 0 {
                    follow_due = None;
                    go_to!(tgt.0, tgt.1);
                } else {
                    let at = tokio::time::Instant::now()
                        + std::time::Duration::from_millis(st.follow_delay);
                    follow_due = Some((tgt, at));
                }
            }
        }};
    }

    let outcome = loop {
        tokio::select! {
            maybe_msg = read.next() => {
                let txt = match maybe_msg {
                    Some(Ok(Message::Text(t))) => t,
                    Some(Ok(Message::Ping(p))) => { let _ = out_tx.send(Message::Pong(p)); continue; }
                    Some(Ok(Message::Close(frame))) => {
                        let code = frame.as_ref().map(|f| u16::from(f.code)).unwrap_or(0);
                        break if is_fatal_close(code) { Outcome::Fatal(fatal_reason(code)) } else { Outcome::Reconnect };
                    }
                    Some(Ok(_)) => continue,
                    Some(Err(_)) | None => break Outcome::Reconnect,
                };
                let v: Value = match serde_json::from_str(&txt) { Ok(v) => v, Err(_) => continue };
                if let Some(s) = v.get("s").and_then(Value::as_i64) { st.seq.store(s, Ordering::SeqCst); }

                match v.get("op").and_then(Value::as_i64).unwrap_or(-1) {
                    10 => {
                        let ms = v["d"]["heartbeat_interval"].as_f64().unwrap_or(41250.0);
                        hb_period = std::time::Duration::from_millis(ms as u64);
                        // Premier battement après un délai réduit (recommandation Discord).
                        next_hb = tokio::time::Instant::now() + std::time::Duration::from_millis((ms * 0.5) as u64);
                        awaiting_ack = false;
                        send(match (resuming, &st.session_id) {
                            (true, Some(sid)) => resume(token, sid, st.seq.load(Ordering::SeqCst)),
                            _ => identify(token, st.properties.as_ref()),
                        });
                    }
                    1 => {
                        send(heartbeat(st.seq.load(Ordering::SeqCst)));
                        awaiting_ack = true;
                    }
                    11 => awaiting_ack = false,
                    7 => break Outcome::Reconnect,
                    9 => break if v["d"].as_bool().unwrap_or(false) { Outcome::Reconnect } else { Outcome::Reidentify },
                    0 => match v.get("t").and_then(Value::as_str).unwrap_or("") {
                        "READY" => {
                            *backoff_ms = 1000;
                            let d = &v["d"];
                            st.our_uid = d["user"]["id"].as_str().map(String::from);
                            st.session_id = d["session_id"].as_str().map(String::from);
                            st.resume_url = d["resume_gateway_url"].as_str().map(String::from);
                            emit(&st.key, json!({
                                "state": "connected",
                                "user": {
                                    "id": st.our_uid,
                                    "username": d["user"]["username"].as_str().unwrap_or("?"),
                                    "avatar": d["user"]["avatar"],
                                },
                                "guilds": parse_guilds(&d["guilds"]),
                                "follow": st.follow,
                                "fakeDeafen": st.fake_deafen,
                            }));
                            seed_voice_map(&mut voice_map, &d["guilds"]);
                            guild_ids = collect_guild_ids(&d["guilds"]);
                            // Suivi : il faut s'abonner aux serveurs pour recevoir
                            // les mouvements vocaux hors de notre salon.
                            if st.follow.is_some() {
                                for g in &guild_ids { send(guild_subscribe(g)); }
                            }
                            // Après (ré)identification : on se cale sur la cible
                            // suivie, sinon on revient dans le salon courant.
                            if let Some(f) = st.follow.clone() {
                                if let Some((g, c)) = voice_map.get(&f).cloned() {
                                    st.current = None;
                                    follow_to!(g, c);
                                }
                            } else if let Some((g, c)) = st.current.clone() {
                                go_to!(g, c);
                            }
                        }
                        "RESUMED" => {
                            *backoff_ms = 1000;
                            if let Some((g, c)) = st.current.clone() {
                                emit(&st.key, json!({ "state": "in_voice", "current": { "guild": g, "channel": c } }));
                                go_to!(g, c);
                            } else {
                                emit(&st.key, json!({ "state": "connected" }));
                            }
                        }
                        "VOICE_STATE_UPDATE" => {
                            let d = &v["d"];
                            let uid = d["user_id"].as_str().map(String::from);
                            let chan = d["channel_id"].as_str().map(String::from);
                            let gid = d["guild_id"].as_str().unwrap_or("").to_string();

                            if uid.is_some() && uid == st.our_uid {
                                voice_session = d["session_id"].as_str().map(String::from);
                            }
                            if let Some(u) = uid.clone() {
                                match chan.clone() {
                                    Some(c) if !gid.is_empty() => { voice_map.insert(u, (gid.clone(), c)); }
                                    _ => { voice_map.remove(&u); }
                                }
                            }
                            // Suivi : la cible bouge → on la suit.
                            if st.follow.is_some() && uid == st.follow {
                                match chan {
                                    Some(c) if !gid.is_empty() => follow_to!(gid, c),
                                    _ => {
                                        // La cible a quitté le vocal → on quitte aussi.
                                        follow_due = None;
                                        if let Some((g, _)) = st.current.take() {
                                            send(leave_voice(&g));
                                            driver.leave();
                                            emit(&st.key, json!({ "state": "connected_left" }));
                                        }
                                        pending = None;
                                    }
                                }
                            }
                        }
                        "VOICE_SERVER_UPDATE" => {
                            vendpoint = v["d"]["endpoint"].as_str().map(String::from);
                            vtoken = v["d"]["token"].as_str().map(String::from);
                        }
                        _ => {}
                    },
                    _ => {}
                }

                // Poignée de main vocale complète → connexion songbird.
                if let (Some((g, c)), Some(s), Some(ep), Some(tk), Some(uid)) =
                    (pending.clone(), voice_session.clone(), vendpoint.clone(), vtoken.clone(), st.our_uid.clone())
                {
                    if ep_ready(&ep) {
                        match build_conn(&g, &c, &uid, ep, s, tk) {
                            Ok(info) => match driver.connect(info).await {
                                Ok(()) => {
                                    st.current = Some((g.clone(), c.clone()));
                                    driver.play_only_input(RawAdapter::new(LiveSource::new(), OUT_RATE, 2).into());
                                    driver.set_bitrate(songbird::driver::Bitrate::Bits(
                                        bitrate_bps().load(Ordering::Relaxed) as i32,
                                    ));
                                    emit(&st.key, json!({ "state": "in_voice", "current": { "guild": g, "channel": c } }));
                                }
                                Err(e) => emit(&st.key, json!({ "state": "error", "error": format!("connexion vocale : {e:?}") })),
                            },
                            Err(e) => emit(&st.key, json!({ "state": "error", "error": e })),
                        }
                        pending = None;
                        voice_session = None;
                        vendpoint = None;
                        vtoken = None;
                    }
                }
            }

            _ = tokio::time::sleep_until(next_hb) => {
                if awaiting_ack {
                    // Aucun accusé depuis le dernier battement → connexion morte.
                    break Outcome::Reconnect;
                }
                send(heartbeat(st.seq.load(Ordering::SeqCst)));
                awaiting_ack = true;
                next_hb = tokio::time::Instant::now() + hb_period;
            }

            // Déplacement de suivi arrivé à échéance.
            _ = tokio::time::sleep_until(follow_due.as_ref().map_or_else(far, |d| d.1)), if follow_due.is_some() => {
                if let Some(((g, c), _)) = follow_due.take() {
                    if st.follow.is_some() && st.current.as_ref() != Some(&(g.clone(), c.clone())) {
                        go_to!(g, c);
                    }
                }
            }

            maybe_cmd = cmd_rx.recv() => match maybe_cmd {
                Some(Cmd::Join { guild, channel }) => go_to!(guild, channel),
                Some(Cmd::Leave) => {
                    if let Some((g, _)) = st.current.take() {
                        send(leave_voice(&g));
                        driver.leave();
                        emit(&st.key, json!({ "state": "connected_left" }));
                    }
                    pending = None;
                }
                Some(Cmd::SetBitrate(bps)) => driver.set_bitrate(songbird::driver::Bitrate::Bits(bps)),
                Some(Cmd::SetFollow(target, delay)) => {
                    st.follow = target.clone();
                    st.follow_delay = delay;
                    follow_due = None;
                    if let Some(t) = &target {
                        for g in &guild_ids { send(guild_subscribe(g)); }
                        if let Some((g, c)) = voice_map.get(t).cloned() {
                            follow_to!(g, c);
                        }
                    }
                    // Arrêter de suivre ne quitte pas le vocal.
                    emit(&st.key, json!({ "follow": st.follow }));
                }
                Some(Cmd::SetFakeDeafen(on)) => {
                    st.fake_deafen = on;
                    // Ré-annonce l'état vocal sur le salon courant pour appliquer à chaud.
                    if let Some((g, c)) = st.current.clone() { send(join_voice(&g, &c, on)); }
                    emit(&st.key, json!({ "fakeDeafen": on }));
                }
                Some(Cmd::Shutdown) | None => {
                    // On quitte le vocal proprement (sinon le compte y reste
                    // affiché jusqu'à ce que Discord constate la coupure).
                    if let Some((g, _)) = st.current.take() {
                        send(leave_voice(&g));
                    }
                    driver.leave();
                    break Outcome::Shutdown;
                }
            },
        }
    };

    // Laisse partir les derniers messages (sortie du vocal) puis ferme.
    drop(out_tx);
    let _ = tokio::time::timeout(std::time::Duration::from_millis(1500), writer).await;
    outcome
}

/// Codes de fermeture définitifs (inutile de reconnecter).
fn is_fatal_close(code: u16) -> bool {
    matches!(code, 4004 | 4010 | 4011 | 4012 | 4013 | 4014)
}

fn fatal_reason(code: u16) -> String {
    match code {
        4004 => "Token invalide ou expiré.".into(),
        4013 | 4014 => "Connexion refusée par Discord.".into(),
        _ => format!("Fermeture définitive (code {code})."),
    }
}

fn heartbeat(seq: i64) -> String {
    json!({ "op": 1, "d": if seq < 0 { Value::Null } else { json!(seq) } }).to_string()
}

fn resume(token: &str, session_id: &str, seq: i64) -> String {
    json!({ "op": 6, "d": { "token": token, "session_id": session_id, "seq": seq.max(0) } })
        .to_string()
}

/// L'endpoint peut arriver `null` un instant : on attend un vrai endpoint.
fn ep_ready(ep: &str) -> bool {
    !ep.is_empty() && ep != "null"
}

fn build_conn(
    guild: &str,
    channel: &str,
    uid: &str,
    endpoint: String,
    session: String,
    token: String,
) -> Result<ConnectionInfo, String> {
    let id = |s: &str, what: &str| {
        s.parse::<u64>()
            .ok()
            .and_then(NonZeroU64::new)
            .ok_or(format!("{what} invalide"))
    };
    Ok(ConnectionInfo {
        channel_id: ChannelId(id(channel, "salon")?),
        guild_id: GuildId(id(guild, "serveur")?),
        user_id: UserId(id(uid, "compte")?),
        endpoint,
        session_id: session,
        token,
    })
}

/// Serveurs + salons vocaux (types 2 vocal, 13 conférence) depuis le READY.
fn parse_guilds(guilds: &Value) -> Vec<Value> {
    let Some(arr) = guilds.as_array() else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|g| {
            let gid = g["id"].as_str().filter(|s| !s.is_empty())?;
            let name = g["name"].as_str().or_else(|| g["properties"]["name"].as_str()).unwrap_or("Serveur");
            let icon = g["icon"].as_str().or_else(|| g["properties"]["icon"].as_str());
            let mut chans: Vec<(i64, Value)> = g["channels"]
                .as_array()
                .map(|c| {
                    c.iter()
                        .filter(|c| matches!(c["type"].as_i64(), Some(2) | Some(13)))
                        .map(|c| {
                            (
                                c["position"].as_i64().unwrap_or(0),
                                json!({ "id": c["id"].as_str().unwrap_or(""), "name": c["name"].as_str().unwrap_or("vocal") }),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default();
            if chans.is_empty() {
                return None;
            }
            chans.sort_by_key(|(p, _)| *p);
            Some(json!({ "id": gid, "name": name, "icon": icon, "channels": chans.into_iter().map(|(_, c)| c).collect::<Vec<_>>() }))
        })
        .collect()
}

/// Cache des états vocaux depuis le READY. Ici `guild_id` n'est pas dans
/// chaque état vocal : on le prend sur le serveur.
fn seed_voice_map(map: &mut std::collections::HashMap<String, (String, String)>, guilds: &Value) {
    map.clear();
    for g in guilds.as_array().into_iter().flatten() {
        let Some(gid) = g["id"].as_str() else {
            continue;
        };
        for vs in g["voice_states"].as_array().into_iter().flatten() {
            if let (Some(u), Some(c)) = (vs["user_id"].as_str(), vs["channel_id"].as_str()) {
                map.insert(u.to_string(), (gid.to_string(), c.to_string()));
            }
        }
    }
}

fn collect_guild_ids(guilds: &Value) -> Vec<String> {
    guilds
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|g| g["id"].as_str().map(String::from))
        .collect()
}

/// Identité par défaut, utilisée seulement si low-cord n'a pas fourni celle
/// du vrai Discord.
/// (Reprise telle quelle de WalkerCord, déjà éprouvée.)
fn default_properties() -> Value {
    json!({
        "os": "Windows", "browser": "Chrome", "device": "",
        "system_locale": "fr-FR",
        "browser_user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "browser_version": "125.0.0.0", "os_version": "10",
        "referrer": "", "referring_domain": "",
        "referrer_current": "", "referring_domain_current": "",
        "release_channel": "stable", "client_build_number": 300000,
        "client_event_source": null
    })
}

fn identify(token: &str, properties: Option<&Value>) -> String {
    json!({
        "op": 2,
        "d": {
            "token": token,
            "capabilities": 16381,
            "properties": properties.cloned().unwrap_or_else(default_properties),
            "presence": { "status": "online", "since": 0, "activities": [], "afk": false },
            "compress": false,
            "client_state": {
                "guild_versions": {}, "highest_last_message_id": "0",
                "read_state_version": 0, "user_guild_settings_version": -1,
                "user_settings_version": -1, "private_channels_version": "0",
                "api_code_version": 0
            }
        }
    })
    .to_string()
}

fn join_voice(guild: &str, channel: &str, deaf: bool) -> String {
    // Faux sourd : self_deaf seulement, jamais self_mute (la diffusion continue).
    json!({ "op": 4, "d": { "guild_id": guild, "channel_id": channel, "self_mute": false, "self_deaf": deaf, "self_video": false } })
        .to_string()
}

fn leave_voice(guild: &str) -> String {
    json!({ "op": 4, "d": { "guild_id": guild, "channel_id": Value::Null, "self_mute": false, "self_deaf": false, "self_video": false } })
        .to_string()
}

/// Abonnement à un serveur (op 14) : sans lui, un compte utilisateur ne reçoit
/// pas les mouvements vocaux des serveurs où il n'est pas en vocal. Le client
/// officiel envoie le même en ouvrant un serveur.
fn guild_subscribe(guild: &str) -> String {
    json!({ "op": 14, "d": { "guild_id": guild, "typing": true, "activities": true, "threads": false } }).to_string()
}
