import { useEffect, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { message } from "@tauri-apps/plugin-dialog";
import { LOCALES } from "../locales";
import { useT } from "../translate";
import { useInterfaceStore } from "../store/interfaceStore";
import { usePlayerStore } from "../store/playerStore";
import type { TKey } from "../locales";

/** One line of a drop-down menu. `menuId` is sent as the same "menu" event the native menu sends. */
type Entry =
  | "separator"
  | { label: string; menuId?: string; run?: () => void; hint?: string; checked?: boolean; children?: Entry[] };

async function toggleFullscreen() {
  const win = getCurrentWindow();
  const next = !(await win.isFullscreen());
  if (next && document.documentElement.dataset.windowResizable === "no") await win.setResizable(true);
  await win.setFullscreen(next);
  usePlayerStore.getState().setFullscreen(next);
}

/**
 * The menu bar of the floating themes that have no system title bar: the same menus as the native
 * bar (File, View, Download Manager, Window, Help) plus window buttons. It is also the place to drag
 * the window. Every item sends the native menu's event, so one handler (App.tsx) serves both bars.
 */
export default function CustomTopBar() {
  const { t } = useT();
  const language = useInterfaceStore((s) => s.language);
  const sidebarSide = useInterfaceStore((s) => s.sidebarSide);
  const [open, setOpen] = useState<number | null>(null);
  const [subOpen, setSubOpen] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const mac = navigator.userAgent.includes("Mac");
  const mod = mac ? "⌘" : "Ctrl+";

  const m = (key: string) => t(`menu.${key}` as TKey);
  const send = (id: string) => () => void emit("menu", id);
  const item = (key: string, menuId: string, hint?: string): Entry => ({ label: m(key), menuId, hint });

  const menus: { label: string; entries: Entry[] }[] = [
    {
      label: m("file"),
      entries: [
        item("openVideo", "open-video", `${mod}O`),
        item("openVideoAudio", "open-video-audio"),
        item("addVideos", "add-videos"),
        item("addFromYoutube", "add-youtube"),
        "separator",
        item("importPlaylist", "import-playlist"),
        item("exportPlaylist", "export-playlist"),
        "separator",
        item("mergeAv", "merge-av"),
        "separator",
        item("settings", "settings", `${mod},`),
        "separator",
        { label: m("minimize"), run: () => void getCurrentWindow().minimize() },
        { label: m("closeWindow"), run: () => void getCurrentWindow().close() },
      ],
    },
    {
      label: m("view"),
      entries: [
        item("togglePanel", "toggle-sidebar", `${mod}B`),
        {
          label: m("playlistPosition"),
          children: [
            { label: m("left"), menuId: "sidebar-left", checked: sidebarSide === "left" },
            { label: m("right"), menuId: "sidebar-right", checked: sidebarSide === "right" },
          ],
        },
        {
          label: m("language"),
          children: Object.entries(LOCALES).map(([code, l]) => ({ label: l.name, menuId: `language:${code}`, checked: code === language })),
        },
        item("themes", "themes", `${mod}⇧T`),
        "separator",
        { label: m("fullscreen"), run: () => void toggleFullscreen() },
      ],
    },
    {
      label: m("downloadManager"),
      entries: [
        item("openDownloadManager", "downloads", `${mod}J`),
        item("addFromYoutube", "add-youtube"),
        "separator",
        item("pauseAllDownloads", "pause-all-downloads"),
        item("resumeAllDownloads", "resume-all-downloads"),
      ],
    },
    {
      label: m("window"),
      entries: [
        { label: m("minimize"), run: () => void getCurrentWindow().minimize() },
        { label: m("maximize"), run: () => void getCurrentWindow().toggleMaximize() },
      ],
    },
    {
      label: m("help"),
      entries: [
        item("checkUpdates", "check-updates"),
        "separator",
        {
          label: t("menu.about" as TKey, { name: __APP_NAME__ }),
          run: () => void getVersion().then((v) => message(`${__APP_NAME__}\n${v}`, { title: __APP_NAME__ })),
        },
      ],
    },
  ];

  // A click anywhere else, or Escape, closes the open menu.
  useEffect(() => {
    if (open === null) return;
    const onDown = (e: PointerEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const choose = (e: Extract<Entry, object>) => {
    setOpen(null);
    setSubOpen(null);
    if (e.run) e.run();
    else if (e.menuId) send(e.menuId)();
  };

  const row = (e: Entry, i: number) => {
    if (e === "separator") return <div key={i} className="topbar-separator" role="separator" />;
    if (e.children) {
      const expanded = subOpen === e.label;
      return (
        <div key={i}>
          <button className="topbar-entry" aria-expanded={expanded} onClick={() => setSubOpen(expanded ? null : e.label)}>
            <span>{e.label}</span>
            <span className="topbar-hint">{expanded ? "▾" : "▸"}</span>
          </button>
          {expanded && <div className="topbar-sub">{e.children.map((c, j) => row(c, j))}</div>}
        </div>
      );
    }
    return (
      <button key={i} className="topbar-entry" onClick={() => choose(e)}>
        <span>{e.checked ? "✓ " : ""}{e.label}</span>
        {e.hint && <span className="topbar-hint">{e.hint}</span>}
      </button>
    );
  };

  const win = getCurrentWindow();
  return (
    <div className="custom-topbar" ref={barRef} data-tauri-drag-region>
      <div className="topbar-menus">
        {menus.map((menu, i) => (
          <div key={i} className="topbar-menu">
            <button
              className={`topbar-title${open === i ? " open" : ""}`}
              onClick={() => { setOpen(open === i ? null : i); setSubOpen(null); }}
              onMouseEnter={() => open !== null && open !== i && (setOpen(i), setSubOpen(null))}
            >
              {menu.label}
            </button>
            {open === i && <div className="topbar-dropdown">{menu.entries.map((e, j) => row(e, j))}</div>}
          </div>
        ))}
      </div>
      <div className="topbar-spacer" data-tauri-drag-region />
      <div className="topbar-window-buttons">
        <button onClick={() => void win.minimize()} title={m("minimize")} aria-label={m("minimize")}>
          <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 6h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        </button>
        <button onClick={() => void win.toggleMaximize()} title={m("maximize")} aria-label={m("maximize")}>
          <svg width="12" height="12" viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
        </button>
        <button className="close" onClick={() => void win.close()} title={m("closeWindow")} aria-label={m("closeWindow")}>
          <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        </button>
      </div>
    </div>
  );
}
