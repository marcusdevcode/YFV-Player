import { useState } from "react";
import { useT } from "../translate";
import { youtubeLookup, type YouTubeEntry, type YouTubeFormat } from "../youtubeApi";
import { useYouTubeDownloadStore } from "../store/youtubeDownloadStore";
import { formatTime } from "../textFormatting";
import ScrollArea from "./ScrollArea";

type Found =
  | { kind: "video"; entries: YouTubeEntry[]; formats: YouTubeFormat[] }
  | { kind: "list"; title: string; entries: YouTubeEntry[] }
  | { kind: "search"; query: string; entries: YouTubeEntry[] };

/** A channel being browsed: its link and which tab is shown. */
interface Channel {
  url: string;
  title: string;
  /** "search" is a search inside the channel (videos and playlists together). */
  tab: "videos" | "playlists" | "search";
}

/** What was shown before a channel was opened, for the Back button. */
interface Previous {
  found: Found | null;
  picked: YouTubeEntry[];
  source: string | null;
  page: number;
  hasMore: boolean;
}

/** Search results fetched at a time ("Load more" adds another batch). */
const SEARCH_BATCH = 30;
/** Videos or playlists shown on one page of a channel or playlist (a few more are asked for to know if a next page exists). */
const LIST_PAGE = 24;
const LIST_ASK = SEARCH_BATCH;

