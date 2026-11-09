import { useMergeStore } from "../store/mergeStore";
import { useT } from "../translate";
import { formatBytes, formatTime } from "../textFormatting";

/** Progress window for "merge video + audio". Updates only when the backend sends progress. */
export default function MergeDialog() {
  const { status, phase, done, total, speed, error, videoName, audioName, cancel, dismiss } = useMergeStore();
  const { t } = useT();
  if (status === "idle") return null;

  const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
  const eta = speed > 0 && total > done ? (total - done) / speed : 0;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={t("merge.aria")}>
      <div className="modal">
        <h2>{status === "error" ? t("merge.failed") : t("merge.title")}</h2>
        <p className="modal-sub">
          {videoName} + {audioName}
        </p>

        {status === "error" ? (
          <>
            <p className="modal-error">{error}</p>
            <div className="modal-actions">
              <button onClick={dismiss}>{t("common.close")}</button>
            </div>
          </>
        ) : (
          <>
            <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
              <div className="progress-bar" style={{ width: `${pct}%` }} />
            </div>
            <div className="progress-row">
              <span>{phase === "writing" ? `${pct.toFixed(0)}%` : t(`merge.${phase}`)}</span>
              {phase === "writing" && (
                <span>
                  {t("merge.ofTotal", { done: formatBytes(done), total: formatBytes(total) })}
                  {speed > 0 && ` · ${formatBytes(speed)}/s`}
                  {eta > 0 && ` · ${t("merge.left", { time: formatTime(eta) })}`}
                </span>
              )}
            </div>
            <div className="modal-actions">
              <button onClick={cancel}>{t("common.cancel")}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
