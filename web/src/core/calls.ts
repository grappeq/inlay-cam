// The calls to the core that are under way: which answer and which word of
// progress belongs to which call. Nothing here knows of a worker, so that it
// can be tried without one.

import type { CoreApi, CoreMessage, CoreMethod, CoreProgress, CoreRequest } from "./protocol";

type Pending = { request: CoreRequest; tag?: string; resolve: (value: unknown) => void; reject: (error: Error) => void; onProgress?: (progress: CoreProgress) => void };

/** What a call that was cancelled fails with: nothing went wrong, it was called off. */
export class Cancelled extends Error {
  constructor() {
    super("Cancelled.");
    this.name = "Cancelled";
  }
}

/** Whether something failed only because it was called off. */
export const isCancelled = (e: unknown): e is Cancelled => e instanceof Cancelled;

/** Keeps the calls under way. `post` sends a request to where the core runs; what comes back is given to `receive`. */
export function createCalls(post: (request: CoreRequest) => void) {
  const pending = new Map<number, Pending>();
  let nextId = 1;
  return {
    /** Asks the core for something. `onProgress` is told how far it is, for the calls that say. `tag` names the work it is part of, to call it off by. */
    call<M extends CoreMethod>(method: M, args: Parameters<CoreApi[M]>, onProgress?: (progress: CoreProgress) => void, tag?: string): Promise<ReturnType<CoreApi[M]>> {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const request: CoreRequest = { id, method, args };
        pending.set(id, { request, tag, resolve: resolve as (value: unknown) => void, reject, onProgress });
        post(request);
      });
    },
    /**
     * Calls off every call under way that has the tag: each fails as
     * cancelled. Gives how many there were, and the requests of the calls
     * still under way, in the order they were made: where the core runs does
     * one thing at a time and cannot be told to leave one out, so it is
     * started anew and these are sent to it again.
     */
    cancel(tag: string): { cancelled: number; rest: CoreRequest[] } {
      let cancelled = 0;
      for (const [id, entry] of [...pending]) {
        if (entry.tag !== tag) continue;
        pending.delete(id);
        cancelled++;
        entry.reject(new Cancelled());
      }
      return { cancelled, rest: [...pending.values()].map((entry) => entry.request) };
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
