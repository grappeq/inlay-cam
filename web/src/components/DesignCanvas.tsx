import { useEffect, useMemo, useRef, useState } from "react";
import type { Design, DesignRegion, Ring } from "../core/types";
import { moveOnBoard, overlapping, placedBox, shapesInBox } from "../state/arrange";
import { fmt, regionOwners } from "../state/model";
import { useApp, useDispatch } from "../state/store";

/** Colours for inlays, by position in the list. Chosen to stay distinct from the selection colour. */
export const JOB_COLORS = ["#c2552d", "#2f7f6f", "#8a5fbf", "#b8892b", "#3f78b5", "#b04a7a"];

export function jobColor(index: number): string {
  return JOB_COLORS[index % JOB_COLORS.length];
}

function ringPath(ring: Ring, design: Design): string {
  let d = "";
  for (let i = 0; i < ring.length; i++) {
    const x = (design.mirror ? design.width - ring[i][0] : ring[i][0]) * design.scale;
    // SVG's Y axis points down; the design's points up.
    const y = (design.height - ring[i][1]) * design.scale;
    d += `${i === 0 ? "M" : "L"}${x.toFixed(3)} ${y.toFixed(3)}`;
  }
  return d + "Z";
}

function ringArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    sum += x0 * y1 - x1 * y0;
  }
  return Math.abs(sum) / 2;
}

function regionPath(region: DesignRegion, design: Design): string {
  return ringPath(region.outer, design) + region.holes.map((h) => ringPath(h, design)).join("");
}

interface Props {
  design: Design;
  /** Stretches too narrow for a plug to seat, in board coordinates, from the last generated output. */
  narrow: [[number, number], [number, number]][];
  /** The outline a flat inlay will really be cut to, in board coordinates, from the last generated output. */
  cuttable: [number, number][][];
}

