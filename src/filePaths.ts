// Taking file paths apart (handles / and \ separators).

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
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
