import { describe, expect, it } from "vitest";
import { isCancelled } from "./calls";
import { CoreClient, type CoreWorker } from "./coreClient";
import type { CoreMessage, CoreRequest } from "./protocol";

/** A worker that keeps what it was sent and answers when the test says. */
class FakeWorker implements CoreWorker {
  sent: CoreRequest[] = [];
  ended = false;
  onmessage: ((event: MessageEvent<CoreMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage(request: CoreRequest) {
    this.sent.push(request);
  }
  terminate() {
    this.ended = true;
  }
  say(message: CoreMessage) {
    this.onmessage?.({ data: message } as MessageEvent<CoreMessage>);
  }
}

function setup() {
  const workers: FakeWorker[] = [];
  const client = new CoreClient(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  });
  return { client, workers };
}

describe("the client of the core", () => {
  it("sends calls to its worker and gives back the answers", async () => {
    const { client, workers } = setup();
    const version = client.call("coreVersion");
    expect(workers).toHaveLength(1);
    expect(workers[0].sent).toEqual([{ id: 1, method: "coreVersion", args: [] }]);
    workers[0].say({ id: 1, ok: true, value: "0.1.0" });
    expect(await version).toBe("0.1.0");
  });

  it("tells a watcher how far its call is", async () => {
    const { client, workers } = setup();
    const seen: number[] = [];
    const made = client.watch((p) => seen.push(p.done), "coreVersion");
    workers[0].say({ id: 1, progress: { stage: "cut", done: 3, total: 9 } });
    workers[0].say({ id: 1, ok: true, value: "v" });
    await made;
    expect(seen).toEqual([3]);
  });

  it("calls work off by ending the worker and starting another, which gets the other calls again", async () => {
    const { client, workers } = setup();
    const save = client.call("coreVersion");
    const pocket = client.work("generate 1", () => {}, "coreVersion");
    const stock = client.work("stock 1", () => {}, "coreVersion");
    expect(client.cancel("generate 1")).toBe(true);
    await expect(pocket).rejects.toSatisfy(isCancelled);

    expect(workers).toHaveLength(2);
    expect(workers[0].ended).toBe(true);
    expect(workers[1].ended).toBe(false);
    // The others, as they were sent, in the order they were made.
    expect(workers[1].sent).toEqual([workers[0].sent[0], workers[0].sent[2]]);

    // Their answers come from the new one.
    workers[1].say({ id: 1, ok: true, value: "saved" });
    workers[1].say({ id: 3, ok: true, value: "stock" });
    expect(await save).toBe("saved");
    expect(await stock).toBe("stock");
  });

  it("no longer hears the worker it ended", async () => {
    const { client, workers } = setup();
    const save = client.call("coreVersion");
    void client.work("generate 1", () => {}, "coreVersion").catch(() => {});
    client.cancel("generate 1");
    // Whatever it still had to say, or to fail with, reaches nobody.
    expect(workers[0].onmessage).toBeNull();
    expect(workers[0].onerror).toBeNull();
    workers[1].say({ id: 1, ok: true, value: "from the new one" });
    expect(await save).toBe("from the new one");
  });

  it("leaves the worker alone when there is nothing to call off", async () => {
    const { client, workers } = setup();
    const save = client.call("coreVersion");
    expect(client.cancel("generate 1")).toBe(false);
    expect(workers).toHaveLength(1);
    expect(workers[0].ended).toBe(false);
    workers[0].say({ id: 1, ok: true, value: "saved" });
    expect(await save).toBe("saved");
  });

  it("goes on working after one calling off, and after another", async () => {
    const { client, workers } = setup();
    void client.work("a", () => {}, "coreVersion").catch(() => {});
    client.cancel("a");
    void client.work("b", () => {}, "coreVersion").catch(() => {});
    client.cancel("b");
    expect(workers).toHaveLength(3);
    expect(workers.map((w) => w.ended)).toEqual([true, true, false]);
    const version = client.call("coreVersion");
    expect(workers[2].sent).toEqual([{ id: 3, method: "coreVersion", args: [] }]);
    workers[2].say({ id: 3, ok: true, value: "v" });
    expect(await version).toBe("v");
  });

  it("fails every call when its worker cannot load", async () => {
    const { client, workers } = setup();
    const made = client.call("coreVersion");
    workers[0].onerror?.({ message: "" } as ErrorEvent);
    await expect(made).rejects.toThrow("The core worker failed to load");
  });
});
