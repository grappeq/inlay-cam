import type { CoreApi, CoreMethod, CoreRequest, CoreResponse } from "./protocol";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

/** Promise-based access to the core running in a Web Worker. */
export class CoreClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  constructor() {
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (event: MessageEvent<CoreResponse>) => {
      const response = event.data;
      const entry = this.pending.get(response.id);
      if (!entry) return;
      this.pending.delete(response.id);
      if (response.ok) entry.resolve(response.value);
      else entry.reject(new Error(response.error));
    };
    this.worker.onerror = (event) => {
      const error = new Error(event.message || "The core worker failed to load");
      for (const entry of this.pending.values()) entry.reject(error);
      this.pending.clear();
    };
  }

  call<M extends CoreMethod>(method: M, ...args: Parameters<CoreApi[M]>): Promise<ReturnType<CoreApi[M]>> {
    const id = this.nextId++;
    const request: CoreRequest<M> = { id, method, args };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.worker.postMessage(request);
    });
  }

  dispose(): void {
    this.worker.terminate();
  }
}
