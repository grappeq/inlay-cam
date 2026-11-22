import { createCalls } from "./calls";
import type { CoreApi, CoreMessage, CoreMethod, CoreProgress, CoreRequest } from "./protocol";

/** As much of a worker as the client needs: so that it can be tried with one that is not. */
export interface CoreWorker {
  postMessage(request: CoreRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<CoreMessage>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

/** Promise-based access to the core running in a worker that `spawn` starts. */
export class CoreClient {
  private worker: CoreWorker;
  private readonly calls: ReturnType<typeof createCalls>;

  constructor(private readonly spawn: () => CoreWorker) {
    this.calls = createCalls((request) => this.worker.postMessage(request));
    this.worker = this.start();
  }

  private start(): CoreWorker {
    const worker = this.spawn();
    worker.onmessage = (event) => this.calls.receive(event.data);
    worker.onerror = (event) => this.calls.failAll(new Error(event.message || "The core worker failed to load"));
    return worker;
  }

  call<M extends CoreMethod>(method: M, ...args: Parameters<CoreApi[M]>): Promise<ReturnType<CoreApi[M]>> {
    return this.calls.call(method, args);
  }

  /** As `call`, with `onProgress` told how far the work is, for the calls that say: those that build a file, cut a board or take the stock through the list. */
  watch<M extends CoreMethod>(onProgress: (progress: CoreProgress) => void, method: M, ...args: Parameters<CoreApi[M]>): Promise<ReturnType<CoreApi[M]>> {
    return this.calls.call(method, args, onProgress);
  }

  /** As `watch`, as part of the work called `tag`, which `cancel` calls off. */
  work<M extends CoreMethod>(tag: string, onProgress: (progress: CoreProgress) => void, method: M, ...args: Parameters<CoreApi[M]>): Promise<ReturnType<CoreApi[M]>> {
    return this.calls.call(method, args, onProgress, tag);
  }

  /**
   * Calls off the work called `tag`: its calls fail as cancelled. The core
   * does one thing at a time and cannot be interrupted, so the worker is
   * ended and a new one started, which is sent every other call that was
   * under way, in the order they were made: one of those that was being
   * worked on starts again from nothing. What the old worker had kept from
   * earlier work is gone with it. Gives whether there was anything to call
   * off.
   */
  cancel(tag: string): boolean {
    const { cancelled, rest } = this.calls.cancel(tag);
    if (cancelled === 0) return false;
    // Nothing more is heard from the old one: an answer of its, late, could pass for the new one's.
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.terminate();
    this.worker = this.start();
    for (const request of rest) this.worker.postMessage(request);
    return true;
  }

  dispose(): void {
    this.worker.terminate();
  }
}
