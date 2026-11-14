import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { PocketPreview } from "../core/types";

/** Most vertices per side of the displayed surface; finer height maps are thinned for display only. */
const MAX_DISPLAY = 600;

const TOP = new THREE.Color("#dcbd8e");
const DEEP = new THREE.Color("#6f4a26");
const SIDE = new THREE.Color("#b6935f");

interface Props {
  preview: PocketPreview;
  /** Thickness of the stock, mm, for drawing its sides. */
  thickness: number;
}

/** The simulated stock in 3D, with the tool path as an optional overlay. */
export function Viewer3D({ preview, thickness }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const pathGroup = useRef<THREE.Group | null>(null);
  const redraw = useRef<() => void>(() => {});
  const [showPath, setShowPath] = useState(false);

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
    const path = buildPath(preview);
    path.visible = false;
    scene.add(path);
    pathGroup.current = path;

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
      pathGroup.current = null;
    };
  }, [preview, thickness]);

  useEffect(() => {
    if (pathGroup.current) pathGroup.current.visible = showPath;
    redraw.current();
  }, [showPath, preview]);

  return (
    <div className="viewer">
      <div className="viewer-canvas" ref={host} role="img" aria-label="3D preview of the base board after cutting" />
      <div className="viewer-bar">
        <label className="check">
          <input type="checkbox" checked={showPath} onChange={(e) => setShowPath(e.target.checked)} />
          Show tool path
        </label>
        <span className="muted">
          Drag to turn, scroll to zoom, right-drag to move. Simulated at {preview.cell} mm per cell from the G-code file.
        </span>
      </div>
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

  const group = new THREE.Group();
  group.add(new THREE.Mesh(surface, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 })));
  group.add(new THREE.Mesh(sides, new THREE.MeshStandardMaterial({ color: SIDE, roughness: 0.9, metalness: 0, side: THREE.DoubleSide })));
  return group;
}

/** Cutting moves and rapids as two sets of lines. */
function buildPath(preview: PocketPreview): THREE.Group {
  const { path } = preview;
  const cuts: number[] = [];
  const rapids: number[] = [];
  for (let i = 0; i < path.length; i += 7) {
    // The descent from the tool-change height would dwarf the model; start it just above the work.
    const z0 = Math.min(path[i + 2], 15);
    const z1 = Math.min(path[i + 5], 15);
    (path[i + 6] === 1 ? rapids : cuts).push(path[i], path[i + 1], z0, path[i + 3], path[i + 4], z1);
  }
  const lines = (points: number[], color: number, opacity: number) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(points), 3));
    return new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }));
  };
  const group = new THREE.Group();
  group.add(lines(cuts, 0x1f6f8b, 1));
  group.add(lines(rapids, 0xc0392b, 0.55));
  return group;
}
