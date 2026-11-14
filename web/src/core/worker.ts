// Runs the WebAssembly core off the main thread so long computations never
// freeze the page.

import init, * as wasm from "../wasm/inlay_wasm";
import type { CoreApi, CoreRequest, CoreResponse } from "./protocol";

const ready = init();

const api: CoreApi = {
  coreVersion: () => wasm.coreVersion(),
  medialAxisOfRing: (ring) => wasm.medialAxisOfRing(ring),
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
