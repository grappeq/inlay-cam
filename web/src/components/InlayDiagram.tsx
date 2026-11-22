import type { TrueInlay } from "../core/types";
import { fmt } from "../state/model";

/** The numbers the picture marks: named as the fields that set them, so that the one being typed in can be marked out. */
export type InlayHot = "saw" | "engagement" | "glue" | "pocket" | "insert" | "start" | null;

/** One measured height in the picture: where it starts and ends, and what to call it. */
interface Dimension {
  of: InlayHot;
  from: number;
  to: number;
  label: string;
  /** How far right of the others its bracket is drawn, so two that share a span stay apart. */
  shift?: number;
}

/** Brackets down the right-hand side, each with its label, kept from overlapping. */
function Dimensions({ x, items, hot }: { x: number; items: Dimension[]; hot: InlayHot }) {
  let previous = -Infinity;
  return (
    <g className="dims">
      {items.map((d) => {
        const y = Math.max((d.from + d.to) / 2, previous + 14);
        previous = y;
        const bx = x + (d.shift ?? 0);
        return (
          <g key={d.label} className={hot === null ? undefined : d.of === hot ? "hot" : "faint"}>
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
 * The stock's surface either side of a pocket cut into a lower one: two
 * shoulders of the base board standing `drop` above `y`, the surface the
 * pocket is cut into, and the wood between them that must be gone, dashed.
 */
function Lowered({ y, drop, left, right }: { y: number; drop: number; left: number; right: number }) {
  if (drop <= 0) return null;
  return (
    <>
      <rect className="ch-gone" x={left + 6} y={y - drop} width={right - left - 12} height={drop} />
      <rect className="wood-base" x={left} y={y - drop} width={6} height={drop} />
      <rect className="wood-base" x={right - 6} y={y - drop} width={6} height={drop} />
    </>
  );
}

/** How tall a start depth is drawn: to scale, but never too small to see or so large that it swamps the rest. */
const dropOf = (start: number, k: number) => (start > 0 ? Math.min(Math.max(start * k, 6), 34) : 0);

/** What the caption says of a pocket cut into a lower surface. */
const loweredLine = (start: number) => (start > 0 ? ` Cut into a surface ${fmt(start)} mm down, where the wood above (dashed) is gone already.` : "");

/**
 * A cross-section through the inlay as the current numbers make it: the base
 * board, and the plug or insert in place. Heights follow the numbers; very
 * small ones are drawn large enough to see.
 */
export function InlayDiagram({ inlay, halfAngle, hot = null }: { inlay: TrueInlay; halfAngle: number; hot?: InlayHot }) {
  const left = 8;
  const right = 176;
  const middle = (left + right) / 2;
  const dimX = right + 10;

  const start = inlay.startDepth ?? 0;

  if (inlay.type === "vcarve") {
    const total = Math.max(inlay.engagementDepth + inlay.glueGap + inlay.sawGap, 0.1);
    const k = 62 / total;
    const saw = Math.max(inlay.sawGap * k, 5);
    const engagement = Math.max(inlay.engagementDepth * k, 8);
    const glue = Math.max(inlay.glueGap * k, 4);
    const backer = 14;
    const drop = dropOf(start, k);
    // Room above the backer for the stock's surface, when it stands higher.
    const yBacker = 6 + Math.max(backer, drop - saw);
    const y0 = yBacker + saw;
    const yTip = y0 + engagement;
    const yFloor = yTip + glue;
    const yBottom = yFloor + 14;
    const top = 52;
    // Keep a floor to stand on however steep the numbers make the walls.
    const slope = Math.min(Math.tan(halfAngle), (top - 10) / (engagement + glue));
    const at = (y: number) => top - (y - y0) * slope;
    const base = `M${left} ${y0}H${middle - top}L${middle - at(yFloor)} ${yFloor}H${middle + at(yFloor)}L${middle + top} ${y0}H${right}V${yBottom}H${left}Z`;
    const yTop = yBacker - backer;
    const plug = `M${left + 10} ${yTop}H${right - 10}V${yBacker}H${middle + at(yBacker)}L${middle + at(yTip)} ${yTip}H${middle - at(yTip)}L${middle - at(yBacker)} ${yBacker}H${left + 10}Z`;
    return (
      <figure className="diagram">
        <svg viewBox={`0 0 300 ${yBottom + 4}`} role="img" aria-label="Cross-section: the plug sitting in its pocket">
          <Lowered y={y0} drop={drop} left={left} right={right} />
          <path className="wood-base" d={base} />
          <path className="wood-plug" d={plug} />
          <Dimensions
            hot={hot}
            x={dimX}
            items={[
              ...(drop > 0 ? [{ of: "start" as const, from: y0 - drop, to: y0, label: `Start depth ${fmt(start)}`, shift: 10 }] : []),
              { of: "saw", from: yBacker, to: y0, label: `Saw gap ${fmt(inlay.sawGap)}` },
              { of: "engagement", from: y0, to: yTip, label: `Engagement ${fmt(inlay.engagementDepth)}` },
              { of: "glue", from: yTip, to: yFloor, label: `Glue gap ${fmt(inlay.glueGap)}` },
            ]}
          />
        </svg>
        <figcaption>
          Plug (dark) glued into the base board. Pocket {fmt(inlay.engagementDepth + inlay.glueGap)} mm deep; plug cut{" "}
          {fmt(inlay.engagementDepth + inlay.sawGap)} mm deep.{loweredLine(start)} Not to scale.
        </figcaption>
      </figure>
    );
  }

  if (inlay.insertStyle === "backer") {
    const k = 56 / Math.max(inlay.pocketDepth + inlay.sawGap, 0.1);
    const backer = 14;
    const saw = Math.max(inlay.sawGap * k, inlay.sawGap > 0 ? 5 : 0);
    const drop = dropOf(start, k);
    const yBacker = 6 + Math.max(backer, drop - saw);
    const yTop = yBacker - backer;
    const depth = Math.max(inlay.pocketDepth * k, 8);
    const y0 = yBacker + saw;
    const yFloor = y0 + depth;
    const yBottom = yFloor + 14;
    const half = 48;
    const gap = inlay.allowance > 0 ? 3 : 0;
    const base = `M${left} ${y0}H${middle - half}V${yFloor}H${middle + half}V${y0}H${right}V${yBottom}H${left}Z`;
    const plug = `M${left + 10} ${yTop}H${right - 10}V${yBacker}H${middle + half - gap}V${yFloor}H${middle - half + gap}V${yBacker}H${left + 10}Z`;
    return (
      <figure className="diagram">
        <svg viewBox={`0 0 300 ${yBottom + 4}`} role="img" aria-label="Cross-section: the plug on its backer sitting in the pocket">
          <Lowered y={y0} drop={drop} left={left} right={right} />
          <path className="wood-base" d={base} />
          <path className="wood-plug" d={plug} />
          <Dimensions
            hot={hot}
            x={dimX}
            items={[
              ...(drop > 0 ? [{ of: "start" as const, from: y0 - drop, to: y0, label: `Start depth ${fmt(start)}`, shift: 10 }] : []),
              { of: "saw", from: yBacker, to: y0, label: `Saw gap ${fmt(inlay.sawGap)}` },
              { of: "pocket", from: y0, to: yFloor, label: `Pocket ${fmt(inlay.pocketDepth)} deep` },
            ]}
          />
        </svg>
        <figcaption>
          Plug (dark) glued in face down, {fmt(inlay.allowance / 2)} mm clear on each side. Its backer is sawn or planed off afterwards. The plug
          is cut {fmt(inlay.pocketDepth + inlay.sawGap)} mm deep into a {fmt(inlay.insertThickness)} mm board.{loweredLine(start)} Not to scale.
        </figcaption>
      </figure>
    );
  }

  const k = 46 / Math.max(inlay.pocketDepth, inlay.insertThickness, 0.1);
  const depth = Math.max(inlay.pocketDepth * k, 6);
  const thickness = Math.max(inlay.insertThickness * k, 6);
  const drop = dropOf(start, k);
  const y0 = 8 + Math.max(thickness - depth, drop, 0) + 6;
  const yFloor = y0 + depth;
  const yTop = yFloor - thickness;
  const yBottom = yFloor + 14;
  const half = 48;
  const gap = inlay.allowance > 0 ? 3 : 0;
  // How far the insert stands above the surface its pocket is cut into.
  const proud = inlay.insertThickness - inlay.pocketDepth;
  const base = `M${left} ${y0}H${middle - half}V${yFloor}H${middle + half}V${y0}H${right}V${yBottom}H${left}Z`;
  return (
    <figure className="diagram">
      <svg viewBox={`0 0 300 ${yBottom + 4}`} role="img" aria-label="Cross-section: the insert sitting in its pocket">
        <Lowered y={y0} drop={drop} left={left} right={right} />
        <path className="wood-base" d={base} />
        <rect className="wood-plug" x={middle - half + gap} y={yTop} width={2 * (half - gap)} height={thickness} />
        <Dimensions
          hot={hot}
          x={dimX}
          items={[
            ...(drop > 0 ? [{ of: "start" as const, from: y0 - drop, to: y0, label: `Start depth ${fmt(start)}`, shift: 20 }] : []),
            { of: "insert", from: yTop, to: yFloor, label: `Insert ${fmt(inlay.insertThickness)} thick`, shift: 10 },
            { of: "pocket", from: y0, to: yFloor, label: `Pocket ${fmt(inlay.pocketDepth)} deep` },
          ]}
        />
      </svg>
      <figcaption>
        Insert (dark) in its pocket, {fmt(inlay.allowance / 2)} mm clear on each side.{" "}
        {Math.abs(proud) < 0.005
          ? "It sits flush."
          : proud > 0
            ? `It stands ${fmt(proud)} mm proud, to sand flush.`
            : `It sits ${fmt(-proud)} mm below the surface.`}
        {loweredLine(start)} Not to scale.
      </figcaption>
    </figure>
  );
}
