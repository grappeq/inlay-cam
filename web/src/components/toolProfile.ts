// To-scale side profile of a cutter: shank on the left, cutting end on the
// right, drawn from the tool's own geometry: shank and back chamfer, the step
// or taper to the cutting diameter, then the cutting end by kind (square,
// ball, cone, drill point, quarter-round, thread teeth) with its flutes
// projected as helices, a relieved neck when the shoulder reaches past the
// flutes, and, right of it on the same axis, the end view: the cutter seen
// from its tip, with its flutes, core and tip form. The tool's style word sets
// the helix hand and the cutting end's detail: a downcut's mirrored helix, a
// compression cutter's crossover, a rougher's serrated edges, a corn bit's
// burr teeth, a PCB bit's depth-stop collar.
//
// This is the drawing of `cnc-tooling-library`'s workbench, kept line for
// line where it could be; the quarter-round end of a corner-rounding bit is
// this app's addition. Colours come from the `.draw` rules in app.css.

const NS = "http://www.w3.org/2000/svg";
/** Helix angle drawn for spiral-fluted tools: the tool list does not hold one. */
const HELIX = (30 * Math.PI) / 180;
/** Half-angle of the shank-to-neck taper on reduced-diameter tools. */
const NECK_TAPER = (20 * Math.PI) / 180;
/** The side view's width budget, with the end view beside it. */
const SIDE_W = 470;
/** The end view's centre, and the radius the larger of the diameter and the shank maps to. */
const EX = 575;
const EY = 84;
const ER = 55;

type Pt = [number, number];
export type ProfileKind = "flat_end" | "ball_end" | "v_bit" | "corner_round" | "drill" | "thread_mill";
export type Style = "Upcut" | "Downcut" | "Compression" | "Straight" | "Roughing" | "Corn" | "PCB";

/** A tool's shape for drawing, in mm and degrees. 0 means unknown. */
export interface ProfileGeometry {
  diameter: number;
  length: number;
  fluteLength: number;
  shoulderLength: number;
  shankDiameter: number;
  tipDiameter: number;
  tipAngle: number;
  flutes: number;
  pitch: number;
  cornerRadius: number;
}

interface End {
  pts: Pt[];
  radiusAt: (x: number) => number;
  /** The flutes run straight along the axis. */
  straight?: boolean;
  /** Where along the cutting end the cutting starts. */
  cutsFrom?: number;
}

/**
 * Canonical style and the words that name it, matched as whole words of the
 * style text. The more specific styles come first: "Compression upcut" is a
 * compression cutter.
 */
const STYLE_ALIASES: [Style, string[]][] = [
  ["Compression", ["compression", "comp", "up down", "updown"]],
  ["Roughing", ["roughing", "rougher", "rough", "gryzak", "serrated", "chipbreaker", "chip breaker", "ripper"]],
  ["Corn", ["corn", "burr", "diamond cut", "pineapple"]],
  ["Straight", ["straight"]],
  ["Downcut", ["downcut", "down"]],
  ["Upcut", ["upcut", "up"]],
  ["PCB", ["pcb"]],
];

/** The style a style text names, or null: "Downcut 1F" is Downcut, "Alu" nothing. */
export function matchStyle(text: string | undefined): Style | null {
  const words = String(text ?? "")
    .toLowerCase()
    .replace(/[-_/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!words) return null;
  const padded = ` ${words} `;
  for (const [canonical, aliases] of STYLE_ALIASES) {
    if (aliases.some((a) => padded.includes(` ${a} `))) return canonical;
  }
  return null;
}

const num = (v: number) => String(Number(v.toPrecision(12)));

function s(tag: string, attrs: Record<string, string | number> = {}, text?: string): SVGElement {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, typeof v === "number" ? v.toFixed(1) : v);
  if (text !== undefined) el.textContent = text;
  return el;
}

/** Keeps marker and clip ids unique when several drawings share a page. */
let seq = 0;

function dimLine(svg: SVGElement, x1: number, x2: number, y: number, unknown: boolean, arr: string) {
  const attrs: Record<string, string | number> = { x1, y1: y, x2, y2: y, class: unknown ? "dim unk" : "dim", "marker-start": `url(#${arr})`, "marker-end": `url(#${arr})` };
  if (unknown) attrs["stroke-dasharray"] = "4 3";
  svg.append(s("line", attrs));
}

