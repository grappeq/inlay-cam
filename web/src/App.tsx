import { useEffect, useState, type DragEvent } from "react";
import { DesignCanvas } from "./components/DesignCanvas";
import { DesignPanel, useImportSvg } from "./components/DesignPanel";
import { FitView } from "./components/FitView";
import { Header } from "./components/Header";
import { ToolsView } from "./components/ToolsView";
import { Viewer3D } from "./components/Viewer3D";
import { useFileActions } from "./state/files";
import { AppProvider, useApp, useDispatch } from "./state/store";

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
  const { project, output, fit, activeJobId } = useApp();
  const importSvg = useImportSvg();
  const preview = output !== null && output.jobId === activeJobId ? output.preview : null;
  const check = fit !== null && fit.jobId === activeJobId ? fit.check : null;
  const [mode, setMode] = useState<"drawing" | "preview" | "fit">("drawing");

  // A fresh result is what the user asked to see.
  useEffect(() => {
    setMode(preview ? "preview" : "drawing");
  }, [preview]);
  useEffect(() => {
    if (check) setMode("fit");
    else setMode((m) => (m === "fit" ? "drawing" : m));
  }, [check]);

  return (
    <div className="design-view">
      <main className="stage">
        {(preview || check) && (
          <nav className="tabs stage-tabs" aria-label="Stage">
            <button aria-pressed={mode === "drawing"} onClick={() => setMode("drawing")}>
              Drawing
            </button>
            {preview && (
              <button aria-pressed={mode === "preview"} onClick={() => setMode("preview")}>
                3D preview
              </button>
            )}
            {check && (
              <button aria-pressed={mode === "fit"} onClick={() => setMode("fit")}>
                Fit
              </button>
            )}
          </nav>
        )}
        {check && mode === "fit" ? (
          <FitView fit={check} />
        ) : preview && mode === "preview" ? (
          <Viewer3D preview={preview} thickness={preview.built.stock.thickness} />
        ) : project.design ? (
          <DesignCanvas design={project.design} narrow={preview?.built.narrow ?? []} cuttable={preview?.built.cuttable ?? []} />
        ) : (
          <div className="empty">
            <p>No design yet.</p>
            <button className="primary" onClick={importSvg}>
              Import SVG…
            </button>
          </div>
        )}
      </main>
      <DesignPanel />
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
