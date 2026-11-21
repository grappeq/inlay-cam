import { describe, expect, it } from "vitest";
import { crc32, foldedNames, zipFiles } from "./zip";

describe("zipFiles", () => {
  it("takes the CRC-32 that .zip readers check", () => {
    expect(crc32(new TextEncoder().encode("hello"))).toBe(0x3610a686);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it("writes each file stored, with a central directory that finds it", () => {
    const zip = zipFiles([
      { name: "End mills.json", text: "{}" },
      { name: "Gravírky.json", text: '{"a":1}' },
    ]);
    const view = new DataView(zip.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    // The end record: two entries, and where the directory starts.
    const end = zip.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 10, true)).toBe(2);
    const directory = view.getUint32(end + 16, true);
    expect(view.getUint32(directory, true)).toBe(0x02014b50);
    // The second entry's name, in UTF-8, read back from its local header.
    const second = view.getUint32(
      directory + 46 + "End mills.json".length + 42,
      true,
    );
    const length = view.getUint16(second + 26, true);
    expect(
      new TextDecoder().decode(zip.slice(second + 30, second + 30 + length)),
    ).toBe("Gravírky.json");
    expect(view.getUint16(second + 6, true) & 0x0800).toBe(0x0800);
  });
});

describe("foldedNames", () => {
  it("folds look-alike letters, and keeps the names apart", () => {
    expect(
      foldedNames([
        "Ｅnd mills.json",
        "End mills.json",
        "END MILLS.json",
        "Drills.json",
      ]),
    ).toEqual([
      "End mills.json",
      "End mills (2).json",
      "END MILLS (3).json",
      "Drills.json",
    ]);
  });

  it("makes what folding turns into a letter a file name may not hold safe", () => {
    expect(foldedNames(["Wood／Hard.json", "ﬁnish.json"])).toEqual([
      "Wood_Hard.json",
      "finish.json",
    ]);
  });

  it("keeps clear of names Windows keeps, long names and numbers twice", () => {
    expect(
      foldedNames(["ＣＯＮ.json", "ＬＰＴ１.json", "Trail．.json"]),
    ).toEqual(["CON_.json", "LPT1_.json", "Trail.json"]);
    expect([...foldedNames(["ﷺ".repeat(60) + ".json"])[0]].length).toBe(
      100 + ".json".length,
    );
    expect(
      new TextEncoder().encode(foldedNames(["木".repeat(100) + ".json"])[0])
        .length,
    ).toBeLessThanOrEqual(255);
    expect(
      foldedNames([
        "End mills.json",
        "End mills (2).json",
        "Ｅnd mills (2).json",
      ]),
    ).toEqual(["End mills.json", "End mills (2).json", "End mills (3).json"]);
  });
});
