import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { usePlayerStore } from "../store/playerStore";
import { formatTime, loadPosition, savePosition } from "../utils";

/*
 * No timers here (no setInterval / setTimeout / requestAnimationFrame): everything is driven by
 * media events (`timeupdate`, `seeked`, `playing`, ...) and by input events, using timestamps.
 *
 * Separate audio file: video and audio are aligned only when the user plays, pauses or seeks
 * (slider, +/-5/10/30 s, key scrub, loop restart). There is no continuous drift correction.
 */

const HIDE_AFTER_MS = 3000;
const HOLD_MS = 400;
const SCRUB_SPEED = 15; // seconds of media per second while a seek key is held
const SAVE_EVERY_MS = 5000;
const FS_GUARD_MS = 1500;

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d={d} />
  </svg>
);
const ICONS = {
  play: "M8 5v14l11-7z",
  pause: "M6 19h4V5H6v14zm8-14v14h4V5h-4z",
  rewind: "M11.5 12l8.5 6V6l-8.5 6zm-9 0l8.5 6V6l-8.5 6z",
  forward: "M13 6v12l8.5-6L13 6zM4.5 6v12l8.5-6-8.5-6z",
  loop: "M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z",
  enterFs: "M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z",
  exitFs: "M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z",
  volumeUp:
    "M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z",
  volumeDown: "M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z",
  volumeOff:
    "M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z",
};

/** Resolves the next time any of `events` fires on `el` (used instead of timeouts). */
function once(el: HTMLMediaElement, events: string[]): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      events.forEach((e) => el.removeEventListener(e, done));
      resolve();
    };
    events.forEach((e) => el.addEventListener(e, done));
  });
}

// How far ahead the video starts relative to the audio. It depends on the machine, so it is
// remembered between runs (a per-viewer convenience; the player works without storage).
const LEAD_KEY = `${__APP_ID__}:video-lead`;
function loadLead(): number {
  try {
    const v = parseFloat(localStorage.getItem(LEAD_KEY) ?? "");
    return Number.isFinite(v) ? Math.max(-1, Math.min(1.5, v)) : -0.13;
  } catch {
    return -0.13;
  }
}
function saveLead(v: number) {
  try {
    localStorage.setItem(LEAD_KEY, String(v));
  } catch {
    /* storage unavailable */
  }
}

const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

