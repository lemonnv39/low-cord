/*
 * Port fidèle de WriteAppAsar (app_asar.go, Vencord/Installer) : construit un
 * app.asar minimal dont l'unique rôle est de `require()` le vrai patcher.js
 * de low-cord au démarrage d'Electron.
 *
 * Format ASAR (celui-ci en particulier, sans sous-dossiers ni offsets
 * multiples) : 4 entiers u32 little-endian, puis le header JSON (paddé à un
 * multiple de 4 avec des caractères '0' ASCII — pas des octets nuls, c'est
 * bien ce que fait le Go d'origine), puis le contenu des fichiers concaténé
 * dans l'ordre déclaré par le header.
 *
 * `inspect_asar` (ajouté pour la détection "autre mod déjà patché") lit ce
 * même format en sens inverse : un vrai app.asar Discord contient des
 * centaines d'entrées (tout le code d'Electron/Discord), alors qu'un stub de
 * patcher (low-cord, Vencord, Equicord...) n'a jamais que index.js +
 * package.json — cette seule différence de taille de header suffit à
 * distinguer "Discord d'origine" de "patché par quelque chose". Pour
 * distinguer ENSUITE "patché par low-cord" de "patché par autre chose", on lit
 * le contenu de index.js : le require() qu'il contient pointe soit vers notre
 * propre patcher.js en cache, soit vers autre chose (Vencord/Equicord
 * téléchargent le leur dans %APPDATA%\Vencord ou %APPDATA%\Equicord).
 */

use serde::Serialize;
use std::collections::BTreeMap;
use std::fs::File;
use std::io::{Read, Result as IoResult, Write};
use std::path::Path;

#[derive(Serialize)]
struct AsarEntry {
    size: u32,
    offset: String,
}

#[derive(Serialize)]
struct AsarHeader {
    files: BTreeMap<String, AsarEntry>,
}

#[derive(serde::Deserialize)]
struct ParsedAsarEntry {
    size: u32,
    offset: String,
}

#[derive(serde::Deserialize)]
struct ParsedAsarHeader {
    files: BTreeMap<String, ParsedAsarEntry>,
}

const PACKAGE_JSON: &str = "{\n\t\"name\": \"discord\",\n\t\"main\": \"index.js\"\n}";

/// Qui a patché cet `app.asar` — voir le commentaire d'en-tête pour la logique
/// de distinction.
#[derive(Debug, Clone, PartialEq)]
pub enum StubOwner {
    /// app.asar d'origine, jamais patché (des centaines de fichiers dedans).
    Genuine,
    /// Stub minimal écrit par low-cord lui-même (même chemin de patcher.js).
    LowCord { build_sha: Option<String> },
    /// Stub minimal écrit par un autre mod (Vencord, Equicord, un fork...).
    Foreign { require_path: String },
}

pub fn write_app_asar(out_file: &Path, patcher_path: &str, build_sha: Option<&str>) -> IoResult<()> {
    // Le SHA du build est encodé en commentaire JS avant le require() —
    // purement informatif pour nous (inspect_asar le relit), Electron l'ignore.
    let index_js = match build_sha {
        Some(sha) => format!("// lowcord-build-sha:{sha}\nrequire({})", serde_json::to_string(patcher_path)?),
        None => format!("require({})", serde_json::to_string(patcher_path)?),
    };
    let index_js_bytes = index_js.as_bytes();
    let package_json_bytes = PACKAGE_JSON.as_bytes();

    let mut files = BTreeMap::new();
    files.insert(
        "index.js".to_string(),
        AsarEntry { size: index_js_bytes.len() as u32, offset: "0".to_string() },
    );
    files.insert(
        "package.json".to_string(),
        AsarEntry {
            size: package_json_bytes.len() as u32,
            offset: index_js_bytes.len().to_string(),
        },
    );

    let mut header_string = serde_json::to_string(&AsarHeader { files })?;

    let data_size: u32 = 4;
    let header_string_size = header_string.len() as u32;
    let aligned_size = (header_string_size + data_size - 1) & !(data_size - 1);
    let header_size = aligned_size + 8;
    let header_object_size = aligned_size + data_size;

    let diff = aligned_size - header_string_size;
    if diff > 0 {
        header_string.push_str(&"0".repeat(diff as usize));
    }

    let mut f = File::create(out_file)?;
    for n in [data_size, header_size, header_object_size, header_string_size] {
        f.write_all(&n.to_le_bytes())?;
    }
    f.write_all(header_string.as_bytes())?;
    f.write_all(index_js_bytes)?;
    f.write_all(package_json_bytes)?;

    Ok(())
}

