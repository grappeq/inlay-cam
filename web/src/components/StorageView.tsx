// Settings, Storage: the places things can be kept in, which one is in use,
// and syncing two of them. Syncing shows what differs first, each line with
// what will be done to it, and does nothing until it is told to.

import { useEffect, useState, useSyncExternalStore } from "react";
import { core } from "../core/client";
import { duplicateProject } from "../state/model";
import { message, useApp } from "../state/store";
import { mayLeave } from "../state/unsaved";
import {
  answerGate,
  folderSupported,
  getGate,
  pickFolder,
  placeName,
  places,
  placesVersion,
  readBase,
  reconnectFolder,
  refreshPlaces,
  reloadPage,
  storeOf,
  subscribePlaces,
  switchPlace,
  writeBase,
  type Home,
  type PlaceInfo,
} from "../storage/places";
import { apply, choices, compare, effect, snapshot, type Action, type Base, type Duplicate, type Row, type State } from "../storage/sync";
import { PageHead } from "./Cells";
import { Spinner } from "./Progress";

const WHAT: Record<Home, string> = {
  browser: "Gone when site data is cleared",
  folder: "Files you can copy and back up",
  server: "Shared by everyone who opens it",
};

/** A copy of a project's file under an id and a name of its own. */
const duplicate: Duplicate = async (text, taken) => {
  const copy = duplicateProject(await core.call("projectFromFile", text), taken);
  return { id: copy.id, name: copy.name, text: await core.call("projectToFile", copy) };
};

function capital(text: string): string {
  return text.replace(/^./, (c) => c.toUpperCase());
}