/** Search YouTube, or paste a video / playlist / channel link; tick videos or playlists and download them. */
export default function YouTubeSearchPanel() {
  const { t } = useT();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<Found | null>(null);
  const [channel, setChannel] = useState<Channel | null>(null);
  const [before, setBefore] = useState<Previous | null>(null);
  /** Everything ticked, kept when the page changes. Nothing is ticked by itself (except a single pasted video). */
  const [picked, setPicked] = useState<YouTubeEntry[]>([]);
  /** The link of the list being paged (a playlist, or a channel's tab). */
  const [source, setSource] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [channelText, setChannelText] = useState("");

  async function attempt(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(t("youtube.error", { error: String(e) }));
    } finally {
      setBusy(false);
    }
  }

  /** Show one page of a playlist or channel tab. */
  function showListPage(title: string, all: YouTubeEntry[], link: string, pageNumber: number) {
    setFound({ kind: "list", title, entries: all.slice(0, LIST_PAGE) });
    setHasMore(all.length > LIST_PAGE);
    setSource(link);
    setPage(pageNumber);
  }

  const run = (input: string, count = SEARCH_BATCH) =>
    attempt(async () => {
      const query = input.trim();
      if (!query) return;
      const r = await youtubeLookup(query, count === SEARCH_BATCH ? LIST_ASK : count);
      if (r.type === "video") {
        setFound({ kind: "video", entries: [r.entry], formats: r.formats });
        setChannel(null);
        setSource(null);
        setPicked([r.entry]);
      } else if (r.type === "list") {
        showListPage(r.title, r.entries, query, 0);
        setChannel(r.channelUrl ? { url: r.channelUrl, title: r.title.replace(/ - (Videos|Playlists)$/, ""), tab: "videos" } : null);
        setPicked([]);
      } else {
        setFound({ kind: "search", query, entries: r.entries });
        setChannel(null);
        setSource(null);
        setHasMore(false);
        if (count === SEARCH_BATCH) setPicked([]);
      }
      if (count === SEARCH_BATCH) setBefore(null);
    });

  /** Fetch page `n` (0 is the first) of the list at `link`. */
  const goToPage = (link: string, n: number, title?: string) =>
    attempt(async () => {
      const r = await youtubeLookup(link, LIST_PAGE + 1, n * LIST_PAGE);
      if (r.type !== "list") return;
      showListPage(title ?? (found?.kind === "list" ? found.title : r.title), r.entries, link, n);
    });

  /** Open a channel from a search result; Back returns to the search. */
  const openChannel = (entry: YouTubeEntry) =>
    attempt(async () => {
      const r = await youtubeLookup(entry.url, LIST_PAGE + 1);
      if (r.type !== "list") return;
      setBefore((b) => b ?? { found, picked, source, page, hasMore });
      const url = r.channelUrl ?? entry.url;
      setChannel({ url, title: entry.title, tab: "videos" });
      showListPage(r.title, r.entries, `${url}/videos`, 0);
    });

  const showTab = (tab: Exclude<Channel["tab"], "search">) =>
    attempt(async () => {
      if (!channel) return;
      setChannelText("");
      const link = `${channel.url}/${tab}`;
      const r = await youtubeLookup(link, LIST_PAGE + 1);
      if (r.type !== "list") return;
      setChannel({ ...channel, tab });
      showListPage(r.title, r.entries, link, 0);
    });

  /** Search the channel's videos and playlists. */
  const searchChannel = () =>
    attempt(async () => {
      const words = channelText.trim();
      if (!channel || !words) return;
      const link = `${channel.url}/search?query=${encodeURIComponent(words)}`;
      const r = await youtubeLookup(link, LIST_PAGE + 1);
      if (r.type !== "list") return;
      setChannel({ ...channel, tab: "search" });
      showListPage(r.title, r.entries, link, 0);
    });

  function back() {
    if (!before) return;
    setFound(before.found);
    setPicked(before.picked);
    setSource(before.source);
    setPage(before.page);
    setHasMore(before.hasMore);
    setChannel(null);
    setBefore(null);
  }

  const entries = found?.entries ?? [];
  const isPicked = (id: string) => picked.some((e) => e.id === id);
  const toggle = (entry: YouTubeEntry) => setPicked((p) => (p.some((e) => e.id === entry.id) ? p.filter((e) => e.id !== entry.id) : [...p, entry]));

  /** Download what is ticked; every ticked playlist is read first, so all of its videos are downloaded. */
  const download = () =>
    attempt(async () => {
      const playlists = picked.filter((e) => e.kind === "playlist");
      const videos = picked.filter((e) => e.kind === "video");
      const all = [...videos];
      for (const list of playlists) {
        const r = await youtubeLookup(list.url, 0);
        if (r.type === "list") for (const e of r.entries) if (!all.some((x) => x.id === e.id)) all.push(e);
      }
      if (all.length === 0) {
        setError(t("youtube.noResults"));
        return;
      }
      useYouTubeDownloadStore.getState().askQuality({
        entries: all,
        formats: found?.kind === "video" ? found.formats : null,
        // One playlist and nothing else: it becomes a playlist of its own.
        newPlaylistTitle: playlists.length === 1 && videos.length === 0 ? playlists[0].title : null,
      });
    });

  /** Every video of the list being browsed, not just the page on screen. */
  const downloadWholeList = () =>
    attempt(async () => {
      if (found?.kind !== "list" || !source) return;
      const r = await youtubeLookup(source, 0);
      if (r.type !== "list" || r.entries.length === 0) {
        setError(t("youtube.noResults"));
        return;
      }
      useYouTubeDownloadStore.getState().askQuality({ entries: r.entries, formats: null, newPlaylistTitle: channel?.title ?? found.title });
    });

  const onlyVideos = entries.length > 0 && entries.every((e) => e.kind === "video") && channel?.tab !== "search";
  const grid = channel !== null;

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

      {channel && (
        <div className="youtube-channel-bar">
          {before && (
            <button disabled={busy} onClick={back}>
              {t("youtube.back")}
            </button>
          )}
          <strong className="youtube-channel-name" title={channel.title}>
            {channel.title}
          </strong>
          <span className="tabs">
            <button className={channel.tab === "videos" ? "active" : ""} disabled={busy} onClick={() => void showTab("videos")}>
              {t("youtube.tabVideos")}
            </button>
            <button className={channel.tab === "playlists" ? "active" : ""} disabled={busy} onClick={() => void showTab("playlists")}>
              {t("youtube.tabPlaylists")}
            </button>
          </span>
          <form
            className="youtube-channel-search"
            onSubmit={(e) => {
              e.preventDefault();
              void searchChannel();
            }}
          >
            <input type="text" value={channelText} placeholder={t("youtube.searchChannel")} onChange={(e) => setChannelText(e.target.value)} />
            <button type="submit" disabled={busy || !channelText.trim()}>
              {t("youtube.search")}
            </button>
          </form>
        </div>
      )}
      {found?.kind === "list" && !channel && <p className="muted">{t("youtube.playlistFound", { title: found.title })}</p>}
      {found && entries.length === 0 && !error && <p className="muted">{t("youtube.noResults")}</p>}

      {entries.length > 0 && (
        <ScrollArea className={`staged youtube-results${grid ? " youtube-grid" : ""}`}>
          {entries.map((e) =>
            e.kind === "channel" ? (
              <div key={e.id} className="staged-row youtube-box" onClick={() => !busy && void openChannel(e)} role="button">
                <span className="youtube-badge">{t("youtube.badgeChannel")}</span>
                <span className="youtube-thumb youtube-avatar">{e.thumbnail && <img src={e.thumbnail} alt="" loading="lazy" />}</span>
                <span className="staged-title" title={e.title}>
                  {e.title}
                  <span className="muted"> · {t("youtube.openChannel")}</span>
                </span>
              </div>
            ) : (
              <label key={e.id} className={`staged-row${e.kind === "playlist" ? " youtube-box" : ""}`}>
                <input type="checkbox" checked={isPicked(e.id)} onChange={() => toggle(e)} />
                {e.kind === "playlist" && <span className="youtube-badge">{t("youtube.badgePlaylist")}</span>}
                <img className="youtube-thumb" src={e.thumbnail} alt="" loading="lazy" />
                <span className="staged-title" title={e.title}>
                  {e.title}
                  {e.channel && <span className="muted"> · {e.channel}</span>}
                </span>
                {e.duration ? <span className="muted">{formatTime(e.duration)}</span> : null}
              </label>
            ),
          )}
        </ScrollArea>
      )}

      {found?.kind === "list" && source && (page > 0 || hasMore) && (
        <div className="youtube-pager">
          <button disabled={busy || page === 0} onClick={() => void goToPage(source, page - 1)}>
            {t("youtube.previousPage")}
          </button>
          <span className="muted">{t("youtube.pageNumber", { page: page + 1 })}</span>
          <button disabled={busy || !hasMore} onClick={() => void goToPage(source, page + 1)}>
            {t("youtube.nextPage")}
          </button>
        </div>
      )}

      <div className="modal-actions">
        {found?.kind === "search" && entries.length > 0 && (
          <button disabled={busy} onClick={() => void run(found.query, entries.length + SEARCH_BATCH)}>
            {t("youtube.loadMore")}
          </button>
        )}
        <span className="spacer" />
        {found?.kind === "list" && onlyVideos && (
          <button disabled={busy} onClick={() => void downloadWholeList()}>
            {t("youtube.downloadAll")}
          </button>
        )}
        <button className="primary" disabled={busy || picked.length === 0} onClick={() => void download()}>
          {picked.length > 0 ? t("youtube.downloadCount", { count: picked.length }) : t("youtube.download")}
        </button>
      </div>
    </>
  );
}
