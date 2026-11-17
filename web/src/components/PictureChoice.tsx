// A choice between a few ways of cutting, each shown as a small picture of
// what it does, with its name under it.

import type { ReactNode } from "react";

export interface PictureOption<T extends string> {
  value: T;
  label: string;
  picture: ReactNode;
}

export function PictureChoice<T extends string>(props: { label: string; value: T; options: PictureOption<T>[]; onChange: (value: T) => void; hint?: ReactNode }) {
  return (
    <div className="field">
      <span className="field-label">{props.label}</span>
      <div className="pictures" role="radiogroup" aria-label={props.label}>
        {props.options.map((option) => (
          <button key={option.value} type="button" role="radio" aria-checked={option.value === props.value} className="picture" onClick={() => props.onChange(option.value)}>
            {option.picture}
            <span>{option.label}</span>
          </button>
        ))}
      </div>
      {props.hint && <span className="hint">{props.hint}</span>}
    </div>
  );
}

/** A picture's frame: 56 by 40, drawn with the colours of the page. */
function Frame(props: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 56 40" aria-hidden="true">
      {props.children}
    </svg>
  );
}

/** An arrow head at the end of a path that arrives heading `dx`, `dy`. */
function head(x: number, y: number, dx: number, dy: number): string {
  const [px, py] = [-dy, dx];
  return `M ${x} ${y} L ${x - dx * 4 + px * 2.5} ${y - dy * 4 + py * 2.5} L ${x - dx * 4 - px * 2.5} ${y - dy * 4 - py * 2.5} Z`;
}

/** Straight passes back and forth across an area, along X or along Y. */
function passes(x: number, y: number, w: number, h: number, along: "x" | "y", lines: number): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    const t = lines === 1 ? 0.5 : i / (lines - 1);
    const forward = i % 2 === 0;
    if (along === "x") {
      const yy = y + t * h;
      out.push(`${i === 0 ? "M" : "L"} ${forward ? x : x + w} ${yy} L ${forward ? x + w : x} ${yy}`);
    } else {
      const xx = x + t * w;
      out.push(`${i === 0 ? "M" : "L"} ${xx} ${forward ? y + h : y} L ${xx} ${forward ? y : y + h}`);
    }
  }
  return out.join(" ");
}

/** The tool's path: straight passes, or rings that follow the outline. */
export const PATTERN_PICTURES = {
  raster: (
    <Frame>
      <rect className="pic-area" x="6" y="6" width="44" height="28" rx="1.5" />
      <path className="pic-path" d={passes(11, 11, 34, 18, "x", 5)} />
    </Frame>
  ),
  offset: (
    <Frame>
      <rect className="pic-area" x="6" y="6" width="44" height="28" rx="1.5" />
      <rect className="pic-path" x="11" y="11" width="34" height="18" rx="1" />
      <rect className="pic-path" x="16" y="15.5" width="24" height="9" rx="1" />
      <path className="pic-path" d="M 21 20 H 35" />
    </Frame>
  ),
};

/** Which way straight passes run: along the longer side whichever that is, along X, or along Y. */
export const DIRECTION_PICTURES = {
  longer: (
    <Frame>
      <rect className="pic-area" x="3" y="11" width="28" height="18" rx="1.5" />
      <path className="pic-path" d={passes(7, 15, 20, 10, "x", 3)} />
      <rect className="pic-area" x="37" y="4" width="16" height="32" rx="1.5" />
      <path className="pic-path" d={passes(41, 8, 8, 24, "y", 3)} />
    </Frame>
  ),
  x: (
    <Frame>
      <rect className="pic-area" x="6" y="3" width="44" height="24" rx="1.5" />
      <path className="pic-path" d={passes(11, 8, 34, 14, "x", 4)} />
      <path className="pic-axis" d="M 14 34 H 40" />
      <path className="pic-axis fill" d={head(42, 34, 1, 0)} />
      <text className="pic-text" x="46" y="37">
        X
      </text>
    </Frame>
  ),
  y: (
    <Frame>
      <rect className="pic-area" x="16" y="3" width="36" height="34" rx="1.5" />
      <path className="pic-path" d={passes(21, 8, 26, 24, "y", 5)} />
      <path className="pic-axis" d="M 8 32 V 12" />
      <path className="pic-axis fill" d={head(8, 10, 0, -1)} />
      <text className="pic-text" x="5" y="8">
        Y
      </text>
    </Frame>
  ),
};

/** Which edge a chamfer bevels, seen from above: wood is filled, what was cut away is not. */
export const CHAMFER_PICTURES = {
  outside: (
    <Frame>
      <rect className="pic-cut" x="3" y="3" width="50" height="34" rx="2" />
      <rect className="pic-wood" x="14" y="9" width="28" height="22" rx="3" />
      <rect className="pic-bevel" x="15.5" y="10.5" width="25" height="19" rx="2" />
    </Frame>
  ),
  inside: (
    <Frame>
      <rect className="pic-wood" x="3" y="3" width="50" height="34" rx="2" />
      <rect className="pic-cut solid" x="14" y="9" width="28" height="22" rx="3" />
      <rect className="pic-bevel" x="12.5" y="7.5" width="31" height="25" rx="4" />
    </Frame>
  ),
};
