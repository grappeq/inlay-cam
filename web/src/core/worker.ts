// Runs the WebAssembly core off the main thread so long computations never
// freeze the page. Structured values cross into the core as JSON text.

import init, * as wasm from "../wasm/inlay_wasm";
import type { CoreApi, CoreRequest, CoreResponse } from "./protocol";

const ready = init();

const api: CoreApi = {
  coreVersion: () => wasm.coreVersion(),
  importSvg: (text, sourceName) => JSON.parse(wasm.importSvg(text, sourceName)),
  importDxf: (text, sourceName) => JSON.parse(wasm.importDxf(text, sourceName)),
  importToolsYaml: (text) => JSON.parse(wasm.importToolsYaml(text)),
  projectFromFile: (text) => JSON.parse(wasm.projectFromFile(text)),
  projectToFile: (project) => wasm.projectToFile(JSON.stringify(project)),
  libraryFromFile: (text) => JSON.parse(wasm.libraryFromFile(text)),
  libraryToFile: (library) => wasm.libraryToFile(JSON.stringify(library)),
  validateTool: (tool) => wasm.validateTool(JSON.stringify(tool)) ?? null,
  previewPart: (project, jobId, part) => {
    const preview = wasm.previewPart(JSON.stringify(project), jobId, part);
    try {
      return { ...JSON.parse(preview.info), heights: preview.heights, path: preview.path };
    } finally {
      preview.free();
    }
  },
  previewCombined: (project, jobIds) => {
    const preview = wasm.previewCombined(JSON.stringify(project), JSON.stringify(jobIds));
    try {
      return { ...JSON.parse(preview.info), heights: preview.heights, path: preview.path };
    } finally {
      preview.free();
    }
  },
  checkFit: (project, jobId) => {
    const check = wasm.checkFit(JSON.stringify(project), jobId);
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
    response = { id, ok: true, value: fn(...args) };
  } catch (e) {
    response = { id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  self.postMessage(response);
};
