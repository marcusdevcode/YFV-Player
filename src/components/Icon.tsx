import { useThemeStore, activeTheme } from "../store/themeStore";
import { defaultIconRef, iconData, iconRefOf, type IconSlot } from "../theme/themeEngine";

/** An icon by name: "<set>:<name>", drawn in the current text color. */
export function IconByRef({ icon, className = "" }: { icon: string; className?: string }) {
  const data = iconData(icon);
  if (!data) return null;
  return (
    <svg className={`icon ${className}`} viewBox={data.viewBox} aria-hidden="true">
      {data.paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}

/** The icon the active theme uses for a slot of the interface (play, pause, ...). */
export default function Icon({ slot, className }: { slot: IconSlot; className?: string }) {
  const ref = useThemeStore((s) => iconRefOf(activeTheme(s), slot));
  return <IconByRef icon={iconData(ref) ? ref : defaultIconRef(slot)} className={className} />;
}
