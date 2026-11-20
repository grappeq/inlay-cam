import type { Design, Project } from "../core/types";
import { duplicateShapes, emptiedSteps, keepOnly, moveToLayer, removeShapes } from "../state/arrange";
import { addLayer, layerOf, shapesOn } from "../state/layers";
import { useApp, useDispatch } from "../state/store";

/** Board left around the shapes that are kept by "Keep only", mm. */
const KEEP_MARGIN = 5;

/**
 * What can be done to the selected shapes besides moving and resizing them:
 * the same from the toolbar above the drawing, from the keyboard, from the
 * menu a right click opens and from the list of layers.
 */
export function useShapeActions(design: Design) {
  const { project, selection, activeStepId } = useApp();
  const dispatch = useDispatch();

  const editProject = (update: (p: Project) => Project, select?: number[], layer?: number) => dispatch({ type: "editDrawing", update, select, layer });
  const say = (text: string) => dispatch({ type: "notice", notice: { kind: "info", text } });

  const none = selection.length === 0;
  const count = `${selection.length} shape${selection.length === 1 ? "" : "s"}`;
  const everything = selection.length === design.regions.length;

  const remove = () => {
    if (none) return;
    if (everything) return say("This would leave the stock without shapes. To start over, replace the drawing.");
    const inUse = new Set(project.steps.flatMap((j) => j.regionIds));
    const used = selection.filter((id) => inUse.has(id)).length;
    const emptied = emptiedSteps(project, selection);
    const consequence =
      emptied.length > 0
        ? `${emptied.map((n) => `"${n}"`).join(" and ")} will have no shapes left and will be removed too.`
        : `${used === 1 ? "It" : "They"} will be taken out of ${used === 1 ? "it" : "them"}.`;
    if (used > 0 && !confirm(`${used} of these shapes ${used === 1 ? "is" : "are"} used by an inlay or operation. ${consequence} Delete?`)) return;
    editProject((p) => removeShapes(p, selection));
  };

  const duplicate = () => {
    if (none) return;
    const copy = duplicateShapes(design, selection, 5 / design.scale);
    editProject((p) => ({ ...p, design: copy.design }), copy.ids);
  };

  const keep = () => {
    if (none || everything) return;
    const kept = selection;
    const others = design.regions.length - kept.length;
    const emptied = emptiedSteps(
      project,
      design.regions.map((r) => r.id).filter((id) => !kept.includes(id)),
    );
    const gone = emptied.length > 0 ? ` ${emptied.map((n) => `"${n}"`).join(" and ")} will be removed with them.` : "";
    if (!confirm(`Delete the other ${others} shape${others === 1 ? "" : "s"} and fit the stock to what is left?${gone}`)) return;
    editProject((p) => keepOnly(p, selection, KEEP_MARGIN / design.scale));
  };

  /** Puts the selected shapes on a layer, which becomes the one that is drawn on. */
  const moveTo = (layer: number) => {
    if (none) return;
    editProject(
      (p) => {
        const moved = p.design && moveToLayer(p.design, selection, layer);
        return moved && moved !== p.design ? { ...p, design: moved } : p;
      },
      undefined,
      layer,
    );
  };

  /** Puts the selected shapes on a new layer, on top. */
  const moveToNew = () => {
    if (none) return;
    const made = addLayer(design);
    editProject((p) => (p.design ? { ...p, design: moveToLayer(addLayer(p.design).design, selection, made.id) } : p), undefined, made.id);
  };

  /** Selects every shape on a layer. Not while an inlay or operation is open: a click then adds to it. */
  const selectLayer = (layer: number) => {
    if (activeStepId === null) dispatch({ type: "setSelection", ids: shapesOn(design, layer) });
  };

  /** The ids of the layers the selected shapes are on. */
  const chosen = new Set(selection);
  const selectedOn = new Set(design.regions.filter((r) => chosen.has(r.id)).map(layerOf));

  return { none, count, everything, remove, duplicate, keep, moveTo, moveToNew, selectLayer, selectedOn };
}
