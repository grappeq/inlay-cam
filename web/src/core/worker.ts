// Runs the WebAssembly core off the main thread so long computations never
// freeze the page. Structured values cross into the core as JSON text.

import init, * as wasm from "../wasm/inlay_wasm";
import { createPace } from "./calls";
import type { CoreApi, CoreNote, CoreRequest, CoreResponse, ProgressStage } from "./protocol";

/** The call that is going on, for its words of progress to be sent under. */
let current: number | null = null;
/** At most a word of progress each this long, ms, within one stage. */
const PACE = 100;
const pace = createPace(() => performance.now(), PACE);

const ready = init().then(() => {
  // The core says how far long work is; it is passed on under the call that asked for the work.
  // The listener only posts: it must not call into the core, which is in the middle of its work.
  try {
    wasm.setProgress((stage: ProgressStage, done: number, total: number) => {
      if (current === null) return;
      const progress = { stage, done, total };
      if (!pace(progress)) return;
      const note: CoreNote = { id: current, progress };
      self.postMessage(note);
    });
  } catch {
    // A core that cannot say how far it is still does its work: the bars go on without numbers.
  }
});

const api: CoreApi = {
  coreVersion: () => wasm.coreVersion(),
  importSvg: (text, sourceName, gap) => JSON.parse(wasm.importSvg(text, sourceName, gap)),
  importDxf: (bytes, sourceName, gap) => JSON.parse(wasm.importDxf(bytes, sourceName, gap)),
  importToolsYaml: (text) => JSON.parse(wasm.importToolsYaml(text)),
  projectFromFile: (text) => JSON.parse(wasm.projectFromFile(text)),
  projectToFile: (project) => wasm.projectToFile(JSON.stringify(project)),
  starterLibrary: () => JSON.parse(wasm.starterLibrary()),
  libraryFromFile: (text) => JSON.parse(wasm.libraryFromFile(text)),
  libraryToFile: (library) => wasm.libraryToFile(JSON.stringify(library)),
  libraryToToolsYaml: (library) => wasm.libraryToToolsYaml(JSON.stringify(library)),
  suggestFeeds: (tool, material, options) => JSON.parse(wasm.suggestFeeds(JSON.stringify(tool), material, JSON.stringify(options))),
  suggestStops: (tool, material, flags) => JSON.parse(wasm.suggestStops(JSON.stringify(tool), material, JSON.stringify(flags))),
  suggestEntry: (tool, material, profile, machine) => JSON.parse(wasm.suggestEntry(JSON.stringify(tool), material, JSON.stringify(profile), JSON.stringify(machine))),
  suggestName: (tool, named, taken) => JSON.parse(wasm.suggestName(JSON.stringify(tool), named, JSON.stringify(taken))),
  exportMakera: (library, app, now) => JSON.parse(wasm.exportMakera(JSON.stringify(library), app, now)),
  exportFusion: (library) => JSON.parse(wasm.exportFusion(JSON.stringify(library))),
  planMakeraImport: (library, data) => JSON.parse(wasm.planMakeraImport(JSON.stringify(library), data)),
  applyMakeraImport: (library, plan, selected) => JSON.parse(wasm.applyMakeraImport(JSON.stringify(library), JSON.stringify(plan), JSON.stringify(selected))),
  checkRow: (tool, material, values, machine) => JSON.parse(wasm.checkRow(JSON.stringify(tool), material, JSON.stringify(values), JSON.stringify(machine))),
  needsAttention: (tools) => JSON.parse(wasm.needsAttention(JSON.stringify(tools))),
  validateTool: (tool) => wasm.validateTool(JSON.stringify(tool)) ?? null,
  camNameProblem: (tool) => wasm.camNameProblem(JSON.stringify(tool)) ?? null,
  previewPart: (project, stepId, part) => {
    const preview = wasm.previewPart(JSON.stringify(project), stepId, part);
    try {
      return { ...JSON.parse(preview.info), heights: preview.heights, path: preview.path };
    } finally {
      preview.free();
    }
  },
  facingStart: (project, stepId) => wasm.facingStart(JSON.stringify(project), stepId) ?? null,
  chamferPlan: (project, stepId) => {
    const planned = wasm.chamferPlan(JSON.stringify(project), stepId);
    return planned ? JSON.parse(planned) : null;
  },
  stockTimeline: (project) => {
    const timeline = wasm.stockTimeline(JSON.stringify(project));
    try {
      const info = JSON.parse(timeline.info);
      return {
        ...info,
        steps: info.steps.map((step: object, i: number) => ({ ...step, path: timeline.path(i) })),
        snapshots: [...Array(info.steps.length + 1).keys()].map((i) => ({ heights: timeline.heights(i), owners: timeline.owners(i), unders: timeline.unders(i), floors: timeline.floors(i) })),
      };
    } finally {
      timeline.free();
    }
  },
  exportSteps: (project, stepIds) => JSON.parse(wasm.exportSteps(JSON.stringify(project), JSON.stringify(stepIds))),
  checkFit: (project, stepId) => {
    const check = wasm.checkFit(JSON.stringify(project), stepId);
    try {
      return { ...JSON.parse(check.info), gap: check.gap, plugUnder: check.plugUnder, face: check.face, base: check.base };
    } finally {
      check.free();
    }
  },
};

self.onmessage = async (event: MessageEvent<CoreRequest>) => {
  const { id, method, args } = event.data;
  let response: CoreResponse;
  try {
    await ready;
    const fn = api[method] as (...a: unknown[]) => unknown;
    current = id;
    pace.reset();
    response = { id, ok: true, value: fn(...args) };
  } catch (e) {
    response = { id, ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    current = null;
  }
  self.postMessage(response);
};
