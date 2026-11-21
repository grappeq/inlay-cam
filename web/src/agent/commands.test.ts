// The relay (mcp/) lists the page's commands as tools before any page has
// connected, from a copy it is shipped with: mcp/src/commands.json. This
// keeps that copy what the page says. After a change to a command, in web/:
//   npx vitest run -u src/agent/commands.test.ts
import { describe, expect, it, vi } from "vitest";
import { listCommands } from "./commands";

// The commands only describe themselves here: nothing reaches the core.
vi.mock("../core/client", () => ({ core: { call: () => Promise.reject(new Error("no core in a test")) } }));

describe("the commands the relay is shipped with", () => {
  it("are the page's", async () => {
    await expect(`${JSON.stringify(listCommands(), null, 1)}\n`).toMatchFileSnapshot("../../../mcp/src/commands.json");
  });
});
