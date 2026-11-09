import { useState } from "react";
import { useT } from "../translate";
import { youtubeLookup, type YouTubeEntry, type YouTubeFormat } from "../youtubeApi";
import { useYouTubeDownloadStore } from "../store/youtubeDownloadStore";
import { formatTime } from "../textFormatting";

type Found =
  | { kind: "video"; entries: YouTubeEntry[]; formats: YouTubeFormat[] }
  | { kind: "list"; title: string; entries: YouTubeEntry[] }
  | { kind: "search"; query: string; entries: YouTubeEntry[] };

const PAGE = 30;

/** Search YouTube, or paste a video / playlist / channel link; tick videos and download them. */
export default function YouTubeSearchPanel() {
  const { t } = useT();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<Found | null>(null);
  const [unticked, setUnticked] = useState<string[]>([]);

  async function run(input: string, count = PAGE) {
    const query = input.trim();
    if (!query) return;
    setBusy(true);
    setError(null);
    try {
      const r = await youtubeLookup(query, count);
      if (r.type === "video") setFound({ kind: "video", entries: [r.entry], formats: r.formats });
      else if (r.type === "list") setFound({ kind: "list", title: r.title, entries: r.entries });
      else setFound({ kind: "search", query, entries: r.entries });
      if (count === PAGE) setUnticked([]);
    } catch (e) {
      setError(t("youtube.error", { error: String(e) }));
    } finally {
      setBusy(false);
    }
  }

  const entries = found?.entries ?? [];
  const ticked = entries.filter((e) => !unticked.includes(e.id));
  const toggle = (id: string) => setUnticked((u) => (u.includes(id) ? u.filter((x) => x !== id) : [...u, id]));

  return (
    <>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void run(text);
        }}
      >
        <input type="text" autoFocus value={text} placeholder={t("youtube.placeholder")} onChange={(e) => setText(e.target.value)} />
        <button className="primary" type="submit" disabled={busy || !text.trim()}>
          {busy ? t("youtube.searching") : t("youtube.search")}
        </button>
      </form>

      {error && <p className="modal-error">{error}</p>}
      {found?.kind === "list" && <p className="muted">{t("youtube.playlistFound", { title: found.title })}</p>}
      {found && entries.length === 0 && !error && <p className="muted">{t("youtube.noResults")}</p>}

      {entries.length > 0 && (
        <div className="staged youtube-results">
          {entries.map((e) => (
            <label key={e.id} className="staged-row">
              <input type="checkbox" checked={!unticked.includes(e.id)} onChange={() => toggle(e.id)} />
              <img className="youtube-thumb" src={e.thumbnail} alt="" loading="lazy" />
              <span className="staged-title" title={e.title}>
                {e.title}
                {e.channel && <span className="muted"> · {e.channel}</span>}
              </span>
              {e.duration ? <span className="muted">{formatTime(e.duration)}</span> : null}
            </label>
          ))}
        </div>
      )}

      <div className="modal-actions">
        {found?.kind === "search" && entries.length > 0 && (
          <button disabled={busy} onClick={() => void run(found.query, entries.length + PAGE)}>
            {t("youtube.loadMore")}
          </button>
        )}
        <span className="spacer" />
        {found?.kind === "list" && entries.length > 0 && (
          <button
            disabled={busy}
            onClick={() => useYouTubeDownloadStore.getState().askQuality({ entries, formats: null, newPlaylistTitle: found.title })}
          >
            {t("youtube.downloadAll")}
          </button>
        )}
        <button
          className="primary"
          disabled={ticked.length === 0}
          onClick={() =>
            useYouTubeDownloadStore.getState().askQuality({
              entries: ticked,
              formats: found?.kind === "video" ? found.formats : null,
              newPlaylistTitle: null,
            })
          }
        >
          {t("youtube.download")}
        </button>
      </div>
    </>
  );
}
