import { useT } from "../translate";
import { useDownloadQueueStore, type DownloadJob } from "../store/downloadQueueStore";
import { formatBytes, formatSpeed, formatTime } from "../textFormatting";

/** One progress bar per file of a download (video, audio, or both in one), with speed and time left. */
export default function DownloadPartBars({ job }: { job: DownloadJob }) {
  const live = useDownloadQueueStore((s) => s.live[job.id]);
  const { t } = useT();
  const labels = { together: t("downloads.part.together"), video: t("downloads.part.video"), audio: t("downloads.part.audio") };

  return (
    <div className="part-bars">
      {job.parts.map((part, index) => {
        // The newest numbers come from progress events; the snapshot has the rest.
        const now = job.status === "downloading" && live && live.part === index ? live : part;
        const percent = part.done ? 100 : now.total ? Math.min(100, (now.downloaded / now.total) * 100) : null;
        return (
          <div key={index} className="part-bar">
            <div className="part-line">
              <span>{labels[part.kind]}</span>
              <span className="muted">
                {part.done
                  ? t("downloads.partDone")
                  : [
                      percent !== null ? `${percent.toFixed(0)}%` : "",
                      now.total ? `${formatBytes(now.downloaded)} / ${formatBytes(now.total)}` : now.downloaded ? formatBytes(now.downloaded) : "",
                      job.status === "downloading" && now.speed ? formatSpeed(now.speed) : "",
                      job.status === "downloading" && now.eta ? t("downloads.eta", { time: formatTime(now.eta) }) : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
              </span>
            </div>
            <div className="progress">
              <div
                className={`progress-bar${percent === null && job.status === "downloading" ? " indeterminate" : ""}`}
                style={{ width: percent === null ? "100%" : `${percent}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
