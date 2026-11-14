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

function regionPath(region: DesignRegion, design: Design): string {
  return ringPath(region.outer, design) + region.holes.map((h) => ringPath(h, design)).join("");
}

export function DesignCanvas({ design }: { design: Design }) {
  const { project, selection, activeJobId } = useApp();
  const dispatch = useDispatch();

  const paths = useMemo(
    () => design.regions.map((region) => ({ id: region.id, d: regionPath(region, design) })),
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
    </svg>
  );
}
