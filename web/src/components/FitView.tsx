import { useEffect, useMemo, useRef, useState } from "react";
import type { FitCheck } from "../core/types";
import { fmt } from "../state/model";

type Layer = "face" | "gap";

const BASE: [number, number, number] = [220, 189, 142];
const PLUG: [number, number, number] = [111, 74, 38];
const VOID: [number, number, number] = [210, 31, 60];
const NO_PLUG: [number, number, number] = [236, 232, 224];
/** Gaps at or above this are drawn in the strongest colour, mm. */
const GAP_FULL = 0.5;

/** Colour for a gap: green where the parts touch, through yellow, to blue for a wide gap. */
function gapColor(gap: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, gap / GAP_FULL));
  if (t < 0.1) return [46, 140, 87];
  if (t < 0.5) {
    const k = (t - 0.1) / 0.4;
    return [46 + k * 190, 140 + k * 60, 87 - k * 40];
  }
  const k = (t - 0.5) / 0.5;
  return [236 - k * 190, 200 - k * 90, 47 + k * 140];
}

/** A height relative to the base board's surface, to two decimals, with its sign. */
function signed(z: number): string {
  const v = Math.round(z * 100) / 100;
  return v === 0 ? "0.00" : `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}`;
}

/** The fit of plug and pocket from above, with a cross-section through a chosen row. */
export function FitView({ fit }: { fit: FitCheck }) {
  const map = useRef<HTMLCanvasElement>(null);
  const section = useRef<HTMLCanvasElement>(null);
  const [layer, setLayer] = useState<Layer>("face");
  // Row and column of the cross-section's centre, in cells.
  const [at, setAt] = useState<[number, number]>(() => {
    const [x, y] = fit.report.firstContact;
    return [Math.floor(x / fit.cell), Math.floor(y / fit.cell)];
  });
  const whole = Math.ceil(fit.nx * fit.cell);
  const [span, setSpan] = useState<number>(whole);
  // How many times taller than true the cross-section is drawn.
  const [stretch, setStretch] = useState(1);

  const image = useMemo(() => {
    const { nx, ny, face, gap } = fit;
    const data = new ImageData(nx, ny);
    for (let iy = 0; iy < ny; iy++) {
      // Row 0 of the board is its bottom edge; row 0 of the picture is its top.
      const row = (ny - 1 - iy) * nx;
      for (let ix = 0; ix < nx; ix++) {
        const i = iy * nx + ix;
        let c: [number, number, number];
        if (layer === "face") c = face[i] === 0 ? BASE : face[i] === 1 ? PLUG : VOID;
        else c = Number.isNaN(gap[i]) ? NO_PLUG : gapColor(gap[i]);
        const o = (row + ix) * 4;
        data.data[o] = c[0];
        data.data[o + 1] = c[1];
        data.data[o + 2] = c[2];
        data.data[o + 3] = 255;
      }
    }
    return data;
  }, [fit, layer]);

  useEffect(() => {
    const canvas = map.current;
    if (!canvas) return;
    canvas.width = fit.nx;
    canvas.height = fit.ny;
    const ctx = canvas.getContext("2d")!;
    ctx.putImageData(image, 0, 0);
    // The line the cross-section is taken along.
    const y = fit.ny - 1 - at[1] + 0.5;
    const half = span / fit.cell / 2;
    ctx.strokeStyle = "#1f6f8b";
    ctx.lineWidth = Math.max(1, fit.nx / 500);
    ctx.beginPath();
    ctx.moveTo(Math.max(0, at[0] - half), y);
    ctx.lineTo(Math.min(fit.nx, at[0] + half), y);
    ctx.stroke();
    // The point the numbers are for.
    const r = Math.max(4, fit.nx / 120);
    ctx.lineWidth = Math.max(1.5, fit.nx / 350);
    ctx.strokeStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(at[0] + 0.5, y, r + ctx.lineWidth, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = "#1f6f8b";
    ctx.beginPath();
    ctx.arc(at[0] + 0.5, y, r, 0, Math.PI * 2);
    ctx.stroke();
  }, [fit, image, at, span]);

  useEffect(() => {
    const canvas = section.current;
    if (!canvas) return;
    const width = canvas.clientWidth || 600;
    const { nx, cell, base, plugUnder } = fit;
    const half = Math.round(span / cell / 2);
    const from = Math.max(0, Math.min(nx - 1, at[0] - half));
    const to = Math.max(from + 1, Math.min(nx - 1, at[0] + half));
    const row = at[1] * nx;

    const scale = width / ((to - from) * cell);
    let lowest = 0;
    let highest = 0.5;
    for (let ix = from; ix <= to; ix++) {
      lowest = Math.min(lowest, base[row + ix]);
      const under = plugUnder[row + ix];
      if (!Number.isNaN(under)) highest = Math.max(highest, under + 0.5);
    }
    lowest -= 0.5;
    // Same scale both ways when that leaves something to see, so slopes look
    // as they are. A long section is a few millimetres tall, so it is drawn
    // taller than true and says so.
    const height = Math.min(220, Math.max(150, (highest - lowest) * scale));
    const vscale = height / (highest - lowest);
    setStretch(vscale / scale);
    const ratio = window.devicePixelRatio || 1;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(ratio, ratio);
    ctx.clearRect(0, 0, width, height);
    const px = (ix: number) => (ix - from) * cell * scale;
    const py = (z: number) => (highest - z) * vscale;

    // Base board: everything under its surface.
    ctx.fillStyle = `rgb(${BASE.join(",")})`;
    ctx.beginPath();
    ctx.moveTo(px(from), height);
    for (let ix = from; ix <= to; ix++) ctx.lineTo(px(ix), py(base[row + ix]));
    ctx.lineTo(px(to), height);
    ctx.fill();

    // Plug: everything above its underside, in runs where it exists.
    ctx.fillStyle = `rgb(${PLUG.join(",")})`;
    let start = -1;
    for (let ix = from; ix <= to + 1; ix++) {
      const has = ix <= to && !Number.isNaN(plugUnder[row + ix]);
      if (has && start < 0) start = ix;
      if (!has && start >= 0) {
        ctx.beginPath();
        ctx.moveTo(px(start), 0);
        for (let k = start; k < ix; k++) ctx.lineTo(px(k), py(plugUnder[row + k]));
        ctx.lineTo(px(ix - 1), 0);
        ctx.fill();
        start = -1;
      }
    }

    // The base board's surface, where the face is trimmed to.
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, py(0));
    ctx.lineTo(width, py(0));
    ctx.stroke();
    ctx.setLineDash([]);

    // The clicked point: a line through both surfaces, with the heights and
    // the gap between them written beside it.
    const x = px(Math.max(from, Math.min(to, at[0])));
    const baseZ = base[row + at[0]];
    const underZ = plugUnder[row + at[0]];
    ctx.strokeStyle = "#1f6f8b";
    ctx.fillStyle = "#1f6f8b";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
    const labels: [number, string][] = [[baseZ, `base ${signed(baseZ)}`]];
    if (!Number.isNaN(underZ)) labels.push([underZ, `plug ${signed(underZ)}`]);
    for (const [z] of labels) {
      ctx.beginPath();
      ctx.arc(x, py(z), 4, 0, Math.PI * 2);
      ctx.fill();
    }
    if (!Number.isNaN(underZ)) {
      labels.push([(baseZ + underZ) / 2, `gap ${(underZ - baseZ).toFixed(2)}`]);
    }
    ctx.font = "600 12px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    // Keep the labels apart when the surfaces are close together.
    labels.sort((a, b) => b[0] - a[0]);
    let previous = -Infinity;
    for (const [z, text] of labels) {
      const y = Math.min(height - 9, Math.max(previous + 16, py(z), 9));
      previous = y;
      const w = ctx.measureText(text).width + 8;
      const left = x + 8 + w > width ? x - 8 - w : x + 8;
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.fillRect(left, y - 8, w, 16);
      ctx.fillStyle = "#12414f";
      ctx.fillText(text, left + 4, y);
    }
  }, [fit, at, span]);

  const pick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const ix = Math.floor(((e.clientX - box.left) / box.width) * fit.nx);
    const iy = fit.ny - 1 - Math.floor(((e.clientY - box.top) / box.height) * fit.ny);
    setAt([Math.max(0, Math.min(fit.nx - 1, ix)), Math.max(0, Math.min(fit.ny - 1, iy))]);
  };

  const i = at[1] * fit.nx + at[0];
  const gapHere = fit.gap[i];
  const baseHere = fit.base[i];
  const underHere = fit.plugUnder[i];
  const faceHere = fit.face[i] === 0 ? "base board" : fit.face[i] === 1 ? "plug" : "gap";
  return (
    <div className="fit-view">
      <div className="viewer-bar">
        <nav className="tabs" aria-label="What the picture shows">
          <button aria-pressed={layer === "face"} onClick={() => setLayer("face")}>
            Finished face
          </button>
          <button aria-pressed={layer === "gap"} onClick={() => setLayer("gap")}>
            Gaps
          </button>
        </nav>
        <span className="muted">
          {layer === "face"
            ? `The face after trimming ${fmt(fit.report.trimDepth)} mm below the surface: base board light, plug dark, gaps red.`
            : `Space between plug and pocket, straight up: green touching, yellow about ${fmt(GAP_FULL / 2)} mm, blue ${fmt(GAP_FULL)} mm or more.`}{" "}
          Click to move the cross-section.
        </span>
      </div>
      <div className="fit-map">
        <canvas ref={map} onClick={pick} role="img" aria-label={layer === "face" ? "Finished face of the inlay" : "Gap between plug and pocket"} />
      </div>
      <div className="viewer-bar">
        <strong>Cross-section</strong>
        <span className="muted">{stretch > 1.05 ? `Heights drawn ${stretch.toFixed(1)}× taller than true.` : "True proportions."}</span>
        <label className="inline">
          Width
          <select value={span} onChange={(e) => setSpan(Number(e.target.value))}>
            <option value={3}>3 mm</option>
            <option value={10}>10 mm</option>
            <option value={30}>30 mm</option>
            <option value={whole}>Whole board</option>
          </select>
        </label>
      </div>
      <dl className="fit-point" aria-live="polite">
        <dt>Clicked point</dt>
        <dd>
          X {(at[0] * fit.cell).toFixed(2)}, Y {(at[1] * fit.cell).toFixed(2)} mm
        </dd>
        <dt>Base board</dt>
        <dd>{signed(baseHere)} mm</dd>
        <dt>Plug underside</dt>
        <dd>{Number.isNaN(underHere) ? "no plug here" : `${signed(underHere)} mm`}</dd>
        <dt>Gap</dt>
        <dd>{Number.isNaN(gapHere) ? "–" : `${gapHere.toFixed(2)} mm`}</dd>
        <dt>Finished face</dt>
        <dd>{faceHere}</dd>
      </dl>
      <canvas className="fit-section" ref={section} role="img" aria-label="Cross-section through plug and pocket" />
    </div>
  );
}
