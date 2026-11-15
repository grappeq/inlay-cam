// Putting the lines of a list in another order by dragging them, or with the
// arrow keys on a line's grip.

import { useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { ToolIcon } from "./icons";

/** Where a line moves to when line `from` is dropped at gap `gap` (0 is above the first line). */
export function dropIndex(from: number, gap: number): number {
  return gap > from ? gap - 1 : gap;
}

/**
 * Makes a list sortable. Spread `row(i)` on each line and put `<Grip>` with
 * `grip(i, name)` in it: the grip is what is dragged. `onMove(from, to)` is
 * told the line's old and new place.
 */
export function useSortable(count: number, onMove: (from: number, to: number) => void) {
  const [drag, setDrag] = useState<{ from: number; gap: number | null } | null>(null);
  // Read by handlers that fire between renders.
  const now = useRef(drag);
  now.current = drag;

  const row = (index: number) => ({
    "data-drop": drag && drag.gap !== null && dropIndex(drag.from, drag.gap) !== drag.from ? (drag.gap === index ? "before" : drag.gap === index + 1 && index === count - 1 ? "after" : undefined) : undefined,
    "data-dragging": drag?.from === index ? true : undefined,
    onDragOver: (e: DragEvent<HTMLElement>) => {
      const d = now.current;
      if (!d) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const box = e.currentTarget.getBoundingClientRect();
      const gap = e.clientY > box.top + box.height / 2 ? index + 1 : index;
      if (gap !== d.gap) setDrag({ ...d, gap });
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      const d = now.current;
      if (!d) return;
      e.preventDefault();
      e.stopPropagation();
      setDrag(null);
      if (d.gap === null) return;
      const to = dropIndex(d.from, d.gap);
      if (to !== d.from) onMove(d.from, to);
    },
  });

  const grip = (index: number, name: string) => ({
    draggable: true,
    role: "button" as const,
    tabIndex: 0,
    "aria-label": `Move ${name}: drag it, or press the up or down arrow`,
    title: "Drag to change the order",
    onDragStart: (e: DragEvent<HTMLElement>) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", name);
      // Show the whole line under the pointer, not only the grip.
      const line = e.currentTarget.closest("li");
      if (line) e.dataTransfer.setDragImage(line, 12, 12);
      setDrag({ from: index, gap: null });
    },
    onDragEnd: () => setDrag(null),
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      const to = e.key === "ArrowUp" ? index - 1 : e.key === "ArrowDown" ? index + 1 : -1;
      if (to < 0 || to >= count) return;
      e.preventDefault();
      onMove(index, to);
      // Keep the focus on the line that moved.
      const list = e.currentTarget.closest("ul, ol");
      requestAnimationFrame(() => list?.querySelectorAll<HTMLElement>(".grip")[to]?.focus());
    },
  });

  return { row, grip };
}

/** The handle a line is dragged by. */
export function Grip(props: ReturnType<ReturnType<typeof useSortable>["grip"]>) {
  return (
    <span className="grip" {...props}>
      <ToolIcon name="grip" />
    </span>
  );
}
