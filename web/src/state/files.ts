// What happens when a file comes into the app, whether picked or dropped.

import { core } from "../core/client";
import * as db from "../storage/db";
import type { ImportReport } from "../core/types";
import { mergeLists, mergeTools, newId } from "./model";
import { message, useApp, useDispatch } from "./store";

export interface TextFile {
  name: string;
  text: string;
}

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
  async function importDrawings(files: TextFile[], replace = false) {
    let had = project.design !== null;
    let shapes = 0;
    const read: string[] = [];
    const failed: string[] = [];
    let merged: ImportReport | null = null;
    for (const file of files) {
      const dxf = file.name.toLowerCase().endsWith(".dxf");
      let result;
      try {
        result = await core.call(dxf ? "importDxf" : "importSvg", file.text, file.name);
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
            hasText: merged.hasText || report.hasText,
            images: merged.images + report.images,
            specks: merged.specks + report.specks,
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
    dispatch({ type: "setView", view: "design" });
    dispatch({ type: "setImportReport", report: merged });
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
    if (name.endsWith(".json")) {
      let kind: unknown;
      try {
        kind = JSON.parse(file.text)?.kind;
      } catch {
        // Fall through: the project reader gives the proper error message.
      }
      return kind === "tool-library" ? importToolLibrary(file) : openProject(file);
    }
    throw new Error(`${file.name} is not a file this app reads. It takes SVG and DXF drawings, project and tool files (.json) and tools.yaml.`);
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
    importAny: guarded(importAny),
  };
}
