// Runs the WebAssembly core off the main thread so long computations never
// freeze the page. Structured values cross into the core as JSON text.

import init, * as wasm from "../wasm/inlay_wasm";
import type { CoreApi, CoreRequest, CoreResponse } from "./protocol";

const ready = init();

const api: CoreApi = {
  coreVersion: () => wasm.coreVersion(),
  importSvg: (text, sourceName) => JSON.parse(wasm.importSvg(text, sourceName)),
  importToolsYaml: (text) => JSON.parse(wasm.importToolsYaml(text)),
  projectFromFile: (text) => JSON.parse(wasm.projectFromFile(text)),
  projectToFile: (project) => wasm.projectToFile(JSON.stringify(project)),
  toolsFromFile: (text) => JSON.parse(wasm.toolsFromFile(text)),
  toolsToFile: (tools) => wasm.toolsToFile(JSON.stringify(tools)),
  validateTool: (tool) => wasm.validateTool(JSON.stringify(tool)) ?? null,
  previewPocket: (project, jobId) => {
    const preview = wasm.previewPocket(JSON.stringify(project), jobId);
    try {
      return { ...JSON.parse(preview.info), heights: preview.heights, path: preview.path };
    } finally {
      preview.free();
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
