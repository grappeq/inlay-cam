import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { PocketPreview } from "../core/types";
import { dimensionMarks, edgeMarks, pathReach, surfaceHit, type Mark, type Vec3 } from "./dimensions";

/** Most vertices per side of the displayed surface; finer height maps are thinned for display only. */
const MAX_DISPLAY = 600;

/** The wood's colour when none is given. */
const WOOD = "#dcbd8e";

/** Numbers per straight piece of the tool path: x0 y0 z0 x1 y1 z1 rapid tool line. */
const PIECE = 9;
/** Colours of the cutting moves, by the order the tools are loaded. Chosen to stand out from wood. */
const TOOL_COLORS = ["#1f6f8b", "#7a3fb0", "#1d8a4c", "#c2188b"];
const RAPID_COLOR = "#c0392b";
/** Moves above this height are drawn at it: the descent from the tool-change height would dwarf the model. */
const CEILING = 15;

function toolColor(index: number): string {
  return TOOL_COLORS[index % TOOL_COLORS.length];
}

/** The tool path as drawn: one set of lines per tool, one for the rapids, and a marker for the tool. */
interface PathView {
  group: THREE.Group;
  /** Each set of lines with the positions its pieces have in the file's order. */
  sets: { lines: THREE.LineSegments; order: number[]; rapid: boolean }[];
  marker: THREE.Mesh;
}

/** The dimensions as drawn: lines in the scene, and where each label stands. */
interface DimensionView {
  group: THREE.Group;
  labels: { at: THREE.Vector3; text: string; tone?: "x" | "y" | "z" | "quiet" }[];
}

/** Where the camera was left, kept by whoever shows the view so that it stays there when what is shown changes. */
export interface KeptCamera {
  position?: [number, number, number];
  target?: [number, number, number];
}

interface Props {
  preview: PocketPreview;
  /** Thickness of the stock, mm, for drawing its sides. */
  thickness: number;
  /** The colour of the wood, as #rrggbb. */
  color?: string;
  /** Whose wood each cell is in: 0 for the board's own, else an index into `colors`. Without it the board is one wood. */
  owners?: Uint8Array;
  /**
   * With `owners`, for the cells that are in glued-in wood: the height of that wood's underside, and of the surface it was put on. The wood is then
   * drawn as a body of its own, standing off the board where it does.
   */
  below?: { unders: Float32Array; floors: Float32Array };
  /** The colours `owners` points into, as #rrggbb. */
  colors?: string[];
  /** Filled in as the camera is moved, and read when the view is set up again. */
  keepCamera?: KeptCamera;
  /** The cell size the heights were simulated at, when they were thinned before they got here. */
  simulatedCell?: number;
}

