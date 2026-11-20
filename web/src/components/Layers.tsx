// The layers of the drawing on the screen: their list beside the drawing,
// the menu a right click on a shape opens, and the toolbar's "Move to layer".

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { Design, Layer } from "../core/types";
import { emptiedSteps } from "../state/arrange";
import { LAYER_COLORS, LAYER_COLOR_NAMES, activeLayerOf, addLayer, changeLayer, layerColor, layerOf, layersOf, removeLayer, reorderLayers, shapesOn } from "../state/layers";
import { useApp, useDispatch } from "../state/store";
import { ToolIcon } from "./icons";
import { useShapeActions } from "./shapeActions";
import { Grip, useSortable } from "./sortable";

/**
 * Closes something that lies over the page: on a press outside it, and on
 * Escape before anything else hears of it. `close` is told whether a key did
 * it, after which the focus is put back where it came from. A press on an
 * element that matches `also` counts as inside.
 */
function useDismiss(inside: RefObject<HTMLElement | null>, open: boolean, close: (byKey: boolean) => void, also?: string) {
  const closeNow = useRef(close);
  closeNow.current = close;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (inside.current?.contains(e.target as Node) || (also && (e.target as Element).closest?.(also))) return;
      closeNow.current(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      closeNow.current(true);
    };
    const away = () => closeNow.current(false);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", away);
    window.addEventListener("resize", away);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", away);
      window.removeEventListener("resize", away);
    };
  }, [inside, open, also]);
}

/** Puts the keyboard's focus on an element once the page has been drawn again. */
function focusSoon(find: () => HTMLElement | SVGElement | null | undefined) {
  requestAnimationFrame(() => find()?.focus());
}

