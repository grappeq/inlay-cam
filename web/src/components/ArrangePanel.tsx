import { useMemo, useState } from "react";
import type { Design } from "../core/types";
import { countParts, overlapping, trimBoard, withInside } from "../state/arrange";
import { useApp, useDispatch } from "../state/store";
import { NumberField } from "./NumberField";

const mm = (v: number) => Math.round(v * 100) / 100;

/**
 * The panel beside the drawing while it is edited: what is selected, how
 * selecting works, and the stock. The tools themselves are above the drawing.
 */
export function ArrangePanel({ design }: { design: Design }) {
  const { selection, wholeParts, drawTool } = useApp();
  const dispatch = useDispatch();
  const [margin, setMargin] = useState(5);

  const edit = (update: (d: Design) => Design) => dispatch({ type: "editDrawing", update: (p) => (p.design ? { ...p, design: update(p.design) } : p) });
  const none = selection.length === 0;
  const count = `${selection.length} shape${selection.length === 1 ? "" : "s"}`;
  const parts = countParts(design);
  const overlaps = useMemo(() => overlapping(design), [design]);
  const everything = withInside(design, selection).length === design.regions.length;

  return (
    <aside className="panel" aria-label="Edit the drawing">
      <div className="panel-scroll">
        <section>
          <h2>Editing the drawing</h2>
          <p className="status-line" role="status">
            {drawTool
              ? "Drag on the stock to draw the shape. It comes in selected, so that its size and place can be typed."
              : parts === 0
                ? "The stock has no shapes yet. Choose a shape under Draw, above the drawing, and drag it out on the stock."
                : none
                  ? `Click a part of the drawing to select it. The drawing has ${parts} part${parts === 1 ? "" : "s"}.`
                  : `${count} selected. Drag ${selection.length === 1 ? "it" : "them"}, or use the tools above the drawing.`}
          </p>
          <label className="check">
            <input type="checkbox" checked={wholeParts} onChange={(e) => dispatch({ type: "setWholeParts", on: e.target.checked })} />
            Select whole parts
          </label>
          <p className="hint">
            A part is an outer outline with everything inside it. Untick to pick an outline inside a part, such as a hole or a letter; what lies inside it
            comes along.
          </p>
          <div className="row links">
            <button className="link" disabled={everything} onClick={() => dispatch({ type: "setSelection", ids: design.regions.map((r) => r.id) })}>
              Select everything
            </button>
            {!none && (
              <button className="link" onClick={() => dispatch({ type: "setSelection", ids: [] })}>
                Clear selection
              </button>
            )}
          </div>
        </section>

        {overlaps.length > 0 && (
          <section>
            <p className="status-line warn" role="status">
              {overlaps.length} shapes lie on top of each other. They are outlined in red. Move them apart, or wholly inside one another, before making inlays
              from them.
            </p>
          </section>
        )}

        <section>
          <h3>Stock</h3>
          <div className="row">
            <NumberField deferred label="Width (X)" unit="mm" min={1} value={mm(design.width * design.scale)} onChange={(v) => v !== undefined && edit((d) => ({ ...d, width: v / d.scale }))} />
            <NumberField deferred label="Height (Y)" unit="mm" min={1} value={mm(design.height * design.scale)} onChange={(v) => v !== undefined && edit((d) => ({ ...d, height: v / d.scale }))} />
          </div>
          <p className="hint">It grows when shapes are moved past its right or top edge. Shapes stop at its left and bottom edges, where the work origin is.</p>
          <div className="row tools">
            <NumberField label="Margin" unit="mm" value={margin} onChange={(v) => v !== undefined && setMargin(v)} />
            <button onClick={() => edit((d) => trimBoard(d, margin / d.scale))}>Fit stock to shapes</button>
          </div>
          <p className="hint">Fitting leaves the margin between the outermost shapes and the stock's edges.</p>
        </section>

        <section>
          <h3>Mouse and keys</h3>
          <ul className="keys">
            <li>
              With a shape chosen under Draw, drag on the stock to draw it. Shift makes a square or a circle, or turns a polygon in steps of 15°; Ctrl
              draws a rectangle or an ellipse from its middle. Escape puts the tool away.
            </li>
            <li>Shift-click adds to the selection or takes away from it. Drag across empty stock to select what the box encloses.</li>
            <li>Drag the selection to move it; hold Shift to keep it straight. Escape abandons the drag.</li>
            <li>Drag a square on its frame to resize it. Corners keep the proportions unless Shift is held; Ctrl resizes about the middle.</li>
            <li>Arrow keys move it by 1 mm, or by 0.1 mm with Shift.</li>
            <li>Delete removes it. Ctrl+D copies it. Ctrl+A selects everything. Escape clears the selection.</li>
            <li>Ctrl+Z undoes, Ctrl+Y redoes, also after editing.</li>
            <li>The wheel zooms. Drag with the middle button to move the view; double-click empty stock to see it whole.</li>
          </ul>
        </section>
      </div>
      <div className="generate-bar arrange-bar">
        <button className="primary" onClick={() => dispatch({ type: "setArranging", on: false })}>
          Done editing
        </button>
      </div>
    </aside>
  );
}
