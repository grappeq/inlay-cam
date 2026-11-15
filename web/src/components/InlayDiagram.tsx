import type { Inlay } from "../core/types";
import { fmt } from "../state/model";

/** One measured height in the picture: where it starts and ends, and what to call it. */
interface Dimension {
  from: number;
  to: number;
  label: string;
  /** How far right of the others its bracket is drawn, so two that share a span stay apart. */
  shift?: number;
}

/** Brackets down the right-hand side, each with its label, kept from overlapping. */
function Dimensions({ x, items }: { x: number; items: Dimension[] }) {
  let previous = -Infinity;
  return (
    <g className="dims">
      {items.map((d) => {
        const y = Math.max((d.from + d.to) / 2, previous + 14);
        previous = y;
        const bx = x + (d.shift ?? 0);
        return (
          <g key={d.label}>
            <path d={`M${bx - 3} ${d.from}H${bx + 3}M${bx} ${d.from}V${d.to}M${bx - 3} ${d.to}H${bx + 3}`} />
            <path className="leader" d={`M${bx + 3} ${(d.from + d.to) / 2}L${x + 22} ${y}`} />
            <text x={x + 25} y={y} dominantBaseline="middle">
              {d.label}
            </text>
          </g>
        );
      })}
    </g>
  );
}

/**
 * A cross-section through the inlay as the current numbers make it: the base
 * board, and the plug or insert in place. Heights follow the numbers; very
 * small ones are drawn large enough to see.
 */
export function InlayDiagram({ inlay, halfAngle }: { inlay: Inlay; halfAngle: number }) {
  const left = 8;
  const right = 176;
  const middle = (left + right) / 2;
  const dimX = right + 10;

  if (inlay.type === "vcarve") {
    const total = Math.max(inlay.engagementDepth + inlay.glueGap + inlay.sawGap, 0.1);
    const k = 62 / total;
    const saw = Math.max(inlay.sawGap * k, 5);
    const engagement = Math.max(inlay.engagementDepth * k, 8);
    const glue = Math.max(inlay.glueGap * k, 4);
    const backer = 14;
    const yBacker = 6 + backer;
    const y0 = yBacker + saw;
    const yTip = y0 + engagement;
    const yFloor = yTip + glue;
    const yBottom = yFloor + 14;
    const top = 52;
    // Keep a floor to stand on however steep the numbers make the walls.
    const slope = Math.min(Math.tan(halfAngle), (top - 10) / (engagement + glue));
    const at = (y: number) => top - (y - y0) * slope;
    const base = `M${left} ${y0}H${middle - top}L${middle - at(yFloor)} ${yFloor}H${middle + at(yFloor)}L${middle + top} ${y0}H${right}V${yBottom}H${left}Z`;
    const plug = `M${left + 10} 6H${right - 10}V${yBacker}H${middle + at(yBacker)}L${middle + at(yTip)} ${yTip}H${middle - at(yTip)}L${middle - at(yBacker)} ${yBacker}H${left + 10}Z`;
    return (
      <figure className="diagram">
        <svg viewBox={`0 0 300 ${yBottom + 4}`} role="img" aria-label="Cross-section: the plug sitting in its pocket">
          <path className="wood-base" d={base} />
          <path className="wood-plug" d={plug} />
          <Dimensions
            x={dimX}
            items={[
              { from: yBacker, to: y0, label: `Saw gap ${fmt(inlay.sawGap)}` },
              { from: y0, to: yTip, label: `Engagement ${fmt(inlay.engagementDepth)}` },
              { from: yTip, to: yFloor, label: `Glue gap ${fmt(inlay.glueGap)}` },
            ]}
          />
        </svg>
        <figcaption>
          Plug (dark) glued into the base board. Pocket {fmt(inlay.engagementDepth + inlay.glueGap)} mm deep; plug cut{" "}
          {fmt(inlay.engagementDepth + inlay.sawGap)} mm deep. Not to scale.
        </figcaption>
      </figure>
    );
  }

  if (inlay.insertStyle === "backer") {
    const k = 56 / Math.max(inlay.pocketDepth + inlay.sawGap, 0.1);
    const backer = 14;
    const yBacker = 6 + backer;
    const saw = Math.max(inlay.sawGap * k, inlay.sawGap > 0 ? 5 : 0);
    const depth = Math.max(inlay.pocketDepth * k, 8);
    const y0 = yBacker + saw;
    const yFloor = y0 + depth;
    const yBottom = yFloor + 14;
    const half = 48;
    const gap = inlay.allowance > 0 ? 3 : 0;
    const base = `M${left} ${y0}H${middle - half}V${yFloor}H${middle + half}V${y0}H${right}V${yBottom}H${left}Z`;
    const plug = `M${left + 10} 6H${right - 10}V${yBacker}H${middle + half - gap}V${yFloor}H${middle - half + gap}V${yBacker}H${left + 10}Z`;
    return (
      <figure className="diagram">
        <svg viewBox={`0 0 300 ${yBottom + 4}`} role="img" aria-label="Cross-section: the plug on its backer sitting in the pocket">
          <path className="wood-base" d={base} />
          <path className="wood-plug" d={plug} />
          <Dimensions
            x={dimX}
            items={[
              { from: yBacker, to: y0, label: `Saw gap ${fmt(inlay.sawGap)}` },
              { from: y0, to: yFloor, label: `Pocket ${fmt(inlay.pocketDepth)} deep` },
            ]}
          />
        </svg>
        <figcaption>
          Plug (dark) glued in face down, {fmt(inlay.allowance / 2)} mm clear on each side. Its backer is sawn or planed off afterwards. The plug
          is cut {fmt(inlay.pocketDepth + inlay.sawGap)} mm deep into a {fmt(inlay.insertThickness)} mm board. Not to scale.
        </figcaption>
      </figure>
    );
  }

  const k = 46 / Math.max(inlay.pocketDepth, inlay.insertThickness, 0.1);
  const depth = Math.max(inlay.pocketDepth * k, 6);
  const thickness = Math.max(inlay.insertThickness * k, 6);
  const y0 = 8 + Math.max(thickness - depth, 0) + 6;
  const yFloor = y0 + depth;
  const yTop = yFloor - thickness;
  const yBottom = yFloor + 14;
  const half = 48;
  const gap = inlay.allowance > 0 ? 3 : 0;
  const proud = inlay.insertThickness - inlay.pocketDepth;
  const base = `M${left} ${y0}H${middle - half}V${yFloor}H${middle + half}V${y0}H${right}V${yBottom}H${left}Z`;
  return (
    <figure className="diagram">
      <svg viewBox={`0 0 300 ${yBottom + 4}`} role="img" aria-label="Cross-section: the insert sitting in its pocket">
        <path className="wood-base" d={base} />
        <rect className="wood-plug" x={middle - half + gap} y={yTop} width={2 * (half - gap)} height={thickness} />
        <Dimensions
          x={dimX}
          items={[
            { from: yTop, to: yFloor, label: `Insert ${fmt(inlay.insertThickness)} thick`, shift: 10 },
            { from: y0, to: yFloor, label: `Pocket ${fmt(inlay.pocketDepth)} deep` },
          ]}
        />
      </svg>
      <figcaption>
        Insert (dark) in its pocket, {fmt(inlay.allowance / 2)} mm clear on each side.{" "}
        {Math.abs(proud) < 0.005
          ? "It sits flush."
          : proud > 0
            ? `It stands ${fmt(proud)} mm proud, to sand flush.`
            : `It sits ${fmt(-proud)} mm below the surface.`}{" "}
        Not to scale.
      </figcaption>
    </figure>
  );
}
