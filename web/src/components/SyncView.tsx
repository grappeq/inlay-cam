// Syncing two places, on the Storage page: what differs is shown first,
// projects under their folders and the settings apart, each line with how
// either place has it and which way it goes. Only what is ticked is done.

import { useEffect, useRef, useState } from "react";
import { core } from "../core/client";
import { duplicateProject } from "../state/model";
import { message } from "../state/store";
import { tasks } from "../state/tasks";
import { mayLeave } from "../state/unsaved";
import { placeName, readBase, reloadPage, storeOf, writeBase, type Home, type PlaceInfo } from "../storage/places";
import { aim, apply, chosen, compare, effect, losses, otherFolder, parts, snapshot, standing, tickedOf, tone, tree, turn, turns, type Action, type Base, type Duplicate, type Row } from "../storage/sync";
import { SyncIcon, type SyncIconName } from "./icons";
import { ProgressLine, Spinner, useTask } from "./Progress";

const SYNC = "sync";

/** A place in a word, where the two that are synced are named above. */
const SHORT: Record<Home, string> = { browser: "browser", folder: "folder", server: "server" };
const PLACE_ICON: Record<Home, SyncIconName> = { browser: "browser", folder: "folder", server: "server" };

/** A copy of a project's file under an id and a name of its own. */
const duplicate: Duplicate = async (text, taken) => {
  const copy = duplicateProject(await core.call("projectFromFile", text), taken);
  return { id: copy.id, name: copy.name, text: await core.call("projectToFile", copy) };
};

function capital(text: string): string {
  return text.replace(/^./, (c) => c.toUpperCase());
}

/** When something was last changed, the year only where it is not this one. */
export function dated(ms: number | undefined, now = Date.now()): string | null {
  if (ms === undefined) return null;
  const at = new Date(ms);
  const year = at.getFullYear() === new Date(now).getFullYear() ? {} : ({ year: "numeric" } as const);
  return at.toLocaleString(undefined, { day: "numeric", month: "short", ...year, hour: "2-digit", minute: "2-digit" });
}

interface Found {
  a: Home;
  b: Home;
  rows: Row[];
  base: Base;
  /** How many projects the two places hold between them. */
  projects: number;
}

/** A tick box that can stand for several: some of them ticked shows as neither. */
function Tick(props: { state: "all" | "some" | "none"; label: string; disabled: boolean; onChange: (on: boolean) => void }) {
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (box.current) box.current.indeterminate = props.state === "some";
  }, [props.state]);
  return <input ref={box} type="checkbox" aria-label={props.label} checked={props.state === "all"} disabled={props.disabled} onChange={(e) => props.onChange(e.target.checked)} />;
}

