import { useEffect, useState, type DragEvent } from "react";
import { ArrangeBar, StageBar } from "./components/ArrangeBar";
import { DesignCanvas } from "./components/DesignCanvas";
import { DesignPanel } from "./components/DesignPanel";
import { FitView } from "./components/FitView";
import { Header } from "./components/Header";
import { partName } from "./components/OutputPanel";
import { isInlay, jobColor, stockColor } from "./state/model";
import { StartGuide } from "./components/StartGuide";
import { SettingsView } from "./components/SettingsView";
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
  const { importAll } = useFileActions();
  const [dragging, setDragging] = useState(false);

  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");
  const onDrop = async (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setDragging(false);
    const files = await Promise.all([...e.dataTransfer.files].map(async (file) => ({ name: file.name, text: await file.text() })));
    await importAll(files);
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
      {!ready ? <p className="loading">Loading…</p> : view === "design" ? <DesignView /> : <SettingsView />}
      {dragging && <div className="drop-hint">Drop SVG or DXF drawings, a project or tool file, or tools.yaml</div>}
    </div>
  );
}

function DesignView() {
  const { project, output, combined, stage, activeJobId, arranging } = useApp();
  const dispatch = useDispatch();
  if (!project.design) return <StartGuide />;

  const job = project.jobs.find((j) => j.id === activeJobId);
  const mine = job && output !== null && output.jobId === job.id ? output : null;
  const pocket = mine?.parts.pocket ?? null;
  const plug = mine?.parts.plug ?? null;
  const fit = mine?.fit ?? null;
  // The one file for the stock is looked at from the list, with no inlay or operation open.
  const whole = !job ? (combined?.preview ?? null) : null;
  // Fall back to the drawing when what was asked for is not there (any more).
  const shown: Stage =
    (stage === "pocket" && pocket) || (stage === "plug" && plug) || (stage === "fit" && fit) || (stage === "stock" && whole) ? stage : "drawing";
  const preview = shown === "pocket" ? pocket : shown === "plug" ? plug : shown === "stock" ? whole : null;
  const wood = stockColor(project);
  const plugWood = job && isInlay(job.inlay) ? jobColor(job, project.jobs) : wood;
  const capital = (text: string) => text.replace(/^./, (c) => c.toUpperCase());
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
            {pocket && tab("pocket", `${capital(partName("pocket", job))} in 3D`)}
            {plug && tab("plug", `${capital(partName("plug", job))} in 3D`)}
            {fit && tab("fit", "Fit")}
          </nav>
        )}
        {whole && (
          <nav className="tabs stage-tabs" aria-label="What to look at">
            {tab("drawing", "Drawing")}
            {tab("stock", "File for the stock in 3D")}
          </nav>
        )}
        {shown === "fit" && fit ? (
          <FitView fit={fit} baseColor={wood} plugColor={plugWood} />
        ) : preview ? (
          <Viewer3D key={shown} preview={preview} thickness={preview.built.stock.thickness} color={shown === "plug" ? plugWood : wood} />
        ) : (
          <>
            <StageBar design={project.design} />
            {arranging && <ArrangeBar design={project.design} />}
            <DesignCanvas design={project.design} narrow={marks?.built.narrow ?? []} cuttable={marks?.built.cuttable ?? []} />
          </>
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
