// What happens when a file comes into the app, whether picked or dropped.

import { core } from "../core/client";
import * as db from "../storage/db";
import { mergeTools, newId } from "./model";
import { message, useApp, useDispatch } from "./store";

export interface TextFile {
  name: string;
  text: string;
}

export function useFileActions() {
  const { project, tools } = useApp();
  const dispatch = useDispatch();
  const info = (text: string) => dispatch({ type: "notice", notice: { kind: "info", text } });
  const fail = (e: unknown) => dispatch({ type: "notice", notice: { kind: "error", text: message(e) } });
  const summary = (name: string, added: number, updated: number) => `${name}: ${added} added, ${updated} updated.`;

  async function importSvg(file: TextFile) {
    const { design, report } = await core.call("importSvg", file.text, file.name);
    dispatch({ type: "setView", view: "design" });
    if (design.regions.length === 0) {
      dispatch({ type: "setImportReport", report });
      throw new Error(`No filled shapes were found in ${file.name}.`);
    }
    const hadJobs = project.jobs.length > 0;
    // A new drawing has new shapes, so inlays made from the old one cannot be kept.
    dispatch({ type: "updateProject", update: (p) => ({ ...p, design, jobs: [] }) });
    dispatch({ type: "setActiveJob", id: null });
    dispatch({ type: "setImportReport", report });
    const shapes = `${design.regions.length} shape${design.regions.length === 1 ? "" : "s"}`;
    info(`Imported ${shapes} from ${file.name}.${hadJobs ? " The inlays of the previous design were removed." : ""}`);
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
    dispatch({ type: "setTools", tools: merged.tools });
    dispatch({ type: "setView", view: "tools" });
    const reasons = new Map<string, number>();
    for (const s of result.skipped) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
    const skipped = [...reasons].map(([reason, n]) => `${n} × ${reason}`).join("; ");
    info(summary(file.name, merged.added, merged.updated) + (result.skipped.length ? ` Left out ${result.skipped.length}: ${skipped}.` : ""));
  }

  async function importToolLibrary(file: TextFile) {
    const merged = mergeTools(tools, await core.call("toolsFromFile", file.text));
    dispatch({ type: "setTools", tools: merged.tools });
    dispatch({ type: "setView", view: "tools" });
    info(summary(file.name, merged.added, merged.updated));
  }

  /** Works out what a file is from its name and content, and brings it in. */
  async function importAny(file: TextFile) {
    const name = file.name.toLowerCase();
    if (name.endsWith(".svg")) return importSvg(file);
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
    throw new Error(`${file.name} is not a file this app reads. It takes SVG drawings, project and tool files (.json) and tools.yaml.`);
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
    openProject: guarded(openProject),
    importToolsYaml: guarded(importToolsYaml),
    importToolLibrary: guarded(importToolLibrary),
    importAny: guarded(importAny),
  };
}