export function SyncBlock(props: { home: Home; ready: PlaceInfo[] }) {
  const ids = props.ready.map((p) => p.id);
  const [a, setA] = useState<Home>(props.home);
  const [picked, setB] = useState<Home | null>(null);
  const from = ids.includes(a) ? a : props.home;
  const b = picked && picked !== from && ids.includes(picked) ? picked : (ids.find((id) => id !== from) ?? null);
  const [found, setFound] = useState<Found | null>(null);
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [ways, setWays] = useState<Record<string, Action>>({});
  const [shut, setShut] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<"Comparing" | "Syncing" | null>(null);
  const [said, setSaid] = useState<{ text: string; failed: { name: string; error: string }[]; reload: boolean } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const task = useTask(SYNC);
  // What was compared is of the two places it names: another pair starts over.
  const shown = found && found.a === from && found.b === b ? found : null;

  if (b === null) {
    return (
      <section className="block">
        <h3>Sync</h3>
        <p className="block-empty muted">Needs a second place: choose a folder above.</p>
      </section>
    );
  }
  const [nameA, nameB] = [placeName(from), placeName(b)];

  const look = async (): Promise<void> => {
    setBusy("Comparing");
    setProblem(null);
    try {
      const [x, y] = [await snapshot(storeOf(from)), await snapshot(storeOf(b))];
      const next = compare(x, y, await readBase(from, b));
      await writeBase(from, b, next.base);
      const projects = new Set([...x.keys(), ...y.keys()].filter((key) => key.startsWith("project:"))).size;
      setFound({ a: from, b, ...next, projects });
      setTicked({});
      setWays({});
    } catch (e) {
      setProblem(message(e));
    } finally {
      setBusy(null);
    }
  };
  const compareNow = () => {
    setSaid(null);
    void look();
  };

  const rows = shown?.rows ?? [];
  const list = chosen(rows, ticked, ways);
  const count = (to: Action, what: string) => list.filter((c) => c.action === to && effect(c.row, c.action) === what).length;
  const deleted = count("toA", "delete") + count("toB", "delete");
  const both = list.filter((c) => effect(c.row, c.action) === "copies").length;
  const todo = parts(list);
  const summary = [
    count("toB", "copy") > 0 && `${count("toB", "copy")} to ${nameB}`,
    count("toA", "copy") > 0 && `${count("toA", "copy")} to ${nameA}`,
    both > 0 && `${both} kept twice`,
    deleted > 0 && `${deleted} deleted`,
    rows.length - todo > 0 && `${rows.length - todo} left`,
  ].filter(Boolean);

  const sync = async () => {
    if (!shown) return;
    // The page starts again after: not over a sheet that is still being filled in.
    if ((shown.a === props.home || shown.b === props.home) && !mayLeave()) return;
    // What cannot be seen again in either place is asked about by name: it may be in a folder that is shut.
    const lost = losses(list);
    const named = (names: string[]) => `${names.slice(0, 6).join(", ")}${names.length > 6 ? ` and ${names.length - 6} more` : ""}`;
    const asked = [lost.deleted.length > 0 && `Delete from both places: ${named(lost.deleted)}`, lost.overwritten.length > 0 && `Copy over changes: ${named(lost.overwritten)}`].filter(Boolean);
    if (asked.length > 0 && !confirm(`${asked.join("\n")}\n\nGo on?`)) return;
    setBusy("Syncing");
    setProblem(null);
    const going = tasks.start({ key: SYNC, label: `Syncing ${nameA} and ${nameB}`, total: todo });
    try {
      const done = await apply(list, storeOf(shown.a), storeOf(shown.b), shown.base, duplicate, (n, name) => going.update({ done: n, stage: name === null ? "Checking what was done" : name || "Untitled" }));
      await writeBase(shown.a, shown.b, done.base);
      const reload = (done.wroteA && shown.a === props.home) || (done.wroteB && shown.b === props.home);
      setSaid({ text: `${done.done} synced${done.failed.length > 0 ? `, ${done.failed.length} not` : ""}`, failed: done.failed, reload });
      going.end();
      if (!reload) await look();
    } catch (e) {
      setProblem(message(e));
    } finally {
      going.end();
      setBusy(null);
    }
  };

  // As it was when the two were compared: the ticks, and which way each line goes.
  const newerOnly = () => {
    setTicked({});
    setWays({});
  };
  const tick = (some: Row[], on: boolean) => setTicked({ ...ticked, ...Object.fromEntries(some.map((row) => [row.key, on])) });
  const wayText = (row: Row, action: Action): string => {
    const to = SHORT[action === "toB" ? shown!.b : shown!.a];
    const what = effect(row, action);
    return what === "copy" ? `Copy to ${to}` : what === "delete" ? `Delete from ${to}` : "Keep both";
  };

  const side = (row: Row, which: "a" | "b") => {
    const how = tone(row, which);
    const when = dated(row[which]?.modified);
    const text = how === "gone" || how === "none" ? standing(row, which) : (when ?? standing(row, which));
    return (
      <td className="sync-side">
        <span className={`sync-pill ${how}`}>{text}</span>
      </td>
    );
  };

  const line = (row: Row, deep: boolean) => {
    const on = ticked[row.key] ?? row.action !== "skip";
    const way = ways[row.key] ?? aim(row);
    const what = effect(row, way);
    const steps = (way === "toA" ? (row.b ?? row.a) : (row.a ?? row.b))?.steps;
    const icon: SyncIconName = what === "delete" ? "trash" : what === "copies" ? "both" : way === "toB" ? "right" : "left";
    const name = row.name || "Untitled";
    const fixed = turns(row).length < 2;
    const moved = otherFolder(row, way);
    return (
      <tr key={row.key} className={on ? undefined : "off"}>
        <td className="sync-tick">
          <input type="checkbox" aria-label={`Sync ${name}`} checked={on} disabled={busy !== null} onChange={(e) => tick([row], e.target.checked)} />
        </td>
        <th scope="row" className={`sync-name${deep ? " deep" : ""}`}>
          <SyncIcon name={row.kind === "project" ? "project" : row.kind === "tools" ? "tool" : "settings"} />
          <span>{name}</span>
          {row.kind === "project" && steps !== undefined && <span className="muted"> · {steps === 1 ? "1 step" : `${steps} steps`}</span>}
          {moved !== null && (
            <span className="muted">
              {" "}
              · {moved ? moved.split("/").join(" / ") : "Unfiled"} in {SHORT[way === "toA" ? shown!.a : shown!.b]}
            </span>
          )}
        </th>
        {side(row, "a")}
        <td className="sync-turn">
          <button
            type="button"
            className={`sync-way ${what}${row.state === "both" ? " clash" : ""}`}
            title={fixed ? wayText(row, way) : `${wayText(row, way)}. Press for: ${wayText(row, turn(row, way)).toLowerCase()}`}
            aria-label={`${name}: ${wayText(row, way).toLowerCase()}${fixed ? "" : ". Press to change"}`}
            disabled={busy !== null || fixed}
            onClick={() => {
              // Turning it says something is to be done to it.
              setWays({ ...ways, [row.key]: turn(row, way) });
              tick([row], true);
            }}
          >
            <SyncIcon name={icon} />
          </button>
        </td>
        {side(row, "b")}
      </tr>
    );
  };

  const made = tree(rows);
  const projectRows = made.folders.flatMap((f) => f.rows);

  return (
    <section className="block">
      <h3>Sync</h3>
      <div className="sync-pick">
        <select aria-label="One place" value={from} disabled={busy !== null} onChange={(e) => setA(e.target.value as Home)}>
          {props.ready.map((p) => (
            <option key={p.id} value={p.id}>
              {capital(placeName(p.id))}
            </option>
          ))}
        </select>
        <span aria-hidden="true">⇄</span>
        <select aria-label="The other place" value={b} disabled={busy !== null} onChange={(e) => setB(e.target.value as Home)}>
          {props.ready
            .filter((p) => p.id !== from)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {capital(placeName(p.id))}
              </option>
            ))}
        </select>
        <button onClick={compareNow} disabled={busy !== null}>
          Compare
        </button>
        {busy === "Comparing" && (
          <span className="status-line" role="status">
            <Spinner /> Comparing…
          </span>
        )}
      </div>
      {problem && (
        <p className="form-error" role="alert">
          {problem}
        </p>
      )}
      {said && !said.reload && (
        <p className="block-line" role="status">
          {capital(said.text)}
        </p>
      )}
      {said && !said.reload && said.failed.length > 0 && <Failed failed={said.failed} />}
      {shown && rows.length === 0 && <p className="block-empty muted">Nothing differs.</p>}
      {shown && rows.length > 0 && (
        <>
          <div className="sync-bar">
            <span className="muted">Select</span>
            <button type="button" className="link" disabled={busy !== null} onClick={() => tick(rows, true)}>
              All
            </button>
            <button type="button" className="link" disabled={busy !== null} onClick={() => tick(rows, false)}>
              None
            </button>
            <button type="button" className="link" disabled={busy !== null} onClick={newerOnly}>
              Newer only
            </button>
            <span className="sync-key">
              <span className="sync-pill new">Newer</span>
              <span className="sync-pill clash">Changed in both</span>
              <span className="sync-pill gone">Deleted</span>
            </span>
          </div>
          <table className="sync-table" aria-label="What differs">
            <thead>
              <tr>
                <td className="sync-tick">
                  <Tick state={tickedOf(rows, ticked)} label="Sync everything" disabled={busy !== null} onChange={(on) => tick(rows, on)} />
                </td>
                <td />
                <th scope="col" className="sync-side">
                  <SyncIcon name={PLACE_ICON[shown.a]} /> {capital(nameA)}
                </th>
                <td />
                <th scope="col" className="sync-side">
                  <SyncIcon name={PLACE_ICON[shown.b]} /> {capital(nameB)}
                </th>
              </tr>
            </thead>
            {projectRows.length > 0 && (
              <tbody>
                <tr className="sync-head">
                  <td className="sync-tick">
                    <Tick state={tickedOf(projectRows, ticked)} label="Sync all projects" disabled={busy !== null} onChange={(on) => tick(projectRows, on)} />
                  </td>
                  <th scope="rowgroup" colSpan={4}>
                    Projects
                    <span className="sync-count">
                      {projectRows.length} of {shown.projects} differ
                    </span>
                  </th>
                </tr>
                {made.folders.map(({ folder, rows: inside }) => {
                  const label = folder ? folder.split("/").join(" / ") : "Unfiled";
                  const closed = shut[folder] === true;
                  return [
                    <tr key={`folder:${folder}`} className="sync-folder">
                      <td className="sync-tick">
                        <Tick state={tickedOf(inside, ticked)} label={`Sync all in ${label}`} disabled={busy !== null} onChange={(on) => tick(inside, on)} />
                      </td>
                      <th scope="rowgroup" colSpan={4}>
                        <button type="button" className="sync-fold" aria-expanded={!closed} onClick={() => setShut({ ...shut, [folder]: !closed })}>
                          <SyncIcon name={closed ? "closed" : "open"} />
                          <SyncIcon name="folder" />
                          <span>{label}</span>
                          <span className="sync-count">
                            {inside.length}
                            {closed && ` · ${inside.filter((row) => ticked[row.key] ?? row.action !== "skip").length} ticked`}
                          </span>
                        </button>
                      </th>
                    </tr>,
                    ...(closed ? [] : inside.map((row) => line(row, true))),
                  ];
                })}
              </tbody>
            )}
            {made.settings.length > 0 && (
              <tbody>
                <tr className="sync-head">
                  <td className="sync-tick">
                    <Tick state={tickedOf(made.settings, ticked)} label="Sync all tools and settings" disabled={busy !== null} onChange={(on) => tick(made.settings, on)} />
                  </td>
                  <th scope="rowgroup" colSpan={4}>
                    Tools and settings
                    <span className="sync-count">{made.settings.length} differ</span>
                  </th>
                </tr>
                {made.settings.map((row) => line(row, false))}
              </tbody>
            )}
          </table>
          {busy === "Syncing" ? (
            <ProgressLine task={task} always className="sync-progress" />
          ) : (
            <div className="row end sync-foot">
              <span className="muted">{summary.join(" · ")}</span>
              <button className="primary" disabled={busy !== null || todo === 0} onClick={sync}>
                Sync {todo}
              </button>
            </div>
          )}
        </>
      )}
      {said?.reload && (
        <div className="backdrop">
          <div className="dialog" role="dialog" aria-modal="true" aria-label="Synced">
            <h2>{capital(said.text)}</h2>
            <Failed failed={said.failed} />
            <div className="row end">
              <span className="muted">The page starts again to show it</span>
              <button className="primary" autoFocus onClick={reloadPage}>
                Reload
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function Failed(props: { failed: { name: string; error: string }[] }) {
  if (props.failed.length === 0) return null;
  return (
    <table className="set-table">
      <tbody>
        {props.failed.map((f, i) => (
          <tr key={i}>
            <th scope="row">{f.name || "Untitled"}</th>
            <td className="form-error">{f.error}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
