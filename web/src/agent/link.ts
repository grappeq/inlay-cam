// The page's end of the link to an AI agent. With the agent connection on
// (Settings, Agent), the page calls the agent's local relay, inlay-cam-mcp,
// at http://127.0.0.1:<port>: it presents the pairing token, says which
// commands it has, then asks over and over for the next command to run
// (a request the relay holds until there is one), runs each in turn, in
// front of the user, and sends the result back. The connection is to this
// computer and nowhere else.
//
// The port and token are this browser's own: they pair it with a relay on
// this computer, so they stay in its local storage also when everything
// else is kept on a server.

import { version as APP_VERSION } from "../../package.json";
import { CommandError, listCommands, runCommand } from "./commands";
import { host } from "./host";
import { tasks } from "../state/tasks";

/** Where the link stands: switched off; no relay answering yet; connected; or turned away by the relay. */
export type LinkStatus = "off" | "waiting" | "connected" | "refused";

export interface AgentPrefs {
  on: boolean;
  port: number;
  token: string;
  /** The user has agreed, once, to an agent reading and changing what the app holds. */
  accepted: boolean;
}

export interface AgentLink {
  prefs: AgentPrefs;
  status: LinkStatus;
  /** Why it stands as it does, in a sentence, when there is something to say. */
  detail: string | null;
  /** A pairing link was opened and waits for the user's yes. */
  asking: boolean;
}

/** The key of the task that is an agent's command running. */
export const AGENT_COMMAND = "agent";

export const DEFAULT_PORT = 7391;
const KEY = "inlay-cam.agent";

export const STATUS_TEXT: Record<LinkStatus, string> = {
  off: "Off",
  waiting: "Listening for the agent",
  connected: "Connected to the agent",
  refused: "Turned away",
};

function readPrefs(): AgentPrefs {
  const fallback: AgentPrefs = { on: false, port: DEFAULT_PORT, token: "", accepted: false };
  try {
    const kept = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (!kept || typeof kept !== "object") return fallback;
    return {
      on: kept.on === true,
      port: validPort(kept.port) ? kept.port : DEFAULT_PORT,
      token: typeof kept.token === "string" ? kept.token : "",
      accepted: kept.accepted === true,
    };
  } catch {
    return fallback;
  }
}

export const validPort = (port: unknown): port is number => typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535;
export const validToken = (token: string) => /^[A-Za-z0-9_-]{8,}$/.test(token);

let link: AgentLink = { prefs: readPrefs(), status: "off", detail: null, asking: false };
const listeners = new Set<() => void>();

function set(change: Partial<AgentLink>) {
  link = { ...link, ...change };
  for (const listener of listeners) listener();
}

export function getLink(): AgentLink {
  return link;
}

export function subscribeLink(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Changes what is kept about the link, and connects or disconnects to match. */
export function setPrefs(change: Partial<AgentPrefs>) {
  const prefs = { ...link.prefs, ...change };
  set({ prefs });
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Without storage the pairing lasts as long as the page.
  }
  restart();
}

/** The user's answer to a pairing link: yes switches the link on, no forgets the link. */
export function answerPairing(yes: boolean) {
  set({ asking: false });
  if (yes) setPrefs({ accepted: true, on: true });
}

