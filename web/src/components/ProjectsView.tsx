// The Projects tab: every kept project, filed in folders. The folders are on
// the left, what is right in the one picked on the right: its folders, then
// its projects, to open, rename, copy, move, save as files or delete, one at
// a time or several. A move, a copy and what is done to a folder can be
// undone from the notice that says it was done.
//
// A folder is its path (state/folders.ts). Filing a project does not change
// it: on a server its file is renamed into the folder, in a browser the
// folder is noted beside it.

import { useCallback, useEffect, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { core } from "../core/client";
import { useFileActions } from "../state/files";
import {
  MAX_FOLDER_DEPTH,
  byFolder,
  undoMove,
  depthOf,
  folderNameProblem,
  folderRows,
  heldBy,
  joinFolder,
  missingFolders,
  nameOf,
  parentOf,
  refileStarts,
  resolveFolder,
  shownFolders,
  shownProjects,
  startIn,
  rowShowing,
  unfoldTo,
  unfoldedRows,
  within,
  type FolderRow,
  type ProjectSort,
  type Scope,
} from "../state/folders";
import { duplicateProject, newProject } from "../state/model";
import { loadStoredProject, message, useApp, useDispatch } from "../state/store";
import { deletedText, movedText, partWayText, waitText } from "../state/several";
import { inTurn, tasks, type TaskHandle, type TaskStart } from "../state/tasks";
import { fillThumbs, thumbOf } from "../state/thumbs";
import { mayLeave } from "../state/unsaved";
import * as db from "../storage/home";
import type { Thumb } from "../storage/db";
import { keptText, placeName } from "../storage/places";
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

/** What is being named in place: a new folder in `parent`, a folder, on the left or in the list, or a project. */
type Naming = { kind: "new"; parent: string } | { kind: "folder"; path: string; where: "nav" | "list" } | { kind: "project"; id: string };

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
  // Projects are being dragged: every folder they can be dropped on says so.
  const [dragging, setDragging] = useState(false);
  // The folders whose folders are not listed on the left.
  const [folded, setFolded] = useState<string[]>(() => {
    const kept = recall<unknown>("projects.folded", []);
    return Array.isArray(kept) ? kept.filter((path): path is string => typeof path === "string") : [];
  });
  // On a narrow screen the folders fold away above the list, and are opened to pick one.
  const [foldersOpen, setFoldersOpen] = useState(false);

  const setScope = (next: Scope) => dispatch({ type: "setScope", scope: next });
  const fold = (next: string[]) => {
    setFolded(next);
    remember("projects.folded", next);
  };
  // Another folder, however it was come to: what was ticked in the last one is let go, and so is the search, unless it was carried along.
  const scopeKey = scope.kind === "folder" ? `in:${scope.path}` : scope.kind;
  const keepQuery = useRef(false);
  useEffect(() => {
    setPicked([]);
    setFoldersOpen(false);
    if (!keepQuery.current) setQuery("");
    keepQuery.current = false;
    // The folder shown is seen on the left, whatever it is in.
    if (scope.kind === "folder") setFolded((now) => unfoldTo(now, scope.path));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);
  const fail = (e: unknown) => dispatch({ type: "notice", notice: { kind: "error", text: message(e) } });
  const info = (text: string, undo?: () => void) => dispatch({ type: "notice", notice: { kind: "info", text, action: undo ? { label: "Undo", run: undo } : undefined } });
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
    // Not while something is done to what is kept: what it shows at once would be read back from part of the way, and jump.
    const look = () => {
      if (tasks.get().some((t) => t.key === SEVERAL || t.key.startsWith("projects:"))) return;
      void refresh().catch(() => undefined);
    };
    look();
    window.addEventListener("focus", look);
    return () => window.removeEventListener("focus", look);
  }, [refresh]);

  // Projects kept before there were pictures are given theirs, once.
  useEffect(() => {
    if (projects.some((p) => p.thumb === undefined)) void fillThumbs(projects).then((any) => {
        if (any) void refresh().catch(() => undefined);
      });
  }, [projects, refresh]);

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
  const searching = query.trim() !== "";
  const shown = shownProjects(projects, scope, query, sort);
  const subfolders = shownFolders(folders, scope, query);
  const rows = folderRows(folders, projects);
  const rowOf = (path: string) => rows.find((row) => row.path === path);
  // What the bar acts on: the ticked projects that are shown. One that a search has hidden keeps its tick, and is left alone.
  const chosen = picked.filter((id) => shown.some((p) => p.id === id));
  const nameOfProject = (id: string) => projects.find((p) => p.id === id)?.name || "Untitled";
  const folderOfProject = (id: string) => projects.find((p) => p.id === id)?.folder ?? "";
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  const label = (folder: string) => (folder ? folder.split("/").join(" / ") : "Unfiled");
  /** What a folder holds, in a few words. */
  const holds = (row: FolderRow | undefined) => {
    if (!row || (row.count === 0 && row.folders === 0)) return "Empty";
    return [row.folders > 0 ? plural(row.folders, "folder") : "", row.count > 0 ? plural(row.count, "project") : ""].filter(Boolean).join(" · ");
  };

  // What Undo does is done by the view as it is when it is pressed, not as it was when the work was.
  const later = useRef<Later>(null as unknown as Later);

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
      const folder = folderOfProject(id);
      await db.putProject({ id: copy.id, name: copy.name, modified: Date.now(), text, steps: copy.steps.length, folder, thumb: await thumbOf(copy.design) });
      info(`Duplicated as "${copy.name}"${folder === here || scope.kind === "all" ? "" : `, in ${label(folder)}`}.`, () => void later.current.unduplicate(copy.id, copy.name, text));
    }, { key: "projects:copy", label: `Duplicating "${nameOfProject(id)}"` });

  /** Takes away a copy that was just made, `text` as it was made: one that was changed since is kept. */
  const unduplicate = (id: string, name: string, text: string) =>
    run(async () => {
      if (id === project.id) throw new Error(`"${name}" is open now, and is not deleted from here.`);
      const stored = await db.getProject(id);
      if (!stored) return info(`"${name}" is gone already.`);
      if (stored.text !== text) throw new Error(`"${name}" was changed since it was made, and is kept. Delete it from its menu if you want it gone.`);
      await db.deleteProject(id);
      info(`"${name}" deleted.`);
    }, { key: SEVERAL, label: `Deleting "${name}"` });

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
    const going = ids.filter((id) => folderOfProject(id) !== folder);
    // Where each was, to put it back.
    const from = going.map((id) => ({ id, folder: folderOfProject(id) }));
    return run(async (task) => {
      // Shown where it goes at once; what is kept is read again when it is over.
      dispatch({ type: "refileProjects", ids: going, folder });
      const { done: moved, error } = await inTurn(task, going, nameOfProject, (id) => db.moveProject(id, folder));
      // What was moved is no longer ticked; what was not, and what else was, stays so.
      const gone = going.slice(0, moved);
      setPicked((now) => now.filter((id) => !gone.includes(id)));
      if (error) throw new Error(partWayText(moved, `moved to ${label(folder)}`, message(error)));
      // What was moved is said, also when it stopped part of the way.
      const said = movedText(moved, going.length, going.length === 1 ? nameOfProject(going[0]) : "", label(folder));
      if (said) info(said, moved > 0 ? () => void later.current.putBack(from.slice(0, moved), folder) : undefined);
    }, each(`Moving to ${label(folder)}`, going));
  };

  /** Files projects that were moved to `to` again where they were; one moved again since, or gone, is left as it is. */
  const putBack = (places: { id: string; folder: string }[], to: string) => {
    const { back, left } = undoMove(places, to, projects);
    const stays = left > 0 ? ` ${left === 1 ? "One was" : `${left} were`} moved again or deleted since, and ${left === 1 ? "is" : "are"} left as ${left === 1 ? "it is" : "they are"}.` : "";
    if (back.length === 0) return info(`Nothing to put back.${stays}`);
    return run(async (task) => {
      for (const [folder, ids] of byFolder(back)) dispatch({ type: "refileProjects", ids, folder });
      const { done, error } = await inTurn(task, back, (place) => nameOfProject(place.id), (place) => db.moveProject(place.id, place.folder));
      if (error) throw new Error(partWayText(done, "put back", message(error)));
      info((back.length === 1 ? `"${nameOfProject(back[0].id)}" is back in ${label(back[0].folder)}.` : `${plural(done, "project")} put back.`) + stays);
    }, each("Putting back", back.map((place) => place.id)));
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
      : home === "folder"
        ? `Delete ${what} from ${placeName(home)}? ${going.length === 1 ? "Its file is" : "Their files are"} moved to the folder's backups folder.`
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

  /** Renames a folder or moves it into another: `to` is its whole new path. The folder shown follows. Said, with an Undo, unless it is the undoing. */
  const renameFolder = (from: string, to: string, undoing = false) =>
    run(async () => {
      if (from === to) return;
      const now = await db.renameFolder(from, to);
      // A project started in it and not kept yet goes where the folder went.
      refileStarts((folder) => (within(folder, from) ? now + folder.slice(from.length) : folder));
      if (scope.kind === "folder" && within(scope.path, from)) setScope({ kind: "folder", path: now + scope.path.slice(from.length) });
      // A folder folded up stays so under its new name.
      if (folded.some((path) => within(path, from))) fold(folded.map((path) => (within(path, from) ? now + path.slice(from.length) : path)));
      if (undoing) return info(`The folder "${nameOf(now)}" is back in ${parentOf(now) ? label(parentOf(now)) : "the top level"}.`);
      const said =
        parentOf(from).toLowerCase() === parentOf(now).toLowerCase()
          ? `The folder "${nameOf(from)}" is now "${nameOf(now)}".`
          : `The folder "${nameOf(now)}" moved to ${parentOf(now) ? label(parentOf(now)) : "the top level"}.`;
      info(said, () => void later.current.renameFolder(now, from, true));
    }, { key: "projects:folder", label: `Moving the folder "${nameOf(from)}"` });

  const deleteFolder = (path: string) => {
    const inside = folders.filter((other) => other !== path && within(other, path)).length;
    const held = projects.filter((p) => within(p.folder, path)).length;
    const asked =
      `Delete the folder "${label(path)}"${inside > 0 ? ` and the ${plural(inside, "folder")} in it` : ""}?` +
      (held > 0 ? ` ${held === 1 ? "Its project is" : `The ${held} projects in it are`} kept, and ${held === 1 ? "goes" : "go"} to Unfiled.` : "");
    if (!confirm(asked)) return;
    // What it held, to put back.
    const was = heldBy(folders, projects, path);
    return run(async () => {
      await db.deleteFolder(path);
      refileStarts((folder) => (within(folder, path) ? "" : folder));
      info(`The folder "${nameOf(path)}" is deleted${held > 0 ? `; ${held === 1 ? "its project is" : `its ${held} projects are`} in Unfiled` : ""}.`, () => void later.current.undelete(path, was));
    }, { key: "projects:folder", label: `Deleting the folder "${nameOf(path)}"` });
  };

  /** Makes a deleted folder again, with the folders that were in it, and files its projects in them again. */
  const undelete = (path: string, was: ReturnType<typeof heldBy>) =>
    run(async () => {
      const now = (await db.readShelf()).folders;
      const missing = missingFolders(now, was.folders);
      // One of that name was made since: what was in the deleted one goes into it.
      const madeSince = !missing.some((folder) => folder.toLowerCase() === path.toLowerCase());
      for (const folder of missing) await db.createFolder(folder);
      let lost = 0;
      for (const place of was.projects) {
        await db.moveProject(place.id, place.folder).catch(() => lost++);
      }
      const spelt = nameOf(resolveFolder(now, path));
      const lostText = lost > 0 ? ` ${plural(lost, "project")} that ${lost === 1 ? "was" : "were"} in it ${lost === 1 ? "is" : "are"} no longer kept.` : "";
      info((madeSince ? `What was in the folder "${nameOf(path)}" is back, in the folder "${spelt}" made since.` : `The folder "${nameOf(path)}" is back.`) + lostText);
    }, { key: "projects:folder", label: `Putting the folder "${nameOf(path)}" back` });

  later.current = { putBack, unduplicate, renameFolder, undelete };

  // ---- Dragging projects onto a folder ----

  const dragStart = (e: DragEvent, id: string) => {
    // The ticked projects that are shown, as the bar takes them: one a search hides is left alone.
    const ids = chosen.includes(id) ? chosen : [id];
    e.dataTransfer.setData(DRAGGED, JSON.stringify(ids));
    e.dataTransfer.effectAllowed = "move";
    setDragging(true);
  };
  // However the drag ends, dropped, given up or let go elsewhere, nothing is marked any more.
  const dragEnd = () => {
    setDragging(false);
    setDropOn(null);
  };
  const dropTarget = (key: string, folder: string) => ({
    "data-drop": dropOn === key || undefined,
    "data-target": true,
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAGGED)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDropOn(key);
    },
    onDragLeave: () => setDropOn((now) => (now === key ? null : now)),
    onDrop: (e: DragEvent) => {
      dragEnd();
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
  /** A right click opens a line's own menu, not the browser's; in a name being typed it is the browser's. */
  const contextMenu = (key: string) => (e: ReactMouseEvent) => {
    if (e.target instanceof HTMLInputElement) return;
    e.preventDefault();
    e.stopPropagation();
    setMenu(key);
  };
  const allPicked = shown.length > 0 && shown.every((p) => picked.includes(p.id));
  const count = (n: number) => <span className="count">{n}</span>;

  /** The menu of a folder, on the left (`nav`) or in the list. */
  const folderMenu = (path: string, where: "nav" | "list") => {
    const key = `${where === "nav" ? "f" : "l"}:${path}`;
    const name = nameOf(path);
    return (
      <Menu label={`More for the folder ${name}`} title="Rename, move or delete" open={menu === key || menu === `${key}:move`} onToggle={() => toggle(key)}>
        {menu === `${key}:move` ? (
          <FolderPick
            folders={folders.filter((other) => !within(other, path) && depthOf(other) + 1 + Math.max(0, ...folders.filter((f) => within(f, path)).map((f) => depthOf(f) - depthOf(path))) <= MAX_FOLDER_DEPTH)}
            current={parentOf(path)}
            none="Top level"
            onPick={(parent) => void renameFolder(path, joinFolder(parent, name))}
          />
        ) : (
          <>
            <button type="button" role="menuitem" onClick={() => (setMenu(null), setNaming({ kind: "folder", path, where }))}>
              Rename
            </button>
            {depthOf(path) < MAX_FOLDER_DEPTH && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(null);
                  if (folded.includes(path)) fold(folded.filter((other) => other !== path));
                  setFoldersOpen(true);
                  setNaming({ kind: "new", parent: path });
                }}
              >
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
            <button type="button" role="menuitem" className="danger" onClick={() => void deleteFolder(path)}>
              Delete…
            </button>
          </>
        )}
      </Menu>
    );
  };

  /** A folder's name, typed in place of it. */
  const folderNaming = (path: string) => (
    <NameInput
      label={`New name for the folder ${nameOf(path)}`}
      initial={nameOf(path)}
      problem={(name) => folderNameProblem(name) ?? (folders.some((other) => other !== path && other.toLowerCase() === joinFolder(parentOf(path), name).toLowerCase()) ? "There is one already" : null)}
      onDone={(name) => {
        setNaming(null);
        if (name !== null) void renameFolder(path, joinFolder(parentOf(path), name));
      }}
    />
  );

  const title =
    scope.kind === "all" ? (
      "All projects"
    ) : scope.kind === "unfiled" ? (
      "Unfiled"
    ) : (
      // The folders it is in, each a step up.
      <>
        {here.split("/").map((name, i, names) => {
          const path = names.slice(0, i + 1).join("/");
          return i < names.length - 1 ? (
            <span key={path}>
              <button className="link pf-crumb" onClick={() => setScope({ kind: "folder", path })} title={`Show ${name}`}>
                {name}
              </button>
              <span className="pf-crumb-sep"> / </span>
            </span>
          ) : (
            <span key={path}>{name}</span>
          );
        })}
      </>
    );
  const where = scope.kind === "all" ? "All projects" : label(here);
  const seenRows = unfoldedRows(rows, folded);
  const showing = scope.kind === "folder" ? rowShowing(seenRows, here) : undefined;

  return (
    <div className="projects-split" onClick={() => setMenu(null)} data-dragging={dragging || undefined}>
      <nav className="pf-nav" aria-label="Folders">
        <button className="pf-drawer" aria-expanded={foldersOpen} onClick={(e) => (e.stopPropagation(), setFoldersOpen(!foldersOpen))}>
          <span className="muted">Folders:</span> <span className="pf-folder-name">{where}</span>
          <span aria-hidden="true">{foldersOpen ? "▴" : "▾"}</span>
        </button>
        <div className="pf-nav-body" data-open={foldersOpen || undefined}>
          <button className="pf-folder" aria-current={scope.kind === "all" ? "page" : undefined} onClick={() => setScope({ kind: "all" })}>
            <span className="pf-folder-name">All projects</span>
            {count(projects.length)}
          </button>
          <button className="pf-folder" aria-current={scope.kind === "unfiled" ? "page" : undefined} onClick={() => setScope({ kind: "unfiled" })} title="Projects in no folder" {...dropTarget("unfiled", "")}>
            <span className="pf-folder-name">Unfiled</span>
            {count(projects.filter((p) => p.folder === "").length)}
          </button>
          <div className="pf-tree">
            {seenRows.map((row) => {
              const key = `f:${row.path}`;
              const current = scope.kind === "folder" && scope.path === row.path;
              // The folder shown is folded away in this one.
              const holdsShown = !current && scope.kind === "folder" && showing === row.path;
              const indent = 10 + row.depth * 16;
              if (naming?.kind === "folder" && naming.where === "nav" && naming.path === row.path) {
                return (
                  <div key={row.path} className="pf-naming" style={{ paddingLeft: indent + 18 }}>
                    {folderNaming(row.path)}
                  </div>
                );
              }
              const isFolded = folded.includes(row.path);
              return (
                <div key={row.path} className="pf-folder-line" onContextMenu={contextMenu(key)}>
                  <button className="pf-folder" style={{ paddingLeft: indent + 18 }} aria-current={current ? "page" : undefined} data-holds-shown={holdsShown || undefined} onClick={() => setScope({ kind: "folder", path: row.path })} title={holds(row)} {...dropTarget(key, row.path)}>
                    <span className="pf-folder-name">{row.name}</span>
                    {row.count > 0 && count(row.count)}
                  </button>
                  {row.folders > 0 && (
                    <button
                      className="pf-fold"
                      style={{ left: indent - 2 }}
                      aria-expanded={!isFolded}
                      aria-label={`${isFolded ? "Show" : "Hide"} the folders in ${row.name}`}
                      title={`${isFolded ? "Show" : "Hide"} the folders in it`}
                      onClick={(e) => {
                        e.stopPropagation();
                        fold(isFolded ? folded.filter((path) => path !== row.path) : [...folded, row.path]);
                      }}
                    >
                      {isFolded ? "▸" : "▾"}
                    </button>
                  )}
                  {folderMenu(row.path, "nav")}
                  {naming?.kind === "new" && naming.parent === row.path && (
                    <div className="pf-naming" style={{ paddingLeft: indent + 16 + 18 }}>
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
            <button className="pf-new" onClick={(e) => (e.stopPropagation(), setNaming({ kind: "new", parent: "" }))}>
              + New folder
            </button>
          )}
          {folders.length > 0 && projects.length > 0 && <p className="pf-hint">Drag projects onto a folder to move them.</p>}
          <p className="set-nav-foot">{keptText(home)}</p>
        </div>
      </nav>

      <main className="pf-main">
        <div className="pf-bar">
          <h2 className="pf-title">{title}</h2>
          <input className="pf-search" type="text" aria-label="Search projects and folders by name" placeholder={scope.kind === "all" ? "Search by name" : `Search in ${scope.kind === "unfiled" ? "Unfiled" : nameOf(here)}`} value={query} onChange={(e) => setQuery(e.target.value)} />
          <label className="pf-sort">
            <span className="muted">Sort</span>
            <select
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
          </label>
          <button onClick={async () => mayLeave() && openFile(await pickTextFile(".json,application/json"))} title="Open a project file from disk">
            Open file…
          </button>
          <button className="primary" onClick={startNew} title={here ? `Start a project in ${label(here)}` : "Start a project"}>
            {here ? `New project in ${nameOf(here)}` : "New project"}
          </button>
        </div>

        {shown.length === 0 && subfolders.length === 0 ? (
          <div className="muted pf-empty">
            <p>
              {searching
                ? `Nothing ${scope.kind === "all" ? "" : `in ${where} `}has that in its name.`
                : projects.length === 0 && folders.length === 0
                  ? "Nothing kept yet. A project is kept as soon as it has a drawing."
                  : scope.kind === "folder"
                    ? "Nothing in this folder. Drag projects onto it, or start a new one here."
                    : scope.kind === "unfiled"
                      ? "Every project is in a folder."
                      : "Nothing kept yet. A project is kept as soon as it has a drawing."}
            </p>
            {searching && scope.kind !== "all" && (
              <button
                onClick={() => {
                  keepQuery.current = true;
                  setScope({ kind: "all" });
                }}
              >
                Search all projects
              </button>
            )}
          </div>
        ) : (
          <ul className="pf-list">
            <li className="pf-head" data-picked={chosen.length > 0 || undefined}>
              {shown.length > 0 ? (
                <input
                  type="checkbox"
                  aria-label="Select all shown"
                  checked={allPicked}
                  disabled={several?.shown === true && several.place === "inline"}
                  onChange={() => setPicked(allPicked ? picked.filter((id) => !shown.some((p) => p.id === id)) : [...new Set([...picked, ...shown.map((p) => p.id)])])}
                />
              ) : (
                <span />
              )}
              {several?.shown && several.place === "inline" ? (
                <ProgressLine task={several} />
              ) : chosen.length > 0 ? (
                // In place of the count: the list under it does not move.
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
              ) : (
                <span>
                  {[subfolders.length > 0 ? plural(subfolders.length, "folder") : "", shown.length > 0 ? plural(shown.length, "project") : ""].filter(Boolean).join(" · ")}
                  {searching && scope.kind === "folder" && " (with the folders in it)"}
                </span>
              )}
            </li>
            {subfolders.map((path) => {
              const key = `l:${path}`;
              if (naming?.kind === "folder" && naming.where === "list" && naming.path === path) {
                return (
                  <li key={key} className="pf-row pf-sub">
                    <span />
                    {folderNaming(path)}
                  </li>
                );
              }
              return (
                <li key={key} className="pf-row pf-sub" onContextMenu={contextMenu(key)} {...dropTarget(key, path)}>
                  <span />
                  <button className="pf-open" onClick={() => setScope({ kind: "folder", path })} title={`Show ${nameOf(path)}`}>
                    <FolderIcon />
                    <span className="pf-name">{nameOf(path)}</span>
                    {parentOf(path) !== here && <span className="muted pf-in">{label(parentOf(path)) === "Unfiled" ? "Top level" : label(parentOf(path))}</span>}
                  </button>
                  <span className="muted pf-facts">{holds(rowOf(path))}</span>
                  {folderMenu(path, "list")}
                </li>
              );
            })}
            {shown.map((p) => {
              const isOpen = p.id === project.id;
              const name = p.name || "Untitled";
              const key = `p:${p.id}`;
              const isNaming = naming?.kind === "project" && naming.id === p.id;
              return (
                <li key={p.id} className="pf-row" data-picked={picked.includes(p.id) || undefined} draggable={!isNaming} onDragStart={(e) => dragStart(e, p.id)} onDragEnd={dragEnd} onContextMenu={isNaming ? undefined : contextMenu(key)}>
                  <input type="checkbox" aria-label={`Select ${name}`} checked={picked.includes(p.id)} onChange={() => setPicked(picked.includes(p.id) ? picked.filter((id) => id !== p.id) : [...picked, p.id])} />
                  {isNaming ? (
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
                      <Thumbnail thumb={p.thumb} />
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
                        <button type="button" role="menuitem" onClick={() => void open(p.id)}>
                          {isOpen ? "Go to it" : "Open"}
                        </button>
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

/** What Undo calls, as the view is when it is pressed. */
interface Later {
  putBack: (places: { id: string; folder: string }[], to: string) => Promise<void> | void;
  unduplicate: (id: string, name: string, text: string) => Promise<void>;
  renameFolder: (from: string, to: string, undoing?: boolean) => Promise<void>;
  undelete: (path: string, was: ReturnType<typeof heldBy>) => Promise<void>;
}

/** A folder in the list, before its name. */
function FolderIcon() {
  return (
    <svg className="pf-thumb pf-folder-icon" viewBox="-12 -9 44 34" aria-hidden="true">
      <path d="M1.5 3.5a1.5 1.5 0 0 1 1.5-1.5h4.2l1.8 2h8a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H3a1.5 1.5 0 0 1-1.5-1.5z" />
    </svg>
  );
}

/** A small picture of a project's drawing on its stock; an empty place for one without a drawing. */
function Thumbnail({ thumb }: { thumb: Thumb | null | undefined }) {
  if (!thumb) return <span className="pf-thumb" aria-hidden="true" />;
  const pad = 2;
  return (
    <svg className="pf-thumb" viewBox={`${-pad} ${-pad} ${thumb.w + 2 * pad} ${thumb.h + 2 * pad}`} aria-hidden="true">
      <rect className="pf-thumb-stock" width={thumb.w} height={thumb.h} />
      <path className="pf-thumb-shapes" d={thumb.d} />
    </svg>
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
