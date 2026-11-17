import { useEffect, useState, type DragEvent } from "react";
import { ArrangeBar, StageBar } from "./components/ArrangeBar";
import { DesignCanvas } from "./components/DesignCanvas";
import { DesignPanel } from "./components/DesignPanel";
import { FitView } from "./components/FitView";
import { Header } from "./components/Header";
import { partName } from "./components/OutputPanel";
import { isInlay, jobColor, stockColor } from "./state/model";
import { StartGuide } from "./components/StartGuide";
import { TimelineView } from "./components/Timeline";
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
  const { project, output, timeline, stage, activeJobId, arranging } = useApp();
  const dispatch = useDispatch();
  if (!project.design) return <StartGuide />;

  const job = project.jobs.find((j) => j.id === activeJobId);
  const mine = job && output !== null && output.jobId === job.id ? output : null;
  const pocket = mine?.parts.pocket ?? null;
  const plug = mine?.parts.plug ?? null;
  const fit = mine?.fit ?? null;
  // Fall back to the drawing when what was asked for is not there (any more).
  const steps = timeline?.result ?? null;
  const shown: Stage =
    (stage === "pocket" && pocket) || (stage === "plug" && plug) || (stage === "fit" && fit) || (stage === "timeline" && steps)
      ? stage
      : "drawing";
  const preview = shown === "pocket" ? pocket : shown === "plug" ? plug : null;
  const wood = stockColor(project);
  const plugWood = job && isInlay(job.inlay) ? jobColor(job, project.jobs) : wood;
  const capital = (text: string) => text.replace(/^./, (c) => c.toUpperCase());
  const marks = pocket ?? plug;
  // What there is to look at, besides the drawing.
  const tabs: [Stage, string][] = [["drawing", "Drawing"]];
  if (job && pocket) tabs.push(["pocket", `${capital(partName("pocket", job))} in 3D`]);
  if (job && plug) tabs.push(["plug", `${capital(partName("plug", job))} in 3D`]);
  if (fit) tabs.push(["fit", "Fit"]);
  if (steps) tabs.push(["timeline", "Stock, step by step"]);
  const show = (to: Stage) => {
    // From an inlay or operation, the stock is shown as that one leaves it.
    const at = to === "timeline" && job && steps ? steps.steps.findIndex((s) => s.jobId === job.id) : -1;
    if (at >= 0) dispatch({ type: "setTimelineAt", at: at + 1 });
    dispatch({ type: "setStage", stage: to });
  };

  return (
    <div className="design-view">
      <main className="stage">
        {tabs.length > 1 && (
          <nav className="tabs stage-tabs" aria-label="What to look at">
            {tabs.map(([to, label]) => (
              <button key={to} aria-pressed={shown === to} onClick={() => show(to)}>
                {label}
              </button>
            ))}
          </nav>
        )}
        {shown === "fit" && fit ? (
          <FitView fit={fit} baseColor={wood} plugColor={plugWood} />
        ) : shown === "timeline" && timeline && steps ? (
          <TimelineView timeline={timeline} result={steps} />
        ) : preview ? (
          <Viewer3D key={shown} preview={preview} thickness={preview.built.stock.thickness} color={shown === "plug" ? plugWood : wood} />
        ) : (
          <>
            <StageBar />
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
