import { useEffect, useState } from "react";
import { mediaUrl } from "../videoThumbnails";

/** A preview image from a saved thumbnail file, or a plain placeholder. */
export default function ThumbnailImage({ path, className = "" }: { path?: string | null; className?: string }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setUrl(null);
    if (path) mediaUrl(path).then((u) => alive && setUrl(u)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [path]);

  return url ? <img className={`thumb ${className}`} src={url} alt="" draggable={false} /> : <div className={`thumb placeholder ${className}`} />;
}
