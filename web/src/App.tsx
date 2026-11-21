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
import { readFile } from "./util/files";
import { AppProvider, message, settleConflict, useApp, useDispatch, type Stage } from "./state/store";
import { core } from "./core/client";
import * as db from "./storage/home";
import { duplicateProject } from "./state/model";
import { MakeraImportDialog } from "./components/LibraryDialogs";

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
  const [dragTick, setDragTick] = useState(0);

  // A drag over the window sends dragover again and again; when they stop (the drag left the window, was cancelled
  // or ended somewhere that does not say so), the hint goes.
  useEffect(() => {
    if (!dragging) return;
    const timer = setTimeout(() => setDragging(false), 400);
    return () => clearTimeout(timer);
  }, [dragging, dragTick]);

  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");
  const onDrop = async (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setDragging(false);
    const files = await Promise.all([...e.dataTransfer.files].map(readFile));
    await importAll(files);
  };

  return (
    <div
      className={`app${dragging ? " dragging" : ""}`}
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDragging(true);
        setDragTick((n) => n + 1);
      }}
      onDragLeave={(e) => {
        // Leaving the window or pressing Escape leaves to nothing; moving onto another element of the app does not.
        const to = e.relatedTarget as Node | null;
        if (!to || !e.currentTarget.contains(to)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <Header />
      <NoticeBar />
      <ConflictBar />
      <AgentPairing />
      <MakeraIncoming />
      {!ready ? <p className="loading">Loading…</p> : view === "design" ? <DesignView /> : <SettingsView />}
      {dragging && <div className="drop-hint">Drop SVG or DXF drawings, a project or tool file, tools.yaml, or a Makera export</div>}
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

/** Values from a Makera export to take into the tools, picked from the menu or dropped on the window. */
function MakeraIncoming() {
  const { makeraImport } = useApp();
  const dispatch = useDispatch();
  if (!makeraImport) return null;
  return <MakeraImportDialog plan={makeraImport.plan} fileName={makeraImport.fileName} onClose={() => dispatch({ type: "setMakeraImport", incoming: null })} />;
}

/**
 * The open project was saved from another window or browser while it was
 * changed here too. Nothing is saved until one of the two is chosen, or both
 * kept: this one as a copy beside the other.
 */
function ConflictBar() {
  const { projectConflict: conflict, project, projects } = useApp();
  const dispatch = useDispatch();
  const [busy, setBusy] = useState(false);
  if (!conflict || conflict.id !== project.id) return null;

  const run = (work: () => Promise<void>) => async () => {
    setBusy(true);
    try {
      await work();
    } catch (e) {
      dispatch({ type: "notice", notice: { kind: "error", text: message(e) } });
    } finally {
      setBusy(false);
    }
  };
  const openOther = async () => {
    const other = await core.call("projectFromFile", conflict.text);
    settleConflict(conflict);
    dispatch({ type: "projectConflict", conflict: null });
    dispatch({ type: "openProject", project: other });
  };
  const keepThis = async () => {
    settleConflict(conflict);
    dispatch({ type: "projectConflict", conflict: null });
  };
  const keepBoth = async () => {
    const copy = duplicateProject(project, projects.map((p) => p.name));
    await db.putProject({ id: copy.id, name: copy.name, modified: Date.now(), text: await core.call("projectToFile", copy) });
    dispatch({ type: "setProjects", projects: await db.listProjects() });
    await openOther();
    dispatch({ type: "notice", notice: { kind: "info", text: `Your version is kept as "${copy.name}", under Projects.` } });
  };

  return (
    <div className="notice error" role="alert">
      <span>
        This project was saved from another window or browser while you changed it here. Your changes are not saved until you choose which version to keep.
      </span>
      <span className="notice-actions">
        <button disabled={busy} onClick={run(keepBoth)} title="Keep your version as a copy, and show the one saved elsewhere">
          Keep both
        </button>
        <button disabled={busy} onClick={run(openOther)} title="Show the version saved elsewhere. Your changes here are dropped.">
          Use the other
        </button>
        <button disabled={busy} onClick={run(keepThis)} title="Save your version over the one saved elsewhere">
          Keep mine
        </button>
      </span>
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