const pathOf = (pts: Pt[]) => pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
const f1 = (v: number) => v.toFixed(1);
const conical = (kind: ProfileKind) => kind === "v_bit" || kind === "corner_round";

/**
 * The upper half of the cutting end as [axial mm from where it starts, radius
 * mm] points, tip last, plus the radius at any axial position, for projecting
 * the flutes. c: cutting length, r: cutting radius, rt: tip radius.
 */
function cuttingEnd(kind: ProfileKind, c: number, r: number, rt: number, half: number, pitch: number, corner: number): End {
  if (kind === "ball_end") {
    // A hemisphere of radius r centred at xc; a cutting end shorter than r is a truncated sphere.
    const xc = c - r;
    const a0 = xc >= 0 ? 0 : Math.asin(-xc / r);
    const pts: Pt[] = xc > 0 ? [[0, r]] : [];
    for (let k = 0; k <= 12; k++) {
      const a = a0 + (k / 12) * (Math.PI / 2 - a0);
      pts.push([Math.max(xc + r * Math.sin(a), 0), r * Math.cos(a)]);
    }
    return { pts, radiusAt: (x) => (x <= xc ? r : Math.sqrt(Math.max(r * r - (x - xc) ** 2, 0))) };
  }
  if (kind === "corner_round" && corner > 0) {
    // A quarter circle, hollow towards the work: along the axis at the tip, level where it meets the body.
    const rad = Math.min(corner, c, Math.max(r - rt, 0.01));
    const top = rt + rad;
    const pts: Pt[] = [
      [0, r],
      [c - rad, r],
    ];
    for (let k = 0; k <= 10; k++) {
      const a = Math.PI / 2 - (k / 10) * (Math.PI / 2);
      pts.push([c - rad * Math.sin(a), top - rad * Math.cos(a)]);
    }
    pts.push([c, 0]);
    return { pts, radiusAt: (x) => (x <= c - rad ? r : top - Math.sqrt(Math.max(rad * rad - (c - x) ** 2, 0))), straight: true };
  }
  if ((conical(kind) || kind === "drill") && half > 0) {
    const tp = Math.min(Math.max((r - rt) / Math.tan(half), 0), c);
    const pts: Pt[] = [
      [0, r],
      [c - tp, r],
      [c, rt],
      [c, 0],
    ];
    return { pts, radiusAt: (x) => (x <= c - tp ? r : r - ((r - rt) * (x - (c - tp))) / (tp || 1)) };
  }
  if (kind === "thread_mill") {
    // Thread teeth (a sharp 60° form) over the last few pitches, on a relieved neck.
    const p = Math.min(pitch > 0 ? pitch : Math.max(c / 8, 0.2), c);
    const depth = Math.min(0.866 * p, r * 0.6);
    const rn = r - depth;
    const teeth = Math.max(1, Math.min(Math.floor(c / p), 4));
    const t0 = c - teeth * p;
    const pts: Pt[] = [
      [0, rn],
      [t0, rn],
    ];
    for (let k = 0; k < teeth; k++) pts.push([t0 + (k + 0.5) * p, r], [t0 + (k + 1) * p, rn]);
    pts.push([c, 0]);
    return { pts, radiusAt: (x) => (x < t0 ? rn : rn + depth * (1 - Math.abs(((x - t0) % p) / p - 0.5) * 2)), straight: true, cutsFrom: t0 };
  }
  return {
    pts: [
      [0, r],
      [c, r],
      [c, 0],
    ],
    radiusAt: () => r,
  };
}

/**
 * A rougher's serration: a triangle wave of amplitude amp and period p along
 * the axis, applied to the cutting end's full-radius stretches.
 */
function serrate(end: End, r: number, amp: number, p: number): End {
  if (!(p > 0) || !(amp > 0)) return end;
  const rip = (x: number) => {
    const t = x / p + 0.25;
    return amp * (1 - 4 * Math.abs(t - Math.floor(t) - 0.5));
  };
  const full = (pt: Pt) => Math.abs(pt[1] - r) < 1e-9;
  const pts: Pt[] = [];
  end.pts.forEach((pt, i) => {
    pts.push(pt);
    const q = end.pts[i + 1];
    if (q && full(pt) && full(q) && q[0] > pt[0]) {
      for (let x = pt[0] + p / 4; x < q[0] - p / 8; x += p / 2) pts.push([x, r + rip(x)]);
    }
  });
  const radiusAt = end.radiusAt;
  return {
    ...end,
    pts,
    radiusAt: (x) => {
      const rr = radiusAt(x);
      return Math.abs(rr - r) < 1e-9 ? rr + rip(x) : rr;
    },
  };
}

