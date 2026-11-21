// A .zip of a few text files, stored as they are: enough to hand several
// files over as one download. No compression, so no library is needed; the
// files are small.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** The CRC-32 a .zip holds of each file. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A date and time as a .zip has them: MS-DOS's, local time, to two seconds. */
function dosTime(at: Date): [number, number] {
  const time =
    (at.getHours() << 11) |
    (at.getMinutes() << 5) |
    Math.floor(at.getSeconds() / 2);
  const date =
    ((Math.max(1980, at.getFullYear()) - 1980) << 9) |
    ((at.getMonth() + 1) << 5) |
    at.getDate();
  return [time, date];
}

/** The files as one .zip, each stored without compression. Names are UTF-8, as the .zip's flag says. */
export function zipFiles(
  files: { name: string; text: string }[],
  at = new Date(),
): Uint8Array {
  const encoder = new TextEncoder();
  const [time, date] = dosTime(at);
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = encoder.encode(file.text);
    const crc = crc32(data);
    // Version 2.0, bit 11 for UTF-8 names, method 0 (stored).
    const common = (view: DataView, at: number) => {
      view.setUint16(at, 20, true);
      view.setUint16(at + 2, 0x0800, true);
      view.setUint16(at + 4, 0, true);
      view.setUint16(at + 6, time, true);
      view.setUint16(at + 8, date, true);
      view.setUint32(at + 10, crc, true);
      view.setUint32(at + 14, data.length, true);
      view.setUint32(at + 18, data.length, true);
      view.setUint16(at + 22, name.length, true);
      view.setUint16(at + 24, 0, true);
    };
    const local = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    common(lv, 4);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    common(cv, 6);
    // Comment length, disk, internal and external attributes: none.
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + end.length);
  let at2 = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at2);
    at2 += part.length;
  }
  return out;
}

/** Names Windows keeps for devices, whatever the case and the extension. */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** Letters a name keeps at most, as the core's own names for the libraries, and bytes, as file systems allow 255. */
const LONGEST = 100;
const LONGEST_BYTES = 200;

/** As many letters of `text` from the start as `LONGEST` and `LONGEST_BYTES` allow. */
function shortened(text: string): string {
  let out = "";
  let bytes = 0;
  for (const letter of [...text].slice(0, LONGEST)) {
    bytes += new TextEncoder().encode(letter).length;
    if (bytes > LONGEST_BYTES) break;
    out += letter;
  }
  return out;
}

/**
 * File names with look-alike letters folded as Unicode's NFKC does, so
 * that "Ｅnd mills" and "End mills" are one name, and kept apart whatever
 * the case of letters by a number after the second. Folding can make a
 * letter a file name may not hold, such as a full-width slash into "/":
 * those are made "_"; and it can make a name Windows keeps, such as
 * "ＣＯＮ" into "CON", or one too long, so those are checked after it.
 */
export function foldedNames(names: string[]): string[] {
  const seen = new Set<string>();
  return names.map((name) => {
    const dot = name.lastIndexOf(".");
    const [stem, ext] =
      dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
    let folded = shortened(
      stem.normalize("NFKC").replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, "_"),
    )
      // Windows drops dots and spaces at the end of a name.
      .replace(/[. ]+$/, "")
      .trim();
    if (!folded) folded = "Tools";
    if (RESERVED.test(folded)) folded = `${folded}_`;
    // A name numbered already, as the core numbers two that were alike, goes on from its number.
    const numbered = /^(.*) \((\d+)\)$/.exec(folded);
    const [base, first] = numbered
      ? [numbered[1], Number(numbered[2]) + 1]
      : [folded, 2];
    let candidate = folded;
    for (let n = first; seen.has(`${candidate}${ext}`.toLowerCase()); n++)
      candidate = `${base} (${n})`;
    seen.add(`${candidate}${ext}`.toLowerCase());
    return `${candidate}${ext}`;
  });
}
