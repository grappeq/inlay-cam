import { useEffect, useState } from "react";
import { CoreClient } from "./core/client";

// Milestone 0 shell: proves the Rust core loads in a worker and that the
// medial axis runs in the browser. Replaced by the real UI in milestone 1.

type Edge = { ax: number; ay: number; ra: number; bx: number; by: number; rb: number };

type State =
  | { kind: "loading" }
  | { kind: "ready"; version: string; edges: Edge[]; maxRadius: number; millis: number }
  | { kind: "error"; message: string };

function star(points: number, outer: number, inner: number): Float64Array {
  const ring = new Float64Array(points * 4);
  for (let i = 0; i < points * 2; i++) {
    const angle = (i / (points * 2)) * Math.PI * 2 + Math.PI / 2;
    const r = i % 2 === 0 ? outer : inner;
    ring[i * 2] = r * Math.cos(angle);
    ring[i * 2 + 1] = r * Math.sin(angle);
  }
  return ring;
}

const RING = star(5, 40, 17);

export function App() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    const core = new CoreClient();
    let cancelled = false;
    (async () => {
      try {
        const version = await core.call("coreVersion");
        const started = performance.now();
        const raw = await core.call("medialAxisOfRing", RING);
        const millis = performance.now() - started;
        const edges: Edge[] = [];
        let maxRadius = 0;
        for (let i = 0; i < raw.length; i += 6) {
          const edge = { ax: raw[i], ay: raw[i + 1], ra: raw[i + 2], bx: raw[i + 3], by: raw[i + 4], rb: raw[i + 5] };
          edges.push(edge);
          maxRadius = Math.max(maxRadius, edge.ra, edge.rb);
        }
        if (!cancelled) setState({ kind: "ready", version, edges, maxRadius, millis });
      } catch (e) {
        if (!cancelled) setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      cancelled = true;
      core.dispose();
    };
  }, []);

  return (
    <main>
      <h1>Wooden Inlays</h1>
      <p>Milestone 0: the geometry core running in the browser.</p>
      {state.kind === "loading" && <p className="status">Loading the core…</p>}
      {state.kind === "error" && <p className="status error">The core failed: {state.message}</p>}
      {state.kind === "ready" && (
        <>
          <p className="status" data-testid="core-status">
            Core {state.version} loaded. Medial axis: {state.edges.length} edges in {state.millis.toFixed(1)} ms,
            deepest point {state.maxRadius.toFixed(2)} mm from the edge.
          </p>
          <div className="panel">
            <Preview edges={state.edges} maxRadius={state.maxRadius} />
          </div>
          <p className="caption">
            The lines are where a V-bit travels. Colour shows distance from the edge, which becomes cut depth: blue is
            shallow, red is deep.
          </p>
        </>
      )}
    </main>
  );
}

function Preview({ edges, maxRadius }: { edges: Edge[]; maxRadius: number }) {
  const outline: string[] = [];
  for (let i = 0; i < RING.length; i += 2) outline.push(`${RING[i]},${-RING[i + 1]}`);
  return (
    <svg viewBox="-45 -45 90 90" role="img" aria-label="A star shape with its medial axis">
      <polygon points={outline.join(" ")} fill="var(--wood)" stroke="var(--wood-edge)" strokeWidth={0.4} />
      {edges.map((e, i) => {
        const depth = maxRadius > 0 ? (e.ra + e.rb) / 2 / maxRadius : 0;
        return (
          <line
            key={i}
            x1={e.ax}
            y1={-e.ay}
            x2={e.bx}
            y2={-e.by}
            stroke={`color-mix(in srgb, var(--axis-deep) ${Math.round(depth * 100)}%, var(--axis-shallow))`}
            strokeWidth={0.6}
            strokeLinecap="round"
          />
        );
      })}
    </svg>
  );
}