/** A point on the end view's circle of radius rad at angle a (radians, clockwise from 3 o'clock). */
const onEnd = (a: number, rad: number): Pt => [EX + rad * Math.cos(a), EY + rad * Math.sin(a)];
const circlePath = (R: number) => `M${f1(EX - R)},${f1(EY)} A${f1(R)},${f1(R)} 0 1 0 ${f1(EX + R)},${f1(EY)} A${f1(R)},${f1(R)} 0 1 0 ${f1(EX - R)},${f1(EY)} Z`;

/**
 * The end view's silhouette for n flutes: a land (an arc of the rim) then a
 * flute (a concave bite down to the core) per flute, going round in the
 * helix hand.
 */
function bitesPath(n: number, R: number, landFrac: number, core: number, hand: number): string {
  const step = (hand * 2 * Math.PI) / n;
  const land = step * landFrac;
  const sweepLand = hand > 0 ? 1 : 0;
  const sweepBite = 1 - sweepLand;
  let d = "";
  for (let k = 0; k < n; k++) {
    const a0 = -Math.PI / 2 + hand * (Math.PI / 12) + k * step;
    const [tx, ty] = onEnd(a0, R);
    const [lx, ly] = onEnd(a0 + land, R);
    const [nx, ny] = onEnd(a0 + step, R);
    if (!k) d += `M${f1(tx)},${f1(ty)} `;
    d += `A${f1(R)},${f1(R)} 0 ${Math.abs(land) > Math.PI ? 1 : 0} ${sweepLand} ${f1(lx)},${f1(ly)} `;
    // The bite: a minor arc whose deepest point sits on the core, always a visible dent.
    const chord = Math.hypot(nx - lx, ny - ly);
    const sag = Math.min(Math.max(R * Math.cos(Math.abs(step - land) / 2) - core * R, 0.06 * R), chord / 2);
    const ra = ((chord * chord) / 4 + sag * sag) / (2 * sag);
    d += `A${f1(ra)},${f1(ra)} 0 0 ${sweepBite} ${f1(nx)},${f1(ny)} `;
  }
  return `${d}Z`;
}

/**
 * The end view: the cutter seen from its tip, on its own scale. The style
 * sets the hand, a rougher's notched rim and big core, a corn bit's ring of
 * burr teeth. `unknown`: the flute count is a guess, drawn dashed.
 */
