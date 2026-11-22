// A section through what a facing takes off: the wood standing above the
// stock's surface, the depth below it, and how far past the shapes it
// reaches. Heights follow the numbers; widths are a sketch.

import { fmt } from "../state/model";

/** Which number to mark out: that of the field being typed in. */
export type FacingHot = "above" | "depth" | "margin" | "start" | null;

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * `margin` is null for a facing of the whole stock, which has none. `beyond`
 * is how far the tool cuts past the area: its radius. `start` is how deep
 * the first pass starts, where the wood above is gone already (dashed); it
 * goes with no wood above the surface.
 */
export function FacingDiagram({
  above,
  start = 0,
  depth,
  margin,
  beyond,
  hot,
}: {
  above: number;
  start?: number;
  depth: number;
  margin: number | null;
  beyond: number | null;
  hot: FacingHot;
}) {
  const whole = margin === null;
  const k = 54 / Math.max(above + Math.max(depth, 0), 0.1);
  const up = above > 0 ? Math.max(above * k, 8) : 0;
  // Gone already, from the surface down to the start; the cut goes on from there.
  const gone = start > 0 ? Math.min(Math.max(start * k, 6), 40) : 0;
  // Below the surface it goes down; under 0 it stops short of the surface, inside the wood above.
  const down = depth > 0 ? Math.max(depth * k, 6, gone + 6) : depth < 0 ? -Math.min(Math.max(-depth * k, 4), Math.max(up - 3, 0)) : 0;
  const surface = 22 + up;
  const bottom = surface + Math.max(down, gone, 0) + 18;
  // What the cut takes, under what is gone already: nothing when it would end above where it starts.
  const cut = Math.max(up + down - gone, 0);
  const [left, right] = whole ? [16, 204] : [74, 146];
  const reach = whole ? 0 : margin > 0 ? 22 : 0;
  const over = beyond && beyond > 0 ? 8 : 0;
  const mark = (of: FacingHot) => `ch-dim${hot === null ? "" : of === hot ? " hot" : " faint"}`;
  const upright = (x: number, from: number, to: number) => `M${x - 3} ${from}H${x + 3}M${x} ${from}V${to}M${x - 3} ${to}H${x + 3}`;
  const total = above + depth - start;
  const [x0, x1] = [left - reach, right + reach];

  return (
    <figure className="diagram">
      <svg viewBox={`0 0 320 ${bottom + 4}`} role="img" aria-label="Section through the stock: what the facing takes off">
        <path className="wood-base" d={gone > 0 ? `M16 ${surface}H${x0}V${surface + gone}H${x1}V${surface}H204V${bottom}H16Z` : `M16 ${surface}H204V${bottom}H16Z`} />
        {gone > 0 && <rect className="ch-gone" x={x0} y={surface} width={x1 - x0} height={gone} />}
        {up > 0 && <rect className={whole ? "wood-base" : "wood-plug"} x={left} y={surface - up} width={right - left} height={up} />}
        {over > 0 && cut > 0 && <rect className="ch-gone" x={x0 - over} y={surface - up + gone} width={x1 - x0 + 2 * over} height={cut} />}
        {(cut > 0 || gone === 0) && <rect className="face-cut" x={x0} y={surface - up + gone} width={x1 - x0} height={Math.max(cut, 1.5)} />}
        {gone > 0 && (
          <g className={mark("start")}>
            <path d={upright(222, surface, surface + gone)} />
            <text x="240" y={surface + Math.min(gone / 2 + 4, gone - 2)}>
              from {fmt(start)}
            </text>
          </g>
        )}
        {above > 0 && (
          <g className={mark("above")}>
            <path d={upright(232, surface - up, surface)} />
            <text x="240" y={surface - up / 2 + 4}>
              {fmt(round2(above))} above
            </text>
          </g>
        )}
        {depth !== 0 && (
          <g className={mark("depth")}>
            <path d={upright(depth > 0 ? 232 : 222, surface, surface + down)} />
            <text x="240" y={depth > 0 ? Math.max(gone > 0 ? surface + down - 2 : surface + down / 2 + 4, surface + 13) : surface + 13}>
              {depth > 0 ? `${fmt(depth)} below` : `stops ${fmt(-depth)} above`}
            </text>
          </g>
        )}
        {reach > 0 && (
          <g className={mark("margin")}>
            <path d={`M${right} ${surface - up - 11}V${surface - up - 5}M${right} ${surface - up - 8}H${right + reach}M${right + reach} ${surface - up - 11}V${surface - up - 5}`} />
            <text x={right + reach + 5} y={surface - up - 4}>
              margin {fmt(margin ?? 0)}
            </text>
          </g>
        )}
      </svg>
      <figcaption>
        {total > 0 ? `${fmt(round2(total))} mm come off in all.` : "Nothing comes off."}
        {gone > 0 ? ` The wood above ${fmt(start)} mm is gone already (dashed).` : ""}
        {beyond && beyond > 0 ? ` The tool cuts ${fmt(beyond)} mm beyond the ${whole ? "stock's edges" : "area"} (dashed).` : ""} Not to scale.
      </figcaption>
    </figure>
  );
}