/** The up and down arrows walk the entries of a menu. */
function walkMenu(e: React.KeyboardEvent<HTMLElement>) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  const at = items.indexOf(document.activeElement as HTMLButtonElement);
  items[(at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
}

/** A layer's colour, as the line its shapes are drawn with. */
function Swatch({ layer }: { layer: Layer }) {
  return <span className="layer-swatch" style={{ "--lc": layerColor(layer) } as CSSProperties} aria-hidden="true" />;
}

/** The entries that put the selected shapes on a layer: one per layer, and one for a new layer. */
function MoveToLayerItems({ design, done }: { design: Design; done: () => void }) {
  const { moveTo, moveToNew, selectedOn } = useShapeActions(design);
  return (
    <>
      <span className="menu-heading" id="move-to-layer">
        Move to layer
      </span>
      <div className="menu-group" role="group" aria-labelledby="move-to-layer">
        {layersOf(design).map((layer) => {
          const here = selectedOn.size === 1 && selectedOn.has(layer.id);
          const off = layer.hidden ? "hidden" : layer.locked ? "locked" : "";
          return (
            <button
              key={layer.id}
              type="button"
              role="menuitemradio"
              aria-checked={here}
              disabled={here || off !== ""}
              title={off ? `This layer is ${off}` : undefined}
              onClick={() => {
                moveTo(layer.id);
                done();
              }}
            >
              <Swatch layer={layer} />
              <span className="name">{layer.name}</span>
              {off && <ToolIcon name={layer.hidden ? "eyeOff" : "lock"} />}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          moveToNew();
          done();
        }}
      >
        <ToolIcon name="plus" />
        New layer
      </button>
    </>
  );
}

/** The toolbar's button that puts the selected shapes on another layer. */
export function MoveToLayerButton({ design }: { design: Design }) {
  const { selection } = useApp();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const back = () => focusSoon(() => wrap.current?.querySelector("button"));
  useDismiss(wrap, open, (byKey) => {
    setOpen(false);
    if (byKey) back();
  });
  const none = selection.length === 0;
  return (
    <span className="tool-menu" ref={wrap}>
      <button type="button" className="tool" disabled={none} aria-haspopup="menu" aria-expanded={open} aria-label="Move to layer" title="Move to layer" onClick={() => setOpen(!open)}>
        <ToolIcon name="toLayer" />
      </button>
      {open && !none && (
        <div className="menu-items layer-menu" role="menu" onKeyDown={walkMenu}>
          <MoveToLayerItems
            design={design}
            done={() => {
              setOpen(false);
              back();
            }}
          />
        </div>
      )}
    </span>
  );
}

/**
 * The menu a right click on the drawing opens, at `x`, `y` of the window.
 * While the drawing is edited it acts on the selection; otherwise it only
 * selects the shapes of the layer of the shape `region` that was clicked.
 */
export function ShapeMenu({ design, x, y, region, close }: { design: Design; x: number; y: number; region: number; close: () => void }) {
  const { arranging } = useApp();
  const { count, everything, remove, duplicate, selectLayer } = useShapeActions(design);
  const menu = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ x, y });
  // Closed by a key or by choosing, the focus goes to the shape the menu was opened on.
  const done = () => {
    close();
    focusSoon(() => document.querySelector<SVGElement>(`.on-stock [data-region="${region}"]`));
  };
  useDismiss(menu, true, (byKey) => (byKey ? done() : close()));

  // Kept inside the window, and the keyboard starts on its first entry.
  useLayoutEffect(() => {
    const box = menu.current?.getBoundingClientRect();
    if (!box) return;
    setAt({ x: Math.max(4, Math.min(x, window.innerWidth - box.width - 4)), y: Math.max(4, Math.min(y, window.innerHeight - box.height - 4)) });
    menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [x, y]);

  const shape = design.regions.find((r) => r.id === region);
  const layer = layersOf(design).find((l) => l.id === (shape ? layerOf(shape) : -1));
  const then = (act: () => void) => () => {
    done();
    act();
  };
  return (
    <div ref={menu} className="menu-items context-menu layer-menu" role="menu" aria-label={arranging ? `What to do with ${count}` : "Layer"} style={{ left: at.x, top: at.y }} onKeyDown={walkMenu} onContextMenu={(e) => e.preventDefault()}>
      {arranging && <MoveToLayerItems design={design} done={done} />}
      {arranging && <hr />}
      {layer && (
        <button type="button" role="menuitem" onClick={then(() => selectLayer(layer.id))}>
          Select all on “{layer.name}”
        </button>
      )}
      {arranging && (
        <>
          <button type="button" role="menuitem" onClick={then(duplicate)}>
            Copy beside
          </button>
          <button type="button" role="menuitem" className="danger" disabled={everything} onClick={then(remove)}>
            Delete
          </button>
        </>
      )}
    </div>
  );
}

const OPEN_KEY = "inlay.layersOpen";
const PLACE_KEY = "inlay.layersAt";

/** Where the list was dragged to, from the top left of the drawing's area, px. */
function readPlace(): { x: number; y: number } | null {
  try {
    const kept = JSON.parse(localStorage.getItem(PLACE_KEY) ?? "null");
    return kept && Number.isFinite(kept.x) && Number.isFinite(kept.y) ? { x: kept.x, y: kept.y } : null;
  } catch {
    return null;
  }
}

/** The colours a layer's lines can take. Escape and a press elsewhere put them away. */
function ColorChoices({ layer, pick, close }: { layer: Layer; pick: (color: string) => void; close: (byKey: boolean) => void }) {
  const choices = useRef<HTMLDivElement>(null);
  useDismiss(choices, true, close, ".swatch-button");
  return (
    <div ref={choices} className="layer-colors" role="radiogroup" aria-label={`Colour of ${layer.name}`}>
      {LAYER_COLORS.map((color, k) => (
        <button key={color} type="button" role="radio" aria-checked={layerColor(layer) === color} aria-label={LAYER_COLOR_NAMES[k]} title={LAYER_COLOR_NAMES[k]} style={{ "--lc": color } as CSSProperties} onClick={() => pick(color)} />
      ))}
    </div>
  );
}

function readOpen(): boolean | null {
  try {
    const kept = localStorage.getItem(OPEN_KEY);
    return kept === null ? null : kept === "1";
  } catch {
    return null;
  }
}

/**
 * The list of layers, over a corner of the drawing: which are shown, which
 * are locked, which is drawn on, and what the selection is on. While the
 * drawing is edited they are also added, named, coloured, put in another
 * order and deleted here. Folded away it is one button. It is dragged by
 * its heading to where it is not in the way; a double click on the heading
 * puts it back in the corner.
 */
export function LayersPanel({ design }: { design: Design }) {
  const { project, arranging, activeLayer, activeStepId, selection } = useApp();
  const dispatch = useDispatch();
  const { moveTo, selectLayer, selectedOn } = useShapeActions(design);
  const layers = layersOf(design);
  // Open by itself once there is more than one layer; after that as it was left.
  const [chosen, setChosen] = useState<boolean | null>(readOpen);
  const open = chosen ?? layers.length > 1;
  const [renaming, setRenaming] = useState<number | null>(null);
  const [colouring, setColouring] = useState<number | null>(null);
  const [place, setPlace] = useState(readPlace);
  const panel = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  // The name of a layer's line, for the focus to come back to; and whether a rename ended by a key.
  const nameOf = (id: number) => panel.current?.querySelector<HTMLElement>(`li[data-layer="${id}"] .layer-name`);
  const byKey = useRef(false);

  const keepPlace = (to: { x: number; y: number } | null) => {
    setPlace(to);
    try {
      if (to) localStorage.setItem(PLACE_KEY, JSON.stringify(to));
      else localStorage.removeItem(PLACE_KEY);
    } catch {
      // Not kept: it is back in the corner next time.
    }
  };
  const onGrab = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as Element).closest("button") || !panel.current) return;
    drag.current = { x: e.clientX, y: e.clientY, left: panel.current.offsetLeft, top: panel.current.offsetTop };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onDrag = (e: React.PointerEvent<HTMLElement>) => {
    const from = drag.current;
    const area = panel.current?.offsetParent;
    if (!from || !panel.current || !area) return;
    // Kept within the drawing's area.
    const x = Math.max(0, Math.min(from.left + e.clientX - from.x, area.clientWidth - panel.current.offsetWidth));
    const y = Math.max(0, Math.min(from.top + e.clientY - from.y, area.clientHeight - 36));
    setPlace({ x, y });
  };
  const onDrop = () => {
    if (drag.current && place) keepPlace(place);
    drag.current = null;
  };

  const setOpen = (to: boolean) => {
    setChosen(to);
    try {
      localStorage.setItem(OPEN_KEY, to ? "1" : "0");
    } catch {
      // Not kept: it opens as it does by itself next time.
    }
  };
  // A change that changes nothing is no step to undo.
  const edit = (update: (d: Design) => Design, layer?: number) =>
    dispatch({
      type: "editDrawing",
      layer,
      update: (p) => {
        const design = p.design && update(p.design);
        return design && design !== p.design ? { ...p, design } : p;
      },
    });
  const sortable = useSortable(layers.length, (from, to) => edit((d) => reorderLayers(d, from, to)));
  const active = activeLayerOf(design, activeLayer);

  if (!open) {
    return (
      <button type="button" className="layers-fold" onClick={() => setOpen(true)} title="Show the drawing's layers">
        <ToolIcon name="layers" />
        Layers
        <span className="count">{layers.length}</span>
      </button>
    );
  }

  const add = () => {
    const made = addLayer(design, active.id);
    edit((d) => addLayer(d, active.id).design, made.id);
    setRenaming(made.id);
  };
  const remove = (layer: Layer) => {
    const ids = shapesOn(design, layer.id);
    if (ids.length > 0) {
      const emptied = emptiedSteps(project, ids);
      const gone = emptied.length > 0 ? ` ${emptied.map((n) => `"${n}"`).join(" and ")} will be removed with them.` : "";
      if (!confirm(`Delete the layer "${layer.name}" with its ${ids.length} shape${ids.length === 1 ? "" : "s"}?${gone}`)) return;
    }
    dispatch({ type: "editDrawing", update: (p) => removeLayer(p, layer.id) });
  };

  return (
    <section
      ref={panel}
      className={`layers${layers.length < 2 ? " single" : ""}`}
      aria-label="Layers"
      // Where it was dragged to, but never out of sight when the window has got smaller since.
      style={place ? { left: `min(${place.x}px, 100% - 80px)`, top: `min(${place.y}px, 100% - 40px)`, maxHeight: `calc(100% - min(${place.y}px, 100% - 40px))` } : undefined}
    >
      <header onPointerDown={onGrab} onPointerMove={onDrag} onPointerUp={onDrop} onPointerCancel={onDrop} onDoubleClick={(e) => !(e.target as Element).closest("button") && keepPlace(null)} title="Drag to move the list; double-click to put it back in the corner">
        <ToolIcon name="layers" />
        <h3>Layers</h3>
        {arranging && (
          <button type="button" className="tool" onClick={add} aria-label="New layer" title="New layer, above the one that is drawn on">
            <ToolIcon name="plus" />
          </button>
        )}
        <button type="button" className="tool" onClick={() => setOpen(false)} aria-label="Fold the layers away" title="Fold away">
          <ToolIcon name="close" />
        </button>
      </header>
      <ul>
        {layers.map((layer, i) => {
          const ids = shapesOn(design, layer.id);
          const holds = selectedOn.has(layer.id);
          // The selection can come here when some of it is elsewhere and the layer takes shapes.
          const takes = arranging && selection.length > 0 && !layer.hidden && !layer.locked && !(holds && selectedOn.size === 1);
          const canSelect = ids.length > 0 && !layer.hidden && !(arranging && layer.locked) && activeStepId === null;
          const shapes = `${ids.length} shape${ids.length === 1 ? "" : "s"}`;
          return (
            <li key={layer.id} data-layer={layer.id} className={`${arranging && layer.id === active.id ? "active" : ""}${layer.hidden ? " hidden" : ""}`} {...(arranging ? sortable.row(i) : {})}>
              <div className="layer-row">
                {arranging && <Grip {...sortable.grip(i, layer.name)} />}
                {arranging && layers.length > 1 ? (
                  <button type="button" className="swatch-button" aria-expanded={colouring === layer.id} aria-label={`Colour of ${layer.name}`} title="Line colour" onClick={() => setColouring(colouring === layer.id ? null : layer.id)}>
                    <Swatch layer={layer} />
                  </button>
                ) : (
                  <Swatch layer={layer} />
                )}
                {renaming === layer.id ? (
                  <input
                    className="layer-name"
                    aria-label="Layer name"
                    defaultValue={layer.name}
                    autoFocus
                    onFocus={(e) => e.currentTarget.select()}
                    onBlur={(e) => {
                      const name = e.currentTarget.value;
                      setRenaming(null);
                      edit((d) => changeLayer(d, layer.id, { name }));
                      // Ended by a key, the focus stays on the layer's name.
                      if (byKey.current) focusSoon(() => nameOf(layer.id));
                      byKey.current = false;
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter" && e.key !== "Escape") return;
                      e.stopPropagation();
                      if (e.key === "Escape") e.currentTarget.value = layer.name;
                      byKey.current = true;
                      e.currentTarget.blur();
                    }}
                  />
                ) : arranging ? (
                  <button
                    type="button"
                    className="layer-name"
                    aria-pressed={layer.id === active.id}
                    title={`${layer.name}: ${layer.id === active.id ? "new shapes go on this layer. Double-click to rename it." : "click to draw on this layer; double-click to rename it"}`}
                    onClick={() => dispatch({ type: "setActiveLayer", id: layer.id })}
                    onDoubleClick={() => setRenaming(layer.id)}
                    onKeyDown={(e) => e.key === "F2" && setRenaming(layer.id)}
                  >
                    {layer.name}
                  </button>
                ) : (
                  <span className="layer-name" title={layer.name}>
                    {layer.name}
                  </span>
                )}
                {takes && (
                  <button
                    type="button"
                    className="tool"
                    onClick={() => {
                      moveTo(layer.id);
                      // The button goes with the move; the focus stays on the line.
                      focusSoon(() => nameOf(layer.id));
                    }}
                    aria-label={`Move the selection to ${layer.name}`} title="Move the selection to this layer">
                    <ToolIcon name="toLayer" />
                  </button>
                )}
                <button type="button" className={`layer-count${holds ? " holds" : ""}`} disabled={!canSelect} onClick={() => selectLayer(layer.id)} aria-label={`${shapes} on ${layer.name}${holds ? ", some selected" : ""}. Select them.`} title={canSelect ? `Select the ${shapes} on this layer` : shapes}>
                  {ids.length}
                </button>
                {arranging && (
                  <button type="button" className="tool" aria-pressed={!!layer.locked} onClick={() => edit((d) => changeLayer(d, layer.id, { locked: !layer.locked }))} aria-label={`${layer.locked ? "Unlock" : "Lock"} ${layer.name}`} title={layer.locked ? "Locked: its shapes cannot be changed. Click to unlock." : "Lock, so that its shapes cannot be changed"}>
                    <ToolIcon name={layer.locked ? "lock" : "unlock"} />
                  </button>
                )}
                <button type="button" className="tool" aria-pressed={!layer.hidden} onClick={() => edit((d) => changeLayer(d, layer.id, { hidden: !layer.hidden }))} aria-label={`${layer.hidden ? "Show" : "Hide"} ${layer.name}`} title={layer.hidden ? "Hidden. Click to show." : "Hide"}>
                  <ToolIcon name={layer.hidden ? "eyeOff" : "eye"} />
                </button>
                {arranging && layers.length > 1 && (
                  <button type="button" className="tool danger quiet" onClick={() => remove(layer)} aria-label={`Delete ${layer.name}`} title="Delete the layer and its shapes">
                    <ToolIcon name="remove" />
                  </button>
                )}
              </div>
              {arranging && colouring === layer.id && (
                <ColorChoices
                  layer={layer}
                  pick={(color) => {
                    edit((d) => changeLayer(d, layer.id, { color }));
                    setColouring(null);
                    focusSoon(() => panel.current?.querySelector<HTMLElement>(`li[data-layer="${layer.id}"] .swatch-button`));
                  }}
                  close={(key) => {
                    setColouring(null);
                    if (key) focusSoon(() => panel.current?.querySelector<HTMLElement>(`li[data-layer="${layer.id}"] .swatch-button`));
                  }}
                />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
