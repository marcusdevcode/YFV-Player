import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { locateTrack, usePlaylistLibraryStore } from "../store/playlistLibraryStore";
import { SHOW_PREVIEW_BUTTON } from "../featureFlags";
import { tr, useT } from "../translate";
import Icon from "./Icon";
import { usePlayerStore } from "../store/playerStore";
import { setTrackFrame } from "../videoThumbnails";
import { formatTime } from "../textFormatting";
import { loadPosition, notePosition, savePosition } from "../playbackPosition";
import { openContextMenu } from "../store/contextMenuStore";
import { useInterfaceStore } from "../store/interfaceStore";

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
const SAVE_EVERY_MS = 2000;
const FS_GUARD_MS = 1500;
/** The picture is only paused once the window has been in the background this long, so quick switches between programs change nothing. */
const BACKGROUND_PAUSE_AFTER_MS = 1500;


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

/** Whether the app window had focus the last time we looked; a new player (next track) starts from it, not from a guess. */
let appHadFocus = true;
const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";
/** The system refused to start playback by itself (no click or key press led to it). */
/**
 * Run `start` as if the user had started it. The system refuses to start media by itself (NotAllowedError),
 * for example the next track of a playlist, but accepts it from a script that the native side runs:
 * the backend (playback_allow_start in lib.rs) calls the function registered here.
 */
function startAllowed(start: () => void) {
  const w = window as unknown as { __startPlayback?: () => void };
  w.__startPlayback = () => {
    w.__startPlayback = undefined;
    start();
  };
  invoke("playback_allow_start").catch(() => w.__startPlayback?.());
}

const isBlockedAutoplay = (e: unknown) => e instanceof DOMException && e.name === "NotAllowedError";

/**
 * One video and one audio element for the whole life of the app. The system lets an element that was started
 * by a click or key press start again by itself (the next track of a playlist, with nobody at the keyboard),
 * but refuses (NotAllowedError) to start a brand-new element that way. So the elements are reused for every
 * track: Player puts its handlers on them while it exists and empties them when it goes.
 */
const sharedVideo = document.createElement("video");
sharedVideo.preload = "auto";
sharedVideo.playsInline = true;
const sharedAudio = document.createElement("audio");
sharedAudio.preload = "auto";

type MediaEvent = Event & { currentTarget: HTMLMediaElement };
type MediaHandlers = { video: Record<string, (e: MediaEvent) => void>; audio: Record<string, (e: MediaEvent) => void> };
const MEDIA_EVENTS = ["canplay", "loadedmetadata", "timeupdate", "ended", "play", "pause", "error"];