function endView(kind: ProfileKind, style: Style | null, n: number, unknown: boolean, r: number, rs: number, tipR: number, cutShade: string): SVGElement {
  const es = ER / Math.max(r, rs);
  // Never a dot: a hairline cutter on a huge shank would have arcs of no size.
  const R = Math.max(r * es, 1.5);
  const g = s("g", unknown ? { class: "endview cutend unk", "stroke-dasharray": "4 3" } : { class: "endview cutend" });
  if (rs > r + 1e-9) g.append(s("circle", { cx: EX, cy: EY, r: rs * es, class: "dim", "stroke-width": ".6" }));
  const hand = style === "Downcut" ? -1 : 1;
  const big = style === "Roughing" || style === "Corn";
  const round = kind === "drill" || conical(kind) || style === "Corn";
  const landFrac = big ? 0.75 : n === 1 ? 0.62 : 0.6;
  const body = round ? circlePath(R) : bitesPath(n, R, landFrac, big ? 0.85 : n === 1 ? 0.5 : 0.6, hand);
  g.append(s("path", { d: body, class: "cutfill", fill: `url(#${cutShade})` }));
  const edge = (d: string, heel = false) => g.append(s("path", { d, class: heel ? "edge heel" : "edge" }));
  // The first flute sits 15° past twelve o'clock, so a two-flute's end teeth don't hide the centreline.
  const tips = Array.from({ length: n }, (_, k) => -Math.PI / 2 + hand * (Math.PI / 12 + (k * 2 * Math.PI) / n));
  if (kind === "drill") {
    // Two lips from a short chisel edge through the centre to the rim, a flute gully ahead of each.
    const c = 0.085 * R;
    const q: Pt[] = [
      [0, -0.46 * R],
      [0, 0.46 * R],
    ];
    for (const sign of [1, -1]) {
      const [cx, cy] = [EX - sign * c, EY - sign * c];
      const [lx, ly] = onEnd(sign > 0 ? Math.PI + (15 * Math.PI) / 180 : (15 * Math.PI) / 180, R);
      const [ax, ay] = onEnd(sign > 0 ? Math.PI + (110 * Math.PI) / 180 : (110 * Math.PI) / 180, R);
      const [qx, qy] = sign > 0 ? q[0] : q[1];
      g.append(s("path", { d: `M${f1(cx)},${f1(cy)} L${f1(lx)},${f1(ly)} A${f1(R)},${f1(R)} 0 0 1 ${f1(ax)},${f1(ay)} Q${f1(EX + qx)},${f1(EY + qy)} ${f1(cx)},${f1(cy)} Z`, class: "gully" }));
      edge(`M${f1(ax)},${f1(ay)} Q${f1(EX + qx)},${f1(EY + qy)} ${f1(cx)},${f1(cy)}`, true);
      edge(`M${f1(cx)},${f1(cy)} L${f1(lx)},${f1(ly)}`);
    }
    edge(`M${f1(EX - c)},${f1(EY - c)} L${f1(EX + c)},${f1(EY + c)}`);
  } else if (conical(kind)) {
    // The tip's flat (or point, never under 3 px so it reads) inside the rim, a faint ring halfway, and straight flutes.
    const rt = Math.min(Math.max(tipR * es, 3), R);
    g.append(s("circle", { cx: EX, cy: EY, r: rt, class: "edge" }));
    if (R > rt + 8) g.append(s("circle", { cx: EX, cy: EY, r: (R + rt) / 2, class: "edge heel" }));
    for (const a of tips) {
      const [x1, y1] = onEnd(a, rt);
      const [x2, y2] = onEnd(a, R);
      edge(`M${f1(x1)},${f1(y1)} L${f1(x2)},${f1(y2)}`);
    }
  } else if (style === "Corn") {
    // A ring of fine burr teeth on a big core.
    g.append(s("circle", { cx: EX, cy: EY, r: R - 1, class: "teeth", "stroke-width": "2", "stroke-dasharray": "1.7 1.7" }));
    g.append(s("circle", { cx: EX, cy: EY, r: R * 0.88, class: "teeth", "stroke-width": f1(Math.max(R * 0.12, 1)), "stroke-dasharray": ".5 2.3", opacity: ".55" }));
    g.append(s("circle", { cx: EX, cy: EY, r: R * 0.8, class: "edge" }));
  } else {
    // End teeth from the centre (a thread mill's hollow centre) to each flute's cutting edge.
    const inner = kind === "thread_mill" ? 0.3 * R : 0;
    if (inner) g.append(s("circle", { cx: EX, cy: EY, r: inner, class: "edge heel" }));
    for (const a of tips) {
      const [x1, y1] = onEnd(a, inner);
      const [x2, y2] = onEnd(a, R);
      if (kind === "ball_end") {
        const [qx, qy] = onEnd(a + hand * 0.5, 0.45 * R);
        edge(`M${f1(x2)},${f1(y2)} Q${f1(qx)},${f1(qy)} ${f1(x1)},${f1(y1)}`);
      } else edge(`M${f1(x1)},${f1(y1)} L${f1(x2)},${f1(y2)}`);
    }
    if (style === "Roughing") {
      // Notches along the lands.
      const step = (hand * 2 * Math.PI) / n;
      const land = step * landFrac;
      const rr = R - 1.2;
      const d = tips
        .map((a) => {
          const [x1, y1] = onEnd(a, rr);
          const [x2, y2] = onEnd(a + land, rr);
          return `M${f1(x1)},${f1(y1)} A${f1(rr)},${f1(rr)} 0 0 ${hand > 0 ? 1 : 0} ${f1(x2)},${f1(y2)}`;
        })
        .join(" ");
      g.append(s("path", { d, class: "teeth", "stroke-width": "2.4", "stroke-dasharray": "1.5 2.5", opacity: ".8" }));
    }
  }
  g.append(s("path", { d: body, class: "cutline" }));
  return g;
}

