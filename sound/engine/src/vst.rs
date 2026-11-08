//! Plugins VST2 pour le Mini APO (commande `VSTPlugin` d'Equalizer APO).
//!
//! Chaque plugin tourne dans son propre processus : le moteur se relance
//! lui-même avec `--vst-host` et lui parle par ses entrée / sortie (messages
//! binaires). Si un plugin plante ou ne répond plus, seul ce processus
//! s'arrête : la diffusion continue, sans le plugin.
//!
//! Comme APO :
//!  - `ChunkData` (base64) est donné au plugin tel quel (effSetChunk, preset) ;
//!    sinon, les paramètres nommés sont appliqués par leur nom ;
//!  - un plugin stéréo traite les deux canaux, un plugin mono est dupliqué
//!    (une copie par canal) ;
//!  - le plugin reçoit 48 kHz et des blocs de 4096 échantillons au plus.
//!
//! Les plugins ne sont chargés que depuis le dossier VST de low-sound
//! (chemin vérifié par low-cord), jamais automatiquement.
//!
//! Le panneau du plugin (son interface) s'ouvre dans une fenêtre Windows de
//! ce même processus, comme le bouton « Open panel » d'APO ; ses réglages sont
//! relus ensuite (ChunkData) pour être gardés dans le set.

use std::collections::BTreeMap;
use std::ffi::{c_char, c_void, CStr};
use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use base64::Engine as _;
use serde_json::{json, Value};

use crate::audio::OUT_RATE;
use crate::lock;

const MAX_BLOCK: usize = 4096;

// ── Interface binaire VST2 ──────────────────────────────────────────────────

const MAGIC: i32 = i32::from_be_bytes(*b"VstP");
const FLAG_HAS_EDITOR: i32 = 1;
const FLAG_CAN_REPLACING: i32 = 1 << 4;
const FLAG_PROGRAM_CHUNKS: i32 = 1 << 5;

const EFF_OPEN: i32 = 0;
const EFF_CLOSE: i32 = 1;
const EFF_GET_PARAM_LABEL: i32 = 6;
const EFF_GET_PARAM_DISPLAY: i32 = 7;
const EFF_GET_PARAM_NAME: i32 = 8;
const EFF_SET_SAMPLE_RATE: i32 = 10;
const EFF_SET_BLOCK_SIZE: i32 = 11;
const EFF_MAINS_CHANGED: i32 = 12;
const EFF_GET_CHUNK: i32 = 23;
const EFF_SET_CHUNK: i32 = 24;
const EFF_GET_EFFECT_NAME: i32 = 45;
const EFF_GET_VENDOR_STRING: i32 = 47;
const EFF_GET_PRODUCT_STRING: i32 = 48;
const EFF_START_PROCESS: i32 = 71;
const EFF_STOP_PROCESS: i32 = 72;

const AM_VERSION: i32 = 1;
const AM_CURRENT_ID: i32 = 2;
const AM_GET_SAMPLE_RATE: i32 = 16;
const AM_GET_BLOCK_SIZE: i32 = 17;
const AM_GET_VENDOR_STRING: i32 = 32;
const AM_GET_PRODUCT_STRING: i32 = 33;
const AM_GET_VENDOR_VERSION: i32 = 34;
const AM_CAN_DO: i32 = 37;
const AM_WILL_REPLACE_OR_ACCUMULATE: i32 = 39;
const AM_SIZE_WINDOW: i32 = 15;
const EFF_EDIT_GET_RECT: i32 = 13;
const EFF_EDIT_OPEN: i32 = 14;
const EFF_EDIT_CLOSE: i32 = 15;
const EFF_EDIT_IDLE: i32 = 19;

type Dispatcher = extern "C" fn(*mut AEffect, i32, i32, isize, *mut c_void, f32) -> isize;
type ProcessFn = extern "C" fn(*mut AEffect, *mut *mut f32, *mut *mut f32, i32);
type SetParamFn = extern "C" fn(*mut AEffect, i32, f32);
type GetParamFn = extern "C" fn(*mut AEffect, i32) -> f32;
pub type HostCallback = extern "C" fn(*mut AEffect, i32, i32, isize, *mut c_void, f32) -> isize;
pub type EntryFn = extern "C" fn(HostCallback) -> *mut AEffect;

#[repr(C)]
pub struct AEffect {
    pub magic: i32,
    pub dispatcher: Option<Dispatcher>,
    pub process: Option<ProcessFn>,
    pub set_parameter: Option<SetParamFn>,
    pub get_parameter: Option<GetParamFn>,
    pub num_programs: i32,
    pub num_params: i32,
    pub num_inputs: i32,
    pub num_outputs: i32,
    pub flags: i32,
    pub resvd1: isize,
    pub resvd2: isize,
    pub initial_delay: i32,
    pub real_qualities: i32,
    pub off_qualities: i32,
    pub io_ratio: f32,
    pub object: *mut c_void,
    pub user: *mut c_void,
    pub unique_id: i32,
    pub version: i32,
    pub process_replacing: Option<ProcessFn>,
    pub process_double_replacing:
        Option<extern "C" fn(*mut AEffect, *mut *mut f64, *mut *mut f64, i32)>,
    pub future: [u8; 56],
}

/// Ce que l'hôte répond au plugin (mêmes réponses qu'APO, ou presque).
extern "C" fn host_callback(
    _: *mut AEffect,
    opcode: i32,
    index: i32,
    value: isize,
    ptr: *mut c_void,
    _: f32,
) -> isize {
    let copy = |text: &[u8]| {
        if !ptr.is_null() {
            // Les chaînes VST2 font 64 octets au plus.
            let n = text.len().min(63);
            // SAFETY : le plugin fournit un tampon d'au moins 64 octets pour ces demandes.
            unsafe {
                std::ptr::copy_nonoverlapping(text.as_ptr(), ptr as *mut u8, n);
                *(ptr as *mut u8).add(n) = 0;
            }
        }
        1
    };
    match opcode {
        AM_VERSION => 2400,
        AM_CURRENT_ID => i32::from_be_bytes(*b"LcMu") as isize,
        AM_GET_SAMPLE_RATE => OUT_RATE as isize,
        AM_GET_BLOCK_SIZE => MAX_BLOCK as isize,
        AM_GET_VENDOR_STRING => copy(b"low-cord"),
        AM_GET_PRODUCT_STRING => copy(b"low-sound"),
        AM_GET_VENDOR_VERSION => 1,
        AM_WILL_REPLACE_OR_ACCUMULATE => 1,
        AM_SIZE_WINDOW => {
            // Le plugin change la taille de son panneau.
            #[cfg(windows)]
            gui::resize(index, value as i32);
            let _ = (index, value);
            1
        }
        AM_CAN_DO => {
            if ptr.is_null() {
                return 0;
            }
            // SAFETY : chaîne terminée par 0 fournie par le plugin.
            let what = unsafe { CStr::from_ptr(ptr as *const c_char) };
            i32::from(matches!(
                what.to_bytes(),
                b"startStopProcess" | b"sizeWindow"
            )) as isize
        }
        _ => 0,
    }
}