export function StoragePage() {
  const { home } = useApp();
  useSyncExternalStore(subscribePlaces, placesVersion);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    const look = () => void refreshPlaces();
    look();
    window.addEventListener("focus", look);
    return () => window.removeEventListener("focus", look);
  }, []);
  const list = places();
  const act = (work: () => Promise<unknown> | void) => async () => {
    setProblem(null);
    try {
      await work();
    } catch (e) {
      setProblem(message(e));
    }
  };
  const use = (id: Home) =>
    act(() => {
      if (!mayLeave()) return;
      if (confirm(`Keep everything in ${placeName(id)} from now on? The page starts again on what is kept there.`)) switchPlace(id);
    });
  const pick = act(async () => {
    if (home === "folder" && (!mayLeave() || !confirm("Choose another folder? The page starts again on what is kept in it."))) return;
    await pickFolder();
  });

  const control = (place: PlaceInfo) => {
    if (place.id === "folder" && place.state === "none") return <button onClick={pick}>Choose a folder</button>;
    if (place.state === "absent") return <span className="muted">{place.id === "folder" ? "Not in this browser" : "Not found"}</span>;
    return (
      <span className="place-acts">
        {place.name && <b className="place-name">{place.name}</b>}
        {place.state === "inUse" && <span className="chip on">In use</span>}
        {place.state === "ready" && <button onClick={use(place.id)}>Use</button>}
        {place.state === "reconnect" && <button onClick={act(reconnectFolder)}>Reconnect</button>}
        {place.id === "folder" && (
          <button className="link" onClick={pick}>
            Choose another
          </button>
        )}
      </span>
    );
  };

  return (
    <>
      <PageHead title="Storage">Where projects, tools and settings are kept.</PageHead>
      <section className="block">
        <h3>Places</h3>
        <table className="set-table">
          <tbody>
            {list.map((place) => (
              <tr key={place.id}>
                <th scope="row">{place.label}</th>
                <td className="set-val">{control(place)}</td>
                <td className="set-what">{place.id === "folder" && !folderSupported() ? "Chrome or Edge on a computer" : place.id === "server" && place.state === "absent" ? "Page not served by inlay-server" : WHAT[place.id]}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {problem && (
          <p className="form-error" role="alert">
            {problem}
          </p>
        )}
      </section>
      <SyncBlock home={home} ready={list.filter((p) => p.state === "inUse" || p.state === "ready")} />
    </>
  );
}

interface Found {
  a: Home;
  b: Home;
  rows: Row[];
  base: Base;
}

function stateText(state: State, a: string, b: string, changed?: boolean): string {
  if (changed) return state === "deletedA" ? `Deleted from ${a}, changed in ${b}` : `Deleted from ${b}, changed in ${a}`;
  switch (state) {
    case "onlyA":
      return `Only in ${a}`;
    case "onlyB":
      return `Only in ${b}`;
    case "newerA":
      return `Changed in ${a}`;
    case "newerB":
      return `Changed in ${b}`;
    case "both":
      return "Changed in both";
    case "deletedA":
      return `Deleted from ${a}`;
    case "deletedB":
      return `Deleted from ${b}`;
  }
}

function SyncBlock(props: { home: Home; ready: PlaceInfo[] }) {
  const ids = props.ready.map((p) => p.id);
  const [a, setA] = useState<Home>(props.home);
  const [picked, setB] = useState<Home | null>(null);
  const from = ids.includes(a) ? a : props.home;
  const b = picked && picked !== from && ids.includes(picked) ? picked : (ids.find((id) => id !== from) ?? null);
  const [found, setFound] = useState<Found | null>(null);
  const [actions, setActions] = useState<Record<string, Action>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<{ text: string; failed: { name: string; error: string }[]; reload: boolean } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
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
      setFound({ a: from, b, ...next });
      setActions(Object.fromEntries(next.rows.map((row) => [row.key, row.action])));
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

  const chosen = (shown?.rows ?? []).map((row) => ({ row, action: actions[row.key] ?? row.action }));
  const count = (to: Action, what: string) => chosen.filter((c) => c.action === to && effect(c.row, c.action) === what).length;
  const deleted = count("toA", "delete") + count("toB", "delete");
  const both = chosen.filter((c) => effect(c.row, c.action) === "copies").length;
  const left = chosen.filter((c) => effect(c.row, c.action) === "none").length;
  const todo = chosen.length - left;
  const summary = [
    count("toB", "copy") > 0 && `${count("toB", "copy")} to ${nameB}`,
    count("toA", "copy") > 0 && `${count("toA", "copy")} to ${nameA}`,
    both > 0 && `${both} kept twice`,
    deleted > 0 && `${deleted} deleted`,
    left > 0 && `${left} left`,
  ].filter(Boolean);

  const sync = async () => {
    if (!shown) return;
    // The page starts again after: not over a sheet that is still being filled in.
    if ((shown.a === props.home || shown.b === props.home) && !mayLeave()) return;
    if (deleted > 0 && !confirm(`Delete ${deleted === 1 ? "1 project" : `${deleted} projects`}? ${deleted === 1 ? "It is" : "They are"} gone from both places then.`)) return;
    setBusy("Syncing");
    setProblem(null);
    try {
      const done = await apply(chosen, storeOf(shown.a), storeOf(shown.b), shown.base, duplicate);
      await writeBase(shown.a, shown.b, done.base);
      const reload = (done.wroteA && shown.a === props.home) || (done.wroteB && shown.b === props.home);
      setSaid({ text: `${done.done} synced${done.failed.length > 0 ? `, ${done.failed.length} not` : ""}`, failed: done.failed, reload });
      if (!reload) await look();
    } catch (e) {
      setProblem(message(e));
    } finally {
      setBusy(null);
    }
  };

  const option = (row: Row, action: Action): string => {
    const to = action === "toB" ? nameB : nameA;
    const what = effect(row, action);
    return what === "copy" ? `Copy to ${to}` : what === "delete" ? `Delete from ${to}` : what === "copies" ? "Keep both" : "Leave as it is";
  };

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
        {busy && (
          <span className="status-line" role="status">
            <Spinner /> {busy}…
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
      {shown && shown.rows.length === 0 && <p className="block-empty muted">Nothing differs.</p>}
      {shown && shown.rows.length > 0 && (
        <>
          <table className="set-table sync-table">
            <tbody>
              {shown.rows.map((row) => {
                const folder = (row.a ?? row.b)?.folder;
                return (
                  <tr key={row.key}>
                    <th scope="row">
                      {row.name || "Untitled"}
                      {folder && <span className="muted"> · {folder}</span>}
                    </th>
                    <td className="sync-state">
                      <span className={`chip${row.state === "both" || row.state.startsWith("deleted") ? " warn" : ""}`}>{stateText(row.state, nameA, nameB, row.changed)}</span>
                    </td>
                    <td className="sync-do">
                      <select aria-label={`What to do with ${row.name || "Untitled"}`} value={actions[row.key] ?? row.action} disabled={busy !== null} onChange={(e) => setActions({ ...actions, [row.key]: e.target.value as Action })}>
                        {choices(row).map((action) => (
                          <option key={action} value={action}>
                            {option(row, action)}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="row end sync-foot">
            <span className="muted">{summary.join(" · ")}</span>
            <button className="primary" disabled={busy !== null || todo === 0} onClick={sync}>
              Sync {todo}
            </button>
          </div>
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

/** The folder in use has to be allowed again before the page starts: the browser asks on a click only. */
export function FolderGate() {
  useSyncExternalStore(subscribePlaces, placesVersion);
  const gate = getGate();
  if (!gate) return null;
  return (
    <div className="backdrop">
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Reconnect the folder">
        <h2>Reconnect the folder “{gate.name}”</h2>
        <p className="muted">{gate.refused ? "Not allowed: it may have been moved or renamed" : "Everything is kept in it"}</p>
        <div className="row end">
          <button onClick={() => void answerGate("other")}>Use {placeName(gate.other)} for now</button>
          <button className="primary" autoFocus onClick={() => void answerGate("folder")}>
            Reconnect
          </button>
        </div>
      </div>
    </div>
  );
}