/**
 * Draws a tool. Returns the drawing and the style word it was drawn in, or
 * null for a plain cutter.
 */
export function profile(kind: ProfileKind, geo: ProfileGeometry, name: string, styleText: string | undefined): { svg: SVGElement; style: Style | null } {
  const W = 640;
  const H = 180;
  const style = matchStyle(styleText);
  // A draft value can be anything a number parses to; anything not finite and positive is unknown.
  const g = Object.fromEntries(Object.entries(geo).map(([k, v]) => [k, Number.isFinite(v) && v > 0 ? v : 0])) as unknown as ProfileGeometry;
  const d = g.diameter > 0 ? g.diameter : 1;
  const ds = g.shankDiameter > 0 ? g.shankDiameter : d;
  const fl = g.fluteLength;
  const tipD = Math.min(g.tipDiameter, d);
  const half = g.tipAngle > 0 && g.tipAngle < 180 ? ((g.tipAngle / 2) * Math.PI) / 180 : 0;
  const tapered = kind === "v_bit" || kind === "drill";
  const rounding = kind === "corner_round" && g.cornerRadius > 0;
  const taper = rounding ? g.cornerRadius : tapered && half > 0 ? Math.max((d - tipD) / 2 / Math.tan(half), 0) : 0;
  const lengthKnown = g.length > 0;
  const L = lengthKnown ? g.length : Math.max(fl * 2.5, taper * 3, 40);
  // Unknown flute length: a V-bit is drawn as just its cone, other tools with a nominal length.
  const guess = conical(kind) && taper > 0 ? taper : Math.max(taper, Math.min(L * 0.3, 15));
  const cutLen = Math.min(fl || guess, L * 0.9);
  const sc = Math.min((SIDE_W - 110) / L, 92 / Math.max(d, ds));
  const x0 = 40;
  const cy = 84;
  const xe = x0 + L * sc;
  const xf = xe - cutLen * sc;
  const fluteUnknown = !fl;
  const r = d / 2;
  const rs = ds / 2;

  // The outline's upper half, in mm from the shank end: back chamfer, shank, step or taper, cutting end.
  let end = cuttingEnd(kind, cutLen, r, tipD / 2, half, g.pitch, g.cornerRadius);
  // A rougher: a fine serration along the cutting end, in the silhouette and the flute edges.
  const ripP = Math.max(0.12 * d, cutLen / 160);
  if (style === "Roughing") end = serrate(end, r, Math.max(1 / sc, 0.04 * r), ripP);
  const neckR = end.pts[0][1];
  const cutStart = L - cutLen;
  // A shoulder past the flutes: a relieved neck, a touch under the cutting diameter, from the shoulder to the flutes.
  const sh = g.shoulderLength;
  const neckLen = fl > 0 && sh > fl && L - sh >= 2 ? sh - cutLen : 0;
  const rn = neckLen > 0 ? Math.min(neckR, Math.max(r - Math.max(0.05 * d, 0.1, 2 / sc), 0.5 * r)) : neckR;
  const neckStart = cutStart - neckLen;
  const trans = rs > rn ? Math.min((rs - rn) / Math.tan(NECK_TAPER), neckStart * 0.5) : Math.min((rn - rs) * 0.4, neckStart * 0.2);
  const shankEnd = neckStart - trans;
  const cham = Math.min(rs * 0.2, 0.5, shankEnd);
  // The shank part of the outline (nb points), then the cutting end's own.
  const base: Pt[] = [[0, rs - cham], [cham, rs], [shankEnd, rs], ...(neckLen > 0 ? ([[neckStart, rn], [cutStart, rn]] as Pt[]) : [])];
  const nb = base.length;
  const top: Pt[] = [...base, ...end.pts.map(([x, y]): Pt => [cutStart + x, y])];
  const X = (mm: number) => x0 + mm * sc;
  const upper = top.map(([x, y]): Pt => [X(x), cy - y * sc]);
  const lower = top
    .slice()
    .reverse()
    .map(([x, y]): Pt => [X(x), cy + y * sc]);

  const arr = `arr-${++seq}`;
  const clipId = `cut-${seq}`;
  const shade = `shade-${seq}`;
  const cutShade = `cutshade-${seq}`;
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `Side profile and end view of ${name}` });
  const defs = s("defs");
  const marker = s("marker", { id: arr, viewBox: "0 0 8 8", refX: "4", refY: "4", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse" });
  marker.append(s("path", { d: "M0,1 L7,4 L0,7", class: "dm" }));
  const clip = s("clipPath", { id: clipId });
  const cutOutline: Pt[] = [...upper.slice(nb), ...lower.slice(0, lower.length - nb), [X(cutStart), cy + neckR * sc]];
  clip.append(s("path", { d: `${pathOf([[X(cutStart), cy - neckR * sc], ...cutOutline])} Z` }));
  // Round stock shading, light along the upper third.
  const gradient = (id: string, cls: string) => {
    const gr = s("linearGradient", { id, x1: "0", y1: "0", x2: "0", y2: "1", class: cls });
    for (const [off, c] of [
      ["0", "g0"],
      ["0.32", "g1"],
      ["1", "g2"],
    ])
      gr.append(s("stop", { offset: off, class: c }));
    return gr;
  };
  defs.append(marker, clip, gradient(shade, "shade"), gradient(cutShade, "cutshade"));
  svg.append(defs);

  // The axis: through the side view, and on through the end view's centre, which a second one crosses.
  svg.append(s("line", { x1: x0 - 12, y1: cy, x2: xe + 5, y2: cy, class: "cl" }));
  svg.append(s("line", { x1: EX - 139, y1: EY, x2: EX + 61, y2: EY, class: "cl" }));
  svg.append(s("line", { x1: EX, y1: EY - 62, x2: EX, y2: EY + 62, class: "cl" }));
  // The whole body filled as round stock; only the shank part is outlined here, so the cutting
  // end's own outline (dashed while its length is unknown) has nothing solid under it.
  svg.append(s("path", { d: `${pathOf([...upper, ...lower])} Z`, class: "shank", fill: `url(#${shade})` }));
  const m = lower.length;
  svg.append(s("path", { d: pathOf([...upper.slice(0, nb + 1).reverse(), ...lower.slice(m - nb - 1).reverse()]), class: "outline" }));
  // A PCB bit's depth-stop ring on its shank.
  if (style === "PCB" && shankEnd > 0) {
    const w = Math.max(4, 3 * sc);
    const hgt = 1.35 * ds * sc;
    const cx = Math.max(x0 + w / 2 + 2, X(shankEnd * 0.25));
    const y1 = cy - hgt / 2;
    const y2 = cy + hgt / 2;
    const ring: Pt[] = [
      [cx - w / 2, y1],
      [cx + w / 2, y1],
      [cx + w / 2, y2],
      [cx - w / 2, y2],
    ];
    svg.append(s("path", { d: `${pathOf(ring)} Z`, class: "shank collar", fill: `url(#${shade})` }));
    svg.append(s("path", { d: `${pathOf(ring)} Z`, class: "outline" }));
  }

  // The cutting end: its own fill, the flutes, then the outline on top.
  const cut = s("g", { "clip-path": `url(#${clipId})`, class: fluteUnknown ? "cutend unk" : "cutend" });
  // A thread mill cuts only with its teeth: its relieved neck is drawn like the shank.
  const from = end.cutsFrom || 0;
  cut.append(s("rect", { x: X(cutStart + from), y: cy - r * sc - 1, width: (cutLen - from) * sc + 2, height: d * sc + 2, class: "cutfill", fill: `url(#${cutShade})` }));
  const flutesKnown = g.flutes > 0;
  const n = Math.max(1, Math.min(Math.round(g.flutes) || 2, 6));
  if (style === "Corn") {
    // Burr teeth: two families of fine hairlines crossing at ±30°, over the cutting length.
    const hgt = d * sc;
    const run = hgt / Math.tan(HELIX);
    const step = Math.max(3, 0.18 * d * sc);
    const xa = X(cutStart + from);
    const xb = X(cutStart + cutLen);
    const yt = cy - r * sc;
    const yb = cy + r * sc;
    for (const down of [true, false]) {
      let dd = "";
      for (let x = xa - run; x < xb; x += step) dd += `M${f1(x)},${f1(down ? yt : yb)} L${f1(x + run)},${f1(down ? yb : yt)} `;
      cut.append(s("path", { d: dd.trim(), class: "edge heel" }));
    }
  } else {
    const helical = !end.straight && !conical(kind) && style !== "Straight";
    const lead = helical ? (Math.PI * d) / Math.tan(HELIX) : Infinity;
    // The hand: a downcut's helix runs the other way; a compression cutter's turns at the tip third.
    const hand = style === "Downcut" ? -1 : 1;
    const xComp = from + ((cutLen - from) * 2) / 3;
    const turn = style === "Compression" ? (xm: number) => (xm <= xComp ? xm : 2 * xComp - xm) : (xm: number) => hand * xm;
    const gully = Math.min((0.3 * 2 * Math.PI) / n, Math.PI * 0.45);
    // A serrated edge is sampled at least four times per tooth so it doesn't alias into noise.
    const steps = style === "Roughing" ? Math.max(240, Math.ceil((4 * cutLen) / ripP)) : 90;
    for (let k = 0; k < n; k++) {
      const phase = (2 * Math.PI * k) / n + 0.35;
      let band: [Pt, Pt][] = [];
      const flush = () => {
        if (band.length > 1) {
          cut.append(s("path", { d: `${pathOf([...band.map((b) => b[0]), ...band.slice().reverse().map((b) => b[1])])} Z`, class: "gully" }));
          cut.append(s("path", { d: pathOf(band.map((b) => b[0])), class: "edge" }));
          cut.append(s("path", { d: pathOf(band.map((b) => b[1])), class: "edge heel" }));
        }
        band = [];
      };
      for (let i = 0; i <= steps; i++) {
        const xm = from + ((cutLen - from) * i) / steps;
        const rr = end.radiusAt(xm);
        const th = (((phase + (2 * Math.PI * turn(xm)) / lead) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        // The visible (front) half is 0..π; a band just past 2π re-enters at the top silhouette.
        let lo: number;
        let hi: number;
        if (th <= Math.PI) {
          lo = th;
          hi = Math.min(th + gully, Math.PI);
        } else if (th + gully > 2 * Math.PI) {
          lo = 0;
          hi = th + gully - 2 * Math.PI;
        } else {
          flush();
          continue;
        }
        const px = X(cutStart + xm);
        band.push([
          [px, cy - rr * sc * Math.cos(lo)],
          [px, cy - rr * sc * Math.cos(hi)],
        ]);
      }
      flush();
    }
    if (style === "Compression" && helical) {
      const xc = X(cutStart + xComp);
      cut.append(s("path", { d: `M${f1(xc)},${f1(cy - r * sc)} L${f1(xc)},${f1(cy + r * sc)}`, class: "edge heel" }));
    }
  }
  svg.append(cut);
  const cutAttrs: Record<string, string> = { d: `M${X(cutStart).toFixed(1)},${(cy - neckR * sc).toFixed(1)} ${pathOf(cutOutline).replace(/^M/, "L")}`, class: "cutline" };
  if (fluteUnknown) cutAttrs["stroke-dasharray"] = "4 3";
  svg.append(s("path", cutAttrs));

  svg.append(endView(kind, style, n, !flutesKnown, r, rs, tipD / 2, cutShade));

  const rmax = Math.max(d, ds) / 2;
  const yb = cy + rmax * sc + 22;
  dimLine(svg, x0, xe, yb, !lengthKnown, arr);
  svg.append(s("text", { x: (x0 + xe) / 2, y: yb - 4, "text-anchor": "middle", class: lengthKnown ? "dl" : "dl unk" }, lengthKnown ? `L ${num(g.length)}` : "L unknown"));
  const yt = cy - rmax * sc - 14;
  dimLine(svg, xf, xe, yt, fluteUnknown, arr);
  // Over a short cutting end (a chamfer cone) the label ends at the tip instead of overhanging it.
  const narrow = xe - xf < 120;
  svg.append(
    s("text", { x: narrow ? xe : (xf + xe) / 2, y: yt - 4, "text-anchor": narrow ? "end" : "middle", class: fluteUnknown ? "dl unk" : "dl" }, fluteUnknown ? "flute length unknown" : `LC ${num(fl)}`),
  );
  svg.append(s("text", { x: x0 + 4, y: yt - 4, class: "dl" }, `shank Ø${num(ds)}`));
  svg.append(s("text", { x: xe + 8, y: cy + 4, class: "dl" }, `Ø${num(g.diameter)}`));

  return { svg, style };
}
