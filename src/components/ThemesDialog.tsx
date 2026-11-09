import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { SHOW_PREVIEW_BUTTON } from "../featureFlags";
import { useT } from "../translate";
import { usePlaylistLibraryStore } from "../store/playlistLibraryStore";
import { activeTheme, useThemeStore } from "../store/themeStore";
import { useInterfaceStore } from "../store/interfaceStore";
import {
  ALL_ICON_REFS,
  BUILTIN_THEMES,
  COLOR_GROUPS,
  COLOR_TOKENS,
  ICON_SLOTS,
  colorsOf,
  defaultIconRef,
  iconRefOf,
  isBuiltin,
  type ColorToken,
  type IconSlot,
  type ThemeBase,
} from "../theme/themeEngine";
import { IconByRef } from "./Icon";

const HEX = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;

/** Themes: choose, create, customize colors and icons, export and import. */
export default function ThemesDialog() {
  const isOpen = useInterfaceStore((s) => s.themesOpen);
  const custom = useThemeStore((s) => s.custom);
  const selected = useThemeStore((s) => s.selected);
  const theme = useThemeStore((s) => activeTheme(s));
  const { t, td } = useT();

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newBase, setNewBase] = useState<ThemeBase>("dark");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pickerSlot, setPickerSlot] = useState<IconSlot | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (pickerSlot) document.querySelector(".icon-tile.active")?.scrollIntoView({ block: "center" });
  }, [pickerSlot]);

  if (!isOpen) return null;
  const store = useThemeStore.getState();
  const notice = usePlaylistLibraryStore.getState().setNotice;
  const editing = custom.find((c) => c.id === selected) ?? null; // only your own themes can be changed
  /** The theme to change. A built-in (or system) theme is never changed: the first change makes your own copy of it. */
  const ensureEditable = (): string => {
    const now = useThemeStore.getState();
    const own = now.custom.find((c) => c.id === now.selected);
    if (own) return own.id;
    const shown = activeTheme(now);
    return now.create(`${themeName(shown.id, shown.name)} 2`, shown.base);
  };
  const colors = colorsOf(theme);
  const close = () => {
    setCreating(false);
    setPickerSlot(null);
    useInterfaceStore.getState().setThemesOpen(false);
  };
  function themeName(id: string, name: string) {
    return id === "dark" ? t("appearance.dark") : id === "light" ? t("appearance.light") : name;
  }

  async function exportTheme() {
    try {
      const path = await save({ defaultPath: `${theme.name}.json`, filters: [{ name: t("filter.theme"), extensions: ["json"] }] });
      const text = store.exportText(theme.id);
      if (path && text) {
        await invoke("text_file_write", { path, text });
        notice(t("appearance.exportedOk"));
      }
    } catch (e) {
      notice(t("appearance.exportFailed", { error: String(e) }));
    }
  }

  async function importTheme() {
    try {
      const picked = await open({ multiple: false, filters: [{ name: t("filter.theme"), extensions: ["json"] }] });
      if (typeof picked !== "string") return;
      const imported = useThemeStore.getState().importText(await invoke<string>("text_file_read", { path: picked }));
      notice(t("appearance.importedOk", { name: imported.name }));
    } catch (e) {
      notice(t("appearance.importFailed", { error: e instanceof Error ? e.message : String(e) }));
    }
  }

  /** Every color can be transparent: #rrggbbaa. A fully opaque color is stored as plain #rrggbb. */
  function setColor(token: ColorToken, value: string) {
    if (!HEX.test(value)) return;
    let lower = value.toLowerCase();
    if (lower.length === 9 && lower.endsWith("ff")) lower = lower.slice(0, 7);
    store.setColor(ensureEditable(), token, lower);
  }

  const query = search.trim().toLowerCase();
  const icons = ALL_ICON_REFS.filter((ref) => ref.toLowerCase().includes(query));

  return (
    <>
    <div className="modal-backdrop" onClick={close}>
      <div className="modal themes" role="dialog" aria-label={t("themes.title")} onClick={(e) => e.stopPropagation()}>
        <h2>{t("themes.title")}</h2>

        <div className="row">
          <label className="grow">
            <span>{t("appearance.theme")}</span>{" "}
            <select
              value={selected === "system" || BUILTIN_THEMES.concat(custom).some((x) => x.id === selected) ? selected : "system"}
              onChange={(e) => {
                setConfirmDelete(false);
                store.select(e.target.value);
              }}
            >
              <option value="system">{t("appearance.system")}</option>
              {BUILTIN_THEMES.map((b) => (
                <option key={b.id} value={b.id}>
                  {themeName(b.id, b.name)}
                </option>
              ))}
              {custom.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <button onClick={() => (setCreating(!creating), setNewName(""))}>{t("appearance.new")}</button>
          <button onClick={() => void importTheme()}>{t("appearance.import")}</button>
          <button onClick={() => void exportTheme()}>{t("appearance.export")}</button>
        </div>

        {selected === "system" && <p className="muted">{t("appearance.systemHint")}</p>}

        {creating && (
          <form
            className="row create-theme"
            onSubmit={(e) => {
              e.preventDefault();
              store.create(newName || t("appearance.newName"), newBase);
              setCreating(false);
            }}
          >
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t("appearance.newName")} autoFocus />
            <label>
              {t("appearance.newBase")}{" "}
              <select value={newBase} onChange={(e) => setNewBase(e.target.value as ThemeBase)}>
                <option value="dark">{t("appearance.dark")}</option>
                <option value="light">{t("appearance.light")}</option>
              </select>
            </label>
            <button type="submit" className="primary">
              {t("appearance.create")}
            </button>
          </form>
        )}

        {editing ? (
          <div className="row">
            <input
              key={editing.id + editing.name}
              className="name"
              defaultValue={editing.name}
              aria-label={t("appearance.nameLabel")}
              onBlur={(e) => store.rename(editing.id, e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
            {confirmDelete ? (
              <button
                className="danger"
                onClick={() => {
                  store.remove(editing.id);
                  setConfirmDelete(false);
                }}
              >
                {t("appearance.confirmDelete")}
              </button>
            ) : (
              <button onClick={() => setConfirmDelete(true)}>{t("appearance.delete")}</button>
            )}
          </div>
        ) : (
          <div className="row">
            <span className="muted grow">{t("appearance.readOnly")}</span>
            <button
              className="primary"
              onClick={() => {
                store.create(`${themeName(theme.id, theme.name)} 2`, theme.base, isBuiltin(theme.id) ? undefined : theme);
              }}
            >
              {t("appearance.createFromThis")}
            </button>
          </div>
        )}

        <div className="theme-scroll">
          <h3>{t("appearance.colors")}</h3>
          {COLOR_GROUPS.map((group) => (
            <section key={group.id} className="theme-group">
              <h4 title={group.description}>{td(`theme.group.${group.id}`, group.title)}</h4>
              {COLOR_TOKENS.filter((c) => c.group === group.id).map((token) => {
                const value = colors[token.id];
                const own = editing?.colors?.[token.id] !== undefined;
                const rgb = value.slice(0, 7);
                const alpha = value.length === 9 ? parseInt(value.slice(7), 16) : 255;
                const label = td(`theme.color.${token.id}`, token.title);
                return (
                  <div key={token.id} className={`color-row${own ? " own" : ""}`} title={token.description}>
                    <span className="color-label">{label}</span>
                    <input
                      type="color"
                      value={rgb}
                      aria-label={label}
                      onChange={(e) => setColor(token.id, e.target.value + alpha.toString(16).padStart(2, "0"))}
                    />
                    <span className="swatch" aria-hidden="true">
                      <i style={{ background: value }} />
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={255}
                      value={alpha}
                      title={`${t("appearance.opacity")}: ${Math.round((alpha / 255) * 100)}%`}
                      aria-label={`${label}: ${t("appearance.opacity")}`}
                      onChange={(e) => setColor(token.id, rgb + Number(e.target.value).toString(16).padStart(2, "0"))}
                    />
                    <input
                      key={value}
                      className="hex"
                      defaultValue={value}
                      spellCheck={false}
                      aria-label={`${label}: ${t("appearance.colorCode")}`}
                      onBlur={(e) => setColor(token.id, e.target.value)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") e.currentTarget.blur();
                      }}
                    />
                    <button
                      className="mini-btn"
                      disabled={!own}
                      title={t("appearance.resetColor")}
                      onClick={() => editing && store.setColor(editing.id, token.id, null)}
                    >
                      ↺
                    </button>
                  </div>
                );
              })}
            </section>
          ))}

          <h3>{t("appearance.icons")}</h3>
          <section className="theme-group">
            {ICON_SLOTS.filter((slot) => SHOW_PREVIEW_BUTTON || slot.id !== "capturePreview").map((slot) => {
              const ref = iconRefOf(theme, slot.id);
              const own = editing?.icons?.[slot.id] !== undefined;
              const label = td(`theme.icon.${slot.id}`, slot.title);
              return (
                <div key={slot.id} className={`icon-row${own ? " own" : ""}`} title={slot.description}>
                  <span className="icon-preview">
                    <IconByRef icon={ref} />
                  </span>
                  <span className="color-label">{label}</span>
                  <span className="muted icon-name">{ref}</span>
                  <button onClick={() => (setSearch(""), setPickerSlot(slot.id))}>
                    {t("appearance.changeIcon")}
                  </button>
                  <button className="mini-btn" disabled={!own} title={t("appearance.resetIcon")} onClick={() => editing && store.setIcon(editing.id, slot.id, null)}>
                    ↺
                  </button>
                </div>
              );
            })}
          </section>
        </div>

        <div className="modal-actions">
          <button className="primary" onClick={close}>
            {t("common.done")}
          </button>
        </div>

      </div>
    </div>
    {pickerSlot && (
      <div className="modal-backdrop picker-backdrop" onClick={() => setPickerSlot(null)}>
        <div className="modal picker" role="dialog" aria-label={t("appearance.pickIcon")} onClick={(e) => e.stopPropagation()}>
          <h2>
            {t("appearance.pickIcon")}: {td(`theme.icon.${pickerSlot}`, ICON_SLOTS.find((x) => x.id === pickerSlot)?.title ?? "")}
          </h2>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("appearance.searchIcons")}
            autoFocus
            onKeyDown={(e) => e.stopPropagation()}
          />
          <div className="icon-grid">
            <button
              className={`icon-tile${editing?.icons?.[pickerSlot] === undefined ? " active" : ""}`}
              title={`${t("appearance.defaultIcon")} (${defaultIconRef(pickerSlot)})`}
              onClick={() => {
                const own = useThemeStore.getState().custom.find((c) => c.id === useThemeStore.getState().selected);
                if (own) store.setIcon(own.id, pickerSlot, null);
                setPickerSlot(null);
              }}
            >
              <IconByRef icon={defaultIconRef(pickerSlot)} />
              <span>{t("appearance.defaultIcon")}</span>
            </button>
            {icons.map((ref) => (
              <button
                key={ref}
                className={`icon-tile${editing?.icons?.[pickerSlot] === ref ? " active" : ""}`}
                title={ref}
                aria-pressed={editing?.icons?.[pickerSlot] === ref}
                onClick={() => {
                  store.setIcon(ensureEditable(), pickerSlot, ref);
                  setPickerSlot(null);
                }}
              >
                <IconByRef icon={ref} />
                <span>{ref.split(":")[1]}</span>
              </button>
            ))}
          </div>
          {icons.length === 0 && <p className="muted">{t("appearance.noIcons")}</p>}
          <div className="modal-actions">
            <button onClick={() => setPickerSlot(null)}>{t("common.cancel")}</button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