/// Extrait le chemin passé à require(...) dans un index.js de stub, en
/// ignorant un éventuel commentaire `// lowcord-build-sha:...` sur la ligne
/// précédente.
fn extract_require_path(index_js: &str) -> Option<String> {
    let start = index_js.find("require(")? + "require(".len();
    let rest = &index_js[start..];
    let end = rest.find(')')?;
    let quoted = rest[..end].trim();
    serde_json::from_str::<String>(quoted).ok()
}

fn extract_build_sha(index_js: &str) -> Option<String> {
    let line = index_js.lines().find(|l| l.starts_with("// lowcord-build-sha:"))?;
    Some(line.trim_start_matches("// lowcord-build-sha:").trim().to_string())
}

/// Lit le `require(...)` d'un stub `app.asar` en forme de DOSSIER
/// (`app.asar/` contenant un `index.js`), la technique d'injection utilisée par
/// Vencord/Equicord — et par Abyss — au lieu
/// d'un fichier asar. `inspect_asar` ci-dessus fait `File::open` et échoue donc
/// sur un dossier ; ce helper permet aux appelants de reconnaître/nommer ce
/// type de stub sans planter. Renvoie le chemin requis (ex. le patcher du mod).
pub fn read_dir_stub_require(app_asar_dir: &Path) -> Option<String> {
    let index = std::fs::read_to_string(app_asar_dir.join("index.js")).ok()?;
    extract_require_path(&index)
}

/// Lit un app.asar existant et détermine s'il s'agit du vrai Discord, d'un
/// stub écrit par low-cord, ou d'un stub écrit par autre chose. `our_patcher_path`
/// est le chemin ABSOLU du patcher.js qu'low-cord utiliserait lui-même
/// (dist_fetch::cached_patcher_path, ou l'override repo local) — sert
/// uniquement à reconnaître nos propres stubs, comparaison insensible à la
/// casse et aux `/` vs `\` (Windows).
pub fn inspect_asar(path: &Path, our_patcher_path: &Path) -> IoResult<StubOwner> {
    let mut f = File::open(path)?;

    let mut header_ints = [0u8; 16];
    f.read_exact(&mut header_ints)?;
    let header_string_size = u32::from_le_bytes(header_ints[12..16].try_into().unwrap());

    let mut header_bytes = vec![0u8; header_string_size as usize];
    f.read_exact(&mut header_bytes)?;
    // Le header est paddé avec des '0' ASCII (voir write_app_asar) — un JSON
    // valide s'arrête avant, serde ignore le reste silencieusement seulement
    // si on coupe au bon endroit. On cherche la fin du premier objet JSON.
    let header_str = String::from_utf8_lossy(&header_bytes);
    let json_end = header_str.rfind('}').map(|i| i + 1).unwrap_or(header_str.len());
    let header: ParsedAsarHeader = match serde_json::from_str(&header_str[..json_end]) {
        Ok(h) => h,
        Err(_) => return Ok(StubOwner::Genuine),
    };

    // Un vrai app.asar Discord embarque tout Electron/Discord — des centaines
    // d'entrées à la racine. Un stub de patcher (low-cord/Vencord/Equicord) n'a
    // toujours que index.js + package.json.
    if header.files.len() > 4 || !header.files.contains_key("index.js") {
        return Ok(StubOwner::Genuine);
    }

    let Some(index_entry) = header.files.get("index.js") else {
        return Ok(StubOwner::Genuine);
    };
    let Ok(offset) = index_entry.offset.parse::<u64>() else {
        return Ok(StubOwner::Genuine);
    };

    // Les données commencent après le header PADDÉ (aligned_size), pas après
    // sa longueur brute (header_string_size) — même calcul que write_app_asar.
    // Oublier ça décale la lecture de 1-3 octets dès que le JSON du header
    // n'est pas déjà un multiple de 4, et fait lire n'importe quoi ensuite
    // (bug réel : un stub low-cord valide était alors pris pour un app.asar
    // Discord d'origine, faute de retrouver un require() cohérent).
    let alignment: u32 = 4;
    let aligned_size = (header_string_size + alignment - 1) & !(alignment - 1);
    let data_start = 16 + aligned_size as u64;
    let mut index_js_bytes = vec![0u8; index_entry.size as usize];
    {
        use std::io::{Seek, SeekFrom};
        f.seek(SeekFrom::Start(data_start + offset))?;
        f.read_exact(&mut index_js_bytes)?;
    }
    let index_js = String::from_utf8_lossy(&index_js_bytes);

    let Some(require_path) = extract_require_path(&index_js) else {
        return Ok(StubOwner::Genuine);
    };

    let normalize = |s: &str| s.to_lowercase().replace('\\', "/");
    if normalize(&require_path) == normalize(&our_patcher_path.to_string_lossy()) {
        Ok(StubOwner::LowCord { build_sha: extract_build_sha(&index_js) })
    } else {
        Ok(StubOwner::Foreign { require_path })
    }
}
