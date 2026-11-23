/** Wood thinner than this, mm, is not there: a cut this near the bottom of the board has gone right through it. */
export const SLIVER = 1e-3;

/** Whether a cell cut to `height` (0 at the top of the board, negative below) is cut right through a board `thickness` thick. */
export function isHole(height: number, thickness: number): boolean {
  return Number.isFinite(height) && height <= -thickness + SLIVER;
}

/**
 * A grid's surface of `dx` × `dy` vertices, row by row, with the holes left
 * open: the two triangles of each square, but none with a corner in a hole.
 * `rims` are the edges where the surface ends at a hole, as pairs of
 * vertices, for the walls down the hole; not those on the grid's border,
 * which has walls of its own.
 */
export function openSurface(dx: number, dy: number, hole: Uint8Array): { index: Uint32Array; rims: number[] } {
  // The first triangle of a square: its corner, the one beside it, the one above it. The second: the other three.
  const corners = (i: number, j: number, second: boolean): number[] => {
    const a = j * dx + i;
    return second ? [a + 1, a + dx + 1, a + dx] : [a, a + 1, a + dx];
  };
  const kept = (i: number, j: number, second: boolean): boolean | null => {
    if (i < 0 || j < 0 || i >= dx - 1 || j >= dy - 1) return null;
    return corners(i, j, second).every((k) => !hole[k]);
  };
  const index: number[] = [];
  const rims: number[] = [];
  for (let j = 0; j < dy - 1; j++) {
    for (let i = 0; i < dx - 1; i++) {
      for (const second of [false, true]) {
        if (!kept(i, j, second)) continue;
        const [p, q, r] = corners(i, j, second);
        index.push(p, q, r);
        // Across each edge, the triangle beside it.
        const across: [number, number, boolean | null][] = second
          ? [
              [q, r, kept(i, j + 1, false)],
              [r, p, kept(i, j, false)],
              [p, q, kept(i + 1, j, false)],
            ]
          : [
              [p, q, kept(i, j - 1, true)],
              [q, r, kept(i, j, true)],
              [r, p, kept(i - 1, j, true)],
            ];
        for (const [from, to, beside] of across) if (beside === false) rims.push(from, to);
      }
    }
  }
  return { index: new Uint32Array(index), rims };
}
