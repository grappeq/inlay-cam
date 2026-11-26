// The app's reducer, as far as a save in flight goes: what the header's
// "Saving…" stands on.

import { describe, expect, it, vi } from "vitest";

vi.mock("../core/client", () => ({ core: { call: () => Promise.reject(new Error("no core in a test")) } }));

import { initial, reducer, toolsAsLoaded } from "./store";

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

describe("the tool list as it was read at start", () => {
  it("is not written back until it is changed here: one that could not be read would go over what is kept", () => {
    const tools = initial.tools;
    const lists = initial.lists;
    expect(toolsAsLoaded({ tools, lists }, { tools, lists })).toBe(true);
    expect(toolsAsLoaded({ tools: [...tools], lists }, { tools, lists })).toBe(false);
    expect(toolsAsLoaded({ tools, lists: { ...lists } }, { tools, lists })).toBe(false);
    // Before anything was read.
    expect(toolsAsLoaded({ tools, lists }, {})).toBe(false);
  });
});
