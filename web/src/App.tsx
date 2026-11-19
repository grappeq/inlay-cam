import { useEffect, useState, useSyncExternalStore, type DragEvent } from "react";
import { answerPairing, getLink, startLink, subscribeLink } from "./agent/link";
import { ArrangeBar, StageBar } from "./components/ArrangeBar";
import { DesignCanvas } from "./components/DesignCanvas";
import { DesignPanel } from "./components/DesignPanel";
import { FitView } from "./components/FitView";
import { Header } from "./components/Header";
import { partName } from "./components/OutputPanel";
import { isInlay, stepColor, stockColor } from "./state/model";
import { StartGuide } from "./components/StartGuide";
import { TimelineStart, TimelineView } from "./components/Timeline";
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
      <AgentPairing />
      {!ready ? <p className="loading">Loading…</p> : view === "design" ? <DesignView /> : <SettingsView />}
      {dragging && <div className="drop-hint">Drop SVG or DXF drawings, a project or tool file, or tools.yaml</div>}
    </div>
  );
}

function DesignView() {
  const { project, output, timeline, stage, activeStepId, arranging } = useApp();
  const dispatch = useDispatch();
  if (!project.design) return <StartGuide />;

  const step = project.steps.find((j) => j.id === activeStepId);
  const mine = step && output !== null && output.stepId === step.id ? output : null;
  const pocket = mine?.parts.pocket ?? null;
  const plug = mine?.parts.plug ?? null;
  const fit = mine?.fit ?? null;
  // Fall back to the drawing when what was asked for is not there (any more).
  const steps = timeline?.result ?? null;
  const shown: Stage =
    (stage === "pocket" && pocket) || (stage === "plug" && plug) || (stage === "fit" && fit) || (stage === "timeline" && project.steps.length > 0)
      ? stage
      : "drawing";
  const preview = shown === "pocket" ? pocket : shown === "plug" ? plug : null;
  const wood = stockColor(project);
  const plugWood = step && isInlay(step.task) ? stepColor(step, project.steps) : wood;
  const capital = (text: string) => text.replace(/^./, (c) => c.toUpperCase());
  const marks = pocket ?? plug;
  // What there is to look at, besides the drawing.
  const tabs: [Stage, string][] = [["drawing", "Drawing"]];
  if (step && pocket) tabs.push(["pocket", `${capital(partName("pocket", step))} in 3D`]);
  if (step && plug) tabs.push(["plug", `${capital(partName("plug", step))} in 3D`]);
  if (fit) tabs.push(["fit", "Fit"]);
  // The stock step by step is there to look at as soon as there is something to do to it; it is worked out when first asked for.
  if (project.steps.length > 0) tabs.push(["timeline", "Stock, step by step"]);
  // From an inlay or operation, the stock is shown as that one leaves it.
  const mineAt = step ? project.steps.indexOf(step) + 1 : undefined;
  const show = (to: Stage) => {
    if (to === "timeline" && mineAt !== undefined && steps) dispatch({ type: "setTimelineAt", at: mineAt });
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
        ) : shown === "timeline" ? (
          <TimelineStart at={mineAt} />

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

/** Starts the link to an AI agent, and asks before a pairing link switches it on for the first time. */
function AgentPairing() {
  const { asking } = useSyncExternalStore(subscribeLink, getLink);
  useEffect(() => startLink(), []);
  if (!asking) return null;
  return (
    <div className="backdrop">
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Let an AI agent work in this app?">
        <h2>Let an AI agent work in this app?</h2>
        <table className="set-table">
          <tbody>
            <tr>
              <th scope="row">Reads</th>
              <td>The open project, your projects and your tools</td>
            </tr>
            <tr>
              <th scope="row">Changes</th>
              <td>The project, in front of you</td>
            </tr>
            <tr>
              <th scope="row">Goes to</th>
              <td>The agent on this computer and its model provider</td>
            </tr>
          </tbody>
        </table>
        <div className="row end">
          <button onClick={() => answerPairing(false)}>Not now</button>
          <button className="primary" onClick={() => answerPairing(true)}>
            Allow
          </button>
        </div>
      </div>
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
