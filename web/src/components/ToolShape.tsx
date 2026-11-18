// A bit drawn from its own measures, seen from the side with its tip down:
// enough to tell an end mill from a V-bit and a thin tool from a thick one
// at a glance. A likeness, not a drawing to scale.

import type { Tool } from "../core/types";

const WIDTH = 28;
const HEIGHT = 48;
const MIDDLE = WIDTH / 2;
const TOP = 1;
const TIP = HEIGHT - 2;

/** How wide a diameter is drawn: thin tools stay visible, thick ones stay in the frame. */
function drawn(diameter: number): number {
  return Math.max(6, Math.min(22, 6 + diameter * 1.3));
}

export function ToolShape({ tool, size = 40 }: { tool: Tool; size?: number }) {
  const cut = drawn(tool.diameter);
  const shank = drawn(tool.shankDiameter > 0 ? tool.shankDiameter : tool.diameter);
  // How much of the height the cutting part takes: more for longer flutes.
  const flutes = Math.max(0.3, Math.min(0.72, (tool.fluteLength ?? tool.diameter * 3) / 40));
  const start = TIP - (TIP - TOP) * flutes;
  const left = MIDDLE - cut / 2;
  const right = MIDDLE + cut / 2;
  const shankRect = (to: number) => <rect className="bit-shank" x={MIDDLE - shank / 2} y={TOP} width={shank} height={to - TOP} />;

  let body;
  if (tool.kind === "v_bit") {
    const half = (((tool.tipAngle ?? 90) / 2) * Math.PI) / 180;
    const tip = Math.max(0.6, drawn(tool.tipDiameter ?? 0) - 6);
    // The cone is as high as its angle makes it, within the frame, and never too flat to read as one.
    const cone = Math.max(10, Math.min(TIP - TOP - 8, (cut - tip) / 2 / Math.tan(half)));
    const top = TIP - cone;
    body = (
      <>
        {shankRect(top)}
        <path className="bit-cut" d={`M${left} ${top}H${right}L${MIDDLE + tip / 2} ${TIP}H${MIDDLE - tip / 2}Z`} />
        <path className="bit-flute" d={`M${MIDDLE} ${top + 1}V${TIP - 1}`} />
      </>
    );
  } else if (tool.kind === "corner_round") {
    const tip = Math.max(2, drawn(tool.tipDiameter ?? 0) - 6);
    const r = Math.min((cut - tip) / 2, 14);
    const top = TIP - r - 4;
    body = (
      <>
        {shankRect(top)}
        <path
          className="bit-cut"
          d={`M${left} ${top}H${right}V${top + 4}A${r} ${r} 0 0 0 ${MIDDLE + tip / 2} ${TIP}H${MIDDLE - tip / 2}A${r} ${r} 0 0 0 ${left} ${top + 4}Z`}
        />
      </>
    );
  } else if (tool.kind === "thread_mill") {
    const neck = Math.max(2, cut * 0.6);
    const head = TIP - 9;
    body = (
      <>
        {shankRect(start)}
        <rect className="bit-cut" x={MIDDLE - neck / 2} y={start} width={neck} height={head - start} />
        <path className="bit-cut" d={`M${left} ${head}H${right}V${TIP}H${left}Z`} />
        <path className="bit-flute" d={`M${left} ${head + 3}H${right}M${left} ${head + 6}H${right}`} />
      </>
    );
  } else {
    // An end mill, a ball end mill or a drill: a fluted cylinder with its own tip.
    const point = tool.kind === "drill" ? Math.min(cut * 0.3, 6) : 0;
    const round = tool.kind === "ball_end" ? cut / 2 : 0;
    const foot = TIP - point - round;
    const lines: string[] = [];
    const rise = cut * 0.7;
    for (let y = start + rise + 2; y < foot; y += Math.max(5, cut * 0.8)) lines.push(`M${left} ${y}L${right} ${y - rise}`);
    body = (
      <>
        {shankRect(start)}
        <path
          className="bit-cut"
          d={
            round > 0
              ? `M${left} ${start}H${right}V${foot}A${round} ${round} 0 0 1 ${left} ${foot}Z`
              : `M${left} ${start}H${right}V${foot}L${MIDDLE} ${foot + point}L${left} ${foot}Z`
          }
        />
        <path className="bit-flute" d={lines.join("")} />
      </>
    );
  }

  return (
    <svg className="bit" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} width={(size * WIDTH) / HEIGHT} height={size} aria-hidden="true">
      {body}
    </svg>
  );
}
