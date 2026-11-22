// The app's reducer, as far as a save in flight goes: what the header's
// "Saving…" stands on.

import { describe, expect, it, vi } from "vitest";

vi.mock("../core/client", () => ({ core: { call: () => Promise.reject(new Error("no core in a test")) } }));

import { initial, reducer } from "./store";

describe("a save in flight", () => {
  it("is not there to start with", () => {
    expect(initial.saving).toBe(false);
  });

  it("goes on until its result is there, good or bad", () => {
    const going = reducer(initial, { type: "saving" });
    expect(going.saving).toBe(true);
    expect(reducer(going, { type: "saveResult", error: null })).toMatchObject({ saving: false, saveError: null });
    expect(reducer(going, { type: "saveResult", error: "The disk is full." })).toMatchObject({ saving: false, saveError: "The disk is full." });
  });

  it("is over when it ran into a version saved elsewhere", () => {
    const going = reducer(initial, { type: "saving" });
    const stopped = reducer(going, { type: "projectConflict", conflict: { id: "p", text: "{}" } });
    expect(stopped.saving).toBe(false);
    expect(stopped.projectConflict).not.toBeNull();
  });

  it("is left as it is when a conflict is settled", () => {
    const going = reducer(initial, { type: "saving" });
    expect(reducer(going, { type: "projectConflict", conflict: null }).saving).toBe(true);
  });
});
