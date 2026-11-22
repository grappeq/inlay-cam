// The calls to the core that are under way: which answer and which word of
// progress belongs to which call. Nothing here knows of a worker, so that it
// can be tried without one.

import type { CoreApi, CoreMessage, CoreMethod, CoreProgress, CoreRequest } from "./protocol";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; onProgress?: (progress: CoreProgress) => void };

/** Keeps the calls under way. `post` sends a request to where the core runs; what comes back is given to `receive`. */
export function createCalls(post: (request: CoreRequest) => void) {
  const pending = new Map<number, Pending>();
  let nextId = 1;
  return {
    /** Asks the core for something. `onProgress` is told how far it is, for the calls that say. */
    call<M extends CoreMethod>(method: M, args: Parameters<CoreApi[M]>, onProgress?: (progress: CoreProgress) => void): Promise<ReturnType<CoreApi[M]>> {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject, onProgress });
        post({ id, method, args });
      });
    },
    /** Takes what the core sent: an answer ends its call, a word of progress goes to whoever watches it. */
    receive(message: CoreMessage) {
      const entry = pending.get(message.id);
      if (!entry) return;
      if ("progress" in message) {
        // A watcher that fails is not the call's business.
        try {
          entry.onProgress?.(message.progress);
        } catch {
          // Nothing to do: the call goes on.
        }
        return;
      }
      pending.delete(message.id);
      if (message.ok) entry.resolve(message.value);
      else entry.reject(new Error(message.error));
    },
    /** Fails every call under way: the core is gone. */
    failAll(error: Error) {
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
    },
    /** How many calls are under way. */
    count: () => pending.size,
  };
}

/**
 * Lets through as much progress as can be followed. Of the cutting of a
 * board, which says very often how far it is: its start, and then one word
 * each `ms`. Every other word says something new, where the work is, and
 * always goes through. `now` is the clock. Gives what says whether a word
 * goes through.
 */
export function createPace(now: () => number, ms: number) {
  let last: { stage: string; at: number } | null = null;
  const pass = (progress: CoreProgress): boolean => {
    const at = now();
    if (progress.stage === "cut" && last && last.stage === "cut" && progress.done !== 0 && at - last.at < ms) return false;
    last = { stage: progress.stage, at };
    return true;
  };
  /** Before a new call: its first word goes through. */
  pass.reset = () => {
    last = null;
  };
  return pass;
}