/** The simulated stock in 3D, with the tool path as an optional overlay. */
export function Viewer3D({ preview, thickness, color = WOOD, owners, below, colors, keepCamera, simulatedCell }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const pathView = useRef<PathView | null>(null);
  const stockGroup = useRef<THREE.Group | null>(null);
  const redraw = useRef<() => void>(() => {});
  const dimensions = useRef<{ group: THREE.Group; labels: HTMLElement } | null>(null);
  // Draws the lines from the edges to the tool path; none for an empty list.
  const edges = useRef<(marks: Mark[]) => void>(() => {});
  const [showDimensions, setShowDimensions] = useState(false);
  // Read by the pointer handler, which outlives a change of the tick box.
  const dimensionsOn = useRef(false);
  const [showPath, setShowPath] = useState(false);
  const [hideBoard, setHideBoard] = useState(false);
  const [showRapids, setShowRapids] = useState(true);
  // How many moves of the file are drawn; null for all of them.
  const [upTo, setUpTo] = useState<number | null>(null);

  // Another file's path starts whole.
  useEffect(() => setUpTo(null), [preview.path]);

  const count = preview.path.length / PIECE;
  const shownMoves = upTo === null ? count : Math.min(upTo, count);
  // The tools in the order the file loads them, with the colour of their moves.
  const tools = useMemo(() => {
    const numbers: number[] = [];
    for (let i = 0; i < preview.path.length; i += PIECE) {
      const tool = preview.path[i + 7];
      if (!numbers.includes(tool)) numbers.push(tool);
    }
    return numbers.map((number, index) => ({
      number,
      name: preview.built.stats.perTool.find((t) => t.number === number)?.name ?? "",
      color: toolColor(index),
    }));
  }, [preview]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7a66, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    scene.add(sun);

    const width = preview.nx * preview.cell;
    const depth = preview.ny * preview.cell;
    const centre = new THREE.Vector3(width / 2, depth / 2, 0);
    const reach = Math.max(width, depth);
    sun.position.set(centre.x - reach, centre.y - reach * 0.6, reach * 1.2);

    const camera = new THREE.PerspectiveCamera(35, 1, reach / 100, reach * 20);
    camera.up.set(0, 0, 1);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(centre);
    // Until the user takes the camera, keep the whole board in view at any pane shape.
    let userMoved = false;
    controls.addEventListener("start", () => (userMoved = true));
    if (keepCamera?.position && keepCamera.target) {
      camera.position.set(...keepCamera.position);
      controls.target.set(...keepCamera.target);
      controls.update();
      userMoved = true;
    }
    controls.addEventListener("change", () => {
      if (!keepCamera || !userMoved) return;
      keepCamera.position = camera.position.toArray();
      keepCamera.target = controls.target.toArray();
    });
    const frame = () => {
      const vertical = THREE.MathUtils.degToRad(camera.fov) / 2;
      const horizontal = Math.atan(Math.tan(vertical) * camera.aspect);
      const distance = Math.max(width / 2 / Math.tan(horizontal), depth / 2 / Math.tan(vertical)) * 1.2;
      const from = new THREE.Vector3(0, -0.77, 0.64).multiplyScalar(distance);
      camera.position.copy(centre).add(from);
      controls.update();
    };

    const stock = buildStock(preview, thickness, color, owners, colors, below);
    scene.add(stock);
    stockGroup.current = stock;
    const path = buildPath(preview, reach);
    path.group.visible = false;
    scene.add(path.group);
    pathView.current = path;

    // Dimensions: lines in the scene, with labels laid over the canvas so that they stay upright.
    const dims = buildDimensions(preview, reach, getComputedStyle(el).color);
    dims.group.visible = dimensionsOn.current;
    scene.add(dims.group);
    const overlay = document.createElement("div");
    overlay.className = "dim-labels";
    overlay.style.display = dimensionsOn.current ? "" : "none";
    el.appendChild(overlay);
    const tags: { tag: HTMLElement; at: THREE.Vector3; off?: boolean }[] = dims.labels.map((label) => {
      const tag = document.createElement("span");
      tag.className = `dim-label${label.tone ? ` ${label.tone}` : ""}`;
      tag.textContent = label.text;
      overlay.appendChild(tag);
      return { tag, at: label.at };
    });

    // From the edges to the tool path: lines and labels of their own, set as the path shown changes.
    const edgeLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: getComputedStyle(el).color, depthTest: false, transparent: true }));
    edgeLines.renderOrder = 5;
    edgeLines.visible = false;
    scene.add(edgeLines);
    const edgeTags = [0, 1, 2, 3].map(() => {
      const tag = document.createElement("span");
      tag.className = "dim-label";
      overlay.appendChild(tag);
      const entry = { tag, at: new THREE.Vector3(), off: true };
      tags.push(entry);
      return entry;
    });
    edges.current = (marks) => {
      const points: number[] = [];
      edgeTags.forEach((entry, i) => {
        const mark = marks[i];
        entry.off = !mark;
        if (!mark) return;
        entry.tag.textContent = mark.text;
        entry.at.copy(surfaceLine(points, mark, reach * 0.07, i % 2 ? -1 : 1));
      });
      edgeLines.geometry.dispose();
      edgeLines.geometry = new THREE.BufferGeometry();
      edgeLines.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(points), 3));
      edgeLines.visible = points.length > 0;
    };
    const readout = document.createElement("span");
    readout.className = "dim-label readout";
    readout.style.display = "none";
    overlay.appendChild(readout);
    dimensions.current = { group: dims.group, labels: overlay };

    const seen = new THREE.Vector3();
    const placeLabels = () => {
      if (!dimensionsOn.current) return;
      const { clientWidth: w, clientHeight: h } = el;
      for (const { tag, at, off } of tags) {
        seen.copy(at).project(camera);
        const inFront = !off && seen.z > -1 && seen.z < 1;
        tag.style.display = inFront ? "" : "none";
        if (inFront) tag.style.transform = `translate(${((seen.x + 1) / 2) * w}px, ${((1 - seen.y) / 2) * h}px) translate(-50%, -50%)`;
      }
    };
    const render = () => {
      renderer.render(scene, camera);
      placeLabels();
    };
    redraw.current = render;
    controls.addEventListener("change", render);

    // The point of the simulated surface under the cursor, while no button is held.
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const onMove = (e: PointerEvent) => {
      readout.style.display = "none";
      if (!dimensionsOn.current || e.buttons !== 0) return;
      const box = renderer.domElement.getBoundingClientRect();
      pointer.set(((e.clientX - box.left) / box.width) * 2 - 1, 1 - ((e.clientY - box.top) / box.height) * 2);
      raycaster.setFromCamera(pointer, camera);
      const { origin, direction } = raycaster.ray;
      const hit = surfaceHit(preview, origin.toArray() as Vec3, direction.toArray() as Vec3);
      if (!hit) return;
      readout.textContent = `X ${hit.x.toFixed(1)}   Y ${hit.y.toFixed(1)}   Z ${hit.z === 0 ? "0, surface" : hit.z.toFixed(2)}`;
      // Beside the cursor, flipped to its other side near the right and bottom edges.
      const [x, y] = [e.clientX - box.left, e.clientY - box.top];
      const flipX = x > box.width - 190 ? "translate(-100%, 0) translate(-14px, 0)" : "translate(14px, 0)";
      const flipY = y > box.height - 50 ? "translate(0, -100%) translate(0, -10px)" : "translate(0, 16px)";
      readout.style.transform = `translate(${x}px, ${y}px) ${flipX} ${flipY}`;
      readout.style.display = "";
    };
    const onLeave = () => (readout.style.display = "none");
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerdown", onLeave);
    el.addEventListener("pointerleave", onLeave);

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = el;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      if (!userMoved) frame();
      render();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    resize();

    return () => {
      observer.disconnect();
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerdown", onLeave);
      el.removeEventListener("pointerleave", onLeave);
      overlay.remove();
      dimensions.current = null;
      edges.current = () => {};
      controls.dispose();
      scene.traverse((object) => {
        const item = object as THREE.Mesh | THREE.LineSegments;
        item.geometry?.dispose();
        const material = item.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material?.dispose();
      });
      renderer.dispose();
      renderer.domElement.remove();
      pathView.current = null;
      stockGroup.current = null;
    };
  }, [preview, thickness, color, owners, below, colors, keepCamera]);

  useEffect(() => {
    const path = pathView.current;
    if (path) {
      path.group.visible = showPath;
      for (const set of path.sets) {
        set.lines.visible = !set.rapid || showRapids;
        // The pieces of this set that come before the last move shown.
        let n = 0;
        while (n < set.order.length && set.order[n] < shownMoves) n++;
        set.lines.geometry.setDrawRange(0, n * 2);
      }
      // The tool stands where the last move shown ends.
      path.marker.visible = shownMoves > 0 && shownMoves < count;
      if (path.marker.visible) {
        const i = (shownMoves - 1) * PIECE;
        path.marker.position.set(preview.path[i + 3], preview.path[i + 4], Math.min(preview.path[i + 5], CEILING));
      }
    }
    if (stockGroup.current) stockGroup.current.visible = !(showPath && hideBoard);
    // With the path and the dimensions both shown: how close the moves drawn cut to each edge.
    edges.current(showPath && showDimensions ? edgeMarks(preview.built.stock, pathReach(preview.path, preview.built.stats.perTool, shownMoves)) : []);
    redraw.current();
  }, [showPath, showDimensions, hideBoard, showRapids, shownMoves, count, preview, thickness, color, owners, below, colors, keepCamera]);

  useEffect(() => {
    dimensionsOn.current = showDimensions;
    const view = dimensions.current;
    if (view) {
      view.group.visible = showDimensions;
      view.labels.style.display = showDimensions ? "" : "none";
    }
    redraw.current();
  }, [showDimensions, preview, thickness]);

  const last = shownMoves > 0 ? (shownMoves - 1) * PIECE : -1;
  const lastTool = last >= 0 ? tools.find((t) => t.number === preview.path[last + 7]) : undefined;

  return (
    <div className="viewer">
      <div className="viewer-bar">
        <label className="check">
          <input type="checkbox" checked={showDimensions} onChange={(e) => setShowDimensions(e.target.checked)} />
          Show dimensions
        </label>
        <label className="check">
          <input type="checkbox" checked={showPath} onChange={(e) => setShowPath(e.target.checked)} />
          Show tool path
        </label>
        {showPath && (
          <>
            <label className="check">
              <input type="checkbox" checked={hideBoard} onChange={(e) => setHideBoard(e.target.checked)} />
              Hide the board
            </label>
            <label className="check">
              <input type="checkbox" checked={showRapids} onChange={(e) => setShowRapids(e.target.checked)} />
              Moves in the air
            </label>
            <ul className="path-legend" aria-label="Colours of the tool path">
              {tools.map((t) => (
                <li key={t.number}>
                  <span className="swatch" style={{ background: t.color }} />T{t.number} {t.name}
                </li>
              ))}
              {showRapids && (
                <li>
                  <span className="swatch" style={{ background: RAPID_COLOR }} />
                  In the air
                </li>
              )}
            </ul>
          </>
        )}
      </div>
      <div className="viewer-canvas" ref={host} role="img" aria-label="3D preview of the base board after cutting" />
      {showPath && count > 0 && (
        <div className="viewer-bar path-progress">
          <label htmlFor="path-up-to">Path shown</label>
          <input
            id="path-up-to"
            type="range"
            min={0}
            max={count}
            step={1}
            value={shownMoves}
            onChange={(e) => setUpTo(Number(e.target.value) >= count ? null : Number(e.target.value))}
            aria-valuetext={shownMoves >= count ? "the whole file" : `up to line ${last >= 0 ? preview.path[last + 8] : 0}`}
          />
          <span className="path-where" role="status">
            {shownMoves >= count
              ? "the whole file"
              : last < 0
                ? "nothing yet"
                : `up to line ${preview.path[last + 8]} of ${preview.built.stats.lines}${lastTool ? `, T${lastTool.number} ${lastTool.name}` : ""}`}
          </span>
          <span className="muted">The arrow keys step one move at a time.</span>
        </div>
      )}
      <p className="viewer-hint muted">
        Drag to turn, scroll to zoom, right-drag to move. Simulated at {simulatedCell ?? preview.cell} mm per cell from the G-code file{simulatedCell ? "s" : ""}.
        {showDimensions && " Dimensions are in mm; point at the board to read a position and its depth."}
      </p>
    </div>
  );
}

