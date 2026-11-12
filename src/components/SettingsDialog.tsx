import { useState } from "react";
import { open as chooseFolder } from "@tauri-apps/plugin-dialog";
import { LOCALES, defaultSidebarSide, isBuiltInLanguage, type SidebarSide } from "../locales";
import { useT } from "../translate";
import { usePlayerStore } from "../store/playerStore";
import { useInterfaceStore } from "../store/interfaceStore";
import {
  AUDIO_QUALITIES,
  COOKIE_BROWSERS,
  VIDEO_QUALITIES,
  useDownloadSettingsStore,
  type DownloadMode,
} from "../store/downloadSettingsStore";
import { exportTranslation, importTranslation, removeImportedTranslation } from "../translationFiles";
import { downloaderVersion, restoreDownloader, updateDownloader } from "../youtubeApi";

/** Settings: the language and where the playlist panel sits. */
export default function SettingsDialog() {
  const open = useInterfaceStore((s) => s.settingsOpen);
  const language = useInterfaceStore((s) => s.language);
  const side = useInterfaceStore((s) => s.sidebarSide);
  const pauseInBackground = usePlayerStore((s) => s.pauseVideoInBackground);
  const ui = useInterfaceStore.getState();
  const d = useDownloadSettingsStore();
  const { t } = useT();
  const [downloaderNote, setDownloaderNote] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  async function runDownloaderAction(action: () => Promise<unknown>, done: (result: unknown) => string) {
    setWorking(true);
    try {
      setDownloaderNote(done(await action()));
    } catch (e) {
      setDownloaderNote(t("settings.downloads.failed", { error: String(e) }));
    } finally {
      setWorking(false);
    }
  }

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

        <div className="row">
          <span className="muted">{t("settings.translation")}</span>
          <button onClick={() => void exportTranslation(language)}>{t("settings.translation.export")}</button>
          <button onClick={() => void importTranslation()}>{t("settings.translation.import")}</button>
          {!isBuiltInLanguage(language) && (
            <button onClick={() => void removeImportedTranslation(language)}>{t("settings.translation.remove")}</button>
          )}
        </div>
        <p className="muted">{t("settings.translation.hint")}</p>

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

        <h3>{t("settings.downloads")}</h3>
        <label className="field">
          <span>{t("quality.how")}</span>
          <select value={d.mode} onChange={(e) => d.change({ mode: e.target.value as DownloadMode })}>
            <option value="separate">{t("quality.modeSeparate")}</option>
            <option value="together">{t("quality.modeTogether")}</option>
            <option value="audioOnly">{t("quality.modeAudio")}</option>
          </select>
        </label>
        <label className="field">
          <span>{t("quality.video")}</span>
          <select value={d.videoQuality} onChange={(e) => d.change({ videoQuality: e.target.value })}>
            {VIDEO_QUALITIES.map((q) => (
              <option key={q} value={q}>
                {q === "best" ? t("quality.best") : `${q}p`}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t("quality.audio")}</span>
          <select value={d.audioQuality} onChange={(e) => d.change({ audioQuality: e.target.value })}>
            {AUDIO_QUALITIES.map((q) => (
              <option key={q} value={q}>
                {t(q === "best" ? "quality.audioBest" : q === "medium" ? "quality.audioMedium" : "quality.audioLow")}
              </option>
            ))}
          </select>
        </label>
        <div className="row">
          <span className="muted">{t("quality.folder")}</span>
          <input type="text" value={d.folder} placeholder={t("quality.folderDefault")} onChange={(e) => d.change({ folder: e.target.value })} />
          <button
            onClick={async () => {
              const picked = await chooseFolder({ directory: true, multiple: false, defaultPath: d.folder || undefined });
              if (typeof picked === "string") d.change({ folder: picked });
            }}
          >
            {t("quality.browse")}
          </button>
        </div>
        <label className="field">
          <span>{t("settings.downloads.delay")}</span>
          <input
            type="number"
            min={0}
            max={60}
            value={d.delayBetweenVideos}
            onChange={(e) => d.change({ delayBetweenVideos: Math.max(0, Math.min(60, Math.round(Number(e.target.value) || 0))) })}
          />
        </label>
        <label className="field">
          <span>{t("settings.downloads.speed")}</span>
          <input
            type="number"
            min={0}
            value={d.speedLimitKbps}
            onChange={(e) => d.change({ speedLimitKbps: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
          />
        </label>
        <label className="field check">
          <span>{t("settings.downloads.autoResume")}</span>
          <input type="checkbox" checked={d.autoResume} onChange={(e) => d.change({ autoResume: e.target.checked })} />
        </label>
        <label className="field">
          <span>
            {t("settings.downloads.cookies")}
            <br />
            <span className="muted">{t("settings.downloads.cookiesHint")}</span>
          </span>
          <select value={d.cookiesBrowser} onChange={(e) => d.change({ cookiesBrowser: e.target.value })}>
            {COOKIE_BROWSERS.map((b) => (
              <option key={b} value={b}>
                {b === "" ? t("settings.downloads.cookiesNone") : b}
              </option>
            ))}
          </select>
        </label>
        <div className="row">
          <button
            disabled={working}
            onClick={() => void runDownloaderAction(downloaderVersion, (v) => t("settings.downloads.version", { version: String(v) }))}
          >
            {t("settings.downloads.checkVersion")}
          </button>
          <button
            disabled={working}
            onClick={() => void runDownloaderAction(updateDownloader, (v) => t("settings.downloads.updated", { version: String(v) }))}
          >
            {working ? t("settings.downloads.updating") : t("settings.downloads.update")}
          </button>
          <button disabled={working} onClick={() => void runDownloaderAction(restoreDownloader, () => t("settings.downloads.restored"))}>
            {t("settings.downloads.restore")}
          </button>
          <button onClick={d.reset}>{t("settings.downloads.reset")}</button>
        </div>
        {downloaderNote && <p className="muted">{downloaderNote}</p>}

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
