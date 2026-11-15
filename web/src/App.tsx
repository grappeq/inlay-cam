import { useEffect, useState, type DragEvent } from "react";
import { DesignCanvas } from "./components/DesignCanvas";
import { DesignPanel } from "./components/DesignPanel";
import { FitView } from "./components/FitView";
import { Header } from "./components/Header";
import { StartGuide } from "./components/StartGuide";
import { ToolsView } from "./components/ToolsView";
import { Viewer3D } from "./components/Viewer3D";
import { useFileActions } from "./state/files";
import { AppProvider, useApp, useDispatch, type Stage } from "./state/store";

export function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}

function Shell() {
  const { ready, view } = useApp();
  const { importAny } = useFileActions();
  const [dragging, setDragging] = useState(false);

  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");
  const onDrop = async (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setDragging(false);
    // One at a time: each import builds on the state the previous one left.
    const file = e.dataTransfer.files[0];
    if (file) await importAny({ name: file.name, text: await file.text() });
  };

  return (
    <div
      className={`app${dragging ? " dragging" : ""}`}
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <Header />
      <NoticeBar />
      {!ready ? <p className="loading">Loading…</p> : view === "design" ? <DesignView /> : <ToolsView />}
      {dragging && <div className="drop-hint">Drop an SVG drawing, a project or tool file, or tools.yaml</div>}
    </div>
  );
}

function DesignView() {
  const { project, output, stage, activeJobId } = useApp();
  const dispatch = useDispatch();
  if (!project.design) return <StartGuide />;

  const job = project.jobs.find((j) => j.id === activeJobId);
  const mine = job && output !== null && output.jobId === job.id ? output : null;
  const pocket = mine?.parts.pocket ?? null;
  const plug = mine?.parts.plug ?? null;
  const fit = mine?.fit ?? null;
  // Fall back to the drawing when what was asked for is not there (any more).
  const shown: Stage = (stage === "pocket" && pocket) || (stage === "plug" && plug) || (stage === "fit" && fit) ? stage : "drawing";
  const preview = shown === "pocket" ? pocket : shown === "plug" ? plug : null;
  const marks = pocket ?? plug;
  const tab = (to: Stage, label: string) => (
    <button aria-pressed={shown === to} onClick={() => dispatch({ type: "setStage", stage: to })}>
      {label}
    </button>
  );

  return (
    <div className="design-view">
      <main className="stage">
        {job && mine && (pocket || plug) && (
          <nav className="tabs stage-tabs" aria-label="What to look at">
            {tab("drawing", "Drawing")}
            {pocket && tab("pocket", "Pocket in 3D")}
            {plug && tab("plug", `${job.inlay.type === "vcarve" ? "Plug" : "Insert"} in 3D`)}
            {fit && tab("fit", "Fit")}
          </nav>
        )}
        {shown === "fit" && fit ? (
          <FitView fit={fit} />
        ) : preview ? (
          <Viewer3D key={shown} preview={preview} thickness={preview.built.stock.thickness} />
        ) : (
          <DesignCanvas design={project.design} narrow={marks?.built.narrow ?? []} cuttable={marks?.built.cuttable ?? []} />
        )}
      </main>
      <DesignPanel design={project.design} />
    </div>
  );
}

function NoticeBar() {
  const { notice } = useApp();
  const dispatch = useDispatch();

  // Confirmations fade by themselves; errors stay until dismissed.
  useEffect(() => {
    if (notice?.kind !== "info") return;
    const timer = setTimeout(() => dispatch({ type: "notice", notice: null }), 8000);
    return () => clearTimeout(timer);
  }, [notice, dispatch]);

  if (!notice) return null;
  return (
    <div className={`notice ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
      <span>{notice.text}</span>
      <button className="link" onClick={() => dispatch({ type: "notice", notice: null })}>
        Dismiss
      </button>
    </div>
  );
}