/** A pairing link's port and token, from the address's fragment: `#agent=<port>:<token>`. */
export function readPairing(hash: string): { port: number; token: string } | null {
  const m = /(?:^#|&)agent=(\d{1,5}):([A-Za-z0-9_-]{8,})(?:&|$)/.exec(hash);
  if (!m || !validPort(Number(m[1]))) return null;
  return { port: Number(m[1]), token: m[2] };
}

/** Takes a pairing link out of the address and keeps it. True when there was one. */
function takePairing(): boolean {
  const pairing = readPairing(location.hash);
  if (!pairing) return false;
  history.replaceState(null, "", location.pathname + location.search);
  // Switched on at once when the user has agreed before, and asked about otherwise.
  setPrefs({ ...pairing, ...(link.prefs.accepted ? { on: true } : {}) });
  if (!link.prefs.accepted) set({ asking: true });
  return true;
}

/**
 * Called when the page starts: takes a pairing link from the address, now
 * and whenever one is put there while the page is open, and connects if the
 * link is switched on. Returns what stops listening for one.
 */
export function startLink(): () => void {
  if (!takePairing()) restart();
  const onHash = () => void takePairing();
  window.addEventListener("hashchange", onHash);
  return () => window.removeEventListener("hashchange", onHash);
}

// This page's name for itself, new each time it loads: the relay tells a reloaded page from a second tab by it.
const PAGE_ID = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

let stop: (() => void) | null = null;

function restart() {
  stop?.();
  stop = null;
  const { on, port, token } = link.prefs;
  if (!on) return set({ status: "off", detail: null });
  if (!validToken(token)) return set({ status: "refused", detail: "No pairing token is set. Ask the agent to open inlay-cam, or enter the port and token that inlay-cam-mcp --pair prints." });
  stop = connect(port, token);
}

const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

/** Connects to the relay and keeps connected until the returned function is called. */
function connect(port: number, token: string): () => void {
  const control = new AbortController();
  const signal = control.signal;
  const base = `http://127.0.0.1:${port}`;
  let session: string | null = null;
  // A plain text body keeps the browser from asking the relay's leave before every request.
  // `targetAddressSpace` marks the request as one to this computer, which is what has a
  // browser ask the user, once, whether this site may reach it.
  const post = (path: string, body: unknown, keepalive = false) =>
    fetch(base + path, { method: "POST", body: JSON.stringify(body), cache: "no-store", signal: keepalive ? undefined : signal, keepalive, targetAddressSpace: "loopback" } as RequestInit);

  // Commands run one at a time, in the order they came.
  let running: Promise<void> = Promise.resolve();
  const run = (call: { id: number; name: string; input: unknown }, to: string) => {
    running = running.then(async () => {
      let body: object;
      try {
        // Shown as the agent's while it runs: the command by its title, unless work inside it says more.
        const title = listCommands().find((c) => c.name === call.name)?.title ?? call.name;
        const result = await tasks.run({ key: AGENT_COMMAND, label: title, cover: true, by: "agent" }, () => runCommand(call.name, call.input, host()));
        body = { session: to, id: call.id, result: result ?? null };
      } catch (e) {
        const error = e instanceof CommandError ? { code: e.code, message: e.message } : { code: "failed", message: e instanceof Error ? e.message : String(e) };
        body = { session: to, id: call.id, error };
      }
      await post("/link/result", body).catch(() => {});
    });
  };

  (async () => {
    let attempt = 0;
    while (!signal.aborted) {
      let hello: Response;
      try {
        hello = await post("/link/hello", { token, pageId: PAGE_ID, appVersion: APP_VERSION, commands: listCommands() });
      } catch {
        if (signal.aborted) return;
        set({
          status: "waiting",
          detail: `Nothing answers on port ${port} of this computer yet. It answers while the agent's app is running with inlay-cam-mcp. If the browser asked whether this site may reach this computer and was told no, allow it in the site's settings and reload.`,
        });
        await pause(Math.min(10_000, 1000 * 2 ** attempt++), signal);
        continue;
      }
      if (!hello.ok) {
        const why =
          hello.status === 401
            ? "The pairing token is not the relay's. Ask the agent to open inlay-cam again, or enter the token that inlay-cam-mcp --pair prints."
            : hello.status === 409
              ? "Another inlay-cam tab is connected to the agent. Close it, and this one connects."
              : hello.status === 403
                ? "The relay does not let this page's address connect. Start inlay-cam-mcp with --app and this page's address."
                : `The relay answered ${hello.status}.`;
        set({ status: "refused", detail: why });
        await pause(hello.status === 409 ? 5000 : 15_000, signal);
        continue;
      }
      attempt = 0;
      const welcomed: string = (await hello.json()).welcome.session;
      session = welcomed;
      set({ status: "connected", detail: null });
      // Ask for the next command until the relay no longer knows this page.
      while (!signal.aborted) {
        let next: Response;
        try {
          next = await post("/link/next", { session: welcomed });
        } catch {
          break;
        }
        if (!next.ok) break;
        const { call } = await next.json();
        if (call) run(call, welcomed);
      }
      session = null;
      if (!signal.aborted) set({ status: "waiting", detail: null });
    }
  })();

  // A page that is closed says so, and the relay does not wait for it.
  const bye = () => {
    if (session) void post("/link/bye", { session }, true).catch(() => {});
  };
  window.addEventListener("pagehide", bye);
  return () => {
    bye();
    window.removeEventListener("pagehide", bye);
    control.abort();
  };
}