/// Un exemplaire du plugin.
struct Instance {
    effect: *mut AEffect,
}

impl Instance {
    fn new(entry: EntryFn) -> Result<Instance, String> {
        let effect = entry(host_callback);
        // SAFETY : pointeur renvoyé par le plugin, vérifié avant usage.
        if effect.is_null() || unsafe { (*effect).magic } != MAGIC {
            return Err("ce fichier n'est pas un plugin VST2".into());
        }
        let inst = Instance { effect };
        if inst.fx().dispatcher.is_none() {
            return Err("plugin VST2 incomplet".into());
        }
        inst.dispatch(EFF_OPEN, 0, 0, std::ptr::null_mut(), 0.0);
        inst.dispatch(
            EFF_SET_SAMPLE_RATE,
            0,
            0,
            std::ptr::null_mut(),
            OUT_RATE as f32,
        );
        inst.dispatch(
            EFF_SET_BLOCK_SIZE,
            0,
            MAX_BLOCK as isize,
            std::ptr::null_mut(),
            0.0,
        );
        Ok(inst)
    }

    fn fx(&self) -> &AEffect {
        // SAFETY : l'effet reste valide jusqu'à effClose (Drop).
        unsafe { &*self.effect }
    }

    fn dispatch(&self, op: i32, index: i32, value: isize, ptr: *mut c_void, opt: f32) -> isize {
        match self.fx().dispatcher {
            Some(d) => d(self.effect, op, index, value, ptr, opt),
            None => 0,
        }
    }

    fn text(&self, op: i32, index: i32) -> String {
        let mut buf = [0u8; 256];
        self.dispatch(op, index, 0, buf.as_mut_ptr() as *mut c_void, 0.0);
        buf[255] = 0;
        let end = buf.iter().position(|&b| b == 0).unwrap_or(0);
        String::from_utf8_lossy(&buf[..end]).trim().to_string()
    }

    fn start(&self) {
        self.dispatch(EFF_MAINS_CHANGED, 0, 1, std::ptr::null_mut(), 0.0);
        self.dispatch(EFF_START_PROCESS, 0, 0, std::ptr::null_mut(), 0.0);
    }

    fn stop(&self) {
        self.dispatch(EFF_STOP_PROCESS, 0, 0, std::ptr::null_mut(), 0.0);
        self.dispatch(EFF_MAINS_CHANGED, 0, 0, std::ptr::null_mut(), 0.0);
    }

    fn uses_chunks(&self) -> bool {
        self.fx().flags & FLAG_PROGRAM_CHUNKS != 0
    }

    fn set_chunk(&self, data: &[u8]) {
        if data.is_empty() {
            return;
        }
        let mut copy = data.to_vec();
        self.dispatch(
            EFF_SET_CHUNK,
            1,
            copy.len() as isize,
            copy.as_mut_ptr() as *mut c_void,
            0.0,
        );
    }

    fn chunk(&self) -> Vec<u8> {
        let mut ptr: *mut c_void = std::ptr::null_mut();
        let len = self.dispatch(
            EFF_GET_CHUNK,
            1,
            0,
            &mut ptr as *mut *mut c_void as *mut c_void,
            0.0,
        );
        if ptr.is_null() || len <= 0 || len > 64 << 20 {
            return Vec::new();
        }
        // SAFETY : le plugin garde ce tampon valide jusqu'au prochain appel.
        unsafe { std::slice::from_raw_parts(ptr as *const u8, len as usize).to_vec() }
    }

    fn param_count(&self) -> i32 {
        self.fx().num_params.clamp(0, 4096)
    }

    fn get_param(&self, i: i32) -> f32 {
        self.fx().get_parameter.map_or(0.0, |g| g(self.effect, i))
    }

    fn set_param(&self, i: i32, v: f32) {
        if let Some(s) = self.fx().set_parameter {
            s(self.effect, i, v.clamp(0.0, 1.0));
        }
    }
}

impl Drop for Instance {
    fn drop(&mut self) {
        self.stop();
        self.dispatch(EFF_CLOSE, 0, 0, std::ptr::null_mut(), 0.0);
    }
}

/// Le plugin chargé : un exemplaire (stéréo) ou deux (mono, un par canal).
pub struct Plugin {
    instances: Vec<Instance>,
    /// canaux traités par exemplaire
    width: usize,
    ins: Vec<Vec<f32>>,
    outs: Vec<Vec<f32>>,
    name: String,
    vendor: String,
    // Garde la bibliothèque chargée tant que le plugin vit.
    _lib: Option<libloading::Library>,
}

impl Plugin {
    pub fn open(entry: EntryFn, lib: Option<libloading::Library>) -> Result<Plugin, String> {
        let first = Instance::new(entry)?;
        let width = (first.fx().num_inputs.max(first.fx().num_outputs).max(1) as usize).min(2);
        let mut instances = vec![first];
        if width == 1 {
            instances.push(Instance::new(entry)?);
        }
        let io = instances[0]
            .fx()
            .num_inputs
            .max(instances[0].fx().num_outputs)
            .clamp(1, 64) as usize;
        let mut name = instances[0].text(EFF_GET_EFFECT_NAME, 0);
        if name.is_empty() {
            name = instances[0].text(EFF_GET_PRODUCT_STRING, 0);
        }
        let vendor = instances[0].text(EFF_GET_VENDOR_STRING, 0);
        for inst in &instances {
            inst.start();
        }
        Ok(Plugin {
            instances,
            width,
            ins: vec![vec![0.0; MAX_BLOCK]; io],
            outs: vec![vec![0.0; MAX_BLOCK]; io],
            name,
            vendor,
            _lib: lib,
        })
    }

    /// Charge un plugin depuis sa DLL (point d'entrée VSTPluginMain ou main).
    pub fn load(path: &str) -> Result<Plugin, String> {
        // SAFETY : on charge une DLL choisie par l'utilisateur dans le dossier VST
        // de low-sound ; elle tourne dans ce processus séparé.
        let lib = unsafe { libloading::Library::new(path) }.map_err(|e| {
            let text = e.to_string();
            if text.contains("193") {
                "plugin 32 bits : seuls les plugins 64 bits fonctionnent".to_string()
            } else {
                format!("plugin impossible à charger : {text}")
            }
        })?;
        // SAFETY : signature standard du point d'entrée VST2.
        let entry: EntryFn = unsafe {
            match lib.get::<EntryFn>(b"VSTPluginMain\0") {
                Ok(f) => *f,
                Err(_) => *lib.get::<EntryFn>(b"main\0").map_err(|_| {
                    "ce fichier n'est pas un plugin VST2 (pas de VSTPluginMain)".to_string()
                })?,
            }
        };
        Plugin::open(entry, Some(lib))
    }

