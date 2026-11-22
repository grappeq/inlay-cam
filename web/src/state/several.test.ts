import { describe, expect, it } from "vitest";
import { deletedText, movedText, partWayText, waitText } from "./several";

describe("what is said after moving projects", () => {
  it("names the one project, and counts several", () => {
    expect(movedText(1, 1, "Walnut tray", "Coasters")).toBe('"Walnut tray" moved to Coasters.');
    expect(movedText(3, 3, "", "Unfiled")).toBe("3 projects moved to Unfiled.");
  });

  it("says what was left when it stopped part of the way", () => {
    expect(movedText(2, 3, "", "Coasters")).toBe("2 projects moved to Coasters; 1 left where it was.");
    expect(movedText(1, 4, "", "Coasters")).toBe("1 project moved to Coasters; 3 left where they were.");
  });

  it("says so when it stopped before anything was moved", () => {
    expect(movedText(0, 3, "", "Coasters")).toBe("Stopped: nothing was moved.");
  });

  it("says nothing when there was nothing to move", () => {
    expect(movedText(0, 0, "", "Coasters")).toBeNull();
  });
});

describe("what is said after deleting projects", () => {
  it("says nothing when all went, as the list shows it", () => {
    expect(deletedText(3, 3)).toBeNull();
  });

  it("says what was kept when it stopped", () => {
    expect(deletedText(1, 3)).toBe("1 project deleted; 2 kept.");
    expect(deletedText(0, 3)).toBe("Stopped: nothing was deleted.");
  });
});

describe("a failure part of the way", () => {
  it("says what was done before it", () => {
    expect(partWayText(2, "moved to Coasters", "The server said no.")).toBe("2 projects moved to Coasters, then: The server said no.");
    expect(partWayText(0, "deleted", "The server said no.")).toBe("The server said no.");
  });
});

describe("something asked for while other work goes on", () => {
  it("is told what it waits for", () => {
    expect(waitText("Moving to Coasters")).toBe('Not done: "Moving to Coasters" is still going on. Try again when it is over.');
  });
});
