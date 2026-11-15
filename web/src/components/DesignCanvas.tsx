import { useMemo } from "react";
import type { Design, DesignRegion, Ring } from "../core/types";
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
  const { project, selection, activeJobId } = useApp();
  const dispatch = useDispatch();

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
      className="canvas"
      viewBox={`${-pad} ${-pad} ${width + 2 * pad} ${height + 2 * pad}`}
      role="group"
      aria-label="Design. Click a shape to select it."
    >
      <rect className="page" x={0} y={0} width={width} height={height} />
      {paths.map(({ id, d }) => {
        const owner = owners.get(id);
        const ownerIndex = owner ? project.jobs.indexOf(owner) : -1;
        const selected = selection.includes(id);
        const inActive = owner !== undefined && owner.id === activeJobId;
        const dimmed = activeJobId !== null && owner !== undefined && !inActive;
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
            onClick={() => dispatch({ type: "clickRegion", id })}
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