    /// État : ChunkData (base64) si le plugin en a, sinon ses paramètres.
    pub fn apply(&mut self, chunk: Option<&str>, params: &BTreeMap<String, f32>) {
        let first = &self.instances[0];
        if first.uses_chunks() {
            if let Some(data) = chunk.and_then(|c| {
                base64::engine::general_purpose::STANDARD
                    .decode(c.trim())
                    .ok()
            }) {
                for inst in &self.instances {
                    inst.set_chunk(&data);
                }
            }
        } else if !params.is_empty() {
            for i in 0..first.param_count() {
                if let Some(v) = params.get(&first.text(EFF_GET_PARAM_NAME, i)) {
                    for inst in &self.instances {
                        inst.set_param(i, *v);
                    }
                }
            }
        }
    }

    pub fn has_editor(&self) -> bool {
        self.instances[0].fx().flags & FLAG_HAS_EDITOR != 0
    }

    /// Recopie l'état du premier exemplaire sur les autres (plugin mono).
    pub fn sync_copies(&mut self) {
        let Some((first, rest)) = self.instances.split_first() else {
            return;
        };
        if rest.is_empty() {
            return;
        }
        if first.uses_chunks() {
            let data = first.chunk();
            for inst in rest {
                if inst.chunk() != data {
                    inst.set_chunk(&data);
                }
            }
        } else {
            for i in 0..first.param_count() {
                let v = first.get_param(i);
                for inst in rest {
                    if inst.get_param(i) != v {
                        inst.set_param(i, v);
                    }
                }
            }
        }
    }

    pub fn set_param(&mut self, index: i32, value: f32) {
        if index >= 0 && index < self.instances[0].param_count() {
            for inst in &self.instances {
                inst.set_param(index, value);
            }
        }
    }

    /// Paramètres (nom, valeur 0..1, affichage) et ChunkData actuel.
    pub fn state(&self) -> Value {
        let first = &self.instances[0];
        let params: Vec<Value> = (0..first.param_count())
            .map(|i| {
                let label = first.text(EFF_GET_PARAM_LABEL, i);
                let display = first.text(EFF_GET_PARAM_DISPLAY, i);
                json!({
                    "name": first.text(EFF_GET_PARAM_NAME, i),
                    "value": first.get_param(i),
                    "display": if label.is_empty() { display } else { format!("{display} {label}") },
                })
            })
            .collect();
        let chunk = if first.uses_chunks() {
            Some(base64::engine::general_purpose::STANDARD.encode(first.chunk()))
        } else {
            None
        };
        json!({
            "name": self.name, "vendor": self.vendor,
            "editor": first.fx().flags & FLAG_HAS_EDITOR != 0,
            "latency": first.fx().initial_delay.max(0),
            "chunks": first.uses_chunks(),
            "editorOpen": EDITOR_OPEN.load(std::sync::atomic::Ordering::Relaxed),
            "params": params, "chunk": chunk,
        })
    }

    /// Traite un bloc stéréo entrelacé (en place).
    pub fn process(&mut self, buf: &mut [f32]) {
        for block in buf.chunks_mut(MAX_BLOCK * 2) {
            let frames = block.len() / 2;
            for (k, inst) in self.instances.iter().enumerate() {
                let fx = inst.fx();
                // Canaux de ce bloc confiés à cet exemplaire.
                const MONO_CH: [[usize; 1]; 2] = [[0], [1]];
                const STEREO_CH: [usize; 2] = [0, 1];
                let chans: &[usize] = if self.width == 1 {
                    &MONO_CH[k]
                } else {
                    &STEREO_CH
                };
                for (slot, input) in self.ins.iter_mut().enumerate() {
                    match chans.get(slot) {
                        Some(&c) => {
                            for (i, s) in input[..frames].iter_mut().enumerate() {
                                *s = block[i * 2 + c];
                            }
                        }
                        None => input[..frames].fill(0.0),
                    }
                }
                for out in self.outs.iter_mut() {
                    out[..frames].fill(0.0);
                }
                let mut ip: Vec<*mut f32> = self.ins.iter_mut().map(|v| v.as_mut_ptr()).collect();
                let mut op: Vec<*mut f32> = self.outs.iter_mut().map(|v| v.as_mut_ptr()).collect();
                let replacing = fx.flags & FLAG_CAN_REPLACING != 0;
                match (replacing, fx.process_replacing, fx.process) {
                    (true, Some(f), _) | (false, _, Some(f)) | (_, Some(f), None) => {
                        f(inst.effect, ip.as_mut_ptr(), op.as_mut_ptr(), frames as i32)
                    }
                    _ => {}
                }
                let outputs = fx.num_outputs.max(0) as usize;
                for (slot, &c) in chans.iter().enumerate() {
                    for i in 0..frames {
                        // Moins de sorties que d'entrées : le canal devient muet (comme APO).
                        block[i * 2 + c] = if slot < outputs {
                            self.outs[slot][i]
                        } else {
                            0.0
                        };
                    }
                }
            }
        }
    }
}

// ── Processus hôte (moteur lancé avec --vst-host) ───────────────────────────
//
// Messages : [type u8][numéro u32][longueur u32][contenu]. Chaque réponse
// reprend le numéro de sa demande : le son (traité tout de suite) n'attend
// jamais une demande de contrôle (traitée sur le fil des fenêtres).

const OP_OPEN: u8 = 1;
const OP_PROCESS: u8 = 2;
const OP_SET_PARAM: u8 = 3;
const OP_APPLY: u8 = 4;
const OP_EDITOR: u8 = 5;
const OP_STATE: u8 = 6;

/// Le panneau du plugin est ouvert (fenêtre de l'hôte).
static EDITOR_OPEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Travail à faire sur le fil du plugin (celui des fenêtres) ; il répond lui-même.
pub type Job = Box<dyn FnOnce() + Send>;
/// Confie un travail au fil du plugin (sans attendre).
pub type RunOnPluginThread<'a> = &'a dyn Fn(Job);
/// Le plugin, partagé : traitement du son d'un côté, tout le reste de l'autre.
pub type PluginSlot = Arc<Mutex<Option<Plugin>>>;
/// Sortie vers le moteur, partagée par les deux fils de l'hôte.
pub type Out<W> = Arc<Mutex<W>>;

fn write_msg(w: &mut impl Write, tag: u8, id: u32, payload: &[u8]) -> std::io::Result<()> {
    let mut head = [0u8; 9];
    head[0] = tag;
    head[1..5].copy_from_slice(&id.to_le_bytes());
    head[5..9].copy_from_slice(&(payload.len() as u32).to_le_bytes());
    w.write_all(&head)?;
    w.write_all(payload)?;
    w.flush()
}