/** The part of the picture that is shown, in the picture's own units (board millimetres, Y down). */
interface View {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What the pointer is doing between press and release. */
type Press =
  | { kind: "pan"; x: number; y: number; view: View }
  | { kind: "shape"; x: number; y: number; id: number; add: boolean; was: boolean; moved: boolean }
  | { kind: "empty"; x: number; y: number; add: boolean; moved: boolean; from: [number, number] };

type Gesture = { kind: "move"; dx: number; dy: number } | { kind: "band"; x0: number; y0: number; x1: number; y1: number };

const mm = (v: number) => fmt(Math.round(v * 100) / 100);

export function DesignCanvas({ design, narrow, cuttable }: Props) {
  const { project, selection, activeJobId, arranging } = useApp();
  const dispatch = useDispatch();
  const svg = useRef<SVGSVGElement>(null);
  const press = useRef<Press | null>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [zoomed, setZoomed] = useState<View | null>(null);

  const paths = useMemo(
    () =>
      design.regions
        .map((region) => ({ id: region.id, d: regionPath(region, design), area: ringArea(region.outer) }))
        // Largest first, so a shape drawn inside another stays on top and can be clicked.
        .sort((a, b) => b.area - a.area),
    [design],
  );
  const owners = useMemo(() => regionOwners(project.jobs), [project.jobs]);
  const overlaps = useMemo(() => (arranging ? new Set(overlapping(design)) : new Set<number>()), [arranging, design]);

  const width = design.width * design.scale;
  const height = design.height * design.scale;
  const pad = Math.max(width, height) * 0.04;
  const whole: View = useMemo(() => ({ x: -pad, y: -pad, w: width + 2 * pad, h: height + 2 * pad }), [pad, width, height]);
  const view = zoomed ?? whole;
  const viewNow = useRef(view);
  viewNow.current = view;

  // A board of another size is shown whole again.
  useEffect(() => setZoomed(null), [width, height]);

  const toPicture = (clientX: number, clientY: number): [number, number] | null => {
    const matrix = svg.current?.getScreenCTM();
    if (!matrix) return null;
    const p = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
    return [p.x, p.y];
  };

  const zoomBy = (factor: number, about?: [number, number]) => {
    const now = viewNow.current;
    const w = Math.max(whole.w / 60, now.w * factor);
    if (w >= whole.w) return setZoomed(null);
    const k = w / now.w;
    const [cx, cy] = about ?? [now.x + now.w / 2, now.y + now.h / 2];
    setZoomed({ x: cx - (cx - now.x) * k, y: cy - (cy - now.y) * k, w, h: now.h * k });
  };

  // The wheel zooms about the pointer. Registered by hand: React's own wheel
  // listener cannot stop the page from scrolling.
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomBy(Math.exp(e.deltaY * 0.0015), toPicture(e.clientX, e.clientY) ?? undefined);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whole]);

  // Escape abandons a drag in progress, before anything else hears of it.
  useEffect(() => {
    if (!gesture) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      press.current = null;
      setGesture(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [gesture]);

  const box = arranging ? placedBox(design, selection) : null;

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const hit = (e.target as Element).closest<SVGElement>("[data-region]");
    const id = hit ? Number(hit.dataset.region) : null;
    if (e.button === 1 || (e.button === 0 && !arranging && id === null)) {
      press.current = { kind: "pan", x: e.clientX, y: e.clientY, view: viewNow.current };
      e.preventDefault();
    } else if (arranging && e.button === 0) {
      const add = e.shiftKey || e.ctrlKey || e.metaKey;
      if (id !== null) {
        const was = selection.includes(id);
        // Pressing on a shape that is not selected picks it, so that it can be dragged at once.
        if (!was && !add) dispatch({ type: "clickRegion", id });
        press.current = { kind: "shape", x: e.clientX, y: e.clientY, id, add, was, moved: false };
      } else {
        const from = toPicture(e.clientX, e.clientY);
        if (!from) return;
        press.current = { kind: "empty", x: e.clientX, y: e.clientY, add, moved: false, from };
      }
    } else {
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const from = press.current;
    const matrix = svg.current?.getScreenCTM();
    if (!from || !matrix) return;
    if (from.kind === "pan") {
      setZoomed({ ...from.view, x: from.view.x - (e.clientX - from.x) / matrix.a, y: from.view.y - (e.clientY - from.y) / matrix.d });
      return;
    }
    if (!from.moved) {
      if (Math.hypot(e.clientX - from.x, e.clientY - from.y) < 4) return;
      from.moved = true;
      if (from.kind === "shape" && from.add && !from.was) {
        dispatch({ type: "clickRegion", id: from.id, add: true });
        from.was = true;
      }
    }
    if (from.kind === "shape") {
      let dx = (e.clientX - from.x) / matrix.a;
      // The picture's Y axis points down; the board's points up.
      let dy = -(e.clientY - from.y) / matrix.d;
      // Shift keeps the move straight across or straight up.
      if (e.shiftKey && !from.add) {
        if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      // Not past the board's left or bottom edge: the work origin stays where it is.
      if (box) {
        dx = Math.max(dx, -box.x);
        dy = Math.max(dy, -box.y);
      }
      setGesture({ kind: "move", dx, dy });
    } else {
      const to = toPicture(e.clientX, e.clientY);
      if (to) setGesture({ kind: "band", x0: from.from[0], y0: from.from[1], x1: to[0], y1: to[1] });
    }
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const from = press.current;
    press.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    const done = gesture;
    setGesture(null);
    if (!from || from.kind === "pan") return;
    if (from.kind === "shape") {
      if (from.moved && done?.kind === "move") {
        dispatch({ type: "editDrawing", update: (p) => (p.design ? { ...p, design: moveOnBoard(p.design, selection, done.dx, done.dy) } : p) });
      } else if (from.add) {
        dispatch({ type: "clickRegion", id: from.id, add: true });
      } else if (from.was) {
        dispatch({ type: "clickRegion", id: from.id });
      }
      return;
    }
    if (from.moved && done?.kind === "band") {
      // From the picture back to the design's own millimetres.
      const s = design.scale;
      const xs = [done.x0, done.x1].map((x) => (design.mirror ? design.width - x / s : x / s));
      const ys = [done.y0, done.y1].map((y) => (height - y) / s);
      const inside = shapesInBox(design, [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
      dispatch({ type: "setSelection", ids: from.add ? [...new Set([...selection, ...inside])] : inside });
    } else if (!from.add) {
      dispatch({ type: "setSelection", ids: [] });
    }
  };

  const moving = gesture?.kind === "move" ? gesture : null;
  const shift = moving ? `translate(${moving.dx} ${-moving.dy})` : undefined;
  const readout =
    box &&
    `${selection.length} shape${selection.length === 1 ? "" : "s"}, ${mm(box.width)} × ${mm(box.height)} mm, ${mm(box.x + (moving?.dx ?? 0))} mm from the left, ${mm(
      box.y + (moving?.dy ?? 0),
    )} mm from the bottom`;

  return (
    <div className="canvas-wrap">
      <svg
        ref={svg}
        className={`canvas${arranging ? " arranging" : ""}${moving ? " dragging" : ""}${zoomed ? " zoomed" : ""}`}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        role="group"
        aria-label={arranging ? "Drawing. Click a part to select it, drag it to move it." : "Drawing. Click a shape to select it."}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          press.current = null;
          setGesture(null);
        }}
        onDoubleClick={(e) => {
          if (!(e.target as Element).closest("[data-region]")) setZoomed(null);
        }}
      >
        <rect className="page" x={0} y={0} width={width} height={height} />
        {paths.map(({ id, d }) => {
          const owner = owners.get(id);
          const ownerIndex = owner ? project.jobs.indexOf(owner) : -1;
          const selected = selection.includes(id);
          const inActive = owner !== undefined && owner.id === activeJobId;
          const dimmed = !arranging && activeJobId !== null && owner !== undefined && !inActive;
          const label = owner ? `Shape ${id + 1}, in ${owner.name}${selected ? ", selected" : ""}` : `Shape ${id + 1}${selected ? ", selected" : ""}`;
          const click = (add: boolean) => dispatch({ type: "clickRegion", id, add });
          return (
            <path
              key={id}
              data-region={id}
              d={d}
              fillRule="evenodd"
              className={`region${selected ? " selected" : ""}${owner ? " owned" : ""}${inActive ? " active" : ""}${dimmed ? " dimmed" : ""}${
                overlaps.has(id) ? " overlap" : ""
              }`}
              // While arranging, the selection colour wins over the inlay's.
              style={owner && !(arranging && selected) ? { fill: jobColor(ownerIndex) } : undefined}
              transform={selected ? shift : undefined}
              tabIndex={0}
              role="button"
              aria-label={label}
              aria-pressed={selected || inActive}
              // While arranging, presses and releases on the drawing do the selecting.
              onClick={arranging ? undefined : () => click(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  click(e.shiftKey);
                }
              }}
            >
              <title>{label}</title>
            </path>
          );
        })}
        {cuttable.length > 0 && (
          <g className="cuttable" aria-label="The outline that will be cut">
            {cuttable.map((ring, i) => (
              <path key={i} d={ring.map(([x, y], k) => `${k === 0 ? "M" : "L"}${x.toFixed(3)} ${(height - y).toFixed(3)}`).join("") + "Z"} />
            ))}
          </g>
        )}
        {narrow.length > 0 && (
          <g className="narrow" aria-label="Parts too narrow for the plug to seat">
            {narrow.map(([a, b], i) => (
              // Board coordinates have Y up; the drawing has Y down.
              <line key={i} x1={a[0]} y1={height - a[1]} x2={b[0]} y2={height - b[1]} />
            ))}
          </g>
        )}
        {box && <rect className="selection-box" x={box.x} y={height - box.y - box.height} width={box.width} height={box.height} transform={shift} />}
        {gesture?.kind === "band" && (
          <rect
            className="band"
            x={Math.min(gesture.x0, gesture.x1)}
            y={Math.min(gesture.y0, gesture.y1)}
            width={Math.abs(gesture.x1 - gesture.x0)}
            height={Math.abs(gesture.y1 - gesture.y0)}
          />
        )}
      </svg>
      <div className="canvas-zoom" role="group" aria-label="Zoom">
        <button onClick={() => zoomBy(1 / 1.4)} aria-label="Zoom in" title="Zoom in">
          +
        </button>
        <button onClick={() => zoomBy(1.4)} aria-label="Zoom out" title="Zoom out" disabled={!zoomed}>
          −
        </button>
        <button onClick={() => setZoomed(null)} disabled={!zoomed}>
          Whole board
        </button>
      </div>
      {readout && (
        <p className="canvas-readout" aria-live="off">
          {readout}
        </p>
      )}
    </div>
  );
}
