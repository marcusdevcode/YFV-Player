import { Children, isValidElement, useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface OptionData {
  value: string;
  label: ReactNode;
  disabled: boolean;
}

/** The `<option>` children, also through fragments, arrays and conditions. */
function optionsOf(children: ReactNode): OptionData[] {
  const out: OptionData[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    const element = child as ReactElement<{ value?: string | number; disabled?: boolean; children?: ReactNode }>;
    if (element.type === "option") {
      out.push({ value: String(element.props.value ?? ""), label: element.props.children, disabled: !!element.props.disabled });
    } else if (element.props.children) {
      out.push(...optionsOf(element.props.children));
    }
  });
  return out;
}

interface Props {
  value: string;
  /** Called like a `<select>`'s onChange: `e.target.value` is the chosen option's value. */
  onChange?: (e: ChangeEvent<HTMLSelectElement>) => void;
  disabled?: boolean;
  className?: string;
  children?: ReactNode;
}

/**
 * The app's own drop-down list, used instead of the system `<select>` so it can be drawn in the theme's style
 * (see `.dropdown-select*` in src/styles.css). It takes `<option>` children and an onChange like `<select>`.
 * The list opens in the page's top layer (a portal), so no dialog can clip it; its scrollbar is the classic kind that takes
 * its own column beside the entries (the floating one would lie over them); it closes on a click elsewhere,
 * Escape, scrolling or resizing. Keys: Up/Down/Home/End move, Enter or Space chooses.
 */
export default function DropdownSelect({ value, onChange, disabled, className, children }: Props) {
  const options = optionsOf(children);
  const current = options.find((o) => o.value === value) ?? options[0];
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<{ left: number; top: number; width: number; up: boolean; right: boolean } | null>(null);
  const trigger = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const openList = useCallback(() => {
    if (disabled) return;
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  }, [disabled, options, value]);

  const choose = (option: OptionData) => {
    if (option.disabled) return;
    setOpen(false);
    trigger.current?.focus();
    if (option.value !== value) onChange?.({ target: { value: option.value } } as unknown as ChangeEvent<HTMLSelectElement>);
  };

  // Where the list goes: under the field (above it when there is no room), as wide as the field at least.
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const r = trigger.current.getBoundingClientRect();
    const listHeight = Math.min(list.current?.offsetHeight ?? 240, window.innerHeight * 0.4);
    const up = window.innerHeight - r.bottom < listHeight + 12 && r.top > listHeight + 12;
    setPlace({ left: r.left, top: up ? r.top : r.bottom, width: r.width, up, right: document.documentElement.dir === "rtl" });
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      const target = e.target as Node;
      if (!trigger.current?.contains(target) && !list.current?.contains(target)) setOpen(false);
    };
    const close = (e: Event) => {
      if (!list.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  // Keep the active entry in view while moving with the keys.
  useEffect(() => {
    if (open) list.current?.querySelector(".dropdown-select-option.active")?.scrollIntoView({ block: "nearest" });
  }, [open, active, place]);

  const move = (step: number) => {
    if (!options.length) return;
    let i = active;
    for (let n = 0; n < options.length; n++) {
      i = (i + step + options.length) % options.length;
      if (!options[i].disabled) break;
    }
    setActive(i);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) openList();
      else move(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Home" || e.key === "End") {
      if (open) {
        e.preventDefault();
        setActive(e.key === "Home" ? 0 : options.length - 1);
      }
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (!open) openList();
      else if (options[active]) choose(options[active]);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <>
      <div
        ref={trigger}
        className={`dropdown-select-trigger${open ? " open" : ""}${disabled ? " disabled" : ""}${className ? ` ${className}` : ""}`}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
      >
        <span className="dropdown-select-value" title={typeof current?.label === "string" ? current.label : undefined}>{current?.label}</span>
        <svg className="dropdown-select-arrow" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2 4.2 6 8l4-3.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      {open &&
        createPortal(
          <div
            ref={list}
            className="dropdown-select-popup"
            role="listbox"
            style={{
              position: "fixed",
              top: place ? (place.up ? undefined : place.top + 4) : -9999,
              bottom: place?.up ? window.innerHeight - place.top + 4 : undefined,
              left: place && !place.right ? place.left : undefined,
              right: place?.right ? window.innerWidth - place.left - place.width : undefined,
              minWidth: place?.width,
            }}
          >
            <div className="dropdown-select-scroll">
              {options.map((o, i) => (
                <div
                  key={o.value + i}
                  role="option"
                  aria-selected={o.value === value}
                  aria-disabled={o.disabled}
                  className={`dropdown-select-option${o.value === value ? " selected" : ""}${i === active ? " active" : ""}${o.disabled ? " disabled" : ""}`}
                  onPointerEnter={() => !o.disabled && setActive(i)}
                  onClick={() => choose(o)}
                >
                  {o.label}
                </div>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
