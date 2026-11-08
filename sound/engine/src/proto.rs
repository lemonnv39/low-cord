//! Sortie vers low-cord : une ligne JSON par message, jamais coupée en deux
//! (le verrou de stdout est tenu pendant toute l'écriture).

use serde_json::{json, Value};
use std::io::Write;

fn write_line(v: &Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

pub fn reply(id: Value, res: Result<Value, String>) {
    write_line(&match res {
        Ok(result) => json!({ "id": id, "ok": true, "result": result }),
        Err(error) => json!({ "id": id, "ok": false, "error": error }),
    });
}

pub fn event(v: Value) {
    write_line(&v);
}
