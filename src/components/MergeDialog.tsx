import { useMergeStore } from "../store/mergeStore";
import { formatBytes, formatTime } from "../utils";

const PHASE_LABEL = { reading: "Reading files…", writing: "Writing the merged file…", finishing: "Finishing…" } as const;

/** Progress window for "merge video + audio". Updates only when the backend sends progress. */
export default function MergeDialog() {
  const { status, phase, done, total, speed, error, videoName, audioName, cancel, dismiss } = useMergeStore();
  if (status === "idle") return null;

  const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
  const eta = speed > 0 && total > done ? (total - done) / speed : 0;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Merging video and audio">
      <div className="modal">
        <h2>{status === "error" ? "Merge failed" : "Merging into one file"}</h2>
        <p className="modal-sub">
          {videoName} + {audioName}
        </p>

        {status === "error" ? (
          <>
            <p className="modal-error">{error}</p>
            <div className="modal-actions">
              <button onClick={dismiss}>Close</button>
            </div>
          </>
        ) : (
          <>
            <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
              <div className="progress-bar" style={{ width: `${pct}%` }} />
            </div>
            <div className="progress-row">
              <span>{phase === "writing" ? `${pct.toFixed(0)}%` : PHASE_LABEL[phase]}</span>
              {phase === "writing" && (
                <span>
                  {formatBytes(done)} of {formatBytes(total)}
                  {speed > 0 && ` · ${formatBytes(speed)}/s`}
                  {eta > 0 && ` · ${formatTime(eta)} left`}
                </span>
              )}
            </div>
            <div className="modal-actions">
              <button onClick={cancel}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
