import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { LOCALES, DEFAULT_LANGUAGE, registerLocale, unregisterLocale, type Locale } from "./locales";
import { tr } from "./translate";
import { useInterfaceStore } from "./store/interfaceStore";
import { usePlaylistLibraryStore } from "./store/playlistLibraryStore";

const CODE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** What is wrong with a language file, or null when it is usable. */
function languageProblem(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "not a language file";
  const v = value as Record<string, unknown>;
  if (typeof v.name !== "string" || !v.name.trim() || v.name.length > 40) return "\"name\" must be a text of 1 to 40 characters";
  if (v.dir !== undefined && v.dir !== "ltr" && v.dir !== "rtl") return "\"dir\" must be \"ltr\" or \"rtl\"";
  if (v.sidebarSide !== undefined && v.sidebarSide !== "left" && v.sidebarSide !== "right") return "\"sidebarSide\" must be \"left\" or \"right\"";
  if (typeof v.strings !== "object" || v.strings === null || Array.isArray(v.strings)) return "\"strings\" must be an object of texts";
  for (const [key, text] of Object.entries(v.strings)) {
    if (typeof text !== "string" || !text) return `the text of "${key}" must not be empty`;
  }
  return null;
}

function toLocale(value: Record<string, unknown>): Locale {
  return {
    name: value.name as string,
    dir: value.dir === "rtl" ? "rtl" : "ltr",
    sidebarSide: value.sidebarSide === "right" ? "right" : "left",
    strings: value.strings as Record<string, string>,
  };
}

/** Languages the user imported earlier come back at startup (before the saved language is applied). */
export async function loadImportedLanguages() {
  try {
    for (const [code, text] of await invoke<[string, string][]>("language_list")) {
      try {
        const value = JSON.parse(text);
        if (CODE.test(code) && !languageProblem(value)) registerLocale(code, toLocale(value));
      } catch {
        /* a broken file is skipped */
      }
    }
  } catch {
    /* no languages folder yet */
  }
}

/** A language file with every text: the language's own, and English for what it lacks, ready to translate. */
function languageFileText(code: string): string {
  const own = LOCALES[code];
  const english = LOCALES[DEFAULT_LANGUAGE];
  const strings: Record<string, string> = { ...english.strings, ...own.strings };
  return JSON.stringify({ $schema: "../../schemas/locale.schema.json", name: own.name, dir: own.dir, sidebarSide: own.sidebarSide, strings }, null, 2) + "\n";
}

/** Settings → Export this language…: save the language as `<code>.json`. */
export async function exportTranslation(code: string) {
  const notice = usePlaylistLibraryStore.getState().setNotice;
  try {
    const path = await save({ defaultPath: `${code}.json`, filters: [{ name: tr("filter.language"), extensions: ["json"] }] });
    if (!path) return;
    await invoke("text_file_write", { path, text: languageFileText(code) });
    notice(tr("settings.translation.exportedOk"));
  } catch (e) {
    notice(tr("settings.translation.exportFailed", { error: String(e) }));
  }
}

/** Settings → Import a language…: the file name is the language code; the language is saved, added and selected. */
export async function importTranslation() {
  const notice = usePlaylistLibraryStore.getState().setNotice;
  try {
    const picked = await open({ multiple: false, filters: [{ name: tr("filter.language"), extensions: ["json"] }] });
    if (typeof picked !== "string") return;
    const code = picked.split(/[\\/]/).pop()!.replace(/\.json$/i, "");
    if (!CODE.test(code)) throw new Error(tr("settings.translation.badCode"));
    const text = await invoke<string>("text_file_read", { path: picked });
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(tr("appearance.notJson"));
    }
    const problem = languageProblem(value);
    if (problem) throw new Error(problem);
    const locale = toLocale(value as Record<string, unknown>);
    await invoke("language_save", { code, json: JSON.stringify(value) });
    registerLocale(code, locale);
    useInterfaceStore.getState().setLanguage(code);
    notice(tr("settings.translation.importedOk", { name: locale.name }));
  } catch (e) {
    notice(tr("settings.translation.importFailed", { error: e instanceof Error ? e.message : String(e) }));
  }
}

/** Remove the imported file of a language (a built-in language of that code comes back, else English is used). */
export async function removeImportedTranslation(code: string) {
  const notice = usePlaylistLibraryStore.getState().setNotice;
  try {
    await invoke("language_delete", { code });
    unregisterLocale(code);
    const ui = useInterfaceStore.getState();
    ui.setLanguage(LOCALES[code] ? code : DEFAULT_LANGUAGE);
    notice(tr("settings.translation.removedOk"));
  } catch (e) {
    notice(tr("settings.translation.importFailed", { error: String(e) }));
  }
}
