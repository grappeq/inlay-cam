import { useState } from "react";
import { core } from "../core/client";
import * as db from "../storage/db";
import { useFileActions } from "../state/files";
import { newProject } from "../state/model";
import { loadStoredProject, message, useApp, useDispatch } from "../state/store";
import { downloadText, fileStem, pickTextFile, useEscape } from "../util/files";

export function Header() {
  const { project, view, saveError, ready, tools } = useApp();
  const dispatch = useDispatch();
  const [showProjects, setShowProjects] = useState(false);
  const { openProject } = useFileActions();
  const fail = (e: unknown) => dispatch({ type: "notice", notice: { kind: "error", text: message(e) } });

  const exportProject = async () => {
    try {
      const text = await core.call("projectToFile", project);
      downloadText(`${fileStem(project.name)}.inlay.json`, text);
    } catch (e) {
      fail(e);
    }
  };

  const importProject = async () => openProject(await pickTextFile(".json,application/json"));

  return (
    <header className="topbar">
      <span className="brand">Wooden Inlays</span>
      <nav className="tabs" aria-label="Views">
        <button aria-pressed={view === "design"} onClick={() => dispatch({ type: "setView", view: "design" })}>
          Design
        </button>
        <button aria-pressed={view === "tools"} onClick={() => dispatch({ type: "setView", view: "tools" })}>
          Tools{tools.length > 0 ? ` (${tools.length})` : ""} and machine
        </button>
      </nav>
      <input
        className="project-name"
        type="text"
        aria-label="Project name"
        value={project.name}
        onChange={(e) => dispatch({ type: "updateProject", update: (p) => ({ ...p, name: e.target.value }) })}
      />
      <span className={`save-state${saveError ? " error" : ""}`} role="status">
        {!ready ? "Loading…" : saveError ? `Not saved: ${saveError}` : "Saved in this browser"}
      </span>
      <div className="actions">
        <button onClick={() => dispatch({ type: "openProject", project: newProject() })}>New project</button>
        <button onClick={() => setShowProjects(true)} title="Projects stored in this browser">
          Projects…
        </button>
        <button onClick={importProject} title="Open a project file from disk">
          Open file…
        </button>
        <button onClick={exportProject} title="Save this project as a file, to keep or to move to another computer">
          Save to file
        </button>
      </div>
      {showProjects && <ProjectsDialog onClose={() => setShowProjects(false)} />}
    </header>
  );
}

function ProjectsDialog({ onClose }: { onClose: () => void }) {
  const { projects, project } = useApp();
  useEscape(onClose);
  const dispatch = useDispatch();

  const open = async (id: string) => {
    try {
      dispatch({ type: "openProject", project: await loadStoredProject(id) });
      onClose();
    } catch (e) {
      dispatch({ type: "notice", notice: { kind: "error", text: message(e) } });
    }
  };

  const remove = async (id: string, name: string) => {
    if (!confirm(`Delete "${name}" from this browser? This cannot be undone. Export it first if you want a copy.`)) return;
    await db.deleteProject(id);
    dispatch({ type: "setProjects", projects: await db.listProjects() });
  };

  return (
    <div className="backdrop" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Projects in this browser" onClick={(e) => e.stopPropagation()}>
        <h2>Projects in this browser</h2>
        {projects.length === 0 && <p className="muted">Nothing stored yet. A project is stored here as soon as it has a drawing.</p>}
        <ul className="project-list">
          {projects.map((p) => (
            <li key={p.id}>
              <span className="project-title">
                {p.name || "Untitled"}
                {p.id === project.id && <span className="muted"> (open)</span>}
              </span>
              <span className="muted">{new Date(p.modified).toLocaleString()}</span>
              <button disabled={p.id === project.id} onClick={() => open(p.id)}>
                Open
              </button>
              <button className="danger" disabled={p.id === project.id} onClick={() => remove(p.id, p.name)}>
                Delete
              </button>
            </li>
          ))}
        </ul>
        <div className="row end">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
