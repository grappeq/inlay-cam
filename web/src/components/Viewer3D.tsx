import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { PocketPreview } from "../core/types";

/** Most vertices per side of the displayed surface; finer height maps are thinned for display only. */
const MAX_DISPLAY = 600;

const TOP = new THREE.Color("#dcbd8e");
const DEEP = new THREE.Color("#6f4a26");
const SIDE = new THREE.Color("#b6935f");

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

interface Props {
  preview: PocketPreview;
  /** Thickness of the stock, mm, for drawing its sides. */
  thickness: number;
}

/** The simulated stock in 3D, with the tool path as an optional overlay. */
export function Viewer3D({ preview, thickness }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const pathView = useRef<PathView | null>(null);
  const stockGroup = useRef<THREE.Group | null>(null);
  const redraw = useRef<() => void>(() => {});
  const [showPath, setShowPath] = useState(false);
  const [hideBoard, setHideBoard] = useState(false);
  const [showRapids, setShowRapids] = useState(true);
  // How many moves of the file are drawn; null for all of them.
  const [upTo, setUpTo] = useState<number | null>(null);

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
    const frame = () => {
      const vertical = THREE.MathUtils.degToRad(camera.fov) / 2;
      const horizontal = Math.atan(Math.tan(vertical) * camera.aspect);
      const distance = Math.max(width / 2 / Math.tan(horizontal), depth / 2 / Math.tan(vertical)) * 1.2;
      const from = new THREE.Vector3(0, -0.77, 0.64).multiplyScalar(distance);
      camera.position.copy(centre).add(from);
      controls.update();
    };

    const stock = buildStock(preview, thickness);
    scene.add(stock);
    stockGroup.current = stock;
    const path = buildPath(preview, reach);
    path.group.visible = false;
    scene.add(path.group);
    pathView.current = path;

    const render = () => renderer.render(scene, camera);
    redraw.current = render;
    controls.addEventListener("change", render);

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
  }, [preview, thickness]);

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
    redraw.current();
  }, [showPath, hideBoard, showRapids, shownMoves, count, preview]);

  const last = shownMoves > 0 ? (shownMoves - 1) * PIECE : -1;
  const lastTool = last >= 0 ? tools.find((t) => t.number === preview.path[last + 7]) : undefined;

  return (
    <div className="viewer">
      <div className="viewer-bar">
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
        Drag to turn, scroll to zoom, right-drag to move. Simulated at {preview.cell} mm per cell from the G-code file.
      </p>
    </div>
  );
}

/** The cut surface plus the four sides of the board. */
function buildStock(preview: PocketPreview, thickness: number): THREE.Group {
  const { nx, ny, cell, heights } = preview;
  const step = Math.max(1, Math.ceil(Math.max(nx, ny) / MAX_DISPLAY));
  const dx = Math.ceil(nx / step);
  const dy = Math.ceil(ny / step);

  // When thinning, keep the deepest cell of each block so narrow cuts stay visible.
  const z = new Float32Array(dx * dy);
  let lowest = 0;
  for (let j = 0; j < dy; j++) {
    for (let i = 0; i < dx; i++) {
      let min = Infinity;
      for (let jj = j * step; jj < Math.min(ny, (j + 1) * step); jj++) {
        for (let ii = i * step; ii < Math.min(nx, (i + 1) * step); ii++) {
          const h = heights[jj * nx + ii];
          if (h < min) min = h;
        }
      }
      z[j * dx + i] = min;
      if (min < lowest) lowest = min;
    }
  }
  const xAt = (i: number) => Math.min(nx * cell, (i + 0.5) * step * cell);
  const yAt = (j: number) => Math.min(ny * cell, (j + 0.5) * step * cell);

  const positions = new Float32Array(dx * dy * 3);
  const colors = new Float32Array(dx * dy * 3);
  const colour = new THREE.Color();
  for (let j = 0; j < dy; j++) {
    for (let i = 0; i < dx; i++) {
      const k = j * dx + i;
      positions.set([xAt(i), yAt(j), z[k]], k * 3);
      colour.copy(TOP).lerp(DEEP, lowest < 0 ? (z[k] / lowest) * 0.85 : 0);
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
  group.add(new THREE.Mesh(sides, new THREE.MeshStandardMaterial({ color: SIDE, roughness: 0.9, metalness: 0, side: THREE.DoubleSide, ...behind })));
  return group;
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