/**
 * Adds a dimension line on the board's surface to `points`: the line, with a
 * short stroke across each end. Returns where its label stands, on the given
 * side of it (1 or -1).
 */
function surfaceLine(points: number[], mark: Mark, gap: number, side: number): THREE.Vector3 {
  const [a, b] = [new THREE.Vector3(...mark.a), new THREE.Vector3(...mark.b)];
  const along = b.clone().sub(a).normalize();
  const across = new THREE.Vector3(-along.y, along.x, 0).multiplyScalar(gap * 0.18);
  for (const [from, to] of [
    [a, b],
    [a.clone().add(across), a.clone().sub(across)],
    [b.clone().add(across), b.clone().sub(across)],
  ]) {
    points.push(from.x, from.y, from.z, to.x, to.y, to.z);
  }
  return a.clone().add(b).multiplyScalar(0.5).addScaledVector(across, side * 3.2);
}

const AXIS_COLORS ={ x: "#c0392b", y: "#1d8a4c", z: "#2f5fd0" } as const;

/**
 * The dimension lines of the part and the axes at the work origin. Drawn over
 * everything else, so that the wood never hides them.
 */
function buildDimensions(preview: PocketPreview, reach: number, ink: string): DimensionView {
  const { marks, outlines } = dimensionMarks(preview.built);
  const gap = reach * 0.07;
  const points: number[] = [];
  const labels: DimensionView["labels"] = [];
  const v = (p: Vec3) => new THREE.Vector3(...p);
  const segment = (a: THREE.Vector3, b: THREE.Vector3) => points.push(a.x, a.y, a.z, b.x, b.y, b.z);

  // Neighbouring lines on the surface are often short: their labels go to alternate sides, so they do not sit on each other.
  let side = 1;
  for (const mark of marks) {
    const [a, b, out] = [v(mark.a), v(mark.b), v(mark.out)];
    if (out.lengthSq() > 0) {
      // Clear of the board: the line stands off by the gap, joined to what it measures by two thin lines.
      const [from, to] = [a.clone().addScaledVector(out, gap), b.clone().addScaledVector(out, gap)];
      segment(from, to);
      for (const end of [a, b]) segment(end.clone().addScaledVector(out, gap * 0.2), end.clone().addScaledVector(out, gap * 1.2));
      labels.push({ at: from.clone().add(to).multiplyScalar(0.5).addScaledVector(out, gap * 0.45), text: mark.text });
    } else {
      labels.push({ at: surfaceLine(points, mark, gap, side), text: mark.text });
      side = -side;
    }
  }
  for (const { rect, text, labelInside } of outlines) {
    const [x0, y0, x1, y1] = rect;
    const corners = [v([x0, y0, 0]), v([x1, y0, 0]), v([x1, y1, 0]), v([x0, y1, 0])];
    corners.forEach((corner, i) => segment(corner, corners[(i + 1) % 4]));
    labels.push({ at: v([(x0 + x1) / 2, y1 + (labelInside ? -1 : 1) * gap * 0.55, 0]), text, tone: "quiet" });
  }

  const group = new THREE.Group();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(points), 3));
  const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: ink, depthTest: false, transparent: true }));
  lines.renderOrder = 5;
  group.add(lines);

  // The work origin: the board's bottom-left corner, on its top face.
  const length = reach * 0.16;
  const axes: [keyof typeof AXIS_COLORS, Vec3][] = [
    ["x", [1, 0, 0]],
    ["y", [0, 1, 0]],
    ["z", [0, 0, 1]],
  ];
  for (const [name, direction] of axes) {
    const arrow = new THREE.ArrowHelper(v(direction), new THREE.Vector3(0, 0, 0), length, AXIS_COLORS[name], length * 0.22, length * 0.1);
    for (const part of [arrow.line, arrow.cone]) {
      const material = part.material as THREE.Material;
      material.depthTest = false;
      material.transparent = true;
      part.renderOrder = 6;
    }
    group.add(arrow);
    labels.push({ at: v(direction).multiplyScalar(length * 1.12), text: name.toUpperCase(), tone: name });
  }
  labels.push({ at: new THREE.Vector3(-gap * 0.5, -gap * 0.5, 0), text: "X0 Y0 Z0", tone: "quiet" });
  return { group, labels };
}