fn read_msg(r: &mut impl Read) -> std::io::Result<(u8, u32, Vec<u8>)> {
    let mut head = [0u8; 9];
    r.read_exact(&mut head)?;
    let id = u32::from_le_bytes([head[1], head[2], head[3], head[4]]);
    let len = u32::from_le_bytes([head[5], head[6], head[7], head[8]]) as usize;
    if len > 64 << 20 {
        return Err(std::io::Error::other("message trop gros"));
    }
    let mut payload = vec![0u8; len];
    r.read_exact(&mut payload)?;
    Ok((head[0], id, payload))
}

fn params_of(v: &Value) -> BTreeMap<String, f32> {
    v.get("params")
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| Some((k.clone(), v.as_f64()? as f32)))
                .collect()
        })
        .unwrap_or_default()
}

// SAFETY : comme dans tout hôte VST2, le plugin est utilisé depuis deux fils :
// traitement du son d'un côté, pilotage et panneau de l'autre. Les accès
// passent par un verrou (sauf les appels du panneau, que VST2 permet pendant
// le traitement).
unsafe impl Send for Plugin {}

/// Réponse JSON (0 = réussi, 1 = erreur avec son message).
fn reply<W: Write>(out: &Out<W>, id: u32, result: Result<Value, String>) -> bool {
    let (tag, body) = match result {
        Ok(v) => (0, v.to_string()),
        Err(e) => (1, e),
    };
    write_msg(&mut *lock(out), tag, id, body.as_bytes()).is_ok()
}

/// Boucle de l'hôte : un plugin, des messages jusqu'à la fermeture de l'entrée.
///
/// Le son est traité ici même ; tout le reste (chargement, état, réglages,
/// panneau) est confié à `on_plugin_thread`, le fil qui gère les fenêtres :
/// les plugins (JUCE notamment) exigent d'être créés et pilotés sur ce fil-là.
pub fn serve<W: Write + Send + 'static>(
    r: &mut impl Read,
    out: Out<W>,
    plugin: PluginSlot,
    load: fn(&str) -> Result<Plugin, String>,
    open_editor: fn(usize, String) -> Result<(), String>,
    on_plugin_thread: RunOnPluginThread,
) {
    let mut bytes = Vec::new();
    while let Ok((op, id, payload)) = read_msg(r) {
        if op == OP_PROCESS {
            let mut buf: Vec<f32> = payload
                .as_chunks::<4>()
                .0
                .iter()
                .map(|b| f32::from_le_bytes(*b))
                .collect();
            if let Some(p) = lock(&plugin).as_mut() {
                p.process(&mut buf);
            }
            bytes.clear();
            bytes.extend(buf.iter().flat_map(|x| x.to_le_bytes()));
            if write_msg(&mut *lock(&out), 0, id, &bytes).is_err() {
                return;
            }
            continue;
        }
        let req: Value = serde_json::from_slice(&payload).unwrap_or(Value::Null);
        let slot = plugin.clone();
        let out = out.clone();
        let work = move || -> Result<Value, String> {
            match op {
                OP_OPEN => {
                    let path = req.get("path").and_then(Value::as_str).unwrap_or("");
                    let mut p = load(path)?;
                    p.apply(req.get("chunk").and_then(Value::as_str), &params_of(&req));
                    let state = p.state();
                    *lock(&slot) = Some(p);
                    Ok(state)
                }
                OP_APPLY | OP_SET_PARAM | OP_STATE => {
                    let mut guard = lock(&slot);
                    let p = guard.as_mut().ok_or("aucun plugin chargé")?;
                    match op {
                        OP_APPLY => {
                            p.apply(req.get("chunk").and_then(Value::as_str), &params_of(&req))
                        }
                        OP_SET_PARAM => {
                            let index =
                                req.get("index").and_then(Value::as_i64).unwrap_or(-1) as i32;
                            let value =
                                req.get("value").and_then(Value::as_f64).unwrap_or(0.0) as f32;
                            p.set_param(index, value);
                        }
                        _ => p.sync_copies(),
                    }
                    Ok(p.state())
                }
                OP_EDITOR => {
                    // Verrou relâché avant d'ouvrir : le son continue pendant ce temps.
                    let (effect, title, has_editor) = {
                        let guard = lock(&slot);
                        let p = guard.as_ref().ok_or("aucun plugin chargé")?;
                        (
                            p.instances[0].effect as usize,
                            format!("{} — low-sound", p.name),
                            p.has_editor(),
                        )
                    };
                    if !has_editor {
                        return Err("ce plugin n'a pas de panneau".into());
                    }
                    open_editor(effect, title)?;
                    Ok(json!({ "ok": true }))
                }
                _ => Err("demande inconnue".into()),
            }
        };
        on_plugin_thread(Box::new(move || {
            reply(&out, id, work());
        }));
    }
}

#[cfg(windows)]
fn open_editor_window(effect: usize, title: String) -> Result<(), String> {
    gui::open(effect, &title)
}

#[cfg(not(windows))]
fn open_editor_window(_: usize, _: String) -> Result<(), String> {
    Err("panneau disponible seulement sous Windows".into())
}

/// Point d'entrée du processus hôte : les messages du moteur sur un fil, le
/// plugin et sa fenêtre (boucle de messages Windows) sur le fil principal.
pub fn host_main() {
    let plugin: PluginSlot = Arc::new(Mutex::new(None));
    let (tx, rx) = mpsc::channel::<Job>();
    let reader_slot = plugin.clone();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let out: Out<std::io::Stdout> = Arc::new(Mutex::new(std::io::stdout()));
        let run = move |job: Job| {
            let _ = tx.send(job);
        };
        serve(
            &mut stdin.lock(),
            out,
            reader_slot,
            Plugin::load,
            open_editor_window,
            &run,
        );
        // Entrée fermée : le moteur ne veut plus de ce plugin.
        std::process::exit(0);
    });
    #[cfg(windows)]
    gui::run(rx, plugin);
    #[cfg(not(windows))]
    for job in rx {
        job();
    }
}

// ── Côté moteur : un plugin dans son processus ──────────────────────────────

type Waiting = Arc<Mutex<std::collections::HashMap<u32, mpsc::Sender<(u8, Vec<u8>)>>>>;

/// Ce qui change au fil du temps (sous verrou, jamais pendant une attente).
struct Known {
    /// état demandé la dernière fois (ChunkData / paramètres)
    applied: (Option<String>, BTreeMap<String, f32>),
    state: Value,
    error: Option<String>,
}

/// Le plugin vu du moteur : processus hôte + dernier état connu. Le son et
/// le contrôle passent par le même processus sans s'attendre l'un l'autre.
pub struct Bridge {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    waiting: Waiting,
    next_id: std::sync::atomic::AtomicU32,
    alive: Arc<std::sync::atomic::AtomicBool>,
    path: String,
    known: Mutex<Known>,
    scratch: Mutex<Vec<u8>>,
}

