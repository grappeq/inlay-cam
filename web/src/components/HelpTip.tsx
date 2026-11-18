// The one way the app shows help on demand: a small "?" beside a label. Its
// card shows while the mark is pointed at or has the focus; a click keeps it
// open until Escape, a click elsewhere or scrolling.

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { HELP, type HelpEntry, type HelpTopic } from "./help";

const EDGE = 8;

export function HelpTip({ topic }: { topic: HelpTopic }) {
  return <Tip entry={HELP[topic]} />;
}

/**
 * A mark with a card of its own, shown the same way. `mark` is what stands
 * in place of the "?", `label` what it is called, `className` its look.
 */
export function Tip({ entry, mark: shown = "?", label, className = "help-mark" }: { entry: HelpEntry; mark?: ReactNode; label?: string; className?: string }) {
  const [open, setOpen] = useState<false | "shown" | "pinned">(false);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const mark = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLSpanElement>(null);
  const id = useId();

  // Under the mark where there is room, above it where there is not; never off the window's sides.
  useLayoutEffect(() => {
    if (!open || !mark.current || !card.current) return setPlace(null);
    const at = mark.current.getBoundingClientRect();
    const size = card.current.getBoundingClientRect();
    const left = Math.max(EDGE, Math.min(at.left + at.width / 2 - size.width / 2, window.innerWidth - size.width - EDGE));
    const below = at.bottom + 6;
    setPlace({ left, top: below + size.height > window.innerHeight - EDGE ? Math.max(EDGE, at.top - 6 - size.height) : below });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // A card kept open is what Escape closes, before anything else it would do.
      if (open === "pinned") e.stopPropagation();
      close();
    };
    const outside = (e: PointerEvent) => {
      if (!mark.current?.contains(e.target as Node)) close();
    };
    // The card is placed against the window, so it cannot follow what scrolls under it.
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    document.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", outside);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerdown", outside);
    };
  }, [open]);

  return (
    <>
      <button
        ref={mark}
        type="button"
        className={className}
        aria-label={label ?? `About: ${entry.title}`}
        aria-expanded={open !== false}
        aria-describedby={open ? id : undefined}
        onPointerEnter={(e) => e.pointerType === "mouse" && setOpen((now) => now || "shown")}
        onPointerLeave={() => setOpen((now) => (now === "pinned" ? now : false))}
        onFocus={() => setOpen((now) => now || "shown")}
        onBlur={() => setOpen(false)}
        onClick={(e) => {
          // Inside a label, a click would otherwise go on to the label's field.
          e.preventDefault();
          setOpen((now) => (now === "pinned" ? false : "pinned"));
        }}
      >
        {shown}
      </button>
      {open && (
        <span ref={card} id={id} role="tooltip" className={`help-card${entry.picture ? " with-picture" : ""}`} style={place ? place : { left: 0, top: 0, visibility: "hidden" }}>
          {entry.picture}
          <span>
            <strong>{entry.title}</strong>
            {entry.text}
          </span>
        </span>
      )}
    </>
  );
}
