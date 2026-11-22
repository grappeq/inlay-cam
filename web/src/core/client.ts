import { createCalls } from "./calls";
import type { CoreApi, CoreMessage, CoreMethod, CoreProgress } from "./protocol";

/** Promise-based access to the core running in a Web Worker. */
export class CoreClient {
  private readonly worker: Worker;
  private readonly calls: ReturnType<typeof createCalls>;

  constructor() {
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.calls = createCalls((request) => this.worker.postMessage(request));
    this.worker.onmessage = (event: MessageEvent<CoreMessage>) => this.calls.receive(event.data);
    this.worker.onerror = (event) => this.calls.failAll(new Error(event.message || "The core worker failed to load"));
  }

  call<M extends CoreMethod>(method: M, ...args: Parameters<CoreApi[M]>): Promise<ReturnType<CoreApi[M]>> {
    return this.calls.call(method, args);
  }

  /** As `call`, with `onProgress` told how far the work is, for the calls that say: those that build a file, cut a board or take the stock through the list. */
  watch<M extends CoreMethod>(onProgress: (progress: CoreProgress) => void, method: M, ...args: Parameters<CoreApi[M]>): Promise<ReturnType<CoreApi[M]>> {
    return this.calls.call(method, args, onProgress);
  }

  dispose(): void {
    this.worker.terminate();
  }
}

/** The one core worker shared by the whole app. */
export const core = new CoreClient();
