// A tool drawn from the side, to scale, tip to the right: what the numbers
// on its sheet describe. Lengths that are not known are drawn dashed, at a
// guess, so that the drawing never claims more than the sheet does.

import type { Tool } from "../core/types";
import { fmt } from "../state/model";

const WIDTH = 560;
const PAD = { left: 16, right: 46, top: 30, bottom: 30 };

export function ToolDrawing({ tool }: { tool: Tool }) {
  const d = tool.diameter;
  const shank = tool.shankDiameter;
  if (!(d > 0) || !(shank > 0)) return null;
  const cut = tool.fluteLength ?? Math.min(3 * d, 20);
  const shoulder = Math.max(tool.shoulderLength ?? cut, cut);
  const length = Math.max(tool.length ?? shoulder + Math.max(20, 3 * shank), shoulder + 1);
  const widest = Math.max(d, shank);

  const scale = Math.min((WIDTH - PAD.left - PAD.right) / length, 90 / widest);
  const height = widest * scale + PAD.top + PAD.bottom;
  const axis = PAD.top + (widest * scale) / 2;
  const x = (mm: number) => PAD.left + mm * scale;
  const y = (mm: number) => axis - mm * scale;

  // The upper outline from the shank's end to the tip, as [distance along the axis, radius].
  const neck = Math.min(Math.abs(shank - d) / 2, Math.max(length - shoulder, 0));
  const upper: [number, number][] = [
    [0, shank / 2],
    [length - shoulder - neck, shank / 2],
    [length - shoulder, d / 2],
  ];
  let tipPath = "";
  const tip = tool.kind === "v_bit" || tool.kind === "corner_round" ? (tool.tipDiameter ?? 0) : 0;
  if (tool.kind === "v_bit" || tool.kind === "drill") {
    const half = (((tool.tipAngle ?? (tool.kind === "drill" ? 118 : 90)) / 2) * Math.PI) / 180;
    const cone = Math.min((d - tip) / 2 / Math.tan(half), shoulder);
    upper.push([length - cone, d / 2], [length, tip / 2]);
  } else if (tool.kind === "ball_end") {
    upper.push([length - d / 2, d / 2]);
    tipPath = ` A ${(d / 2) * scale} ${(d / 2) * scale} 0 0 1 ${x(length)} ${axis}`;
  } else if (tool.kind === "corner_round") {
    const r = Math.min(tool.cornerRadius ?? (d - tip) / 2, shoulder);
    upper.push([length - r, d / 2]);
    // The cutting edge is a quarter circle, hollow towards the work.
    tipPath = ` A ${r * scale} ${r * scale} 0 0 0 ${x(length)} ${y(tip / 2)}`;
  } else {
    upper.push([length, d / 2]);
  }
  const top = upper.map(([mm, r], i) => `${i === 0 ? "M" : "L"} ${x(mm)} ${y(r)}`).join(" ") + tipPath;
  const last = tipPath === "" ? upper[upper.length - 1] : ([length, tool.kind === "ball_end" ? 0 : tip / 2] as [number, number]);
  // The lower half mirrors the upper one.
  const lowerTip =
    tool.kind === "ball_end"
      ? ` A ${(d / 2) * scale} ${(d / 2) * scale} 0 0 1 ${x(length - d / 2)} ${y(-d / 2)}`
      : tool.kind === "corner_round"
        ? ` L ${x(length)} ${y(-tip / 2)} A ${(tool.cornerRadius ?? (d - tip) / 2) * scale} ${(tool.cornerRadius ?? (d - tip) / 2) * scale} 0 0 0 ${x(upper[upper.length - 1][0])} ${y(-d / 2)}`
        : ` L ${x(last[0])} ${y(-last[1])}`;
  const bottom = [...upper]
    .reverse()
    .slice(tipPath === "" ? 1 : 0)
    .map(([mm, r]) => `L ${x(mm)} ${y(-r)}`)
    .join(" ");
  const outline = `${top}${lowerTip} ${bottom} Z`;

  // The flutes: slanted strokes over the cutting length, as a spiral reads from the side.
  const fluted = tool.kind !== "v_bit" && tool.kind !== "corner_round";
  const flutes: string[] = [];
  if (fluted) {
    const pitch = Math.max(d * 1.4, 6 / scale);
    for (let at = length - cut; at < length - pitch * 0.3; at += pitch) {
      flutes.push(`M ${x(at)} ${y(-d / 2)} L ${x(Math.min(at + pitch * 0.6, length))} ${y(d / 2)}`);
    }
  }

  const dim = (from: number, to: number, at: number, label: string, known: boolean) => (
    <g className={known ? "dim" : "dim unknown"}>
      <line x1={x(from)} y1={at} x2={x(to)} y2={at} />
      <line x1={x(from)} y1={at - 4} x2={x(from)} y2={at + 4} />
      <line x1={x(to)} y1={at - 4} x2={x(to)} y2={at + 4} />
      <text x={(x(from) + x(to)) / 2} y={at < axis ? at - 5 : at + 13} textAnchor="middle">
        {label}
      </text>
    </g>
  );

  return (
    <svg className="tool-drawing" viewBox={`0 0 ${WIDTH} ${height}`} role="img" aria-label={`${tool.name || "The tool"} from the side, to scale`}>
      <line className="axis" x1={x(0) - 6} y1={axis} x2={x(length) + 8} y2={axis} />
      <path className={tool.length === undefined ? "body unknown" : "body"} d={outline} />
      {fluted && <rect className="cut" x={x(length - cut)} y={y(d / 2)} width={cut * scale} height={d * scale} />}
      {flutes.map((path) => (
        <path key={path} className="flute" d={path} />
      ))}
      {dim(length - cut, length, PAD.top - 14, tool.fluteLength === undefined ? "flutes ?" : fmt(cut), tool.fluteLength !== undefined)}
      {dim(0, length, height - PAD.bottom + 12, tool.length === undefined ? "length ?" : fmt(length), tool.length !== undefined)}
      <text className="dia" x={x(length) + 10} y={axis + 4}>
        Ø{fmt(d)}
      </text>
    </svg>
  );
}