/// Délais de réponse : chargement (plugins lourds), contrôle, bloc de son.
const OPEN_TIMEOUT: Duration = Duration::from_secs(15);
const CONTROL_TIMEOUT: Duration = Duration::from_secs(3);
const BLOCK_TIMEOUT: Duration = Duration::from_millis(250);

impl Bridge {
    pub fn spawn(
        path: &str,
        chunk: Option<String>,
        params: BTreeMap<String, f32>,
    ) -> Result<Bridge, String> {
        let exe = std::env::current_exe().unwrap_or_default();
        let mut cmd = Command::new(exe);
        cmd.arg("--vst-host")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // pas de fenêtre de console
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("hôte VST impossible à lancer : {e}"))?;
        let (Some(stdin), Some(mut stdout)) = (child.stdin.take(), child.stdout.take()) else {
            let _ = child.kill();
            return Err("hôte VST impossible à lancer".into());
        };
        let waiting: Waiting = Arc::default();
        let alive = Arc::new(std::sync::atomic::AtomicBool::new(true));
        {
            // Chaque réponse retourne à qui l'attend (par son numéro).
            let waiting = waiting.clone();
            let alive = alive.clone();
            std::thread::Builder::new()
                .name("low-sound-vst".into())
                .spawn(move || {
                    while let Ok((tag, id, body)) = read_msg(&mut stdout) {
                        if let Some(tx) = lock(&waiting).remove(&id) {
                            let _ = tx.send((tag, body));
                        }
                    }
                    // Hôte arrêté : plus personne n'attend pour rien.
                    alive.store(false, std::sync::atomic::Ordering::Relaxed);
                    lock(&waiting).clear();
                })
                .ok();
        }
        let bridge = Bridge {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            waiting,
            next_id: std::sync::atomic::AtomicU32::new(1),
            alive,
            path: path.to_string(),
            known: Mutex::new(Known {
                applied: (chunk.clone(), params.clone()),
                state: Value::Null,
                error: None,
            }),
            scratch: Mutex::new(Vec::new()),
        };
        let req = json!({ "path": path, "chunk": chunk, "params": params });
        match bridge.control(OP_OPEN, req.to_string().as_bytes(), OPEN_TIMEOUT) {
            Ok(state) => lock(&bridge.known).state = state,
            Err(e) => bridge.fail(e),
        }
        Ok(bridge)
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(std::sync::atomic::Ordering::Relaxed)
    }

    fn fail(&self, e: String) {
        self.alive
            .store(false, std::sync::atomic::Ordering::Relaxed);
        lock(&self.known).error = Some(e);
        let _ = lock(&self.child).kill();
    }

    /// Envoie une demande et attend sa réponse (et seulement la sienne).
    fn exchange(&self, op: u8, payload: &[u8], timeout: Duration) -> Result<(u8, Vec<u8>), String> {
        if !self.is_alive() {
            return Err(lock(&self.known)
                .error
                .clone()
                .unwrap_or_else(|| "plugin arrêté".into()));
        }
        let id = self
            .next_id
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        lock(&self.waiting).insert(id, tx);
        if write_msg(&mut *lock(&self.stdin), op, id, payload).is_err() {
            lock(&self.waiting).remove(&id);
            return Err("le plugin s'est arrêté".into());
        }
        rx.recv_timeout(timeout).map_err(|_| {
            lock(&self.waiting).remove(&id);
            "le plugin ne répond plus".to_string()
        })
    }

    fn control(&self, op: u8, payload: &[u8], timeout: Duration) -> Result<Value, String> {
        match self.exchange(op, payload, timeout)? {
            (0, body) => {
                serde_json::from_slice(&body).map_err(|_| "réponse illisible du plugin".into())
            }
            (_, body) => Err(String::from_utf8_lossy(&body).into_owned()),
        }
    }

    /// Nouvel état demandé par le set (rien à faire s'il n'a pas changé).
    pub fn apply(&self, chunk: Option<String>, params: BTreeMap<String, f32>) {
        {
            let mut known = lock(&self.known);
            if known.applied == (chunk.clone(), params.clone()) || !self.is_alive() {
                return;
            }
            known.applied = (chunk.clone(), params.clone());
        }
        let req = json!({ "chunk": chunk, "params": params });
        match self.control(OP_APPLY, req.to_string().as_bytes(), CONTROL_TIMEOUT) {
            Ok(s) => lock(&self.known).state = s,
            Err(e) => self.fail(e),
        }
    }

    /// Ouvre le panneau du plugin (sa fenêtre).
    pub fn open_editor(&self) -> Result<Value, String> {
        self.control(OP_EDITOR, b"{}", OPEN_TIMEOUT)
    }

    /// État actuel (réglages faits dans le panneau du plugin compris).
    pub fn refresh(&self) -> Result<Value, String> {
        let state = self.control(OP_STATE, b"{}", CONTROL_TIMEOUT)?;
        Ok(self.adopt(state))
    }

    /// Réglage d'un paramètre depuis le panneau ; renvoie le nouvel état.
    pub fn set_param(&self, index: i64, value: f64) -> Result<Value, String> {
        let req = json!({ "index": index, "value": value });
        let state = self.control(OP_SET_PARAM, req.to_string().as_bytes(), CONTROL_TIMEOUT)?;
        Ok(self.adopt(state))
    }

    /// Le set va être réécrit avec cet état : ce n'est pas un changement à rappliquer.
    fn adopt(&self, state: Value) -> Value {
        let mut known = lock(&self.known);
        known.applied.0 = state
            .get("chunk")
            .and_then(Value::as_str)
            .map(str::to_string);
        let chunks = state
            .get("chunks")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if let (false, Some(list)) = (chunks, state.get("params").and_then(Value::as_array)) {
            known.applied.1 = list
                .iter()
                .filter_map(|p| {
                    Some((
                        p.get("name")?.as_str()?.to_string(),
                        p.get("value")?.as_f64()? as f32,
                    ))
                })
                .collect();
        }
        known.state = state.clone();
        state
    }

    /// Traite un bloc stéréo entrelacé ; plugin arrêté = son inchangé.
    pub fn process(&self, buf: &mut [f32]) {
        if !self.is_alive() {
            return;
        }
        let reply = {
            let mut scratch = lock(&self.scratch);
            scratch.clear();
            scratch.extend(buf.iter().flat_map(|x| x.to_le_bytes()));
            self.exchange(OP_PROCESS, &scratch, BLOCK_TIMEOUT)
        };
        match reply {
            Ok((0, body)) if body.len() == buf.len() * 4 => {
                for (x, b) in buf.iter_mut().zip(body.as_chunks::<4>().0) {
                    let v = f32::from_le_bytes(*b);
                    *x = if v.is_finite() { v } else { 0.0 };
                }
            }
            _ => self.lost("le plugin ne répond plus : il est coupé"),
        }
    }

    fn lost(&self, why: &str) {
        let was_alive = self.alive.swap(false, std::sync::atomic::Ordering::Relaxed);
        let name = lock(&self.known)
            .state
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("plugin")
            .to_string();
        self.fail(why.to_string());
        if was_alive {
            crate::engine::emit_global(json!({ "vstError": format!("{name} : {why}") }));
        }
    }

    pub fn info(&self) -> Value {
        let known = lock(&self.known);
        let mut v = if known.state.is_object() {
            known.state.clone()
        } else {
            json!({})
        };
        v["error"] = json!(known.error);
        v["file"] = json!(std::path::Path::new(&self.path)
            .file_name()
            .map(|f| f.to_string_lossy().into_owned()));
        // Le ChunkData peut être long : le panneau l'a déjà dans le set.
        if let Some(o) = v.as_object_mut() {
            o.remove("chunk");
        }
        v
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        let mut child = lock(&self.child);
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Plugins vivants, par (fichier, rang dans le set) : modifier le set ne
/// relance pas un plugin déjà chargé.
pub type Shared = Arc<Bridge>;

type LivePlugins = Mutex<Vec<((String, usize), Shared)>>;

fn live_plugins() -> &'static LivePlugins {
    static L: OnceLock<LivePlugins> = OnceLock::new();
    L.get_or_init(|| Mutex::new(Vec::new()))
}

