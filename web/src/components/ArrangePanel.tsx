import { useState } from "react";
import type { Design } from "../core/types";
import { trimBoard } from "../state/arrange";
import { useApp, useDispatch } from "../state/store";
import { NumberField } from "./NumberField";

const mm = (v: number) => Math.round(v * 100) / 100;

/**
 * The panel beside the drawing while it is edited: what is selected, how
 * selecting works, and the stock. The tools themselves are above the drawing.
 */
export function ArrangePanel({ design }: { design: Design }) {
  const { selection, drawTool } = useApp();
  const dispatch = useDispatch();
  const [margin, setMargin] = useState(5);

  const edit = (update: (d: Design) => Design) => dispatch({ type: "editDrawing", update: (p) => (p.design ? { ...p, design: update(p.design) } : p) });
  const none = selection.length === 0;
  const count = `${selection.length} shape${selection.length === 1 ? "" : "s"}`;
  const shapes = design.regions.length;
  const everything = selection.length === design.regions.length;

  return (
    <aside className="panel" aria-label="Edit the drawing">
      <div className="panel-scroll">
        <section>
          <h2>Editing the drawing</h2>
          <p className="status-line" role="status">
            {drawTool
              ? "Drag on the stock to draw the shape. It comes in selected, so that its size and place can be typed."
              : shapes === 0
                ? "The stock has no shapes yet. Choose a shape under Draw, above the drawing, and drag it out on the stock."
                : none
                  ? `Click a shape to select it. The drawing has ${shapes} shape${shapes === 1 ? "" : "s"}.`
                  : `${count} selected. Drag ${selection.length === 1 ? "it" : "them"}, or use the tools above the drawing.`}
          </p>
          <p className="hint">
            A click selects one outline; to take a part with everything inside it, drag a box around it.
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

        <section>
          <h3>Stock</h3>
          <div className="row">
            <NumberField deferred label="Width (X)" unit="mm" min={1} value={mm(design.width * design.scale)} onChange={(v) => v !== undefined && edit((d) => ({ ...d, width: v / d.scale }))} />
            <NumberField deferred label="Height (Y)" unit="mm" min={1} value={mm(design.height * design.scale)} onChange={(v) => v !== undefined && edit((d) => ({ ...d, height: v / d.scale }))} />
          </div>
          <p className="hint">Shapes may lie beside it or run over its edges. The work origin stays at its bottom-left corner.</p>
          <div className="row tools">
            <NumberField label="Margin" unit="mm" value={margin} onChange={(v) => v !== undefined && setMargin(v)} />
            <button onClick={() => edit((d) => trimBoard(d, margin / d.scale))}>Fit stock to shapes</button>
          </div>
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
