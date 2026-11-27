// Settings, Storage: the places things can be kept in, which one is in use,
// and syncing two of them. Syncing shows what differs first, each line with
// what will be done to it, and does nothing until it is told to.

import { useEffect, useState, useSyncExternalStore } from "react";
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
  reconnectFolder,
  refreshPlaces,
  subscribePlaces,
  switchPlace,
  type Home,
  type PlaceInfo,
} from "../storage/places";
import { PageHead } from "./Cells";
import { SyncBlock } from "./SyncView";

const WHAT: Record<Home, string> = {
  browser: "Gone when site data is cleared",
  folder: "Files you can copy and back up",
  server: "Shared by everyone who opens it",
};

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
