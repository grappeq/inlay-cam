// A section through the edge a chamfer shapes, with the bit against it as the
// numbers place it: drawn to scale, so that the width, the tip's clearance and
// the bit show what they give instead of a sentence saying so. The wood each
// pass takes is a band of its own, as the core plans them.

import { useId } from "react";
import type { EdgePlan, Tool } from "../core/types";
import { fmt } from "../state/model";
import { HelpTip } from "./HelpTip";

/** Which numbers to mark out: those of the field being typed in. */
export type ChamferHot = "width" | "clearance" | "start" | null;

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Where the core runs the bit on the last pass (`ops::chamfer`): its axis `aside` from the outline, its tip `depth` down. */
export function edgeCut(bit: Tool, width: number, clearance: number): { aside: number; depth: number } | null {
  if (bit.kind === "corner_round") return { aside: (bit.tipDiameter ?? 0) / 2, depth: bit.cornerRadius ?? 0 };
  if (bit.kind !== "v_bit") return null;
  const aside = (bit.tipDiameter ?? 0) / 2 + clearance;
  return { aside, depth: (width + clearance) / Math.tan((((bit.tipAngle ?? 90) / 2) * Math.PI) / 180) };
}

/** What the caption says of the passes: how many, and how far each goes down. */
function passesLine(bit: Tool, plan: EdgePlan): string {
  const n = plan.passes.length;
  const times = n === 1 ? "once" : `${n} times`;
  if (plan.layers > 1)
    return `Wider than "${bit.name}" bevels from one track (${fmt(Math.floor((plan.oneTrack ?? 0) * 100) / 100)} mm): cut in ${plan.layers} layers, ${times} round the outline.`;
  if (n === 1) return "Cut in one pass.";
  const first = plan.passes[0].depth;
  const last = plan.passes[n - 1].depth - plan.passes[n - 2].depth;
  return `Cut in ${n} passes, going down ${fmt(round2(first))} mm at first and ${fmt(round2(last))} mm at the last.`;
}

/**
 * The wood is on the left and the outline is its wall; right of the wall the
 * wood is gone, as it must be before the bit runs there. Lengths are in mm
 * until `X` and `Y` place them.
 */
export function ChamferDiagram({
  bit,
  width,
  clearance,
  side,
  start = 0,
  hot,
  plan,
  blocked,
}: {
  bit: Tool;
  width: number;
  clearance: number;
  side: "inside" | "outside";
  /** How deep the edge lies below the stock's surface, where the wood above it is gone already. */
  start?: number;
  hot: ChamferHot;
  /** The core's passes, once known. */
  plan: EdgePlan | null;
  /** The edge cannot be cut as it stands. */
  blocked: boolean;
}) {
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

  const left = -(across + 1.6);
  const right = room + 0.5;
  const top = -1.3;
  const bottom = depth + 0.9;
  const s = Math.min(214 / (right - left), 108 / (bottom - top), 70);
  const X = (mm: number) => 12 + (mm - left) * s;
  const Y = (mm: number) => 36 + (mm - top) * s;
  const H = Y(bottom) + 20;
  const r = across * s;

  // The wood each pass takes: between the surface it leaves and the one before.
  const bands = (plan?.surfaces ?? []).map((surface, k, all) => {
    const at = (depths: number[], i: number) => `${X(-(plan!.across * i) / plan!.columns)} ${Y(depths[i])}`;
    const before = k === 0 ? surface.map(() => 0) : all[k - 1];
    const down = surface.map((_, i) => at(surface, i));
    const up = before.map((_, i) => at(before, i)).reverse();
    return `M${down.join("L")}L${up.join("L")}Z`;
  });

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
  // An edge below the surface: the wood above it is gone on both sides (dashed), drawn short, not to scale.
  const lowered = start > 0 ? 14 : 0;
  const yEdge = Y(0) - lowered;

  return (
    <figure className={`diagram${blocked ? " blocked" : ""}`}>
      <svg viewBox={`0 0 320 ${H}`} role="img" aria-label="Section through the edge, with the bit against it">
        <defs>
          <clipPath id={clip}>
            <rect x={X(left)} y={Y(top)} width={X(right) + 6 - X(left)} height={H} />
          </clipPath>
        </defs>
        <rect className="ch-gone" x={X(0)} y={Y(0)} width={X(right) - X(0)} height={Y(bottom) - Y(0)} />
        {lowered > 0 && <rect className="ch-gone" x={X(left)} y={yEdge} width={X(right) - X(left)} height={lowered} />}
        <path className="wood-base" d={wood} />
        <path className="ch-bit" clipPath={`url(#${clip})`} d={body} />
        {/* Over the bit, which stands where the last of them ends. */}
        {bands.map((d, k) => (
          <path key={k} className={`ch-pass${k % 2 ? " alt" : ""}`} d={d} />
        ))}
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
        {lowered > 0 && (
          <g className={mark("start", " on-wood")}>
            {/* On the wood, clear of the bit above it and of the bevel's height beside it. */}
            <text x={X(left) + 4} y={Math.min(Y(down) + 14, Y(bottom) - 4)}>
              {fmt(start)} down
            </text>
          </g>
        )}
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
        The bit's tip ends {fmt(round2(aside))} mm {side === "inside" ? "inside" : "outside"} the outline, {fmt(round2(depth))} mm{" "}
        {start > 0 ? `below the edge, ${fmt(round2(start + depth))} mm below the surface; the edge lies ${fmt(start)} mm down, where the wood above is gone (dashed).` : "deep."}
        {plan && (
          <>
            {" "}
            {passesLine(bit, plan)} <HelpTip topic="chamferPasses" />
          </>
        )}
      </figcaption>
    </figure>
  );
}
