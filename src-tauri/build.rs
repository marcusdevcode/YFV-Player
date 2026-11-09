use std::{env, fs, path::PathBuf};

fn main() {
    // The languages are the files in ../src/locales/*.json (the file name is the language code).
    // The native Language menu is built from this list, so adding a file adds a menu entry.
    println!("cargo:rerun-if-changed=../src/locales");
    let mut languages: Vec<(String, String)> = Vec::new();
    // The native menu texts: every "menu.*" string of every language.
    let mut menus: Vec<(String, Vec<(String, String)>)> = Vec::new();
    for entry in fs::read_dir("../src/locales").expect("src/locales is missing") {
        let path = entry.expect("cannot read src/locales").path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let code = path.file_stem().and_then(|s| s.to_str()).unwrap_or_default().to_string();
        let json: serde_json::Value = serde_json::from_str(&fs::read_to_string(&path).expect("cannot read a locale file"))
            .unwrap_or_else(|e| panic!("{} is not valid JSON: {e}", path.display()));
        let name = json["name"].as_str().unwrap_or(&code).to_string();
        let mut texts = Vec::new();
        if let Some(strings) = json["strings"].as_object() {
            for (key, value) in strings {
                if let (Some(k), Some(v)) = (key.strip_prefix("menu."), value.as_str()) {
                    texts.push((k.to_string(), v.to_string()));
                }
            }
        }
        menus.push((code.clone(), texts));
        languages.push((code, name));
    }
    // English first, the rest by code.
    languages.sort_by(|a, b| (a.0 != "en", &a.0).cmp(&(b.0 != "en", &b.0)));

    let mut out = String::from("pub const LANGUAGES: &[(&str, &str)] = &[\n");
    for (code, name) in &languages {
        out.push_str(&format!("    ({code:?}, {name:?}),\n"));
    }
    out.push_str("];\n");
    out.push_str("pub const LOCALE_MENUS: &[(&str, &[(&str, &str)])] = &[\n");
    for (code, texts) in &menus {
        out.push_str(&format!("    ({code:?}, &[\n"));
        for (k, v) in texts {
            out.push_str(&format!("        ({k:?}, {v:?}),\n"));
        }
        out.push_str("    ]),\n");
    }
    out.push_str("];\n");
    fs::write(PathBuf::from(env::var("OUT_DIR").unwrap()).join("languages.rs"), out).unwrap();

    tauri_build::build()
}
