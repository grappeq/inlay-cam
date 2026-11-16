import { describe, expect, it } from "vitest";
import { materialKey, profileKey } from "./model";

describe("keys made from names", () => {
  it("keeps letters and digits, joined by underscores", () => {
    expect(profileKey("Rest machining", [])).toBe("rest_machining");
    expect(materialKey("Oak, quarter-sawn", [])).toBe("oak_quarter_sawn");
  });

  it("reads accented letters as their plain ones", () => {
    expect(profileKey("Żłobienie rowków", [])).toBe("zlobienie_rowkow");
    expect(materialKey("Dąb", [])).toBe("dab");
  });

  it("never gives a key a YAML reader would take for something else", () => {
    expect(profileKey("2024", [])).toBe("tp_2024");
    expect(profileKey("Yes", [])).toBe("tp_yes");
    expect(profileKey("!!!", [])).toBe("profile");
  });

  it("does not reuse a key", () => {
    expect(profileKey("Finishing", ["finishing"])).toBe("finishing_2");
    expect(profileKey("Finishing", ["finishing", "finishing_2"])).toBe("finishing_3");
    expect(materialKey("Oak", ["oak"])).toBe("oak_2");
  });

  it("stays within the 40 characters a profile key may have", () => {
    const key = profileKey("A very long name for a kind of toolpath that goes on", ["x"]);
    expect(key.length).toBeLessThanOrEqual(40);
    expect(key).toMatch(/^[a-z0-9_]+$/);
  });
});
