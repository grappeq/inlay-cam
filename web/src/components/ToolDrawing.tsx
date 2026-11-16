// A tool drawn to scale on squared paper: from the side, and from its tip.
// The drawing itself is made by toolProfile.ts; this puts it on the page and
// redraws it when the tool's shape changes, as it does while one is edited.

import { useEffect, useRef } from "react";
import type { Tool } from "../core/types";
import { matchStyle, profile, type ProfileGeometry } from "./toolProfile";

export function ToolDrawing({ tool }: { tool: Tool }) {
  const holder = useRef<HTMLDivElement>(null);
  const pointed = tool.kind === "v_bit" || tool.kind === "corner_round" || tool.kind === "drill";
  const geometry: ProfileGeometry = {
    diameter: tool.diameter,
    length: tool.length ?? 0,
    fluteLength: tool.fluteLength ?? 0,
    shoulderLength: tool.shoulderLength ?? 0,
    shankDiameter: tool.shankDiameter,
    // A V-bit, a corner-rounding bit and a drill end in a point unless a tip is given; other tools have none.
    tipDiameter: pointed ? (tool.tipDiameter ?? 0) : tool.diameter,
    tipAngle: tool.tipAngle ?? (tool.kind === "drill" ? 118 : tool.kind === "corner_round" ? 90 : 0),
    flutes: tool.flutes ?? 0,
    pitch: tool.pitch ?? 0,
    cornerRadius: tool.cornerRadius ?? 0,
  };
  const key = JSON.stringify([tool.kind, geometry, tool.name, tool.style]);
  useEffect(() => {
    const { svg } = profile(tool.kind, geometry, tool.name || "the tool", tool.style);
    holder.current?.replaceChildren(svg);
    // The key holds everything the drawing is made from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const style = matchStyle(tool.style);
  const flutes = tool.flutes !== undefined ? `${tool.flutes} ${tool.flutes === 1 ? "flute" : "flutes"}` : "Flutes unknown";
  return (
    <figure className="draw">
      <div ref={holder} />
      <figcaption>
        {style ? `${style}, ${flutes.toLowerCase()}` : flutes}. A schematic, not to tolerance.
      </figcaption>
    </figure>
  );
}