/** The cut surface plus the four sides of the board. */
function buildStock(
  preview: PocketPreview,
  thickness: number,
  color: string,
  owners?: Uint8Array,
  palette?: string[],
  below?: { unders: Float32Array; floors: Float32Array },
): THREE.Group {
  // Cut surfaces are drawn darker the deeper they lie; the sides a shade darker than the top.
  const top = new THREE.Color(color);
  const side = top.clone().multiplyScalar(0.82);
  // Each wood, and the same wood deep in a cut.
  const woods = (palette && palette.length > 0 ? palette : [color]).map((c, i) => (i === 0 ? top : new THREE.Color(c)));
  const deeps = woods.map((w) => w.clone().multiplyScalar(0.45));
  const { nx, ny, cell, heights } = preview;
  const step = Math.max(1, Math.ceil(Math.max(nx, ny) / MAX_DISPLAY));
  const dx = Math.ceil(nx / step);
  const dy = Math.ceil(ny / step);

  // When thinning, keep the deepest cell of each block so narrow cuts stay visible.
  const z = new Float32Array(dx * dy);
  const wood = new Uint8Array(dx * dy);
  // Under glued-in wood: its underside, and the surface it was put on.
  const under = new Float32Array(dx * dy).fill(NaN);
  const floor = new Float32Array(dx * dy).fill(NaN);
  let lowest = 0;
  for (let j = 0; j < dy; j++) {
    for (let i = 0; i < dx; i++) {
      let min = Infinity;
      for (let jj = j * step; jj < Math.min(ny, (j + 1) * step); jj++) {
        for (let ii = i * step; ii < Math.min(nx, (i + 1) * step); ii++) {
          const h = heights[jj * nx + ii];
          if (h < min) {
            min = h;
            if (owners) wood[j * dx + i] = owners[jj * nx + ii] < woods.length ? owners[jj * nx + ii] : 0;
            if (below) {
              under[j * dx + i] = below.unders[jj * nx + ii];
              floor[j * dx + i] = below.floors[jj * nx + ii];
            }
          }
        }
      }
      z[j * dx + i] = min;
      if (min < lowest) lowest = min;
    }
  }
  const xAt = (i: number) => Math.min(nx * cell, (i + 0.5) * step * cell);
  const yAt = (j: number) => Math.min(ny * cell, (j + 0.5) * step * cell);

  const bodies = below !== undefined && wood.some((w) => w > 0);
  const positions = new Float32Array(dx * dy * 3);
  const colors = new Float32Array(dx * dy * 3);
  const colour = new THREE.Color();
  for (let j = 0; j < dy; j++) {
    for (let i = 0; i < dx; i++) {
      const k = j * dx + i;
      // With glued-in wood drawn as bodies of its own, the board is what lies under it.
      const lifted = bodies && wood[k] > 0 && !Number.isNaN(floor[k]);
      const height = lifted ? floor[k] : z[k];
      const of = lifted ? 0 : wood[k];
      positions.set([xAt(i), yAt(j), height], k * 3);
      colour.copy(woods[of]).lerp(deeps[of], lowest < 0 && height < 0 ? (height / lowest) * 0.85 : 0);
      colors.set([colour.r, colour.g, colour.b], k * 3);
    }
  }
  const index = new Uint32Array((dx - 1) * (dy - 1) * 6);
  let n = 0;
  for (let j = 0; j < dy - 1; j++) {
    for (let i = 0; i < dx - 1; i++) {
      const a = j * dx + i;
      index.set([a, a + 1, a + dx, a + 1, a + dx + 1, a + dx], n);
      n += 6;
    }
  }
  const surface = new THREE.BufferGeometry();
  surface.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  surface.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  surface.setIndex(new THREE.BufferAttribute(index, 1));
  surface.computeVertexNormals();

  // Sides: a strip from the surface's edge down to the bottom of the board.
  const edge: number[] = [];
  for (let i = 0; i < dx; i++) edge.push(i);
  for (let j = 1; j < dy; j++) edge.push(j * dx + dx - 1);
  for (let i = dx - 2; i >= 0; i--) edge.push((dy - 1) * dx + i);
  for (let j = dy - 2; j >= 1; j--) edge.push(j * dx);
  const sidePositions = new Float32Array(edge.length * 6);
  const sideIndex = new Uint32Array(edge.length * 6);
  edge.forEach((k, e) => {
    const [x, y, top] = [positions[k * 3], positions[k * 3 + 1], positions[k * 3 + 2]];
    sidePositions.set([x, y, top, x, y, -thickness], e * 6);
    const next = (e + 1) % edge.length;
    sideIndex.set([e * 2, e * 2 + 1, next * 2, next * 2, e * 2 + 1, next * 2 + 1], e * 6);
  });
  const sides = new THREE.BufferGeometry();
  sides.setAttribute("position", new THREE.BufferAttribute(sidePositions, 3));
  sides.setIndex(new THREE.BufferAttribute(sideIndex, 1));
  sides.computeVertexNormals();

  // Pushed back a little in depth, so that the tool path lying on the cut surface shows through cleanly.
  const behind = { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };
  const group = new THREE.Group();
  group.add(new THREE.Mesh(surface, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, ...behind })));
  group.add(new THREE.Mesh(sides, new THREE.MeshStandardMaterial({ color: side, roughness: 0.9, metalness: 0, side: THREE.DoubleSide, ...behind })));
  if (bodies) group.add(buildBodies({ dx, dy, z, wood, under, lowest, xAt, yAt, woods, deeps, behind }));
  return group;
}

