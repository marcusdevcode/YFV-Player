import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

type Phase = "idle" | "checking" | "available" | "downloading" | "uptodate" | "error";

/**
 * Checks GitHub Releases for a newer signed build, on startup (silently) and from
 * Help → Check for Updates… (with feedback), and offers to install it.
 */
export default function UpdateBanner() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState(0);

  // Result messages stay until the user closes them (no timers).
  const flash = useCallback((p: Phase, msg: string) => {
    setPhase(p);
    setMessage(msg);
  }, []);

  const runCheck = useCallback(
    async (manual: boolean) => {
      if (manual) setPhase("checking");
      try {
        const u = await check();
        if (u) {
          setUpdate(u);
          setPhase("available");
        } else if (manual) {
          flash("uptodate", "You're up to date.");
        }
      } catch {
        // Offline, no release yet, or running in dev: only tell the user if they asked.
        if (manual) flash("error", "Couldn't check for updates. Check your connection and try again.");
      }
    },
    [flash],
  );

  useEffect(() => {
    void runCheck(false);
    const unlisten = listen<string>("menu", (e) => {
      if (e.payload === "check-updates") void runCheck(true);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [runCheck]);

  async function install() {
    if (!update) return;
    setPhase("downloading");
    let total = 0;
    let done = 0;
    try {
      await update.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        if (e.event === "Progress") {
          done += e.data.chunkLength;
          if (total) setProgress(Math.round((done / total) * 100));
        }
      });
      await relaunch();
    } catch {
      flash("error", "Update failed. Try again later.");
    }
  }

  if (phase === "idle") return null;

  return (
    <div className="update-banner" role="status">
      {phase === "checking" && <span>Checking for updates…</span>}
      {phase === "available" && update && (
        <>
          <span>{__APP_NAME__} {update.version} is available</span>
          <button className="primary" onClick={() => void install()}>
            Install and restart
          </button>
          <button onClick={() => setPhase("idle")}>Later</button>
        </>
      )}
      {phase === "downloading" && <span>Downloading update… {progress ? `${progress}%` : ""}</span>}
      {(phase === "uptodate" || phase === "error") && (
        <>
          <span>{message}</span>
          <button onClick={() => setPhase("idle")}>Close</button>
        </>
      )}
    </div>
  );
}
