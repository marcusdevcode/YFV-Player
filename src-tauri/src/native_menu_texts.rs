//! The texts of the native menu bar in every language. They come from the "menu.*" strings of
//! src/locales/*.json (build.rs embeds them), so a language file translates the menu too.

use std::sync::Mutex;

/// `LANGUAGES` and `LOCALE_MENUS`, made by build.rs.
mod generated {
    include!(concat!(env!("OUT_DIR"), "/languages.rs"));
}
pub use generated::LANGUAGES;

/// The text for a menu key in a language. A missing translation falls back to English.
/// `{name}` is replaced with the app name.
pub fn menu_text(code: &str, key: &str, app_name: &str) -> String {
    let find = |lang: &str| {
        generated::LOCALE_MENUS
            .iter()
            .find(|(c, _)| *c == lang)
            .and_then(|(_, texts)| texts.iter().find(|(k, _)| *k == key))
            .map(|(_, v)| *v)
    };
    find(code).or_else(|| find("en")).unwrap_or(key).replace("{name}", app_name)
}

type Setter = Box<dyn Fn(&str) + Send + Sync>;

/// Every translatable menu item: its key and how to change its text.
#[derive(Default)]
pub struct MenuTexts {
    pub items: Mutex<Vec<(String, Setter)>>,
}

impl MenuTexts {
    pub fn add(&self, key: &str, setter: Setter) {
        self.items.lock().unwrap().push((key.to_string(), setter));
    }

    /// Switch the whole menu bar to a language.
    pub fn apply(&self, code: &str, app_name: &str) {
        for (key, set) in self.items.lock().unwrap().iter() {
            set(&menu_text(code, key, app_name));
        }
    }
}
