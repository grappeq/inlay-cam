// A section through the edge a chamfer shapes, with the bit against it as the
// numbers place it: drawn to scale, so that the width, the tip's clearance and
// the bit show what they give instead of a sentence saying so.

import { useId } from "react";
import type { Tool } from "../core/types";
import { fmt } from "../state/model";

/** Which numbers to mark out: those of the field being typed in. */
export type ChamferHot = "width" | "clearance" | null;

const round2 = (v: number) => Math.round(v * 100) / 100;

/** How the core runs the bit (`edge_cut` in build.rs): its axis `aside` from the outline, its tip `depth` down. */
export function edgeCut(bit: Tool, width: number, clearance: number): { aside: number; depth: number; widest: number } | null {
  if (bit.kind === "corner_round") return { aside: (bit.tipDiameter ?? 0) / 2, depth: bit.cornerRadius ?? 0, widest: Infinity };
  if (bit.kind !== "v_bit") return null;
  const aside = (bit.tipDiameter ?? 0) / 2 + clearance;
  return { aside, depth: (width + clearance) / Math.tan((((bit.tipAngle ?? 90) / 2) * Math.PI) / 180), widest: bit.diameter / 2 - aside };
}

/**
 * The wood is on the left and the outline is its wall; right of the wall the
 * wood is gone, as it must be before the bit runs there. Lengths are in mm
 * until `X` and `Y` place them.
 */
export function ChamferDiagram({ bit, width, clearance, side, hot }: { bit: Tool; width: number; clearance: number; side: "inside" | "outside"; hot: ChamferHot }) {
  const clip = useId();
  const cut = edgeCut(bit, width, clearance);
  if (!cut || cut.depth <= 0) return null;
  const rounding = bit.kind === "corner_round";
  const { aside, depth } = cut;
  const tip = bit.tipDiameter ?? 0;
  const tan = Math.tan((((bit.tipAngle ?? 90) / 2) * Math.PI) / 180);
  // How far the shaped edge reaches into the wood, and how far down the wall.
  const across = rounding ? depth : width;
  const down = rounding ? depth : width / tan;
  // The bit's half-width where it leaves the surface, and so the room it needs beside the edge.
  const atSurface = rounding ? tip / 2 + depth : Math.min(bit.diameter / 2, tip / 2 + depth * tan);
  const room = aside + atSurface;
  const tooWide = width > cut.widest + 1e-9;

  const left = -(across + 1.6);
  const right = room + 0.5;
  const top = -1.3;
  const bottom = depth + 0.9;
  const s = Math.min(214 / (right - left), 108 / (bottom - top), 70);
  const X = (mm: number) => 12 + (mm - left) * s;
  const Y = (mm: number) => 36 + (mm - top) * s;
  const H = Y(bottom) + 20;
  const r = across * s;

  const wood = rounding
    ? `M${X(left)} ${Y(0)}H${X(-across)}A${r} ${r} 0 0 1 ${X(0)} ${Y(down)}V${Y(bottom)}H${X(left)}Z`
    : `M${X(left)} ${Y(0)}H${X(-across)}L${X(0)} ${Y(down)}V${Y(bottom)}H${X(left)}Z`;
  const edge = rounding ? `M${X(-across)} ${Y(0)}A${r} ${r} 0 0 1 ${X(0)} ${Y(down)}` : `M${X(-across)} ${Y(0)}L${X(0)} ${Y(down)}`;
  let body: string;
  if (rounding) {
    const half = Math.max(bit.diameter / 2, atSurface);
    body = `M${X(0)} ${Y(depth)}A${r} ${r} 0 0 0 ${X(-depth)} ${Y(0)}H${X(aside - half)}V${Y(top)}H${X(aside + half)}V${Y(0)}H${X(tip + depth)}A${r} ${r} 0 0 0 ${X(tip)} ${Y(depth)}Z`;
  } else {
    // The cone widens to the bit's diameter, or to the top of the picture, whichever comes first.
    const rise = Math.min((bit.diameter / 2 - tip / 2) / tan, depth - top);
    const half = tip / 2 + rise * tan;
    body = `M${X(aside - tip / 2)} ${Y(depth)}L${X(aside - half)} ${Y(depth - rise)}V${Y(top)}H${X(aside + half)}V${Y(depth - rise)}L${X(aside + tip / 2)} ${Y(depth)}Z`;
  }

  const mark = (of: ChamferHot | "bit", extra = "") => `ch-dim${extra}${hot === null ? "" : of === hot ? " hot" : " faint"}`;
  const across_ = (from: number, to: number, y: number) => `M${X(from)} ${y - 3}V${y + 3}M${X(from)} ${y}H${X(to)}M${X(to)} ${y - 3}V${y + 3}`;
  const upright = (x: number, from: number, to: number) => `M${x - 3} ${Y(from)}H${x + 3}M${x} ${Y(from)}V${Y(to)}M${x - 3} ${Y(to)}H${x + 3}`;
  const yTop = Y(0) - 22;

  return (
    <figure className={`diagram${tooWide ? " too-wide" : ""}`}>
      <svg viewBox={`0 0 320 ${H}`} role="img" aria-label="Section through the edge, with the bit against it">
        <defs>
          <clipPath id={clip}>
            <rect x={X(left)} y={Y(top)} width={X(right) + 6 - X(left)} height={H} />
          </clipPath>
        </defs>
        <rect className="ch-gone" x={X(0)} y={Y(0)} width={X(right) - X(0)} height={Y(bottom) - Y(0)} />
        <path className="wood-base" d={wood} />
        <path className="ch-bit" clipPath={`url(#${clip})`} d={body} />
        <path className="ch-edge" d={edge} />
        <g className={mark("width")}>
          <path d={across_(-across, 0, yTop)} />
          <text x={X(0) - 5} y={yTop - 6} textAnchor="end">
            {rounding ? "radius" : "width"} {fmt(round2(across))}
          </text>
        </g>
        <g className={mark("bit")}>
          <path d={across_(0, room, yTop)} />
          <text x={X(0) + 5} y={yTop - 6}>
            room {fmt(round2(room))}
          </text>
        </g>
        {!rounding && (
          <g className={mark("width", " on-wood")}>
            <path d={upright(X(-across) - 10, 0, down)} />
            <text x={X(-across) - 16} y={(Y(0) + Y(down)) / 2 + 4} textAnchor="end">
              {fmt(round2(down))}
            </text>
          </g>
        )}
        <g className={mark("bit")}>
          <path d={upright(X(right) + 8, 0, depth)} />
          <text x={X(right) + 15} y={(Y(0) + Y(depth)) / 2 + 4}>
            {fmt(round2(depth))} deep
          </text>
        </g>
        {!rounding && (
          <g className={mark("clearance")}>
            <path d={across_(0, clearance, Y(depth) + 9)} />
            <text x={X(clearance) + 6} y={Y(depth) + 13}>
              clear {fmt(clearance)}
            </text>
          </g>
        )}
      </svg>
      <figcaption>
        The bit's tip runs {fmt(round2(aside))} mm {side === "inside" ? "inside" : "outside"} the outline, {fmt(round2(depth))} mm deep.
      </figcaption>
    </figure>
  );
}
