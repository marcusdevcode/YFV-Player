import { LOCALES, defaultSidebarSide, type SidebarSide } from "../locales";
import { useT } from "../translate";
import { usePlayerStore } from "../store/playerStore";
import { useInterfaceStore } from "../store/interfaceStore";

/** Settings: the language and where the playlist panel sits. */
export default function SettingsDialog() {
  const open = useInterfaceStore((s) => s.settingsOpen);
  const language = useInterfaceStore((s) => s.language);
  const side = useInterfaceStore((s) => s.sidebarSide);
  const pauseInBackground = usePlayerStore((s) => s.pauseVideoInBackground);
  const ui = useInterfaceStore.getState();
  const { t } = useT();

  if (!open) return null;
  const close = () => ui.setSettingsOpen(false);
  const languageDefault = defaultSidebarSide(language);

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" role="dialog" aria-label={t("settings.title")} onClick={(e) => e.stopPropagation()}>
        <h2>{t("settings.title")}</h2>

        <label className="field">
          <span>{t("settings.language")}</span>
          <select value={language} onChange={(e) => ui.setLanguage(e.target.value)}>
            {Object.entries(LOCALES).map(([code, locale]) => (
              <option key={code} value={code}>
                {locale.name}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>{t("settings.panel")}</span>
          <select value={side} onChange={(e) => ui.setSidebarSide(e.target.value as SidebarSide)}>
            <option value="left">{t("settings.left")}</option>
            <option value="right">{t("settings.right")}</option>
          </select>
        </label>
        <label className="field check">
          <span>
            {t("settings.pauseInBackground")}
            <br />
            <span className="muted">{t("settings.pauseInBackgroundHint")}</span>
          </span>
          <input
            type="checkbox"
            checked={pauseInBackground}
            onChange={(e) => usePlayerStore.getState().setPauseVideoInBackground(e.target.checked)}
          />
        </label>

        <p className="muted">
          {languageDefault === "left" ? t("settings.defaultLeft") : t("settings.defaultRight")}
          {side !== languageDefault && (
            <>
              {" "}
              <button onClick={() => ui.setSidebarSide(languageDefault)}>{t("settings.useDefault")}</button>
            </>
          )}
          <br />
          {t("settings.explain")}
        </p>

        <div className="modal-actions">
          <button className="primary" onClick={close}>
            {t("common.done")}
          </button>
        </div>
      </div>
    </div>
  );
}