/**
 * The wood that was glued in, as bodies of their own on the board: their tops,
 * and their edges down to their undersides. Where a body stands off the board,
 * as a backer does over the saw gap, its edge stops there and the gap shows;
 * where it sits in the board, its top runs on into the board's surface. Each
 * has its underside too, for the view from below.
 */
function buildBodies(grid: {
  dx: number;
  dy: number;
  z: Float32Array;
  wood: Uint8Array;
  under: Float32Array;
  lowest: number;
  xAt: (i: number) => number;
  yAt: (j: number) => number;
  woods: THREE.Color[];
  deeps: THREE.Color[];
  behind: object;
}): THREE.Mesh {
  const { dx, dy, z, wood, under, lowest, xAt, yAt, woods, deeps } = grid;
  // A gap under this is none: the wood sits on what is beside it.
  const GAP = 0.05;
  const positions: number[] = [];
  const colors: number[] = [];
  const colour = new THREE.Color();
  const corner = new THREE.Color();
  const wall = new THREE.Color();
  const push = (x: number, y: number, height: number, c: THREE.Color) => {
    positions.push(x, y, height);
    colors.push(c.r, c.g, c.b);
  };

  // What each square of the grid is drawn as: the wood it is in, how high its top is at each corner, and how low its edge goes.
  type Square = { of: number; tops: number[]; feet: number[]; hovers: boolean };
  const squares: (Square | null)[] = new Array((dx - 1) * (dy - 1)).fill(null);
  const at = (i: number, j: number) => (i < 0 || j < 0 || i >= dx - 1 || j >= dy - 1 ? null : squares[j * (dx - 1) + i]);
  for (let j = 0; j < dy - 1; j++) {
    for (let i = 0; i < dx - 1; i++) {
      const ks = [j * dx + i, j * dx + i + 1, (j + 1) * dx + i + 1, (j + 1) * dx + i];
      let [of, top, foot, beside] = [0, -Infinity, Infinity, -Infinity];
      for (const k of ks) {
        if (wood[k] > 0) {
          of = Math.max(of, wood[k]);
          top = Math.max(top, z[k]);
          if (!Number.isNaN(under[k])) foot = Math.min(foot, under[k]);
        } else {
          beside = Math.max(beside, z[k]);
        }
      }
      if (of === 0) continue;
      if (foot === Infinity) foot = top;
      // Standing off what is beside it: the top stays level to the edge, and the edge stops at the underside.
      const hovers = foot > beside + GAP;
      const lowest = foot;
      squares[j * (dx - 1) + i] = {
        of,
        hovers,
        tops: ks.map((k) => (wood[k] > 0 ? z[k] : hovers ? top : z[k])),
        // The underside at each corner: the wood's own there, else the lowest of the square.
        feet: ks.map((k) => (wood[k] > 0 && !Number.isNaN(under[k]) ? under[k] : lowest)),
      };
    }
  }

  for (let j = 0; j < dy - 1; j++) {
    for (let i = 0; i < dx - 1; i++) {
      const square = at(i, j);
      if (!square) continue;
      const xs = [xAt(i), xAt(i + 1), xAt(i + 1), xAt(i)];
      const ys = [yAt(j), yAt(j), yAt(j + 1), yAt(j + 1)];
      const shade = (height: number) => colour.copy(woods[square.of]).lerp(deeps[square.of], lowest < 0 && height < 0 ? (height / lowest) * 0.85 : 0);
      for (const c of [0, 1, 3, 1, 2, 3]) push(xs[c], ys[c], square.tops[c], shade(square.tops[c]));
      // The underside, seen from below and through a gap: a shade darker, as it lies in shadow.
      const belly = corner.copy(woods[square.of]).multiplyScalar(0.6);
      for (const c of [0, 3, 1, 1, 3, 2]) push(xs[c], ys[c], Math.min(square.feet[c], square.tops[c]), belly);
      if (!square.hovers) continue;
      // An edge towards a square without this wood: a wall from the top down to the underside.
      const edge = wall.copy(woods[square.of]).multiplyScalar(0.82);
      const sides: [number, number, number, number][] = [
        [0, 1, 0, -1],
        [1, 2, 1, 0],
        [2, 3, 0, 1],
        [3, 0, -1, 0],
      ];
      for (const [a, b, di, dj] of sides) {
        if (at(i + di, j + dj)) continue;
        push(xs[a], ys[a], square.tops[a], edge);
        push(xs[a], ys[a], square.feet[a], edge);
        push(xs[b], ys[b], square.tops[b], edge);
        push(xs[b], ys[b], square.tops[b], edge);
        push(xs[a], ys[a], square.feet[a], edge);
        push(xs[b], ys[b], square.feet[b], edge);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(colors), 3));
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, side: THREE.DoubleSide, ...grid.behind }));
}

