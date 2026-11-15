import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Design, DesignRegion, Ring } from "../core/types";
import { moveOnBoard, overlapping, placedBox, shapesInBox, stretchLimits, stretchOnBoard, type Placed } from "../state/arrange";
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
  /** A handle of the selection's box: `hx`, `hy` say which, as fractions of the box from its left and bottom. */
  | { kind: "handle"; x: number; y: number; hx: number; hy: number; box: Placed; moved: boolean }
  | { kind: "empty"; x: number; y: number; add: boolean; moved: boolean; from: [number, number] };

type Gesture =
  | { kind: "move"; dx: number; dy: number }
  /** Stretching by `fx`, `fy` about the point `anchor` of the box, counted from its left and bottom. */
  | { kind: "resize"; fx: number; fy: number; anchor: [number, number]; box: Placed }
  | { kind: "band"; x0: number; y0: number; x1: number; y1: number };

/** The handles of the selection's box, as fractions of the box from its left and bottom. */
const HANDLES: [number, number][] = [
  [0, 0],
  [0.5, 0],
  [1, 0],
  [1, 0.5],
  [1, 1],
  [0.5, 1],
  [0, 1],
  [0, 0.5],
];
/** Side of a handle on the screen, px. */
const HANDLE = 9;
/** The smallest a selection can be dragged to, mm. */
const SMALLEST = 0.5;

function handleCursor(hx: number, hy: number): string {
  if (hx === 0.5) return "ns-resize";
  if (hy === 0.5) return "ew-resize";
  return hx === hy ? "nesw-resize" : "nwse-resize";
}

function handleName(hx: number, hy: number): string {
  const side = [hy === 0 ? "bottom" : hy === 1 ? "top" : "", hx === 0 ? "left" : hx === 1 ? "right" : ""].filter(Boolean).join("-");
  return `Resize from the ${side}${hx !== 0.5 && hy !== 0.5 ? " corner" : " side"}`;
}

const mm = (v: number) => fmt(Math.round(v * 100) / 100);

export function DesignCanvas({ design, narrow, cuttable }: Props) {
  const { project, selection, activeJobId, arranging } = useApp();
  const dispatch = useDispatch();
  const svg = useRef<SVGSVGElement>(null);
  const press = useRef<Press | null>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [zoomed, setZoomed] = useState<View | null>(null);
  // How many millimetres of the picture one pixel of the screen shows.
  const [pixel, setPixel] = useState(0);

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

  // Handles keep their size on the screen at any zoom and window size.
  const measure = () => {
    const a = svg.current?.getScreenCTM()?.a;
    if (a && a > 0) setPixel((old) => (Math.abs(old - 1 / a) > 1e-9 ? 1 / a : old));
  };
  useLayoutEffect(measure);
  useEffect(() => {
    if (!svg.current) return;
    const observer = new ResizeObserver(measure);
    observer.observe(svg.current);
    return () => observer.disconnect();
  }, []);

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
    const handle = (e.target as Element).closest<SVGElement>("[data-handle]");
    if (e.button === 1 || (e.button === 0 && !arranging && id === null)) {
      press.current = { kind: "pan", x: e.clientX, y: e.clientY, view: viewNow.current };
      e.preventDefault();
    } else if (arranging && e.button === 0 && handle && box) {
      const [hx, hy] = HANDLES[Number(handle.dataset.handle)];
      press.current = { kind: "handle", x: e.clientX, y: e.clientY, hx, hy, box, moved: false };
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
    if (from.kind === "handle") {
      const { hx, hy, box: start } = from;
      // Ctrl or Alt resizes about the middle; otherwise the opposite corner or side stays put.
      const middle = e.ctrlKey || e.metaKey || e.altKey;
      const anchor: [number, number] = middle ? [0.5, 0.5] : [1 - hx, 1 - hy];
      const dx = (e.clientX - from.x) / matrix.a;
      const dy = -(e.clientY - from.y) / matrix.d;
      const factor = (h: number, a: number, d: number, size: number) => (h === 0.5 || size <= 0 ? 1 : Math.max(SMALLEST / size, 1 + d / ((h - a) * size)));
      let fx = factor(hx, anchor[0], dx, start.width);
      let fy = factor(hy, anchor[1], dy, start.height);
      const [maxX, maxY] = stretchLimits(start, anchor);
      const corner = hx !== 0.5 && hy !== 0.5;
      if (corner && !e.shiftKey) {
        // A corner keeps the proportions; Shift lets width and height go their own ways.
        fx = fy = Math.min(Math.max(fx, fy), maxX, maxY);
      } else {
        fx = Math.min(fx, maxX);
        fy = Math.min(fy, maxY);
      }
      setGesture({ kind: "resize", fx, fy, anchor, box: start });
      return;
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
    if (from.kind === "handle") {
      if (from.moved && done?.kind === "resize") {
        dispatch({
          type: "editDrawing",
          update: (p) => (p.design ? { ...p, design: stretchOnBoard(p.design, selection, done.fx, done.fy, done.anchor) } : p),
        });
      }
      return;
    }
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
  const resizing = gesture?.kind === "resize" ? gesture : null;
  // The selection's box as it is shown right now, part-way through a drag.
  const shown: Placed | null = !box
    ? null
    : moving
      ? { ...box, x: box.x + moving.dx, y: box.y + moving.dy }
      : resizing
        ? {
            x: box.x + resizing.anchor[0] * box.width * (1 - resizing.fx),
            y: box.y + resizing.anchor[1] * box.height * (1 - resizing.fy),
            width: box.width * resizing.fx,
            height: box.height * resizing.fy,
          }
        : box;
  let shift: string | undefined;
  if (moving) shift = `translate(${moving.dx} ${-moving.dy})`;
  else if (resizing && box) {
    // The picture's Y axis points down; the board's points up.
    const ax = box.x + resizing.anchor[0] * box.width;
    const ay = height - (box.y + resizing.anchor[1] * box.height);
    shift = `translate(${ax} ${ay}) scale(${resizing.fx} ${resizing.fy}) translate(${-ax} ${-ay})`;
  }
  const readout =
    shown &&
    `${selection.length} shape${selection.length === 1 ? "" : "s"}, ${mm(shown.width)} × ${mm(shown.height)} mm, ${mm(shown.x)} mm from the left, ${mm(
      shown.y,
    )} mm from the bottom`;

  return (
    <div className="canvas-wrap">
      <svg
        ref={svg}
        className={`canvas${arranging ? " arranging" : ""}${moving || resizing ? " dragging" : ""}${zoomed ? " zoomed" : ""}`}
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
          if (!(e.target as Element).closest("[data-region], [data-handle]")) setZoomed(null);
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
        {shown && <rect className="selection-box" x={shown.x} y={height - shown.y - shown.height} width={shown.width} height={shown.height} />}
        {shown &&
          pixel > 0 &&
          !moving &&
          HANDLES.map(([hx, hy], i) => {
            const side = HANDLE * pixel;
            // Side handles only where the box is long enough to tell them from the corners.
            if ((hx === 0.5 && shown.width < 3 * side) || (hy === 0.5 && shown.height < 3 * side)) return null;
            return (
              <rect
                key={i}
                data-handle={i}
                className="handle"
                x={shown.x + hx * shown.width - side / 2}
                y={height - (shown.y + hy * shown.height) - side / 2}
                width={side}
                height={side}
                style={{ cursor: handleCursor(hx, hy) }}
              >
                <title>{handleName(hx, hy)}</title>
              </rect>
            );
          })}
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
