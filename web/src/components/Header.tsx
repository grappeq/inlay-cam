import { useRef, useState } from "react";
import { core } from "../core/client";
import * as db from "../storage/home";
import { useFileActions } from "../state/files";
import { duplicateProject, newProject } from "../state/model";
import { loadStoredProject, message, useApp, useDispatch, type SettingsPage } from "../state/store";
import { mayLeave } from "../state/unsaved";
import { downloadText, fileStem, pickTextFile, useEscape } from "../util/files";

export function Header() {
  const { project, view, settingsPage, saveError, ready, home } = useApp();
  const inTools = view === "settings" && settingsPage === "tools";
  // The settings page last looked at, to come back to after the tools.
  const lastPage = useRef<SettingsPage>("materials");
  if (settingsPage !== "tools") lastPage.current = settingsPage;
  const dispatch = useDispatch();
  const [showProjects, setShowProjects] = useState(false);
  const { openProject } = useFileActions();
  const fail = (e: unknown) => dispatch({ type: "notice", notice: { kind: "error", text: message(e) } });

  const exportProject = async () => {
    try {
      const text = await core.call("projectToFile", project);
      downloadText(`${fileStem(project.name)}.task.json`, text);
    } catch (e) {
      fail(e);
    }
  };

  const importProject = async () => openProject(await pickTextFile(".json,application/json"));

  return (
    <header className="topbar">
      <span className="brand">Wooden Inlays</span>
      <nav className="tabs" aria-label="Views">
        <button aria-pressed={view === "design"} onClick={() => mayLeave() && dispatch({ type: "setView", view: "design" })}>
          Design
        </button>
        <button aria-pressed={inTools} onClick={() => dispatch({ type: "setView", view: "settings", page: "tools" })} title="Your tools">
          Tools
        </button>
        <button
          aria-pressed={view === "settings" && !inTools}
          onClick={() => mayLeave() && dispatch({ type: "setView", view: "settings", page: settingsPage === "tools" ? lastPage.current : settingsPage })}
          title="Your materials, profiles and machine, and what a new inlay starts with"
        >
          Settings
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
        {!ready ? "Loading…" : saveError ? `Not saved: ${saveError}` : home === "server" ? "Saved on this server" : "Saved in this browser"}
      </span>
      <div className="actions">
        <button onClick={() => mayLeave() && dispatch({ type: "openProject", project: newProject() })}>New project</button>
        <button onClick={() => setShowProjects(true)} title={home === "server" ? "Projects kept on this server" : "Projects stored in this browser"}>
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
  // The project whose menu of further actions is showing.
  const [menuFor, setMenuFor] = useState<string | null>(null);

  const open = async (id: string) => {
    try {
      dispatch({ type: "openProject", project: await loadStoredProject(id) });
      onClose();
    } catch (e) {
      dispatch({ type: "notice", notice: { kind: "error", text: message(e) } });
    }
  };

  const duplicate = async (id: string) => {
    try {
      // The open project is copied as it is on screen, which may be ahead of what is kept.
      const source = id === project.id ? project : await loadStoredProject(id);
      const copy = duplicateProject(source, projects.map((p) => p.name));
      const text = await core.call("projectToFile", copy);
      await db.putProject({ id: copy.id, name: copy.name, modified: Date.now(), text });
      dispatch({ type: "setProjects", projects: await db.listProjects() });
    } catch (e) {
      dispatch({ type: "notice", notice: { kind: "error", text: message(e) } });
    }
  };

  const remove = async (id: string, name: string) => {
    const asked =
      db.home() === "server"
        ? `Delete "${name}" from this server? It goes for everyone who opens the app here. Its file is moved to the server's backups folder.`
        : `Delete "${name}" from this browser? This cannot be undone. Export it first if you want a copy.`;
    if (!confirm(asked)) return;
    await db.deleteProject(id);
    dispatch({ type: "setProjects", projects: await db.listProjects() });
  };

  return (
    <div className="backdrop" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={db.home() === "server" ? "Projects on this server" : "Projects in this browser"}
        onClick={(e) => {
          e.stopPropagation();
          // A click anywhere else in the dialog, or on one of its items, shuts a row's menu.
          setMenuFor(null);
        }}
      >
        <h2>{db.home() === "server" ? "Projects on this server" : "Projects in this browser"}</h2>
        {projects.length === 0 && <p className="muted">Nothing stored yet. A project is stored here as soon as it has a drawing.</p>}
        <ul className="project-list">
          {projects.map((p) => {
            const isOpen = p.id === project.id;
            const name = p.name || "Untitled";
            const facts = (
              <>
                <span className="project-title">{name}</span>
                {isOpen && <span className="project-open-tag">Open</span>}
                <span className="muted project-date">{new Date(p.modified).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</span>
              </>
            );
            return (
              <li key={p.id}>
                {isOpen ? (
                  <div className="project-row">{facts}</div>
                ) : (
                  <button className="project-row" onClick={() => open(p.id)} title="Open this project">
                    {facts}
                  </button>
                )}
                <details className="menu" open={menuFor === p.id}>
                  <summary
                    aria-label={`More for ${name}`}
                    title="Duplicate or delete"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setMenuFor(menuFor === p.id ? null : p.id);
                    }}
                  >
                    ⋯
                  </summary>
                  <div className="menu-items" role="menu">
                    <button type="button" role="menuitem" onClick={() => duplicate(p.id)}>
                      Duplicate
                    </button>
                    {!isOpen && (
                      <button type="button" role="menuitem" className="danger" onClick={() => remove(p.id, p.name)}>
                        Delete…
                      </button>
                    )}
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
        <div className="row end">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