/** Cutting moves, a set of lines per tool, and the moves in the air; with a marker for the tool. */
function buildPath(preview: PocketPreview, reach: number): PathView {
  const { path } = preview;
  const cuts = new Map<number, { points: number[]; order: number[] }>();
  const rapids = { points: [] as number[], order: [] as number[] };
  for (let i = 0; i < path.length; i += PIECE) {
    let set = rapids;
    if (path[i + 6] !== 1) {
      if (!cuts.has(path[i + 7])) cuts.set(path[i + 7], { points: [], order: [] });
      set = cuts.get(path[i + 7])!;
    }
    set.points.push(path[i], path[i + 1], Math.min(path[i + 2], CEILING), path[i + 3], path[i + 4], Math.min(path[i + 5], CEILING));
    set.order.push(i / PIECE);
  }
  const lines = (points: number[], color: string, opacity: number) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(points), 3));
    return new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }));
  };
  const group = new THREE.Group();
  const sets: PathView["sets"] = [];
  // Maps keep the order of first use, which is the order the tools are loaded.
  [...cuts.values()].forEach((set, index) => {
    sets.push({ lines: lines(set.points, toolColor(index), 1), order: set.order, rapid: false });
  });
  sets.push({ lines: lines(rapids.points, RAPID_COLOR, 0.55), order: rapids.order, rapid: true });
  for (const set of sets) group.add(set.lines);

  // A cone standing on its point, where the tool's tip is.
  const tall = reach * 0.07;
  const cone = new THREE.ConeGeometry(tall * 0.22, tall, 24);
  cone.rotateX(-Math.PI / 2);
  cone.translate(0, 0, tall / 2);
  const marker = new THREE.Mesh(cone, new THREE.MeshStandardMaterial({ color: 0x2b2f33, roughness: 0.5, metalness: 0.3 }));
  marker.visible = false;
  group.add(marker);
  return { group, sets, marker };
}