export default function Player() {
  const { source, playing, currentTime, duration, videoLoop, volume, muted } = usePlayerStore();
  const { setPlaying, setTime, setDuration, toggleVideoLoop, setVolume, toggleMute } = usePlayerStore.getState();

  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const seeking = useRef(false); // the timeline slider is being dragged
  const autoStarted = useRef(false);
  const videoReady = useRef(false);
  const audioReady = useRef(false);
  const lastActivity = useRef(0);
  const lastSave = useRef(0);
  const lastFsToggle = useRef(0);
  const playToken = useRef(0); // bumped by pause/seek so a pending aligned start gives up
  const wantPlaying = useRef(false); // the user wants playback (set by play, cleared by pause)
  const ownPauseAt = useRef(0); // when pauseBoth last ran: its pause events arrive a little later
  const seekToken = useRef(0);
  const endedHandled = useRef(false);
  // The video needs a moment to start after the audio. We start it that far ahead and refine
  // the value from the first `timeupdate` after each start.
  const videoLead = useRef(loadLead());
  const leadPending = useRef(false);
  // Coming back from a hidden window the audio is already running, so the video only has to
  // cover its own seek + start time. Kept separate from the start-up lead above.
  const rejoinLead = useRef(0.12);
  const leadKind = useRef<"start" | "rejoin">("start");
  const leadStartTime = useRef(0);
  const loopRef = useRef(videoLoop);
  loopRef.current = videoLoop;

  const [scrubValue, setScrubValue] = useState(0);
  const [hidden, setHidden] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [videoSrc, setVideoSrc] = useState<string>();
  const [audioSrc, setAudioSrc] = useState<string>();
  // Duration from the file headers, and the real one read from the segment index (if it differs).
  const [headerDuration, setHeaderDuration] = useState(0);
  const [realDuration, setRealDuration] = useState<number | null>(null);

  // Some downloaders write a doubled duration into the headers; trust the segment index instead.
  const effectiveDuration =
    realDuration && headerDuration && realDuration < headerDuration - 1 ? realDuration : headerDuration;
  const effectiveRef = useRef(effectiveDuration);
  effectiveRef.current = effectiveDuration;

  useEffect(() => setDuration(effectiveDuration), [effectiveDuration, setDuration]);

  const wakeInterface = useCallback(() => {
    setHidden(false);
    lastActivity.current = performance.now();
  }, []);

  const clampTime = useCallback((t: number) => {
    const v = videoRef.current;
    const max = effectiveRef.current > 0 ? effectiveRef.current : v && Number.isFinite(v.duration) ? v.duration : t;
    return Math.max(0, Math.min(max, t));
  }, []);

  /** A pause event that did not come from our own pauseBoth (headphones, media keys, ...). */
  const isOutsidePause = (e: { currentTarget: HTMLMediaElement; timeStamp: number }) =>
    wantPlaying.current &&
    !e.currentTarget.ended &&
    !document.hidden &&
    e.timeStamp - ownPauseAt.current > 400;

  /** A play event that did not come from our own playBoth (and is not a leftover from before a pause). */
  const isOutsidePlay = (e: { timeStamp: number }) =>
    !wantPlaying.current && e.timeStamp - ownPauseAt.current > 400;

  const pauseBoth = useCallback(() => {
    playToken.current++; // cancel any start that is still in progress
    wantPlaying.current = false;
    ownPauseAt.current = performance.now();
    videoRef.current?.pause();
    audioRef.current?.pause();
  }, []);

  /**
   * Start playback. With a separate audio file: audio first, then the video from where the audio
   * is (slightly ahead, to absorb its own start-up delay), so both begin in sync.
   */
  const playBoth = useCallback(async () => {
    const v = videoRef.current;
    const a = audioRef.current;
    if (!v) return;
    const token = ++playToken.current;
    wantPlaying.current = true;
    try {
      if (!a) {
        await v.play();
        return;
      }
      if (Math.abs(a.currentTime - v.currentTime) > 0.05) {
        const seeked = once(a, ["seeked", "error"]);
        a.currentTime = v.currentTime;
        await seeked;
        if (token !== playToken.current) return;
      }
      // The audio may already be running (an outside "play", e.g. headphones, started it): then
      // there is no new "playing" event to wait for.
      if (a.paused) {
        const running = once(a, ["playing", "error"]);
        await a.play();
        await running;
      }
      // "playing" fires before the audio really advances: wait for its first time update.
      await once(a, ["timeupdate", "error"]);
      if (token !== playToken.current || a.paused) return;

      const target = a.currentTime + videoLead.current;
      if (Math.abs(v.currentTime - target) > 0.01) {
        const seeked = once(v, ["seeked", "error"]);
        v.currentTime = target;
        await seeked;
        if (token !== playToken.current || a.paused) return;
      }
      await v.play();
      leadKind.current = "start";
      leadStartTime.current = v.currentTime;
      leadPending.current = true;
    } catch (e) {
      if (!isAbort(e)) setError(`Playback failed: ${String(e)}`);
    }
  }, []);

  /**
   * The window was hidden and is visible again. While hidden, WebKit pauses a muted video (the
   * separate-audio case) but the audio keeps playing; on return it restarts the video from where
   * it stopped. Put the video back at the audio's position without touching the audio.
   */
  const rejoin = useCallback(async () => {
    const v = videoRef.current;
    const a = audioRef.current;
    if (!v || !wantPlaying.current) return;
    try {
      if (!a) {
        if (v.paused) await v.play();
        return;
      }
      if (a.paused) {
        await playBoth(); // the audio stopped as well: start both again, in sync
        return;
      }
      const target = a.currentTime + rejoinLead.current;
      if (Math.abs(v.currentTime - target) > 0.05) {
        const seeked = once(v, ["seeked", "error"]);
        v.currentTime = target;
        await seeked;
      }
      if (wantPlaying.current && v.paused) await v.play();
      leadKind.current = "rejoin";
      leadStartTime.current = v.currentTime;
      leadPending.current = true;
    } catch (e) {
      if (!isAbort(e)) setError(`Playback failed: ${String(e)}`);
    }
  }, [playBoth]);

  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) void rejoin();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [rejoin]);

  /** Manual seek: move video and audio together, then restart in sync if it was playing. */
  const seekTo = useCallback(
    async (t: number, resume?: boolean) => {
      const v = videoRef.current;
      const a = audioRef.current;
      if (!v) return;
      const wasPlaying = resume ?? (!v.paused && !v.ended);
      const token = ++seekToken.current;
      endedHandled.current = false;
      if (wasPlaying) pauseBoth();
      const target = clampTime(t);
      const waits: Promise<void>[] = [];
      if (Math.abs(v.currentTime - target) > 0.01) waits.push(once(v, ["seeked", "error"]));
      v.currentTime = target;
      if (a) {
        if (Math.abs(a.currentTime - target) > 0.01) waits.push(once(a, ["seeked", "error"]));
        a.currentTime = target;
      }
      setTime(target);
      if (!wasPlaying) return;
      await Promise.all(waits);
      if (token !== seekToken.current) return; // a newer seek took over
      await playBoth();
    },
    [clampTime, pauseBoth, playBoth, setTime],
  );

  const seekBy = useCallback((delta: number) => seekTo((videoRef.current?.currentTime ?? 0) + delta), [seekTo]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused || v.ended) void playBoth();
    else pauseBoth();
  }, [playBoth, pauseBoth]);

  /** The real end of the video was reached (also covers files whose header duration is wrong). */
  const handleEnded = useCallback(() => {
    if (endedHandled.current) return;
    endedHandled.current = true;
    if (loopRef.current) {
      void seekTo(0, true);
    } else {
      pauseBoth();
      setTime(effectiveRef.current || (videoRef.current?.currentTime ?? 0));
    }
  }, [seekTo, pauseBoth, setTime]);

  const toggleFullscreen = useCallback(async () => {
    const now = performance.now();
    if (now - lastFsToggle.current < FS_GUARD_MS) return; // macOS animates the switch
    lastFsToggle.current = now;
    try {
      const win = getCurrentWindow();
      const next = !(await win.isFullscreen());
      await win.setFullscreen(next);
      setFullscreen(next);
    } catch (e) {
      setError(`Fullscreen failed: ${String(e)}`);
    }
  }, []);

  // Volume and mute go to whichever element makes the sound: the separate audio file if there is
  // one (the video is muted then), otherwise the video itself.
  useEffect(() => {
    const target = audioRef.current ?? videoRef.current;
    if (!target) return;
    target.volume = volume;
    target.muted = muted;
  }, [volume, muted, videoSrc, audioSrc]);

  // Keep our state in step with the real window (Esc, the green button, the OS, ...).
  useEffect(() => {
    const win = getCurrentWindow();
    const sync = async () => setFullscreen(await win.isFullscreen());
    void sync();
    const unlisten = win.onResized(() => void sync());
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  // Ask the backend for streamable URLs and the real duration whenever the source changes.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setHidden(false);
    setVideoSrc(undefined);
    setAudioSrc(undefined);
    setHeaderDuration(0);
    setRealDuration(null);
    autoStarted.current = false;
    videoReady.current = false;
    audioReady.current = !source?.audioPath;
    endedHandled.current = false;
    leadPending.current = false;
    if (!source) return;

    const fail = (e: unknown) => !cancelled && setError(String(e));
    invoke<string>("media_url", { path: source.videoPath })
      .then((u) => !cancelled && setVideoSrc(u))
      .catch(fail);
    if (source.audioPath) {
      invoke<string>("media_url", { path: source.audioPath })
        .then((u) => !cancelled && setAudioSrc(u))
        .catch(fail);
    }
    // The shortest real duration among the files wins.
    Promise.all(
      [source.videoPath, source.audioPath]
        .filter((p): p is string => !!p)
        .map((p) => invoke<number | null>("media_duration", { path: p }).catch(() => null)),
    ).then((ds) => {
      const known = ds.filter((d): d is number => typeof d === "number" && d > 0);
      if (!cancelled && known.length) setRealDuration(Math.min(...known));
    });
    return () => {
      cancelled = true;
    };
  }, [source]);

  /** Autoplay once everything needed is ready, so video and audio begin together. */
  const tryAutoStart = useCallback(() => {
    if (autoStarted.current || !videoReady.current || !audioReady.current) return;
    autoStarted.current = true;
    void playBoth();
  }, [playBoth]);

  // Keyboard. Space toggles; arrows seek 5 s (tap); holding an arrow scrubs, driven by the key's
  // auto-repeat events; Shift = 30 s.
  useEffect(() => {
    const held = new Map<string, { t0: number; last: number; scrubbing: boolean; wasPlaying: boolean }>();

    const down = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      wakeInterface();
      if (e.key === " ") {
        e.preventDefault();
        if (!e.repeat) togglePlay();
      } else if (e.key === "Escape" && fullscreen) {
        void toggleFullscreen();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const dir = e.key === "ArrowRight" ? 1 : -1;
        if (e.shiftKey) {
          if (!e.repeat) void seekBy(30 * dir);
          return;
        }
        const h = held.get(e.key);
        if (!e.repeat || !h) {
          held.set(e.key, { t0: e.timeStamp, last: e.timeStamp, scrubbing: false, wasPlaying: false });
          return;
        }
        if (e.timeStamp - h.t0 < HOLD_MS) return;
        const v = videoRef.current;
        if (!v) return;
        if (!h.scrubbing) {
          // Scrub preview moves only the video; the audio is aligned when the key is released.
          h.scrubbing = true;
          h.wasPlaying = !v.paused && !v.ended;
          pauseBoth();
        }
        const dt = (e.timeStamp - h.last) / 1000;
        h.last = e.timeStamp;
        const t = clampTime(v.currentTime + dir * SCRUB_SPEED * dt);
        v.currentTime = t;
        setTime(t);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const h = held.get(e.key);
      if (!h) return;
      held.delete(e.key);
      if (h.scrubbing) void seekTo(videoRef.current?.currentTime ?? 0, h.wasPlaying);
      else void seekBy(e.key === "ArrowRight" ? 5 : -5);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [seekBy, seekTo, togglePlay, toggleFullscreen, wakeInterface, pauseBoth, clampTime, setTime, fullscreen]);

  // Headphone buttons and media keys: route them to our own play/pause instead of letting the
  // system pick one of the two media elements (which leaves video and audio out of step).
  useEffect(() => {
    const ms = navigator.mediaSession;
    if (!ms) return;
    const set = (action: MediaSessionAction, fn: (() => void) | null) => {
      try {
        ms.setActionHandler(action, fn);
      } catch {
        /* action not supported here */
      }
    };
    set("play", () => void playBoth());
    set("pause", () => pauseBoth());
    set("stop", () => pauseBoth());
    return () => {
      set("play", null);
      set("pause", null);
      set("stop", null);
    };
  }, [playBoth, pauseBoth]);

  useEffect(() => {
    if (navigator.mediaSession) navigator.mediaSession.playbackState = playing ? "playing" : "paused";
  }, [playing]);

  // Remember the position (also saved from `timeupdate` and on pause).
  useEffect(() => {
    if (!source) return;
    const save = () => savePosition(source.videoPath, videoRef.current?.currentTime ?? 0);
    window.addEventListener("beforeunload", save);
    return () => {
      save();
      window.removeEventListener("beforeunload", save);
    };
  }, [source]);

  if (!source) return null;
  if (!videoSrc || (source.audioPath && !audioSrc)) {
    return <div className="player">{error && <div className="player-error">{error}</div>}</div>;
  }

  const shown = seeking.current ? scrubValue : currentTime;

  return (
    <div className={`player${hidden ? " hide-interface" : ""}${fullscreen ? " is-fullscreen" : ""}`} onMouseMove={wakeInterface}>
      <div className="video-wrapper" onClick={togglePlay}>
        <video
          key={videoSrc}
          ref={videoRef}
          src={videoSrc}
          preload="auto"
          playsInline
          muted={!!audioSrc}
          onCanPlay={() => {
            videoReady.current = true;
            tryAutoStart();
          }}
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            setHeaderDuration(v.duration);
            const pos = loadPosition(source.videoPath);
            const limit = effectiveRef.current || v.duration;
            if (pos > 0 && pos < limit - 2) void seekTo(pos, false);
          }}
          onTimeUpdate={(e) => {
            const v = e.currentTarget;
            const a = audioRef.current;
            const t = v.currentTime;
            const now = performance.now();
            if (!seeking.current) setTime(t);

            // The headers may claim a longer video than really exists.
            if (effectiveRef.current > 0 && t >= effectiveRef.current - 0.1) handleEnded();

            // Hide the controls after a while without activity.
            if (!v.paused && now - lastActivity.current > HIDE_AFTER_MS) setHidden(true);

            // Remember where we are.
            if (now - lastSave.current > SAVE_EVERY_MS) {
              lastSave.current = now;
              savePosition(source.videoPath, t);
            }

            // Refine how far ahead the video should start (once per start).
            if (leadPending.current && a && !a.paused && t - leadStartTime.current > 1.0) {
              leadPending.current = false;
              const drift = a.currentTime - t; // > 0: the video is behind the audio
              if (leadKind.current === "rejoin") {
                rejoinLead.current = Math.max(-1, Math.min(1.5, rejoinLead.current + drift));
              } else {
                videoLead.current = Math.max(-1, Math.min(1.5, videoLead.current + drift));
                saveLead(videoLead.current);
              }
            }
          }}
          onEnded={handleEnded}
          onPlay={(e) => {
            setPlaying(true);
            wakeInterface();
            // An outside play that reached the video only: start the audio with it.
            if (isOutsidePlay(e) && audioRef.current) void playBoth();
          }}
          onPause={(e) => {
            setPlaying(false);
            setHidden(false);
            savePosition(source.videoPath, e.currentTarget.currentTime);
            // An outside pause (headphones, media keys) can reach the video instead of the audio.
            if (isOutsidePause(e)) pauseBoth();
          }}
          onError={(e) => {
            const err = e.currentTarget.error;
            setError(`This file can't be played (error ${err?.code ?? "?"}${err?.message ? `: ${err.message}` : ""}).`);
          }}
        />
      </div>
      {audioSrc && (
        <audio
          key={audioSrc}
          ref={audioRef}
          src={audioSrc}
          preload="auto"
          onCanPlay={() => {
            audioReady.current = true;
            tryAutoStart();
          }}
          // Headphone / media-key pause and play act on the audio element only. Our own pauses
          // clear wantPlaying first, so a pause while we still want playback came from outside:
          // pause the video too (and start both again on an outside play).
          onPause={(e) => {
            if (isOutsidePause(e)) pauseBoth();
          }}
          onPlay={(e) => {
            if (isOutsidePlay(e) && videoRef.current?.paused) void playBoth();
          }}
        />
      )}

      {error && <div className="player-error">{error}</div>}

      <div className="controls">
        <div className="button-group">
          <button onClick={togglePlay} title={playing ? "Pause" : "Play"}>
            <Icon d={playing ? ICONS.pause : ICONS.play} />
          </button>
          <button onClick={() => void seekBy(-10)} title="Back 10s">
            <Icon d={ICONS.rewind} />
          </button>
          <button onClick={() => void seekBy(10)} title="Forward 10s">
            <Icon d={ICONS.forward} />
          </button>
        </div>

        <div className="timeline">
          <span className="time">{formatTime(shown)}</span>
          <input
            type="range"
            min={0}
            max={duration || 0}
            step="any"
            value={Math.min(shown, duration || 0)}
            onChange={(e) => {
              seeking.current = true;
              setScrubValue(Number(e.target.value));
            }}
            onPointerUp={(e) => {
              e.currentTarget.blur(); // so Space keeps toggling play after using the slider
              if (seeking.current) {
                seeking.current = false;
                void seekTo(scrubValue);
              }
            }}
            onKeyDown={(e) => e.stopPropagation()}
          />
          <span className="time">{formatTime(duration)}</span>
        </div>

        <div className="button-group">
          <div className="volume">
            <button onClick={toggleMute} title={muted || volume === 0 ? "Unmute" : "Mute"}>
              <Icon d={muted || volume === 0 ? ICONS.volumeOff : volume < 0.5 ? ICONS.volumeDown : ICONS.volumeUp} />
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={muted ? 0 : volume}
              aria-label="Volume"
              onChange={(e) => setVolume(Number(e.target.value))}
              onPointerUp={(e) => e.currentTarget.blur()}
              onKeyDown={(e) => e.stopPropagation()}
            />
          </div>
          <button className={videoLoop ? "active" : ""} onClick={toggleVideoLoop} title="Loop this video">
            <Icon d={ICONS.loop} />
          </button>
          <button onClick={() => void toggleFullscreen()} title="Fullscreen">
            <Icon d={fullscreen ? ICONS.exitFs : ICONS.enterFs} />
          </button>
        </div>
      </div>
    </div>
  );
}
