import { useRef, useSyncExternalStore } from "react";
import { STATUS_TEXT, getLink, subscribeLink } from "../agent/link";
import * as server from "../storage/server";
import { useApp, useDispatch, type SettingsPage } from "../state/store";
import { placeName } from "../storage/places";
import { startOf } from "../state/folders";
import { mayLeave } from "../state/unsaved";
import { Activity, useLasting, useTasks } from "./Progress";

/** How long a save goes on before the header says so, ms. */
const SAVING_AFTER = 400;

export function Header() {
  const { project, projects, view, settingsPage, saveError, saving, ready, home } = useApp();
  // A save that takes a while is said; one that is over at once is not.
  const slow = useLasting(saving, SAVING_AFTER);
  // The core does one thing at a time: a save waits for long work in it to end.
  const behind = useTasks().some((t) => t.heavy);
  const inTools = view === "settings" && settingsPage === "tools";
  // The settings page last looked at, to come back to after the tools.
  const lastPage = useRef<SettingsPage>("materials");
  if (settingsPage !== "tools") lastPage.current = settingsPage;
  const dispatch = useDispatch();
  // The folder the open project is filed in; for one that is not kept yet, the one it was started in.
  const folder = projects.find((p) => p.id === project.id)?.folder ?? startOf(project.id) ?? "";
  const agent = useSyncExternalStore(subscribeLink, getLink);
  const reach = useSyncExternalStore(server.subscribeReach, server.getReach);
  const out = ready && home === "server" && reach === "unreachable";
  return (
    <header className="topbar">
      <span className="brand">Wooden Inlays</span>
      <nav className="tabs" aria-label="Views">
        <button aria-pressed={view === "projects"} onClick={() => mayLeave() && dispatch({ type: "setView", view: "projects" })} title={`The projects kept ${home === "server" ? "on this server" : `in ${placeName(home)}`}, in their folders`}>
          Projects
        </button>
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
      {folder && (
        <button
          className="link project-folder"
          title="The folder this project is filed in. Show it."
          onClick={() => {
            if (!mayLeave()) return;
            dispatch({ type: "setScope", scope: { kind: "folder", path: folder } });
            dispatch({ type: "setView", view: "projects" });
          }}
        >
          {folder.split("/").join(" / ")} /
        </button>
      )}
      <input
        className="project-name"
        type="text"
        aria-label="Project name"
        value={project.name}
        onChange={(e) => dispatch({ type: "updateProject", update: (p) => ({ ...p, name: e.target.value }) })}
      />
      {out ? (
        <span className="save-state error" role="status" title="Your changes stay in this page, and are saved as soon as the server answers again. Keep this page open until then.">
          Server out of reach: changes wait here
        </span>
      ) : (
        <span className={`save-state${saveError && !slow ? " error" : ""}`} role="status" title={slow && behind ? "It is saved as soon as the work that is going on is done." : undefined}>
          {!ready ? "Loading…" : slow ? "Saving…" : saveError ? `Not saved: ${saveError}` : home === "server" ? "Saved on this server" : `Saved in ${placeName(home)}`}
        </span>
      )}
      <Activity />
      {agent.status !== "off" && (
        <button
          className={`agent-chip ${agent.status}`}
          title={agent.detail ?? "An AI agent on this computer can work in this app. Open the connection's settings."}
          onClick={() => mayLeave() && dispatch({ type: "setView", view: "settings", page: "agent" })}
        >
          Agent: {STATUS_TEXT[agent.status].toLowerCase()}
        </button>
      )}
    </header>
  );
}
