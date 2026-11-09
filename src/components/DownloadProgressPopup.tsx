import { useT } from "../translate";
import { summarizeBatch, useDownloadQueueStore, type JobStatus } from "../store/downloadQueueStore";
import { usePlayerStore } from "../store/playerStore";
import { useInterfaceStore } from "../store/interfaceStore";
import { cancelDownload, pauseAllDownloads, pauseDownload, resumeAllDownloads, resumeDownload } from "../youtubeApi";
import DownloadPartBars from "./DownloadPartBars";

export function useStatusLabel() {
  const { t } = useT();
  const labels: Record<JobStatus, string> = {
    queued: t("downloads.status.queued"),
    downloading: t("downloads.status.downloading"),
    waiting: t("downloads.status.waiting"),
    needsSignIn: t("downloads.status.needsSignIn"),
    paused: t("downloads.status.paused"),
    done: t("downloads.status.done"),
    failed: t("downloads.status.failed"),
    cancelled: t("downloads.status.cancelled"),
  };
  return (status: JobStatus) => labels[status];
}

/**
 * The small progress window in the corner. It appears when downloads start and goes away when the
 * queue is empty. It only shows what the download engine (Rust) reports; the downloads themselves
 * never depend on it, on the player or on the window being in front.
 */
export default function DownloadProgressPopup() {
  const { queue, history, live, holdAll, delaySeconds, alert, popupCollapsed } = useDownloadQueueStore();
  const fullscreen = usePlayerStore((s) => s.fullscreen);
  const store = useDownloadQueueStore.getState();
  const statusLabel = useStatusLabel();
  const { t, tn } = useT();

  // Nothing covers the picture in fullscreen.
  if (fullscreen || (queue.length === 0 && !alert)) return null;
  const current = queue.find((j) => j.status === "downloading" || j.status === "waiting") ?? queue[0];
  const waitingCount = queue.filter((j) => j !== current).length;
  const summary = queue.length > 0 ? summarizeBatch(queue, history, live) : null;

  return (
    <div className="download-popup" role="status">
      <div className="download-popup-head">
        <strong>{t("downloads.title")}</strong>
        <span className="muted download-count">{queue.length ? tn("downloads.inQueue", queue.length) : ""}</span>
        <button onClick={() => store.setPopupCollapsed(!popupCollapsed)} title={popupCollapsed ? t("downloads.expand") : t("downloads.collapse")}>
          {popupCollapsed ? "▲" : "▼"}
        </button>
      </div>
      <div className="download-popup-tools">
        {popupCollapsed && queue.length > 0 && (
          // Minimized: one button pauses or resumes everything.
          <button onClick={() => void (holdAll ? resumeAllDownloads() : pauseAllDownloads())}>
            {holdAll ? t("downloads.resumeAll") : t("downloads.pauseAll")}
          </button>
        )}
        <button className="spacer-button" onClick={() => useInterfaceStore.getState().setDownloadsOpen(true)}>
          {t("downloads.openManager")}
        </button>
      </div>

      {alert && (
        <div className="download-alert">
          <span>{alert.kind === "signIn" ? t("downloads.alert.signIn") : t("downloads.alert.disk", { detail: alert.message })}</span>
          <button onClick={store.dismissAlert}>{t("common.close")}</button>
        </div>
      )}

      {current && !popupCollapsed && (
        <div className="download-current">
          <div className="download-title" title={current.title}>
            {current.title}
          </div>
          <div className="muted">
            {statusLabel(current.status)}
            {current.message && current.status !== "downloading" ? ` · ${current.message}` : ""}
          </div>
          <DownloadPartBars job={current} />
          <div className="download-actions">
            {current.status === "paused" || current.status === "needsSignIn" ? (
              <button onClick={() => void resumeDownload(current.id)}>{t("downloads.resume")}</button>
            ) : (
              <button onClick={() => void pauseDownload(current.id)}>{t("downloads.pause")}</button>
            )}
            <button onClick={() => void cancelDownload(current.id, false)}>{t("downloads.cancel")}</button>
          </div>
        </div>
      )}

      {current && popupCollapsed && (
        <>
          <div className="muted download-collapsed" title={current.title}>
            {holdAll ? t("downloads.status.paused") : statusLabel(current.status)} · {current.title}
          </div>
          <div className="progress">
            <div className="progress-bar" style={{ width: `${(summary!.fraction * 100).toFixed(1)}%` }} />
          </div>
          <div className="part-line muted">
            <span>{t("downloads.summary.videos", { done: summary!.videosDone, total: summary!.videosTotal })}</span>
            {summary!.audiosTotal > 0 && (
              <span>{t("downloads.summary.audios", { done: summary!.audiosDone, total: summary!.audiosTotal })}</span>
            )}
            <span>{(summary!.fraction * 100).toFixed(0)}%</span>
          </div>
        </>
      )}

      {delaySeconds > 0 && <div className="muted">{t("downloads.nextIn", { seconds: delaySeconds })}</div>}
      {waitingCount > 0 && !popupCollapsed && <div className="muted">{tn("downloads.moreWaiting", waitingCount)}</div>}
      {holdAll && queue.length > 0 && !popupCollapsed && (
        <div className="download-alert">
          <span>{t("downloads.onHold")}</span>
          <button onClick={() => void resumeAllDownloads()}>{t("downloads.resumeAll")}</button>
        </div>
      )}
    </div>
  );
}