export default function Player() {
  const { source, playing, currentTime, duration, videoLoop, volume, muted } = usePlayerStore();
  const { setPlaying, setTime, setDuration, toggleVideoLoop, setVolume, toggleMute } = usePlayerStore.getState();

  const videoRef = useRef<HTMLVideoElement | null>(sharedVideo);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  audioRef.current = source?.audioPath ? sharedAudio : null; // null: this track has no separate audio file
  const mediaHandlers = useRef<MediaHandlers | null>(null);
  const attachVideo = useCallback((host: HTMLDivElement | null) => {
    if (host && sharedVideo.parentElement !== host) host.appendChild(sharedVideo);
  }, []);
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
  const seekBusy = useRef(0); // a seek of ours is running: pause/play events now are ours, not headphones
  const endedHandled = useRef(false);
  const nativeFocused = useRef(appHadFocus); // the app window itself has focus (not just the page inside it)
  const backgroundSince = useRef<number | null>(null); // the window lost focus at this time (and has not got it back)
  const suspended = useRef(false); // the window is in the background: only the video is paused, the audio plays on
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
  const [volumeOpen, setVolumeOpen] = useState(false); // the volume slider is open (it opens and closes with a click on the speaker)
  const volumeBox = useRef<HTMLDivElement>(null);
  const volumeAnchor = useRef<HTMLDivElement>(null);
  // While the volume group is open it floats over the bar (position absolute), so nothing around it moves; the place it leaves is kept at its size.
  const [volumeHole, setVolumeHole] = useState<{ width: number; height: number } | null>(null);
  const toggleVolumeOpen = () => {
    if (volumeOpen) {
      setVolumeOpen(false);
      setVolumeHole(null);
    } else {
      const r = volumeAnchor.current?.getBoundingClientRect();
      setVolumeHole(r ? { width: r.width, height: r.height } : null);
      setVolumeOpen(true);
    }
  };
  // A click anywhere else, or Escape, closes the volume slider.
  useEffect(() => {
    if (!volumeOpen) return;
    const close = () => {
      setVolumeOpen(false);
      setVolumeHole(null);
    };
    const away = (e: PointerEvent) => {
      if (!volumeBox.current?.contains(e.target as Node)) close();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", key);
    };
  }, [volumeOpen]);
  const { t } = useT();
  const fullscreen = usePlayerStore((s) => s.fullscreen);
  const setFullscreen = usePlayerStore((s) => s.setFullscreen);
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

  // Braces on purpose: with the stores saved to files, setDuration returns a Promise, and an effect
  // must not return anything but a cleanup function.
  useEffect(() => {
    setDuration(effectiveDuration);
  }, [effectiveDuration, setDuration]);

  // The playing track's preview becomes the frame on screen now.
  const currentTrackId = usePlaylistLibraryStore((s) => s.currentTrackId);
  // Previous / next video buttons show only when the playing track's playlist has more than one video to go between.
  const hasOtherVideos = usePlaylistLibraryStore((s) => {
    const list = s.playlists.find((p) => p.tracks.some((t) => t.id === s.currentTrackId));
    return !!list && list.tracks.filter((t) => !t.download || t.id === s.currentTrackId).length > 1;
  });
  const captureFrameAsPreview = useCallback(async () => {
    const found = locateTrack(usePlaylistLibraryStore.getState().currentTrackId);
    const v = videoRef.current;
    if (!found || !v) return;
    try {
      await setTrackFrame(found.playlist.id, found.track.id, found.track.videoPath, v.currentTime);
    } catch (e) {
      usePlaylistLibraryStore.getState().setNotice(tr("player.errPreview", { error: String(e) }));
    }
  }, []);

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
    seekBusy.current === 0 &&
    wantPlaying.current &&
    !e.currentTarget.ended &&
    !document.hidden &&
    e.timeStamp - ownPauseAt.current > 400;

  /** A play event that did not come from our own playBoth (and is not a leftover from before a pause). */
  const isOutsidePlay = (e: { timeStamp: number }) =>
    seekBusy.current === 0 && !wantPlaying.current && e.timeStamp - ownPauseAt.current > 400;

  const pauseBoth = useCallback(() => {
    playToken.current++; // cancel any start that is still in progress
    wantPlaying.current = false;
    suspended.current = false;
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
      if (isBlockedAutoplay(e)) {
        wantPlaying.current = false;
        audioRef.current?.pause();
        setError(tr("player.errPlayback", { error: String(e) }));
      } else if (!isAbort(e)) setError(tr("player.errPlayback", { error: String(e) }));
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
      if (isBlockedAutoplay(e)) {
        wantPlaying.current = false;
        audioRef.current?.pause();
        setError(tr("player.errPlayback", { error: String(e) }));
      } else if (!isAbort(e)) setError(tr("player.errPlayback", { error: String(e) }));
    }
  }, [playBoth]);

  // Window in the background (the user switched to another program): with a separate audio file, stop
  // drawing the video and let the audio play on, which saves resources. Coming back, the video
  // continues from where the audio is (rejoin). Controlled by a setting.
  // Leaving is decided by the app window's own focus, not the page's: the page loses focus for other
  // reasons too (for example when leaving fullscreen) while the app is still in front. Coming back is
  // detected several ways, because a web view does not always send a focus event.
  useEffect(() => {
    const win = getCurrentWindow();
    // Leaving only notes the time. The audio's time updates (see below) pause the picture once the
    // window has stayed away long enough, so quick back-and-forth switching never touches the video.
    const goAway = () => {
      if (performance.now() - lastFsToggle.current < FS_GUARD_MS) return; // a fullscreen switch, not leaving
      nativeFocused.current = appHadFocus = false;
      if (backgroundSince.current === null) backgroundSince.current = performance.now();
    };
    const goBack = () => {
      nativeFocused.current = appHadFocus = true;
      backgroundSince.current = null;
      if (!suspended.current) return;
      suspended.current = false;
      void rejoin();
    };
    void win.isFocused().then((focused) => (nativeFocused.current = appHadFocus = focused)).catch(() => {});
    const native = win.onFocusChanged(({ payload: focused }) => (focused ? goBack() : goAway()));
    window.addEventListener("focus", goBack);
    window.addEventListener("pointerdown", goBack, true);
    window.addEventListener("keydown", goBack, true);
    return () => {
      window.removeEventListener("focus", goBack);
      window.removeEventListener("pointerdown", goBack, true);
      window.removeEventListener("keydown", goBack, true);
      void native.then((off) => off()).catch(() => {});
    };
  }, [rejoin]);

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
      const wasPlaying = resume ?? (wantPlaying.current && !v.ended);
      const token = ++seekToken.current;
      endedHandled.current = false;
      if (wasPlaying) pauseBoth();
      const target = clampTime(t);
      // Seeking a big file can take longer than the 400 ms that separates our own pause/play events
      // from outside ones, so while this seek runs every such event is treated as ours.
      seekBusy.current++;
      try {
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
        // Playback must be running again: if the start was cut short, start once more.
        if (token === seekToken.current && wantPlaying.current && videoRef.current?.paused) await playBoth();
      } finally {
        seekBusy.current--;
        ownPauseAt.current = performance.now(); // events that trail the seek are still ours
      }
    },
    [clampTime, pauseBoth, playBoth, setTime],
  );

  const seekBy = useCallback((delta: number) => seekTo((videoRef.current?.currentTime ?? 0) + delta), [seekTo]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    // Decide by what the user wants (set by play/pause), not by the video element's momentary state:
    // it can be paused for a moment while it catches up with the audio after the window came back.
    if (wantPlaying.current && !v.ended) pauseBoth();
    else void playBoth();
  }, [playBoth, pauseBoth]);

  /** The real end of the video was reached (also covers files whose header duration is wrong). */
  const handleEnded = useCallback(() => {
    if (endedHandled.current) return;
    endedHandled.current = true;
    if (loopRef.current) {
      void seekTo(0, true);
    } else if (!usePlaylistLibraryStore.getState().playNext()) {
      // Not in a playlist, or it was the last track and the playlist does not loop: stop here.
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
      // A fixed-size floating window would also block full screen on some systems.
      if (next && document.documentElement.dataset.windowResizable === "no") await win.setResizable(true);
      await win.setFullscreen(next);
      setFullscreen(next);
    } catch (e) {
      setError(tr("player.errFullscreen", { error: String(e) }));
    }
  }, []);

  // Put the handlers on the shared elements while this player exists.
  useEffect(() => {
    const forVideo = (e: Event) => mediaHandlers.current?.video[e.type]?.(e as MediaEvent);
    const forAudio = (e: Event) => mediaHandlers.current?.audio[e.type]?.(e as MediaEvent);
    for (const type of MEDIA_EVENTS) {
      sharedVideo.addEventListener(type, forVideo);
      sharedAudio.addEventListener(type, forAudio);
    }
    return () => {
      for (const type of MEDIA_EVENTS) {
        sharedVideo.removeEventListener(type, forVideo);
        sharedAudio.removeEventListener(type, forAudio);
      }
    };
  }, []);

  // The files of this track go onto the shared elements.
  useEffect(() => {
    if (!videoSrc) return;
    sharedVideo.muted = !!audioSrc; // the sound comes from the audio file then
    sharedVideo.src = videoSrc;
  }, [videoSrc, audioSrc]);
  useEffect(() => {
    if (audioSrc) sharedAudio.src = audioSrc;
  }, [audioSrc]);

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
    const sync = async () => {
      const full = await win.isFullscreen();
      if (full !== usePlayerStore.getState().fullscreen) lastFsToggle.current = performance.now(); // entering/leaving fullscreen shuffles focus
      setFullscreen(full);
      // A fixed-size floating window is resizable only while full screen.
      if (document.documentElement.dataset.windowResizable === "no") void win.setResizable(full).catch(() => {});
    };
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
    if (autoStarted.current) return;
    // The window is in the background (the track changed while nobody is looking): a hidden page may never
    // report "can play", so the player does not wait for it. With a separate audio file the sound starts
    // alone (the picture joins when the window comes back); without one the video is simply told to play.
    const audio = audioRef.current;
    if (source?.audioPath && !audio) return; // the audio element is not there yet
    const inBackground = document.hidden || !nativeFocused.current;
    const picture = !audio || usePlayerStore.getState().pauseVideoInBackground;
    const startNow = inBackground && picture && !!videoRef.current;
    if (!startNow && (!audioReady.current || !videoReady.current)) return;
    autoStarted.current = true;
    // The video restored at startup waits, paused, at its saved position. A player that replaces one
    // that was playing and was torn down (rebuilt) continues to play.
    const state = usePlayerStore.getState();
    const resume = state.resumeAfterRemount;
    if (resume) usePlayerStore.setState({ resumeAfterRemount: false });
    if (!(state.autoStart || resume)) return;
    // Starting by itself (nobody pressed anything) is refused by the system for new media. A script run by the
    // native side counts as user-started there, so the start goes through the backend (playback_allow_start).
    startAllowed(() => {
      if (!videoReady.current && !audio && source) {
        wantPlaying.current = true;
        ownPauseAt.current = performance.now();
        void videoRef.current?.play().then(
          () => setPlaying(true),
          (e) => {
            wantPlaying.current = false;
      if (!isAbort(e)) setError(tr("player.errPlayback", { error: String(e) }));
          },
        );
        return;
      }
      if (!videoReady.current && audio && source) {
        const position = state.fromStart ? 0 : loadPosition(source.videoPath);
        wantPlaying.current = true;
        suspended.current = true;
        ownPauseAt.current = performance.now();
        if (position > 0) audio.currentTime = position;
        void audio.play().then(
          () => setPlaying(true),
          (e) => {
            wantPlaying.current = false;
            suspended.current = false;
      if (!isAbort(e)) setError(tr("player.errPlayback", { error: String(e) }));
          },
        );
        return;
      }
      void playBoth();
    });
  }, [playBoth, source, setPlaying]);

  // A new track that starts while the window is in the background: start it as soon as its files are set,
  // without waiting for events a hidden page may not send.
  useEffect(() => {
    if (!videoSrc || (source?.audioPath && !audioSrc)) return;
    if (document.hidden || !nativeFocused.current) tryAutoStart();
  }, [videoSrc, audioSrc, source, tryAutoStart]);

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
          h.wasPlaying = wantPlaying.current && !v.ended;
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

  // Tear down properly. When this player goes away (another video, or React rebuilding it while the
  // code changes in development) its audio and video are stopped, because a removed audio element
  // would otherwise play on by itself. The position is saved, and if it was playing, the next
  // player (or this one, when React only re-runs its effects) plays again once it is ready.
  useEffect(() => {
    const v = videoRef.current;
    const a = audioRef.current;
    const myPlayId = usePlayerStore.getState().playId;
    const path = source?.videoPath;
    // Effects re-run without a rebuild (development): everything below was stopped, so continue.
    if (wantPlaying.current && v && v.paused) {
      usePlayerStore.setState({ resumeAfterRemount: false }); // this player carries on itself, nobody else needs to
      void playBoth();
    }
    return () => {
      const wasPlaying = wantPlaying.current;
      const progressed = !!v && v.currentTime > 0; // false right after mounting (React's development double run)
      if (v && path && progressed) savePosition(path, v.currentTime);
      ownPauseAt.current = performance.now(); // our own pause: not a headphone / media-key pause
      v?.pause();
      a?.pause();
      // Replaced by the same video (a rebuild), not by another one: carry on from where it was.
      if (progressed && usePlayerStore.getState().playId === myPlayId) {
        usePlayerStore.setState({ fromStart: false, resumeAfterRemount: wasPlaying });
      }
    };
  }, [videoSrc, audioSrc]);

  // The player goes away: empty the shared elements, so nothing of this track stays on them
  // (this also drops their pending events). Declared after the effect that saves the position.
  useEffect(() => {
    return () => {
      for (const el of [sharedVideo, sharedAudio]) {
        el.pause();
        el.removeAttribute("src");
        el.load();
      }
      sharedVideo.remove();
    };
  }, []);

  // Remember the position: noted in memory while playing, saved to disk on pause, when the video is replaced, and (by the program) on exit.
  useEffect(() => {
    if (!source) return;
    const save = () => {
      // When the player is torn down the video element is already gone: keep the saved position then.
      const t = videoRef.current?.currentTime;
      if (t !== undefined) savePosition(source.videoPath, t);
    };
    window.addEventListener("beforeunload", save);
    return () => {
      save();
      window.removeEventListener("beforeunload", save);
    };
  }, [source]);

  if (!source) return null;
  if (!videoSrc || (source.audioPath && !audioSrc)) {
    mediaHandlers.current = null;
    return <div className="player">{error && <div className="player-error">{error}</div>}</div>;
  }

  // The handlers of the shared media elements (set on every render, so they see the current state).
  mediaHandlers.current = {
    video: {
      canplay: () => {
            videoReady.current = true;
            tryAutoStart();
          },
      loadedmetadata: (e: MediaEvent) => {
            const v = e.currentTarget as HTMLVideoElement;
            setHeaderDuration(v.duration);
            const pos = usePlayerStore.getState().fromStart ? 0 : loadPosition(source.videoPath);
            const limit = effectiveRef.current || v.duration;
            if (pos > 0 && pos < limit - 2) void seekTo(pos, false);
          },
      timeupdate: (e: MediaEvent) => {
            const v = e.currentTarget as HTMLVideoElement;
            const a = audioRef.current;
            const t = v.currentTime;
            const now = performance.now();
            if (!seeking.current) setTime(t);

            // The headers may claim a longer video than really exists.
            if (effectiveRef.current > 0 && t >= effectiveRef.current - 0.1) handleEnded();

            // Hide the controls after a while without activity.
            if (!v.paused && now - lastActivity.current > HIDE_AFTER_MS) setHidden(true);

            // Remember where we are.
            // (memory only: the file is written on pause and when the program exits)
            if (now - lastSave.current > SAVE_EVERY_MS) {
              lastSave.current = now;
              notePosition(source.videoPath, t);
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
          },
      ended: () => handleEnded(),
      play: (e: MediaEvent) => {
            setPlaying(true);
            wakeInterface();
            // An outside play that reached the video only: start the audio with it.
            if (isOutsidePlay(e) && audioRef.current) void playBoth();
          },
      pause: (e: MediaEvent) => {
            if (suspended.current) return; // paused by us in the background: still "playing" for the user
            setPlaying(false);
            setHidden(false);
            savePosition(source.videoPath, (e.currentTarget as HTMLMediaElement).currentTime);
            // An outside pause (headphones, media keys) can reach the video instead of the audio.
            if (isOutsidePause(e)) pauseBoth();
          },
      error: (e: MediaEvent) => {
            const err = (e.currentTarget as HTMLVideoElement).error;
            // MEDIA_ERR_SRC_NOT_SUPPORTED (4): the system's web view has no decoder for this file.
            setError(
              err?.code === 4
                ? t("player.errUnsupported")
                : t("player.errCannotPlay", { code: err?.code ?? "?", detail: err?.message ? `: ${err.message}` : "" }),
            );
          },
    },
    audio: {
      canplay: () => {
            audioReady.current = true;
            tryAutoStart();
          },
      pause: (e: MediaEvent) => {
            if (isOutsidePause(e)) pauseBoth();
          },
      play: (e: MediaEvent) => {
            if (isOutsidePlay(e) && videoRef.current?.paused) void playBoth();
          },
      timeupdate: (e: MediaEvent) => {
        // The real end of the track: the audio file's header may claim a longer file than there is, so the audio never
        // "ends" by itself. The video's clock sees the end too, but the system pauses the video in the background.
        if (effectiveRef.current > 0 && (e.currentTarget as HTMLMediaElement).currentTime >= effectiveRef.current - 0.1) handleEnded();
            // Safety net: the picture is held back for the background, but the window has focus again
            // and no focus event told us (the audio keeps reporting time, the video does not).
            if (suspended.current && nativeFocused.current) {
              backgroundSince.current = null;
              suspended.current = false;
              void rejoin();
            }
            // Away for long enough: stop drawing the video, the audio plays on.
            const away = backgroundSince.current;
            const video = videoRef.current;
            if (
              away !== null &&
              !suspended.current &&
              performance.now() - away > BACKGROUND_PAUSE_AFTER_MS &&
              !nativeFocused.current &&
              performance.now() - lastFsToggle.current > FS_GUARD_MS &&
              usePlayerStore.getState().pauseVideoInBackground &&
              video &&
              wantPlaying.current &&
              !video.paused &&
              !(e.currentTarget as HTMLMediaElement).paused
            ) {
              suspended.current = true;
              ownPauseAt.current = performance.now(); // our own pause: not a headphone / media-key pause
              video.pause();
            }
            // With the picture paused in the background the video no longer reports time: keep the saved position moving.
            const now = performance.now();
            if (suspended.current && now - lastSave.current > SAVE_EVERY_MS) {
              lastSave.current = now;
              notePosition(source.videoPath, (e.currentTarget as HTMLMediaElement).currentTime);
            }
          },
      ended: () => {
            // The audio is the shortest part (the track's length is the shorter of the two files), so its end
            // is the end of the track, whatever the window or the picture is doing. Counted once.
            suspended.current = false;
            handleEnded();
          },
    },
  };

  const shown = seeking.current ? scrubValue : currentTime;

  return (
    <div className={`player${hidden ? " hide-interface" : ""}${fullscreen ? " is-fullscreen" : ""}`} onMouseMove={wakeInterface}
      onContextMenu={(e) =>
        openContextMenu(e, [
          { label: playing ? t("player.pause") : t("player.play"), onSelect: togglePlay },
          { label: fullscreen ? t("context.exitFullscreen") : t("player.fullscreen"), onSelect: () => void toggleFullscreen() },
          "separator",
          {
            label: useInterfaceStore.getState().sidebarOpen ? t("app.hidePanel") : t("app.showPanel"),
            onSelect: () => useInterfaceStore.getState().toggleSidebar(),
          },
        ])
      }
    >
      <div className="video-wrapper" onClick={togglePlay} ref={attachVideo} />

      {error && <div className="player-error">{error}</div>}

      <div className="controls" data-tauri-drag-region>
        <div className="button-group">
          <button className="play-button" onClick={togglePlay} title={playing ? t("player.pause") : t("player.play")}>
            <Icon slot={playing ? "pause" : "play"} />
          </button>
          {/* The volume: a speaker button that opens the slider (it also opens while the pointer is over it); the mute switch is
              its own button beside the slider. */}
          <div ref={volumeAnchor} className="volume-anchor" style={volumeHole ? volumeHole : undefined}>
          <div ref={volumeBox} className={`volume${volumeOpen ? " open" : ""}`}>
            <button className={volumeOpen ? "active" : ""} onClick={toggleVolumeOpen} title={t("player.volume")} aria-label={t("player.volume")} aria-expanded={volumeOpen}>
              <Icon slot={muted || volume === 0 ? "volumeOff" : volume < 0.5 ? "volumeDown" : "volumeUp"} />
            </button>
            <div className="volume-slider">
              <input
                type="range"
                className="progress-slider"
                style={{ "--fill": `${(muted ? 0 : volume) * 100}%` } as CSSProperties}
                min={0}
                max={1}
                step={0.01}
                value={muted ? 0 : volume}
                aria-label={t("player.volume")}
                onChange={(e) => setVolume(Number(e.target.value))}
                onPointerUp={(e) => e.currentTarget.blur()}
                onKeyDown={(e) => e.stopPropagation()}
              />
              <button className={muted ? "active" : ""} onClick={toggleMute} title={muted ? t("player.unmute") : t("player.mute")} aria-label={muted ? t("player.unmute") : t("player.mute")} aria-pressed={muted}>
                <Icon slot="volumeOff" />
              </button>
            </div>
          </div>
          </div>
          <button onClick={() => void seekBy(-10)} title={t("player.back10")}>
            <Icon slot="rewind" />
          </button>
          <button onClick={() => void seekBy(10)} title={t("player.forward10")}>
            <Icon slot="forward" />
          </button>
        </div>

        <div className="timeline">
          <span className="time">{formatTime(shown)}</span>
          <input
            type="range"
            className="progress-slider"
            style={{ "--fill": `${duration ? Math.min(100, (shown / duration) * 100) : 0}%` } as CSSProperties}
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
          {hasOtherVideos && (
            <>
              <button onClick={() => usePlaylistLibraryStore.getState().skipTrack(-1)} title={t("player.previousVideo")} aria-label={t("player.previousVideo")}>
                <Icon slot="previousVideo" />
              </button>
              <button onClick={() => usePlaylistLibraryStore.getState().skipTrack(1)} title={t("player.nextVideo")} aria-label={t("player.nextVideo")}>
                <Icon slot="nextVideo" />
              </button>
            </>
          )}
          <button className={videoLoop ? "active" : ""} onClick={toggleVideoLoop} title={t("player.loopVideo")}>
            <Icon slot="loopVideo" />
          </button>
          {SHOW_PREVIEW_BUTTON && currentTrackId && (
            <button onClick={() => void captureFrameAsPreview()} title={t("player.useFrame")}>
              <Icon slot="capturePreview" />
            </button>
          )}
          <button onClick={() => void toggleFullscreen()} title={t("player.fullscreen")}>
            <Icon slot={fullscreen ? "fullscreenExit" : "fullscreen"} />
          </button>
        </div>
      </div>
    </div>
  );
}
