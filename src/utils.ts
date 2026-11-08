export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ss = s.toString().padStart(2, "0");
  return h > 0 ? `${h}:${m.toString().padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

const POS_PREFIX = `${__APP_ID__}:pos:`;
export function savePosition(path: string, t: number) {
  try {
    localStorage.setItem(POS_PREFIX + path, String(t));
  } catch {
    /* storage unavailable */
  }
}
export function loadPosition(path: string): number {
  try {
    const v = parseFloat(localStorage.getItem(POS_PREFIX + path) ?? "");
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

/** Folder part of a path (handles / and \). */
export function dirName(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(0, i) : "";
}

/** File name without its extension. */
export function stem(path: string): string {
  const n = fileName(path);
  const i = n.lastIndexOf(".");
  return i > 0 ? n.slice(0, i) : n;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`;
}