/// Plugin pour une étape du set (réutilisé s'il tourne déjà).
pub fn plugin_for(
    path: &str,
    rank: usize,
    chunk: Option<String>,
    params: BTreeMap<String, f32>,
) -> Result<Shared, String> {
    let key = (path.to_string(), rank);
    let existing = lock(live_plugins())
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, b)| b.clone());
    if let Some(b) = existing.filter(|b| b.is_alive()) {
        b.apply(chunk, params);
        return Ok(b);
    }
    let b = Arc::new(Bridge::spawn(path, chunk, params)?);
    let mut live = lock(live_plugins());
    live.retain(|(k, _)| *k != key);
    live.push((key, b.clone()));
    Ok(b)
}

/// Après un nouveau set : on oublie les plugins qui n'y sont plus (arrêtés).
pub fn keep_only(used: &[Shared]) {
    lock(live_plugins()).retain(|(_, b)| used.iter().any(|u| Arc::ptr_eq(u, b)));
}

#[cfg(test)]
pub mod test_plugin {
    //! Petit plugin VST2 de test : gain (paramètre 0) et ChunkData = gain en
    //! texte. `MONO` = version mono (1 entrée, 1 sortie).
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    pub static MONO: AtomicBool = AtomicBool::new(false);

    #[repr(C)]
    struct Fx {
        effect: AEffect,
        gain: f32,
        chunk: Vec<u8>,
    }

