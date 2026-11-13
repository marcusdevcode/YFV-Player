import { useRef, useState } from "react";
import { useT } from "../translate";
import { finishedPaths, useDownloadQueueStore, type DownloadJob } from "../store/downloadQueueStore";
import { useInterfaceStore } from "../store/interfaceStore";
import { usePlaylistLibraryStore } from "../store/playlistLibraryStore";
import { openContextMenu, type ContextMenuItem } from "../store/contextMenuStore";
import {
  cancelDownload,
  downloadNow,
  forgetDownload,
  moveDownload,
  pauseAllDownloads,
  pauseDownload,
  resumeAllDownloads,
  resumeDownload,
  retryDownload,
} from "../youtubeApi";
import { formatBytes } from "../textFormatting";
import DownloadPartBars from "./DownloadPartBars";
import { useStatusLabel } from "./DownloadProgressPopup";
import ScrollArea from "./ScrollArea";

type Tab = "queue" | "history";

/** The download manager: the queue (reorder = change priority) and the history. */
export default function DownloadManagerDialog() {
  const open = useInterfaceStore((s) => s.downloadsOpen);
  const { queue, history, holdAll } = useDownloadQueueStore();
  const [tab, setTab] = useState<Tab>("queue");
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const statusLabel = useStatusLabel();
  const { t, language } = useT();

  if (!open) return null;
  const close = () => useInterfaceStore.getState().setDownloadsOpen(false);

  // Reorder with pointer events, like the track list.
  const overIndex = (clientY: number) => {
    const rows = Array.from(listRef.current?.children ?? []) as HTMLElement[];
    let over = 0;
    rows.forEach((row, i) => {
      const r = row.getBoundingClientRect();
      if (clientY > r.top + r.height / 2) over = i;
    });
    return over;
  };
  const endDrag = (commit: boolean) => {
    if (drag && commit && drag.from !== drag.over) void moveDownload(queue[drag.from].id, drag.over);
    setDrag(null);
  };

  const queueMenu = (job: DownloadJob, index: number): ContextMenuItem[] => [
    { label: t("downloads.now"), disabled: index === 0 && job.status === "downloading", onSelect: () => void downloadNow(job.id) },
    { label: t("downloads.moveTop"), disabled: index === 0, onSelect: () => void moveDownload(job.id, 0) },
    "separator",
    job.status === "paused" || job.status === "needsSignIn"
      ? { label: t("downloads.resume"), onSelect: () => void resumeDownload(job.id) }
      : { label: t("downloads.pause"), onSelect: () => void pauseDownload(job.id) },
    "separator",
    { label: t("downloads.cancel"), onSelect: () => void cancelDownload(job.id, false) },
    { label: t("downloads.cancelDelete"), danger: true, onSelect: () => void cancelDownload(job.id, true) },
  ];

  function play(job: DownloadJob) {
    const paths = finishedPaths(job);
    if (!paths) return;
    close();
    usePlaylistLibraryStore.getState().playSource({ ...paths, title: job.title });
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <ScrollArea className="modal wide downloads-manager" role="dialog" aria-label={t("downloads.title")} onClick={(e) => e.stopPropagation()}>
        <h2>{t("downloads.title")}</h2>
        <div className="tabs" role="tablist">
          <button role="tab" className={tab === "queue" ? "active" : ""} aria-selected={tab === "queue"} onClick={() => setTab("queue")}>
            {t("downloads.queue")} ({queue.length})
          </button>
          <button role="tab" className={tab === "history" ? "active" : ""} aria-selected={tab === "history"} onClick={() => setTab("history")}>
            {t("downloads.history")} ({history.length})
          </button>
          <span className="spacer" />
          {tab === "queue" && queue.length > 0 && (
            <button onClick={() => void (holdAll ? resumeAllDownloads() : pauseAllDownloads())}>
              {holdAll ? t("downloads.resumeAll") : t("downloads.pauseAll")}
            </button>
          )}
          {tab === "history" && history.length > 0 && <button onClick={() => void forgetDownload("")}>{t("downloads.clear")}</button>}
        </div>

        {tab === "queue" ? (
          <ScrollArea className="download-list">
<div className="scroll-rows" ref={listRef}>
            {queue.length === 0 && <p className="muted pad">{t("downloads.empty")}</p>}
            {queue.map((job, i) => (
              <div
                key={job.id}
                className={`download-row${drag?.from === i ? " dragging" : ""}${drag && drag.over === i && drag.from !== i ? (drag.over < drag.from ? " drop-before" : " drop-after") : ""}`}
                onContextMenu={(e) => openContextMenu(e, queueMenu(job, i))}
              >
                <span
                  className="grip"
                  title={t("downloads.dragHint")}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    e.currentTarget.setPointerCapture(e.pointerId);
                    setDrag({ from: i, over: i });
                  }}
                  onPointerMove={(e) => drag && setDrag({ from: drag.from, over: overIndex(e.clientY) })}
                  onPointerUp={() => endDrag(true)}
                  onPointerCancel={() => endDrag(false)}
                >
                  ⋮⋮
                </span>
                <img className="youtube-thumb" src={job.thumbnail} alt="" loading="lazy" />
                <div className="download-info">
                  <div className="download-title" title={job.title}>
                    {job.title}
                  </div>
                  <div className="muted">
                    {statusLabel(job.status)}
                    {job.message && job.status !== "downloading" ? ` · ${job.message}` : ""}
                  </div>
                  {(job.status === "downloading" || job.status === "waiting" || job.parts.some((p) => p.downloaded > 0)) && <DownloadPartBars job={job} />}
                </div>
                <div className="download-buttons">
                  <button disabled={i === 0} onClick={() => void moveDownload(job.id, 0)} title={t("downloads.moveTop")}>
                    ⤒
                  </button>
                  <button onClick={() => void downloadNow(job.id)} title={t("downloads.now")}>
                    ▶
                  </button>
                  {job.status === "paused" || job.status === "needsSignIn" ? (
                    <button onClick={() => void resumeDownload(job.id)}>{t("downloads.resume")}</button>
                  ) : (
                    <button onClick={() => void pauseDownload(job.id)}>{t("downloads.pause")}</button>
                  )}
                  <button onClick={() => void cancelDownload(job.id, false)}>{t("downloads.cancel")}</button>
                </div>
              </div>
            ))}
          </div>
</ScrollArea>
        ) : (
          <ScrollArea className="download-list">
            {history.length === 0 && <p className="muted pad">{t("downloads.historyEmpty")}</p>}
            {history.map((job) => {
              const size = job.parts.reduce((sum, p) => sum + (p.total ?? p.downloaded), 0);
              return (
                <div key={job.id} className="download-row">
                  <img className="youtube-thumb" src={job.thumbnail} alt="" loading="lazy" />
                  <div className="download-info">
                    <div className="download-title" title={job.title}>
                      {job.title}
                    </div>
                    <div className={job.status === "failed" ? "warn" : "muted"}>
                      {[
                        statusLabel(job.status),
                        job.gotHeight ? `${job.gotHeight}p` : "",
                        size ? formatBytes(size) : "",
                        job.finishedAt ? new Date(job.finishedAt).toLocaleString(language) : "",
                        job.status === "failed" ? job.message : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </div>
                  <div className="download-buttons">
                    {job.status === "done" && <button onClick={() => play(job)}>{t("downloads.play")}</button>}
                    {(job.status === "failed" || job.status === "cancelled") && (
                      <button onClick={() => void retryDownload(job.id)}>{t("downloads.retry")}</button>
                    )}
                    <button onClick={() => void forgetDownload(job.id)}>{t("downloads.remove")}</button>
                  </div>
                </div>
              );
            })}
          </ScrollArea>
        )}

        <div className="modal-actions">
          <button className="primary" onClick={close}>
            {t("common.done")}
          </button>
        </div>
      </ScrollArea>
    </div>
  );
}
