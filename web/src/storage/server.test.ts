// What the server says of when the synced settings last changed, against a fetch that answers as it does.

import { afterEach, describe, expect, it, vi } from "vitest";
import { putSetting, readLibrary, settingSaved } from "./server";

afterEach(() => vi.unstubAllGlobals());

const answers = (body: unknown, headers: Record<string, string> = {}) => {
  const fetched = vi.fn(async (_input: string, _init?: RequestInit) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, headers }));
  vi.stubGlobal("fetch", fetched);
  return fetched;
};

describe("when a setting kept on a server was last changed", () => {
  it("is what `saved` says of it, and nothing where that is no time", async () => {
    answers({ machine: "m", inlayDefaults: "d", saved: { machine: 5000, inlayDefaults: "soon" } });
    expect(await settingSaved("machine")).toBe(5000);
    expect(await settingSaved("inlayDefaults")).toBeUndefined();
    // A server that does not date them, or one whose dates are none.
    answers({ machine: "m" });
    expect(await settingSaved("machine")).toBeUndefined();
    answers({ machine: "m", saved: "x" });
    expect(await settingSaved("machine")).toBeUndefined();
  });

  it("is sent along with one copied from another place, and not with one kept here", async () => {
    const fetched = answers({ ok: true });
    await putSetting("machine", "m", 7000);
    await putSetting("machine", "m2");
    expect(fetched.mock.calls.map(([, init]) => JSON.parse(String(init!.body)))).toEqual([{ value: "m", saved: 7000 }, { value: "m2" }]);
  });

  it("is of the tool list when its file was written, where the server says", async () => {
    answers("{tools}", { ETag: '"t1"', "X-Saved-At": "2026-11-27T10:00:00Z" });
    expect(await readLibrary()).toEqual({ text: "{tools}", token: "t1", savedAt: Date.parse("2026-11-27T10:00:00Z") });
    answers("{tools}", { ETag: '"t1"' });
    expect(await readLibrary()).toEqual({ text: "{tools}", token: "t1" });
    answers("{tools}", { ETag: '"t1"', "X-Saved-At": "some day" });
    expect(await readLibrary()).toEqual({ text: "{tools}", token: "t1" });
  });
});
