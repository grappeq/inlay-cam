// The Projects tab: every kept project, filed in folders. The folders are on
// the left, the projects of the one picked on the right, to open, rename,
// copy, move, save as files or delete, one at a time or several.
//
// A folder is its path (state/folders.ts). Filing a project does not change
// it: on a server its file is renamed into the folder, in a browser the
// folder is noted beside it.

import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { core } from "../core/client";
import { useFileActions } from "../state/files";
import {
  MAX_FOLDER_DEPTH,
  depthOf,
  folderNameProblem,
  folderRows,
  joinFolder,
  nameOf,
  parentOf,
  refileStarts,
  shownProjects,
  startIn,
  within,
  type ProjectSort,
  type Scope,
} from "../state/folders";
import { duplicateProject, newProject } from "../state/model";
import { loadStoredProject, message, useApp, useDispatch } from "../state/store";
import { deletedText, movedText, partWayText, waitText } from "../state/several";
import { inTurn, tasks, type TaskHandle, type TaskStart } from "../state/tasks";
import { mayLeave } from "../state/unsaved";
import * as db from "../storage/home";
import { recall, remember } from "../storage/view";
import { downloadBytes, downloadText, fileStem, pickTextFile } from "../util/files";
import { zipFiles } from "../util/zip";
import { ProgressLine, Spinner, useTask, useTasks } from "./Progress";

/** What a drag of projects carries: their ids. */
const DRAGGED = "application/x-inlay-projects";

/** The key of the task that does something to several projects, one after the other. */
export const SEVERAL = "projects";
/** The key of the task that opens a kept project. */
export const openKey = (id: string) => `open:${id}`;

/** What is being named in place: a new folder in `parent`, a folder, or a project. */
type Naming = { kind: "new"; parent: string } | { kind: "folder"; path: string } | { kind: "project"; id: string };

