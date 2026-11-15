import { useMemo, useRef, useState } from "react";
import type { Design, DesignRegion, Ring } from "../core/types";
import { moveOnBoard, removeShapes } from "../state/arrange";
import { regionOwners } from "../state/model";
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

export function DesignCanvas({ design, narrow, cuttable }: Props) {
  const { project, selection, activeJobId, arranging } = useApp();
  const dispatch = useDispatch();
  const svg = useRef<SVGSVGElement>(null);
  // While arranging: where a press began, and how far the selection has been dragged, in board millimetres.
  const press = useRef<{ x: number; y: number; id: number; moved: boolean } | null>(null);
  const [drag, setDrag] = useState<[number, number] | null>(null);

  const edit = (update: (d: Design) => Design) =>
    dispatch({ type: "editDrawing", update: (p) => (p.design ? { ...p, design: update(p.design) } : p) });
  const dragged = (e: React.PointerEvent): [number, number] | null => {
    const from = press.current;
    const matrix = svg.current?.getScreenCTM();
    if (!from || !matrix) return null;
    return [(e.clientX - from.x) / matrix.a, (e.clientY - from.y) / matrix.d];
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const from = press.current;
    if (!from) return;
    if (!from.moved) {
      if (Math.hypot(e.clientX - from.x, e.clientY - from.y) < 4) return;
      from.moved = true;
      // Dragging a shape that is not selected picks it up first.
      if (!selection.includes(from.id)) dispatch({ type: "clickRegion", id: from.id });
    }
    setDrag(dragged(e));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const from = press.current;
    const by = dragged(e);
    if (from?.moved && by) {
      // The picture's Y axis points down; the board's points up.
      edit((d) => moveOnBoard(d, selection, by[0], -by[1]));
      // The click that follows a drag must not change the selection.
      setTimeout(() => (press.current = null), 0);
    } else {
      press.current = null;
    }
    setDrag(null);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!arranging || selection.length === 0) return;
    const step = e.shiftKey ? 0.1 : 1;
    const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[e.key]) {
      e.preventDefault();
      edit((d) => moveOnBoard(d, selection, moves[e.key][0], moves[e.key][1]));
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      dispatch({ type: "editDrawing", update: (p) => removeShapes(p, selection) });
    }
  };

  const paths = useMemo(
    () =>
      design.regions
        .map((region) => ({ id: region.id, d: regionPath(region, design), area: ringArea(region.outer) }))
        // Largest first, so a shape drawn inside another stays on top and can be clicked.
        .sort((a, b) => b.area - a.area),
    [design],
  );
  const owners = useMemo(() => regionOwners(project.jobs), [project.jobs]);

  const width = design.width * design.scale;
  const height = design.height * design.scale;
  const pad = Math.max(width, height) * 0.04;

  return (
    <svg
      ref={svg}
      className={`canvas${arranging ? " arranging" : ""}${drag ? " dragging" : ""}`}
      onPointerMove={arranging ? onPointerMove : undefined}
      onPointerUp={arranging ? onPointerUp : undefined}
      onPointerLeave={arranging ? onPointerUp : undefined}
      onKeyDown={onKeyDown}
      viewBox={`${-pad} ${-pad} ${width + 2 * pad} ${height + 2 * pad}`}
      role="group"
      aria-label={arranging ? "Design. Click a part to select it, drag to move it." : "Design. Click a shape to select it."}
    >
      <rect className="page" x={0} y={0} width={width} height={height} />
      {paths.map(({ id, d }) => {
        const owner = owners.get(id);
        const ownerIndex = owner ? project.jobs.indexOf(owner) : -1;
        const selected = selection.includes(id);
        const inActive = owner !== undefined && owner.id === activeJobId;
        const dimmed = !arranging && activeJobId !== null && owner !== undefined && !inActive;
        const label = owner ? `Shape ${id + 1}, in ${owner.name}` : `Shape ${id + 1}${selected ? ", selected" : ""}`;
        return (
          <path
            key={id}
            d={d}
            fillRule="evenodd"
            className={`region${selected ? " selected" : ""}${owner ? " owned" : ""}${inActive ? " active" : ""}${dimmed ? " dimmed" : ""}`}
            style={owner ? { fill: jobColor(ownerIndex) } : undefined}
            tabIndex={0}
            role="button"
            aria-label={label}
            aria-pressed={selected || inActive}
            transform={drag && selected ? `translate(${drag[0]} ${drag[1]})` : undefined}
            onPointerDown={arranging ? (e) => (press.current = { x: e.clientX, y: e.clientY, id, moved: false }) : undefined}
            onClick={() => {
              if (press.current?.moved) return;
              dispatch({ type: "clickRegion", id });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                dispatch({ type: "clickRegion", id });
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
    </svg>
  );
}