    fn me(e: *mut AEffect) -> &'static mut Fx {
        // SAFETY : `effect` est le premier champ de `Fx` (repr C).
        unsafe { &mut *(e as *mut Fx) }
    }

    extern "C" fn dispatcher(
        e: *mut AEffect,
        op: i32,
        index: i32,
        value: isize,
        ptr: *mut c_void,
        _: f32,
    ) -> isize {
        let fx = me(e);
        let put = |s: &str| {
            // SAFETY : tampon de 256 octets fourni par l'hôte.
            unsafe {
                std::ptr::copy_nonoverlapping(s.as_ptr(), ptr as *mut u8, s.len());
                *(ptr as *mut u8).add(s.len()) = 0;
            }
            1
        };
        match op {
            EFF_GET_EFFECT_NAME => put("Gain test"),
            EFF_GET_VENDOR_STRING => put("low-cord"),
            EFF_GET_PARAM_NAME if index == 0 => put("Gain"),
            EFF_GET_PARAM_DISPLAY if index == 0 => put(&format!("{:.2}", fx.gain * 2.0)),
            EFF_GET_PARAM_LABEL if index == 0 => put("x"),
            EFF_GET_CHUNK => {
                fx.chunk = format!("{}", fx.gain).into_bytes();
                // SAFETY : l'hôte fournit l'adresse d'un pointeur.
                unsafe { *(ptr as *mut *mut u8) = fx.chunk.as_mut_ptr() };
                fx.chunk.len() as isize
            }
            EFF_SET_CHUNK => {
                // SAFETY : tampon de `value` octets fourni par l'hôte.
                let data = unsafe { std::slice::from_raw_parts(ptr as *const u8, value as usize) };
                if let Ok(g) = String::from_utf8_lossy(data).parse::<f32>() {
                    fx.gain = g;
                }
                0
            }
            EFF_CLOSE => {
                // SAFETY : créé par Box::into_raw dans `entry`.
                drop(unsafe { Box::from_raw(e as *mut Fx) });
                0
            }
            _ => 0,
        }
    }

    extern "C" fn process(e: *mut AEffect, ins: *mut *mut f32, outs: *mut *mut f32, n: i32) {
        let fx = me(e);
        let ch = fx.effect.num_inputs as usize;
        for c in 0..ch {
            // SAFETY : l'hôte fournit `ch` tampons de `n` échantillons.
            unsafe {
                let i = std::slice::from_raw_parts(*ins.add(c), n as usize);
                let o = std::slice::from_raw_parts_mut(*outs.add(c), n as usize);
                for (o, i) in o.iter_mut().zip(i) {
                    *o = i * fx.gain * 2.0;
                }
            }
        }
    }

    extern "C" fn set_param(e: *mut AEffect, i: i32, v: f32) {
        if i == 0 {
            me(e).gain = v;
        }
    }

    extern "C" fn get_param(e: *mut AEffect, i: i32) -> f32 {
        if i == 0 {
            me(e).gain
        } else {
            0.0
        }
    }

    pub extern "C" fn entry(cb: HostCallback) -> *mut AEffect {
        assert_eq!(
            cb(
                std::ptr::null_mut(),
                AM_VERSION,
                0,
                0,
                std::ptr::null_mut(),
                0.0
            ),
            2400
        );
        let io = if MONO.load(Ordering::Relaxed) { 1 } else { 2 };
        let fx = Box::new(Fx {
            effect: AEffect {
                magic: MAGIC,
                dispatcher: Some(dispatcher),
                process: None,
                set_parameter: Some(set_param),
                get_parameter: Some(get_param),
                num_programs: 1,
                num_params: 1,
                num_inputs: io,
                num_outputs: io,
                flags: FLAG_CAN_REPLACING | FLAG_PROGRAM_CHUNKS,
                resvd1: 0,
                resvd2: 0,
                initial_delay: 0,
                real_qualities: 0,
                off_qualities: 0,
                io_ratio: 1.0,
                object: std::ptr::null_mut(),
                user: std::ptr::null_mut(),
                unique_id: 1,
                version: 1,
                process_replacing: Some(process),
                process_double_replacing: None,
                future: [0; 56],
            },
            gain: 0.5,
            chunk: Vec::new(),
        });
        Box::into_raw(fx) as *mut AEffect
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_stéréo_chunk_et_paramètres() {
        let mut p = Plugin::open(test_plugin::entry, None).unwrap();
        let state = p.state();
        assert_eq!(state["name"], "Gain test");
        assert_eq!(state["params"][0]["name"], "Gain");
        // Gain 0,5 → ×1 ; ChunkData « 0.25 » (base64 « MC4yNQ== ») → ×0,5.
        let mut buf = vec![0.5f32, -0.5, 0.25, 1.0];
        p.process(&mut buf);
        assert_eq!(buf, vec![0.5, -0.5, 0.25, 1.0]);
        p.apply(Some("MC4yNQ=="), &BTreeMap::new());
        p.process(&mut buf);
        assert_eq!(buf, vec![0.25, -0.25, 0.125, 0.5]);
        assert_eq!(p.state()["chunk"], "MC4yNQ==");
        p.set_param(0, 1.0);
        assert_eq!(p.state()["params"][0]["display"], "2.00 x");
    }

    #[test]
    fn plugin_mono_dupliqué_par_canal() {
        test_plugin::MONO.store(true, std::sync::atomic::Ordering::Relaxed);
        let mut p = Plugin::open(test_plugin::entry, None).unwrap();
        test_plugin::MONO.store(false, std::sync::atomic::Ordering::Relaxed);
        assert_eq!(p.instances.len(), 2);
        let mut buf = vec![0.5f32, -0.25];
        p.set_param(0, 1.0);
        p.process(&mut buf);
        assert_eq!(buf, vec![1.0, -0.5]);
        // Réglage fait sur le premier exemplaire seulement (comme depuis son
        // panneau) : recopié sur le second.
        p.instances[0].set_param(0, 0.25);
        p.sync_copies();
        let mut buf = vec![1.0f32, 1.0];
        p.process(&mut buf);
        assert_eq!(buf, vec![0.5, 0.5]);
    }

    #[test]
    fn protocole_de_l_hôte() {
        // L'hôte tourne dans un fil ; on lui parle par deux tuyaux en mémoire.
        let (mut to_host_w, mut to_host_r) = pipe();
        let (from_host_w, mut from_host_r) = pipe();
        let host = std::thread::spawn(move || {
            serve(
                &mut to_host_r,
                Arc::new(Mutex::new(from_host_w)),
                Arc::new(Mutex::new(None)),
                |_| Plugin::open(test_plugin::entry, None),
                |_, _| Err("pas de panneau".to_string()),
                &|job| job(),
            );
        });
        let mut ask = |op: u8, id: u32, body: &[u8]| {
            write_msg(&mut to_host_w, op, id, body).unwrap();
            let (tag, rid, out) = read_msg(&mut from_host_r).unwrap();
            assert_eq!(rid, id, "chaque réponse reprend le numéro de sa demande");
            (tag, out)
        };
        let (tag, body) = ask(OP_OPEN, 7, br#"{"path":"x","chunk":"MC4yNQ=="}"#);
        assert_eq!(tag, 0);
        assert!(String::from_utf8_lossy(&body).contains("Gain test"));
        let block: Vec<u8> = [1.0f32, 1.0].iter().flat_map(|x| x.to_le_bytes()).collect();
        let (_, out) = ask(OP_PROCESS, 8, &block);
        assert_eq!(f32::from_le_bytes([out[0], out[1], out[2], out[3]]), 0.5);
        let (_, body) = ask(OP_SET_PARAM, 9, br#"{"index":0,"value":1.0}"#);
        assert!(String::from_utf8_lossy(&body).contains("\"chunk\":\"MQ==\""));
        // Pas de panneau pour ce plugin : refus clair, l'hôte continue.
        let (tag, body) = ask(OP_EDITOR, 10, b"{}");
        assert_eq!(tag, 1);
        assert!(String::from_utf8_lossy(&body).contains("pas de panneau"));
        // État relu (comme après un réglage fait dans le panneau du plugin).
        let (tag, body) = ask(OP_STATE, 11, b"{}");
        assert_eq!(tag, 0);
        assert!(String::from_utf8_lossy(&body).contains("\"editorOpen\":false"));
        drop(to_host_w);
        host.join().unwrap();
    }

    /// Tuyau en mémoire (bloquant), pour les tests.
    fn pipe() -> (PipeW, PipeR) {
        let (tx, rx) = mpsc::channel();
        (PipeW(tx), PipeR(rx, Vec::new()))
    }

    struct PipeW(mpsc::Sender<Vec<u8>>);
    struct PipeR(mpsc::Receiver<Vec<u8>>, Vec<u8>);

    impl Write for PipeW {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0
                .send(b.to_vec())
                .map_err(|_| std::io::Error::other("fermé"))?;
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Read for PipeR {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            if self.1.is_empty() {
                match self.0.recv() {
                    Ok(b) => self.1 = b,
                    Err(_) => return Ok(0),
                }
            }
            let n = out.len().min(self.1.len());
            out[..n].copy_from_slice(&self.1[..n]);
            self.1.drain(..n);
            Ok(n)
        }
    }
}

// ── Fenêtre du panneau du plugin (Windows) ──────────────────────────────────

#[cfg(windows)]
mod gui {
    use std::sync::atomic::{AtomicIsize, AtomicUsize, Ordering};
    use std::sync::mpsc::{Receiver, TryRecvError};
    use std::time::{Duration, Instant};

    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        AdjustWindowRectEx, CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW,
        LoadCursorW, PeekMessageW, RegisterClassW, SetForegroundWindow, SetWindowPos, ShowWindow,
        TranslateMessage, CW_USEDEFAULT, HWND_NOTOPMOST, HWND_TOPMOST, IDC_ARROW, MSG, PM_REMOVE,
        SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SW_SHOWNORMAL, WM_CLOSE, WNDCLASSW, WS_CAPTION,
        WS_MINIMIZEBOX, WS_OVERLAPPED, WS_SYSMENU,
    };

    use super::{
        AEffect, Job, PluginSlot, EDITOR_OPEN, EFF_EDIT_CLOSE, EFF_EDIT_GET_RECT, EFF_EDIT_IDLE,
        EFF_EDIT_OPEN,
    };

    const STYLE: u32 = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX;

    /// Fenêtre ouverte (0 = aucune) et effet qu'elle affiche.
    static WINDOW: AtomicIsize = AtomicIsize::new(0);
    static EFFECT: AtomicUsize = AtomicUsize::new(0);

    #[repr(C)]
    struct ERect {
        top: i16,
        left: i16,
        bottom: i16,
        right: i16,
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    fn dispatch(op: i32, ptr: *mut core::ffi::c_void) -> isize {
        let effect = EFFECT.load(Ordering::Relaxed) as *mut AEffect;
        if effect.is_null() {
            return 0;
        }
        // SAFETY : l'effet vit autant que le processus hôte (un seul plugin).
        match unsafe { (*effect).dispatcher } {
            Some(d) => d(effect, op, 0, 0, ptr, 0.0),
            None => 0,
        }
    }

    /// Taille voulue par le plugin (son rectangle d'éditeur).
    fn editor_size() -> (i32, i32) {
        let mut rect: *mut ERect = std::ptr::null_mut();
        dispatch(
            EFF_EDIT_GET_RECT,
            &mut rect as *mut *mut ERect as *mut core::ffi::c_void,
        );
        if rect.is_null() {
            return (480, 320);
        }
        // SAFETY : rectangle fourni par le plugin.
        let r = unsafe { &*rect };
        let (w, h) = ((r.right - r.left) as i32, (r.bottom - r.top) as i32);
        if w > 0 && h > 0 {
            (w, h)
        } else {
            (480, 320)
        }
    }

    /// Taille de la fenêtre (cadre compris) pour une zone intérieure w × h.
    fn outer(w: i32, h: i32) -> (i32, i32) {
        let mut r = RECT {
            left: 0,
            top: 0,
            right: w,
            bottom: h,
        };
        // SAFETY : simple calcul de rectangle.
        unsafe { AdjustWindowRectEx(&mut r, STYLE, 0, 0) };
        (r.right - r.left, r.bottom - r.top)
    }

    /// Le plugin demande une autre taille (audioMasterSizeWindow).
    pub fn resize(w: i32, h: i32) {
        let hwnd = WINDOW.load(Ordering::Relaxed) as HWND;
        if hwnd.is_null() || w <= 0 || h <= 0 {
            return;
        }
        let (ow, oh) = outer(w, h);
        // SAFETY : fenêtre de ce processus.
        unsafe {
            SetWindowPos(
                hwnd,
                std::ptr::null_mut(),
                0,
                0,
                ow,
                oh,
                SWP_NOMOVE | SWP_NOZORDER,
            )
        };
    }

    unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        if msg == WM_CLOSE {
            dispatch(EFF_EDIT_CLOSE, std::ptr::null_mut());
            WINDOW.store(0, Ordering::Relaxed);
            EDITOR_OPEN.store(false, Ordering::Relaxed);
            // SAFETY : fenêtre de ce processus.
            unsafe { DestroyWindow(hwnd) };
            return 0;
        }
        // SAFETY : traitement par défaut de Windows.
        unsafe { DefWindowProcW(hwnd, msg, wp, lp) }
    }

    pub fn open(effect: usize, title: &str) -> Result<(), String> {
        EFFECT.store(effect, Ordering::Relaxed);
        let existing = WINDOW.load(Ordering::Relaxed) as HWND;
        if !existing.is_null() {
            // Déjà ouvert : on le ramène devant.
            // SAFETY : fenêtre de ce processus.
            unsafe { SetForegroundWindow(existing) };
            return Ok(());
        }
        let class = wide("LowSoundVstPanel");
        let title = wide(title);
        let (w, h) = editor_size();
        let (ow, oh) = outer(w, h);
        // SAFETY : création d'une fenêtre Windows ordinaire, dans ce processus.
        unsafe {
            let instance = GetModuleHandleW(std::ptr::null());
            let wc = WNDCLASSW {
                style: 0,
                lpfnWndProc: Some(wndproc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: instance,
                hIcon: std::ptr::null_mut(),
                hCursor: LoadCursorW(std::ptr::null_mut(), IDC_ARROW),
                hbrBackground: std::ptr::null_mut(),
                lpszMenuName: std::ptr::null(),
                lpszClassName: class.as_ptr(),
            };
            RegisterClassW(&wc); // déjà enregistrée : sans effet
            let hwnd = CreateWindowExW(
                0,
                class.as_ptr(),
                title.as_ptr(),
                STYLE,
                CW_USEDEFAULT,
                CW_USEDEFAULT,
                ow,
                oh,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                instance,
                std::ptr::null(),
            );
            if hwnd.is_null() {
                return Err("fenêtre du panneau impossible à créer".into());
            }
            WINDOW.store(hwnd as isize, Ordering::Relaxed);
            EDITOR_OPEN.store(true, Ordering::Relaxed);
            dispatch(EFF_EDIT_OPEN, hwnd);
            // Certains plugins ne connaissent leur taille qu'une fois ouverts.
            let (w2, h2) = editor_size();
            resize(w2, h2);
            // Le premier ShowWindow d'un processus peut suivre le mode « caché »
            // hérité du lancement : le second affiche à coup sûr.
            ShowWindow(hwnd, SW_SHOWNORMAL);
            ShowWindow(hwnd, SW_SHOWNORMAL);
            // Devant tout le reste (la fenêtre du panneau low-sound peut être
            // « toujours au premier plan »), puis comportement normal.
            SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
            SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
            SetForegroundWindow(hwnd);
        }
        Ok(())
    }

    /// Boucle du fil du plugin : messages Windows en continu (les plugins en
    /// ont besoin même sans panneau ouvert), travaux demandés par le moteur,
    /// « idle » du panneau (~30 fois/s) et recopie des réglages (plugin mono).
    pub fn run(rx: Receiver<Job>, plugin: PluginSlot) {
        let mut last_idle = Instant::now();
        let mut last_sync = Instant::now();
        loop {
            // SAFETY : boucle de messages standard du fil qui possède les fenêtres.
            unsafe {
                let mut msg: MSG = std::mem::zeroed();
                while PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                    TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
            loop {
                match rx.try_recv() {
                    Ok(job) => job(),
                    Err(TryRecvError::Disconnected) => return,
                    Err(TryRecvError::Empty) => break,
                }
            }
            let open = WINDOW.load(Ordering::Relaxed) != 0;
            if open && last_idle.elapsed() >= Duration::from_millis(30) {
                last_idle = Instant::now();
                dispatch(EFF_EDIT_IDLE, std::ptr::null_mut());
            }
            if open && last_sync.elapsed() >= Duration::from_millis(500) {
                last_sync = Instant::now();
                if let Some(p) = crate::lock(&plugin).as_mut() {
                    p.sync_copies();
                }
            }
            if open {
                // Panneau ouvert : réactif (~200 fois/s).
                std::thread::sleep(Duration::from_millis(5));
            } else {
                // Sans fenêtre : on attend un travail (ou 20 ms) au lieu de
                // tourner à vide ; les messages Windows restent traités.
                match rx.recv_timeout(Duration::from_millis(20)) {
                    Ok(job) => job(),
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                }
            }
        }
    }
}
