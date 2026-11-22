// What happens when a file comes into the app, whether picked or dropped.

import { core } from "../core/client";
import * as db from "../storage/home";
import type { ImportReport } from "../core/types";
import { addStarter, mergeLists, mergeTools, newId } from "./model";
import { message, useApp, useDispatch } from "./store";
import type { InFile } from "../util/files";
import { tasks } from "./tasks";

/** A file as it is brought in: text, and bytes for a DXF or a Makera library. */
export type TextFile = InFile;

/** The key of the task that reads drawings. */
export const IMPORT = "import";

export function useFileActions() {
  const { project, tools, lists } = useApp();
  const dispatch = useDispatch();
  const info = (text: string) => dispatch({ type: "notice", notice: { kind: "info", text } });
  const fail = (e: unknown) => dispatch({ type: "notice", notice: { kind: "error", text: message(e) } });
  const summary = (name: string, added: number, updated: number) => `${name}: ${added} added, ${updated} updated.`;

  /**
   * Brings in drawings. The first one of a project without a drawing sets
   * the stock; the others are added to the stock beside what is there.
   * With `replace`, the first one takes the place of the drawing instead,
   * and the inlays and operations made from it go.
   */
  async function importDrawings(files: TextFile[], replace = false, gap?: number) {
    let had = project.design !== null;
    let shapes = 0;
    const read: string[] = [];
    const failed: string[] = [];
    let merged: ImportReport | null = null;
    const task = tasks.start({ key: IMPORT, label: files.length === 1 ? `Reading ${files[0].name}` : "Reading the drawings", total: files.length > 1 ? files.length : null, place: "notice", view: "design" });
    try {
      for (const [index, file] of files.entries()) {
        task.update({ done: index, stage: files.length > 1 ? file.name : null });
        const dxf = file.name.toLowerCase().endsWith(".dxf");
        let result;
        try {
          result = dxf
            ? await core.call("importDxf", file.bytes ?? new TextEncoder().encode(file.text), file.name, gap)
            : await core.call("importSvg", file.text, file.name, gap);
        } catch (e) {
          failed.push(`${file.name}: ${message(e)}`);
          continue;
        }
        const { design, report } = result;
        merged = merged
          ? {
              unsupported: [...new Set([...merged.unsupported, ...report.unsupported])],
              unitNote: merged.unitNote ?? report.unitNote,
              openOutlines: merged.openOutlines + report.openOutlines,
              hiddenLayers: [...merged.hiddenLayers, ...report.hiddenLayers],
              hasText: merged.hasText || report.hasText,
              images: merged.images + report.images,
              specks: merged.specks + report.specks,
              // Offered for one file at a time only: see `again` below.
              joinable: null,
              joinedAt: merged.joinedAt ?? report.joinedAt,
            }
          : report;
        if (design.regions.length === 0) {
          failed.push(`No closed shapes were found in ${file.name}. The app needs filled shapes, or lines that join into closed outlines.`);
          continue;
        }
        dispatch({ type: "addDrawing", design, replace: replace && read.length === 0 });
        shapes += design.regions.length;
        read.push(file.name);
      }
    } finally {
      task.end();
    }
    dispatch({ type: "setView", view: "design" });
    // One file can be brought in again with its gaps joined: in place of
    // the drawing it set or replaced, or, when it gave no shapes, as it was
    // brought in. Shapes it added beside others are not taken back.
    const again =
      files.length === 1 && (read.length === 0 || replace || !had)
        ? { file: files[0], replace: read.length === 0 ? replace : true }
        : undefined;
    dispatch({ type: "setImportReport", report: again || !merged ? merged : { ...merged, joinable: null }, again });
    if (read.length > 0) {
      const count = `${shapes} shape${shapes === 1 ? "" : "s"}`;
      const added = had && !replace;
      had = true;
      info(
        added
          ? `Added ${count} from ${read.join(", ")} to the stock. They are selected: drag them to where they belong, then press Done.`
          : `Imported ${count} from ${read.join(", ")}.${replace && project.steps.length > 0 ? " What was made from the previous drawing was removed." : ""}${
              read.length > 1 ? " Arrange the shapes on the stock, then press Done." : ""
            }`,
      );
    }
    if (failed.length > 0) throw new Error(failed.join(" "));
  }

  const importSvg = (file: TextFile) => importDrawings([file]);

  /** Brings the drawing that was last brought in again, with the ends of its outlines joined across gaps up to `gap`, mm, in place of what it gave. */
  async function joinGaps({ file, replace }: { file: TextFile; replace: boolean }, gap: number) {
    const made = project.steps.length;
    if (replace && made > 0 && !confirm(`Bring the drawing in again with gaps up to ${gap} mm joined? The ${made === 1 ? "inlay or operation" : `${made} inlays and operations`} made from it will be removed.`)) return;
    await importDrawings([file], replace, gap);
  }

  /** Takes values changed in Makera CAM or Studio from one of their exports: the dialog shows what would change. */
  async function takeMakeraValues(file: TextFile) {
    if (!file.bytes) throw new Error(`${file.name} could not be read as a file of bytes.`);
    if (tools.length === 0) throw new Error(`${file.name} holds values for tools, but your tool list is empty. Add the tools first, then take the values.`);
    const plan = await core.call("planMakeraImport", { ...lists, tools }, file.bytes);
    dispatch({ type: "setView", view: "settings", page: "tools" });
    dispatch({ type: "setMakeraImport", incoming: { plan, fileName: file.name } });
  }

  async function openProject(file: TextFile) {
    const imported = await core.call("projectFromFile", file.text);
    // Opening a file must never overwrite a stored project that happens to share its id.
    const clash = imported.id !== project.id && (await db.listProjects()).some((p) => p.id === imported.id);
    dispatch({ type: "openProject", project: clash ? { ...imported, id: newId() } : imported });
    info(`Opened ${file.name}${clash ? " as a copy" : ""}.`);
  }

  async function importToolsYaml(file: TextFile) {
    const result = await core.call("importToolsYaml", file.text);
    const merged = mergeTools(tools, result.tools);
    dispatch({ type: "setTools", tools: merged.tools, lists: mergeLists(lists, result) });
    dispatch({ type: "setView", view: "settings", page: "tools" });
    const reasons = new Map<string, number>();
    for (const s of result.skipped) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
    const skipped = [...reasons].map(([reason, n]) => `${n} × ${reason}`).join("; ");
    const lines = (n: number) => `${n} comment line${n === 1 ? "" : "s"}`;
    const comments =
      result.commentsMoved + result.commentsDropped === 0
        ? ""
        : ` ${lines(result.commentsMoved)} above tools ${result.commentsMoved === 1 ? "was" : "were"} kept as their remarks; ${lines(result.commentsDropped)} elsewhere ${result.commentsDropped === 1 ? "was" : "were"} dropped.`;
    info(summary(file.name, merged.added, merged.updated) + (result.skipped.length ? ` Left out ${result.skipped.length}: ${skipped}.` : "") + comments);
  }

  async function importToolLibrary(file: TextFile) {
    const library = await core.call("libraryFromFile", file.text);
    const merged = mergeTools(tools, library.tools);
    dispatch({ type: "setTools", tools: merged.tools, lists: mergeLists(lists, library) });
    dispatch({ type: "setView", view: "settings", page: "tools" });
    info(summary(file.name, merged.added, merged.updated));
  }

  /**
   * Adds the tools of the starter set that the list does not have yet. Nothing there is changed.
   * `open`: show the tool list afterwards, as from the Tools tab; the start guide stays where it is.
   */
  async function addStarterSet(open: boolean) {
    const starter = await core.call("starterLibrary");
    const result = addStarter(tools, lists, starter);
    if (result.added === 0) return info("Every tool of the starter set is in your list already.");
    dispatch({ type: "setTools", tools: result.tools, lists: result.lists });
    if (open) dispatch({ type: "setView", view: "settings", page: "tools" });
    const kept = starter.tools.length - result.added;
    info(`Added ${result.added} tool${result.added === 1 ? "" : "s"} from the starter set${kept > 0 ? `; ${kept} you already have ${kept === 1 ? "was" : "were"} left alone` : ""}. Their cutting settings are a starting point: check them before you cut.`);
  }

  const isDrawing = (file: TextFile) => /\.(svg|dxf)$/i.test(file.name);

  /** Brings in whatever was dropped or picked: drawings together, the rest one by one. */
  async function importAll(files: TextFile[]) {
    for (const file of files.filter((f) => !isDrawing(f))) await guarded(importAny)(file);
    const drawings = files.filter(isDrawing);
    if (drawings.length > 0) await importDrawings(drawings);
  }

  /** Works out what a file is from its name and content, and brings it in. */
  async function importAny(file: TextFile) {
    const name = file.name.toLowerCase();
    if (isDrawing(file)) return importSvg(file);
    if (name.endsWith(".yaml") || name.endsWith(".yml")) return importToolsYaml(file);
    if (name.endsWith(".tlslibrary")) return takeMakeraValues(file);
    if (name.endsWith(".json")) {
      let kind: unknown;
      try {
        kind = JSON.parse(file.text)?.kind;
      } catch {
        // Fall through: the project reader gives the proper error message.
      }
      return kind === "tool-library" ? importToolLibrary(file) : openProject(file);
    }
    throw new Error(`${file.name} is not a file this app reads. It takes SVG and DXF drawings, project and tool files (.json), tools.yaml, and Makera exports (.tlslibrary) to take values from.`);
  }

  /** Wraps an action so that a failure is shown to the user. */
  const guarded =
    (action: (file: TextFile) => Promise<void>) =>
    async (file: TextFile | null): Promise<void> => {
      if (!file) return;
      try {
        await action(file);
      } catch (e) {
        fail(e);
      }
    };

  return {
    importSvg: guarded(importSvg),
    /** Adds drawings to the stock, or sets it from the first when there is none. */
    addDrawings: async (files: TextFile[]) => {
      if (files.length > 0) await importDrawings(files).catch(fail);
    },
    /** Puts a drawing in place of the one there is. */
    replaceDrawing: async (file: TextFile | null) => {
      if (file) await importDrawings([file], true).catch(fail);
    },
    importAll: async (files: TextFile[]) => {
      await importAll(files).catch(fail);
    },
    openProject: guarded(openProject),
    importToolsYaml: guarded(importToolsYaml),
    importToolLibrary: guarded(importToolLibrary),
    addStarterSet: () => addStarterSet(true).catch(fail),
    /** The same, staying on the view it is asked from. */
    addStarterSetHere: () => addStarterSet(false).catch(fail),
    importAny: guarded(importAny),
    takeMakeraValues: guarded(takeMakeraValues),
    joinGaps: async (again: { file: TextFile; replace: boolean }, gap: number) => joinGaps(again, gap).catch(fail),
  };
}