export function ProjectsView() {
  // The folder shown is the app's (`scope`), so that the address names it.
  const { projects, folders, project, home, scope } = useApp();
  const dispatch = useDispatch();
  const { openProject: openFile } = useFileActions();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ProjectSort>(() => (recall<string>("projects.sort", "modified") === "name" ? "name" : "modified"));
  const [picked, setPicked] = useState<string[]>([]);
  const [naming, setNaming] = useState<Naming | null>(null);
  // The menu that is open, by a key of its own: one at a time.
  const [menu, setMenu] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);

  const setScope = (next: Scope) => dispatch({ type: "setScope", scope: next });
  // Another folder, however it was come to: what was ticked in the last one is let go.
  const scopeKey = scope.kind === "folder" ? `in:${scope.path}` : scope.kind;
  useEffect(() => setPicked([]), [scopeKey]);
  const fail = (e: unknown) => dispatch({ type: "notice", notice: { kind: "error", text: message(e) } });
  const info = (text: string) => dispatch({ type: "notice", notice: { kind: "info", text } });
  const refresh = useCallback(async () => dispatch({ type: "setProjects", ...(await db.readShelf()) }), [dispatch]);
  // What is being done to several projects, while it is: it takes the place of the bar that started it.
  const several = useTask(SEVERAL);
  const opening = useTasks().filter((t) => t.key.startsWith("open:"));
  /**
   * Does something to what is kept, says so when it fails, and shows what is
   * kept afterwards either way. `what` names it while it goes on: under the
   * header, unless it has a place of its own.
   */
  const run = async (work: (task: TaskHandle) => Promise<void>, what: TaskStart) => {
    setMenu(null);
    // One thing at a time is done to what is kept, and what has to wait is told so.
    // The same thing asked for again, as by a double click, is the one that is going on.
    if (tasks.find(what.key)) return;
    const going = tasks.find(SEVERAL) ?? (what.key.startsWith("open:") ? tasks.get().find((t) => t.key.startsWith("open:")) : null);
    if (going) return info(waitText(going.label));
    try {
      await tasks.run({ place: "notice", view: "projects", ...what }, work);
    } catch (e) {
      fail(e);
    }
    await refresh().catch(() => undefined);
  };
  /** What doing something to these projects is called, and how it is counted and stopped when there are several. */
  const each = (label: string, ids: string[]): TaskStart =>
    ids.length > 1 ? { key: SEVERAL, label, total: ids.length, stoppable: true, place: "inline" } : { key: SEVERAL, label, place: "notice" };

  // What is kept changes from other windows and browsers too: read when the tab is come to, and come back to.
  useEffect(() => {
    const look = () => void refresh().catch(() => undefined);
    look();
    window.addEventListener("focus", look);
    return () => window.removeEventListener("focus", look);
  }, [refresh]);

  // A project picked that is gone since.
  useEffect(() => {
    setPicked((now) => (now.every((id) => projects.some((p) => p.id === id)) ? now : now.filter((id) => projects.some((p) => p.id === id))));
  }, [projects]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onServer = home === "server";
  const here = scope.kind === "folder" ? scope.path : "";
  const shown = shownProjects(projects, scope, query, sort);
  const rows = folderRows(folders, projects);
  // What the bar acts on: the ticked projects that are shown. One that a search has hidden keeps its tick, and is left alone.
  const chosen = picked.filter((id) => shown.some((p) => p.id === id));
  const nameOfProject = (id: string) => projects.find((p) => p.id === id)?.name || "Untitled";
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  const label = (folder: string) => (folder ? folder.split("/").join(" / ") : "Unfiled");

  // ---- Projects ----

  const open = (id: string) => {
    if (id === project.id) return dispatch({ type: "setView", view: "design" });
    if (!mayLeave()) return;
    return run(async () => dispatch({ type: "openProject", project: await loadStoredProject(id) }), { key: openKey(id), label: `Opening "${nameOfProject(id)}"`, place: "inline" });
  };

  const startNew = () => {
    if (!mayLeave()) return;
    const fresh = newProject();
    startIn(fresh.id, here);
    dispatch({ type: "openProject", project: fresh });
  };

  /** A project's file text: the open one as it is on screen, which may be ahead of what is kept. */
  const textOf = async (id: string): Promise<string> => {
    if (id === project.id) return core.call("projectToFile", project);
    const stored = await db.getProject(id);
    if (!stored) throw new Error(`"${nameOfProject(id)}" is no longer kept.`);
    return stored.text;
  };

  const duplicate = (id: string) =>
    run(async () => {
      const source = id === project.id ? project : await core.call("projectFromFile", await textOf(id));
      const copy = duplicateProject(source, projects.map((p) => p.name));
      const text = await core.call("projectToFile", copy);
      const folder = projects.find((p) => p.id === id)?.folder;
      await db.putProject({ id: copy.id, name: copy.name, modified: Date.now(), text, steps: copy.steps.length, folder });
    }, { key: "projects:copy", label: `Duplicating "${nameOfProject(id)}"` });

  const rename = (id: string, name: string) =>
    run(async () => {
      if (name === (projects.find((p) => p.id === id)?.name ?? "")) return;
      // The open project is renamed as from its name at the top, and saved as every change to it is.
      if (id === project.id) return dispatch({ type: "updateProject", update: (p) => ({ ...p, name }) });
      const stored = await db.getProject(id);
      if (!stored) throw new Error("That project is no longer kept.");
      const renamed = { ...(await core.call("projectFromFile", stored.text)), name };
      const text = await core.call("projectToFile", renamed);
      const kept = await db.putProject({ id, name, modified: Date.now(), text, steps: renamed.steps.length }, stored.token);
      if (kept === "conflict") throw new Error(`"${stored.name || nameOfProject(id)}" was saved from somewhere else just now, and was not renamed. Try again.`);
    }, { key: "projects:name", label: `Renaming "${nameOfProject(id)}"` });

  const move = (ids: string[], folder: string) => {
    const going = ids.filter((id) => projects.find((p) => p.id === id)?.folder !== folder);
    return run(async (task) => {
      const { done: moved, error } = await inTurn(task, going, nameOfProject, (id) => db.moveProject(id, folder));
      // What was not moved stays ticked.
      setPicked(going.slice(moved));
      if (error) throw new Error(partWayText(moved, `moved to ${label(folder)}`, message(error)));
      // What was moved is said, also when it stopped part of the way.
      const said = movedText(moved, going.length, going.length === 1 ? nameOfProject(going[0]) : "", label(folder));
      if (said) info(said);
    }, each(`Moving to ${label(folder)}`, going));
  };

  const saveFiles = (ids: string[]) =>
    run(async (task) => {
      const taken = new Set<string>();
      const files: { name: string; text: string }[] = [];
      const { done, error } = await inTurn(task, ids, nameOfProject, async (id) => {
        const stem = fileStem(nameOfProject(id));
        let name = `${stem}.task.json`;
        for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${stem} (${n}).task.json`;
        taken.add(name.toLowerCase());
        files.push({ name, text: await textOf(id) });
      });
      if (error) throw error;
      // Stopped: nothing is saved, as a .zip of some of them would pass for all.
      if (done < ids.length) return info("Stopped: no file was saved.");
      if (files.length === 1) downloadText(files[0].name, files[0].text);
      else if (files.length > 1) downloadBytes("projects.zip", zipFiles(files), "application/zip");
    }, each("Reading the projects to save", ids));

  const remove = (ids: string[]) => {
    // The open project is on screen, and would be kept again by its next change.
    const going = ids.filter((id) => id !== project.id);
    if (going.length === 0) return info("The open project is not deleted from here. Open another one first.");
    const what = going.length === 1 ? `"${nameOfProject(going[0])}"` : plural(going.length, "project");
    const asked = onServer
      ? `Delete ${what} from this server? ${going.length === 1 ? "It goes" : "They go"} for everyone who opens the app here. ${going.length === 1 ? "Its file is" : "Their files are"} moved to the server's backups folder.`
      : `Delete ${what} from this browser? This cannot be undone. Save ${going.length === 1 ? "it" : "them"} to ${going.length === 1 ? "a file" : "files"} first if you want a copy.`;
    if (!confirm(asked)) return;
    return run(async (task) => {
      const { done: deleted, error } = await inTurn(task, going, nameOfProject, (id) => db.deleteProject(id));
      // What was not deleted stays ticked, as does the open project.
      setPicked([...going.slice(deleted), ...(going.length < ids.length ? [project.id] : [])]);
      if (error) throw new Error(partWayText(deleted, "deleted", message(error)));
      const said = deletedText(deleted, going.length);
      if (said) info(said);
    }, each("Deleting", going));
  };

  // ---- Folders ----

  const createFolder = (parent: string, name: string) =>
    run(async () => {
      const made = await db.createFolder(joinFolder(parent, name));
      setScope({ kind: "folder", path: made });
    }, { key: "projects:folder", label: `Making the folder "${name}"` });

  /** Renames a folder or moves it into another: `to` is its whole new path. The folder shown follows. */
  const renameFolder = (from: string, to: string) =>
    run(async () => {
      if (from === to) return;
      const now = await db.renameFolder(from, to);
      // A project started in it and not kept yet goes where the folder went.
      refileStarts((folder) => (within(folder, from) ? now + folder.slice(from.length) : folder));
      if (scope.kind === "folder" && within(scope.path, from)) setScope({ kind: "folder", path: now + scope.path.slice(from.length) });
    }, { key: "projects:folder", label: `Moving the folder "${nameOf(from)}"` });

  const deleteFolder = (path: string) => {
    const inside = folders.filter((other) => other !== path && within(other, path)).length;
    const held = projects.filter((p) => within(p.folder, path)).length;
    const asked =
      `Delete the folder "${label(path)}"${inside > 0 ? ` and the ${plural(inside, "folder")} in it` : ""}?` +
      (held > 0 ? ` ${held === 1 ? "Its project is" : `The ${held} projects in it are`} kept, and ${held === 1 ? "goes" : "go"} to Unfiled.` : "");
    if (!confirm(asked)) return;
    return run(async () => {
      await db.deleteFolder(path);
      refileStarts((folder) => (within(folder, path) ? "" : folder));
    }, { key: "projects:folder", label: `Deleting the folder "${nameOf(path)}"` });
  };

  // ---- Dragging projects onto a folder ----

  const dragStart = (e: DragEvent, id: string) => {
    const ids = picked.includes(id) ? picked : [id];
    e.dataTransfer.setData(DRAGGED, JSON.stringify(ids));
    e.dataTransfer.effectAllowed = "move";
  };
  const dropTarget = (key: string, folder: string) => ({
    "data-drop": dropOn === key || undefined,
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAGGED)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDropOn(key);
    },
    onDragLeave: () => setDropOn((now) => (now === key ? null : now)),
    onDrop: (e: DragEvent) => {
      setDropOn(null);
      let ids: unknown;
      try {
        ids = JSON.parse(e.dataTransfer.getData(DRAGGED));
      } catch {
        return;
      }
      if (!Array.isArray(ids)) return;
      e.preventDefault();
      void move(
        ids.filter((id): id is string => typeof id === "string" && projects.some((p) => p.id === id)),
        folder,
      );
    },
  });

  const toggle = (key: string) => setMenu(menu === key ? null : key);
  const allPicked = shown.length > 0 && shown.every((p) => picked.includes(p.id));
  const count = (n: number) => <span className="count">{n}</span>;

  return (
    <div className="projects-split" onClick={() => setMenu(null)}>
      <nav className="pf-nav" aria-label="Folders">
        <button className="pf-folder" aria-current={scope.kind === "all" ? "page" : undefined} onClick={() => setScope({ kind: "all" })}>
          <span className="pf-folder-name">All projects</span>
          {count(projects.length)}
        </button>
        <button className="pf-folder" aria-current={scope.kind === "unfiled" ? "page" : undefined} onClick={() => setScope({ kind: "unfiled" })} title="Projects in no folder" {...dropTarget("unfiled", "")}>
          <span className="pf-folder-name">Unfiled</span>
          {count(projects.filter((p) => p.folder === "").length)}
        </button>
        <div className="pf-tree">
          {rows.map((row) => {
            const key = `f:${row.path}`;
            const current = scope.kind === "folder" && scope.path === row.path;
            const indent = { paddingLeft: 10 + row.depth * 16 };
            if (naming?.kind === "folder" && naming.path === row.path) {
              return (
                <div key={row.path} className="pf-naming" style={indent}>
                  <NameInput
                    label={`New name for the folder ${row.name}`}
                    initial={row.name}
                    problem={(name) => folderNameProblem(name) ?? (folders.some((other) => other !== row.path && other.toLowerCase() === joinFolder(parentOf(row.path), name).toLowerCase()) ? "There is one already" : null)}
                    onDone={(name) => {
                      setNaming(null);
                      if (name !== null) void renameFolder(row.path, joinFolder(parentOf(row.path), name));
                    }}
                  />
                </div>
              );
            }
            return (
              <div key={row.path} className="pf-folder-line">
                <button className="pf-folder" style={indent} aria-current={current ? "page" : undefined} onClick={() => setScope({ kind: "folder", path: row.path })} {...dropTarget(key, row.path)}>
                  <span className="pf-folder-name">{row.name}</span>
                  {count(row.count)}
                </button>
                <Menu label={`More for the folder ${row.name}`} title="Rename, move or delete" open={menu === key || menu === `${key}:move`} onToggle={() => toggle(key)}>
                  {menu === `${key}:move` ? (
                    <FolderPick
                      folders={folders.filter((other) => !within(other, row.path) && depthOf(other) + 1 + Math.max(0, ...folders.filter((f) => within(f, row.path)).map((f) => depthOf(f) - depthOf(row.path))) <= MAX_FOLDER_DEPTH)}
                      current={parentOf(row.path)}
                      none="Top level"
                      onPick={(parent) => void renameFolder(row.path, joinFolder(parent, row.name))}
                    />
                  ) : (
                    <>
                      <button type="button" role="menuitem" onClick={() => (setMenu(null), setNaming({ kind: "folder", path: row.path }))}>
                        Rename
                      </button>
                      {depthOf(row.path) < MAX_FOLDER_DEPTH && (
                        <button type="button" role="menuitem" onClick={() => (setMenu(null), setNaming({ kind: "new", parent: row.path }))}>
                          New folder inside
                        </button>
                      )}
                      <button
                        type="button"
                        role="menuitem"
                        onClick={(e) => {
                          e.stopPropagation();
                          setMenu(`${key}:move`);
                        }}
                      >
                        Move to…
                      </button>
                      <button type="button" role="menuitem" className="danger" onClick={() => void deleteFolder(row.path)}>
                        Delete…
                      </button>
                    </>
                  )}
                </Menu>
                {naming?.kind === "new" && naming.parent === row.path && (
                  <div className="pf-naming" style={{ paddingLeft: 10 + (row.depth + 1) * 16 }}>
                    <NewFolder parent={row.path} folders={folders} onDone={(name) => (setNaming(null), name !== null && void createFolder(row.path, name))} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {naming?.kind === "new" && naming.parent === "" ? (
          <div className="pf-naming">
            <NewFolder parent="" folders={folders} onDone={(name) => (setNaming(null), name !== null && void createFolder("", name))} />
          </div>
        ) : (
          <button className="pf-new" onClick={() => setNaming({ kind: "new", parent: "" })}>
            + New folder
          </button>
        )}
        <p className="set-nav-foot">{onServer ? "Kept on this server, for everyone who opens it." : "Kept in this browser."}</p>
      </nav>

      <main className="pf-main">
        <div className="pf-bar">
          <h2 className="pf-title">{scope.kind === "all" ? "All projects" : label(here)}</h2>
          <input className="pf-search" type="text" aria-label="Search projects by name" placeholder="Search by name" value={query} onChange={(e) => setQuery(e.target.value)} />
          <select
            aria-label="Order"
            value={sort}
            onChange={(e) => {
              const next = e.target.value === "name" ? "name" : "modified";
              setSort(next);
              remember("projects.sort", next);
            }}
          >
            <option value="modified">Last changed</option>
            <option value="name">Name</option>
          </select>
          <button onClick={async () => mayLeave() && openFile(await pickTextFile(".json,application/json"))} title="Open a project file from disk">
            Open file…
          </button>
          <button className="primary" onClick={startNew} title={here ? `Start a project in ${label(here)}` : "Start a project"}>
            New project
          </button>
        </div>

        {several?.shown && several.place === "inline" ? (
          <div className="pf-picked">
            <ProgressLine task={several} />
          </div>
        ) : chosen.length > 0 && (
          <div className="pf-picked" role="toolbar" aria-label="The selected projects">
            <span>{chosen.length} selected</span>
            <Menu label="Move the selected projects to a folder" text="Move to…" open={menu === "picked"} onToggle={() => toggle("picked")} left>
              <FolderPick folders={folders} current={sameFolderOf(chosen, projects)} none="Unfiled" onPick={(folder) => void move(chosen, folder)} />
            </Menu>
            <button onClick={() => void saveFiles(chosen)} title={chosen.length > 1 ? "As project files, in one .zip" : "As a project file"}>
              {chosen.length > 1 ? "Save to files" : "Save to file"}
            </button>
            <button className="danger" onClick={() => void remove(chosen)}>
              Delete…
            </button>
            <button className="link" onClick={() => setPicked([])}>
              Clear
            </button>
          </div>
        )}

        {shown.length === 0 ? (
          <p className="muted pf-empty">
            {query.trim() ? "No project here has that in its name." : projects.length === 0 ? "Nothing kept yet. A project is kept as soon as it has a drawing." : scope.kind === "folder" ? "Nothing in this folder. Drag projects onto it, or start a new one here." : "Every project is in a folder."}
          </p>
        ) : (
          <ul className="pf-list">
            <li className="pf-head">
              <input
                type="checkbox"
                aria-label="Select all shown"
                checked={allPicked}
                onChange={() => setPicked(allPicked ? picked.filter((id) => !shown.some((p) => p.id === id)) : [...new Set([...picked, ...shown.map((p) => p.id)])])}
              />
              <span>{plural(shown.length, "project")}</span>
            </li>
            {shown.map((p) => {
              const isOpen = p.id === project.id;
              const name = p.name || "Untitled";
              const key = `p:${p.id}`;
              return (
                <li key={p.id} className="pf-row" data-picked={picked.includes(p.id) || undefined} draggable={naming?.kind !== "project" || naming.id !== p.id} onDragStart={(e) => dragStart(e, p.id)}>
                  <input type="checkbox" aria-label={`Select ${name}`} checked={picked.includes(p.id)} onChange={() => setPicked(picked.includes(p.id) ? picked.filter((id) => id !== p.id) : [...picked, p.id])} />
                  {naming?.kind === "project" && naming.id === p.id ? (
                    <NameInput
                      label={`New name for ${name}`}
                      initial={p.name}
                      problem={() => null}
                      onDone={(next) => {
                        setNaming(null);
                        if (next !== null) void rename(p.id, next);
                      }}
                    />
                  ) : (
                    <button className="pf-open" aria-busy={opening.some((t) => t.key === openKey(p.id)) || undefined} onClick={() => void open(p.id)} title={isOpen ? "Go to this project" : "Open this project"}>
                      {opening.some((t) => t.shown && t.key === openKey(p.id)) && <Spinner />}
                      <span className="pf-name">{name}</span>
                      {isOpen && <span className="project-open-tag">Open</span>}
                      {p.folder !== here && <span className="muted pf-in">{label(p.folder)}</span>}
                    </button>
                  )}
                  <span className="muted pf-facts">
                    {p.steps !== undefined && `${plural(p.steps, "step")} · `}
                    {new Date(p.modified).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                  </span>
                  <Menu label={`More for ${name}`} title="Rename, copy, move, save or delete" open={menu === key || menu === `${key}:move`} onToggle={() => toggle(key)}>
                    {menu === `${key}:move` ? (
                      <FolderPick folders={folders} current={p.folder} none="Unfiled" onPick={(folder) => void move([p.id], folder)} />
                    ) : (
                      <>
                        <button type="button" role="menuitem" onClick={() => (setMenu(null), setNaming({ kind: "project", id: p.id }))}>
                          Rename
                        </button>
                        <button type="button" role="menuitem" onClick={() => void duplicate(p.id)}>
                          Duplicate
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={(e) => {
                            e.stopPropagation();
                            setMenu(`${key}:move`);
                          }}
                        >
                          Move to…
                        </button>
                        <button type="button" role="menuitem" onClick={() => void saveFiles([p.id])}>
                          Save to file
                        </button>
                        {!isOpen && (
                          <button type="button" role="menuitem" className="danger" onClick={() => void remove([p.id])}>
                            Delete…
                          </button>
                        )}
                      </>
                    )}
                  </Menu>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </div>
  );
}

/** The folder all of some projects are in; undefined when they are in several. */
function sameFolderOf(ids: string[], projects: db.ProjectSummary[]): string | undefined {
  const folders = new Set(ids.map((id) => projects.find((p) => p.id === id)?.folder ?? ""));
  return folders.size === 1 ? [...folders][0] : undefined;
}

/** A button that opens a short list of actions: "⋯" unless it has a text. One is open at a time, which the view keeps. */
function Menu(props: { label: string; title?: string; text?: string; open: boolean; onToggle: () => void; left?: boolean; children: ReactNode }) {
  return (
    <details className={`menu pf-menu${props.text ? " worded" : ""}${props.left ? " left" : ""}`} open={props.open}>
      <summary
        aria-label={props.text ? undefined : props.label}
        title={props.title ?? props.label}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          props.onToggle();
        }}
      >
        {props.text ?? "⋯"}
      </summary>
      {props.open && (
        <div className="menu-items" role="menu">
          {props.children}
        </div>
      )}
    </details>
  );
}

/** The folders to move something to, the one it is in marked. `none` names the choice of no folder. */
function FolderPick(props: { folders: string[]; current: string | undefined; none: string; onPick: (folder: string) => void }) {
  const item = (path: string, text: string, depth: number) => (
    <button key={path} type="button" role="menuitemradio" aria-checked={props.current === path} disabled={props.current === path} style={{ paddingLeft: 10 + depth * 14 }} onClick={() => props.onPick(path)}>
      {text}
    </button>
  );
  return (
    <div className="pf-pick">
      {item("", props.none, 0)}
      {props.folders.map((path) => item(path, nameOf(path), depthOf(path) - 1))}
    </div>
  );
}

/** A name typed in place. Enter, or leaving the field for something else on the page, takes it when it can be one; Escape leaves things as they were. `onDone` gets null when nothing is to change. */
function NameInput(props: { label: string; initial: string; placeholder?: string; problem: (name: string) => string | null; onDone: (name: string | null) => void }) {
  const [name, setName] = useState(props.initial);
  const done = useRef(false);
  const problem = name === props.initial ? null : props.problem(name);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    props.onDone(value);
  };
  return (
    <span className="pf-name-input">
      <input
        type="text"
        aria-label={props.label}
        aria-invalid={problem !== null}
        placeholder={props.placeholder}
        autoFocus
        value={name}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setName(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            finish(null);
          } else if (e.key === "Enter" && problem === null) finish(name === props.initial ? null : name);
        }}
        onBlur={() => {
          // Another window was turned to: the name is still being typed, and the field has the focus again on coming back.
          if (!document.hasFocus()) return;
          finish(problem === null && name !== props.initial ? name : null);
        }}
      />
      {problem !== null && (
        <span className="pf-problem" role="alert">
          {problem}
        </span>
      )}
    </span>
  );
}

/** The name of a folder to make in `parent`. */
function NewFolder(props: { parent: string; folders: string[]; onDone: (name: string | null) => void }) {
  return (
    <NameInput
      label={props.parent ? `Name of the new folder in ${nameOf(props.parent)}` : "Name of the new folder"}
      initial=""
      placeholder="Folder name"
      problem={(name) => folderNameProblem(name) ?? (props.folders.some((other) => other.toLowerCase() === joinFolder(props.parent, name).toLowerCase()) ? "There is one already" : null)}
      onDone={props.onDone}
    />
  );
}
