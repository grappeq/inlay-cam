// The link to the inlay-cam page: an HTTP server on 127.0.0.1 that the page
// calls when its agent connection is on. A page is let in from an allowed
// origin, with the pairing token, one page at a time. Once in, it says which
// commands it has and then asks, over and over, for the next one to run
// (`/link/next`, a request that waits until there is one), and sends each
// result back (`/link/result`).
//
// Plain requests rather than a WebSocket, so that nothing is needed beyond
// Node itself. A page that stops asking is gone: its tab was closed.
//
// Other copies of this relay are let in beside the page, with the same
// token (`/peer/…`): an agent may start several, and one port has one
// holder. See SharedLink.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** How long a request for the next command waits before it is answered with none. */
const POLL_MS = 25_000;
/** How long a page may go without asking before it is taken for gone. */
const GONE_MS = 6_000;
/** How long a command may run before its caller is told it timed out. */
export const CALL_MS = 10 * 60_000;
/** Drawings and project files run to megabytes; pictures come back as base64. */
const BODY_MAX = 64 * 1024 ** 2;
const COMMANDS_MAX = 300;

/** Whether a page from `origin` may connect: one of `allowed`, or a page on this computer. */
export function originAllowed(origin, allowed = []) {
  if (allowed.includes(origin)) return true;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK.has(url.hostname);
  } catch {
    return false;
  }
}

/** Whether a request's Host names this computer. Any other name is a page of another site reaching here through DNS. */
export function hostIsLocal(host) {
  if (typeof host !== "string") return false;
  try {
    return LOOPBACK.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

function sameToken(given, token) {
  if (typeof given !== "string") return false;
  const hash = (text) => createHash("sha256").update(text).digest();
  return timingSafeEqual(hash(given), hash(token));
}

/** The commands a page says it has, as far as they can be offered as tools. */
export function cleanCommands(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const c of raw.slice(0, COMMANDS_MAX)) {
    if (!c || typeof c.name !== "string" || !/^[a-z][a-z0-9_]{0,60}$/.test(c.name) || seen.has(c.name)) continue;
    seen.add(c.name);
    out.push({
      name: c.name,
      title: typeof c.title === "string" ? c.title : c.name,
      description: typeof c.description === "string" ? c.description : "",
      inputSchema: c.inputSchema && typeof c.inputSchema === "object" ? c.inputSchema : { type: "object", properties: {} },
      readOnly: c.readOnly === true,
      takesFile: c.takesFile === true,
      givesFiles: c.givesFiles === true,
    });
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > BODY_MAX) {
        reject(Object.assign(new Error("too large"), { status: 413 }));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
        resolve(value);
      } catch {
        reject(Object.assign(new Error("not JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

/** The page's end of the port: who is connected, and what it is asked to run. */
export class PageLink extends EventEmitter {
  constructor({ token, origins = [], version = "", log = () => {}, pollMs = POLL_MS, goneMs = GONE_MS }) {
    super();
    this.token = token;
    this.origins = origins;
    this.version = version;
    this.log = log;
    this.pollMs = pollMs;
    this.goneMs = goneMs;
    this.session = null;
    this.nextId = 1;
    this.watch = setInterval(() => this.#check(), Math.min(1000, goneMs));
    this.watch.unref?.();
  }

  /** What the connected page said about itself, or null. */
  get page() {
    return this.session ? this.session.page : null;
  }

  /** Asks the page to run a command. Resolves with its result, rejects with `{ code, message }`. */
  run(name, input, timeoutMs = CALL_MS) {
    const session = this.session;
    if (!session) return Promise.reject({ code: "unavailable", message: "No inlay-cam page is connected." });
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id);
        session.queue = session.queue.filter((call) => call.id !== id);
        reject({ code: "timeout", message: `"${name}" did not finish in ${Math.round(timeoutMs / 1000)} s. It may still have changed the project: read project_get before running it again.` });
      }, timeoutMs);
      timer.unref?.();
      session.pending.set(id, { resolve, reject, timer });
      session.queue.push({ id, name, input: input ?? {} });
      this.#deliver(session);
    });
  }

  #deliver(session) {
    if (!session.waiting || session.queue.length === 0) return;
    const { res, timer } = session.waiting;
    session.waiting = null;
    session.lastSeen = Date.now();
    clearTimeout(timer);
    send(res, 200, { call: session.queue.shift() });
  }

  #check() {
    const session = this.session;
    if (session && !session.waiting && Date.now() - session.lastSeen > this.goneMs) this.#drop("The inlay-cam page stopped answering: its tab was closed or reloaded.");
  }

  #drop(message) {
    const session = this.session;
    if (!session) return;
    this.session = null;
    if (session.waiting) {
      clearTimeout(session.waiting.timer);
      send(session.waiting.res, 410, { gone: true });
    }
    for (const { reject, timer } of session.pending.values()) {
      clearTimeout(timer);
      reject({ code: "unavailable", message: `${message} If the call was a change, it may still have been made: read project_get before running it again.` });
    }
    this.log(`page gone: ${message}`);
    this.emit("page", null);
  }

  /** Answers a request to the port. */
  async handle(req, res) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const origin = req.headers.origin;
    if (!hostIsLocal(req.headers.host)) return send(res, 403, { error: "This server answers on this computer only." });
    if (origin !== undefined && !originAllowed(origin, this.origins)) return send(res, 403, { error: "This page may not connect. Start inlay-cam-mcp with --app <the page's address>." });
    if (origin !== undefined) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "content-type");
      res.setHeader("Access-Control-Allow-Private-Network", "true");
      res.setHeader("Access-Control-Max-Age", "600");
      res.writeHead(204).end();
      return;
    }
    if (req.method === "GET" && url.pathname === "/inlay-cam-mcp") return send(res, 200, { app: "inlay-cam-mcp", version: this.version });
    if (req.method !== "POST") return send(res, 404, { error: "Nothing here." });

    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return send(res, e.status ?? 400, { error: e.message });
    }
    switch (url.pathname) {
      case "/link/hello":
        return this.#hello(body, origin, res);
      case "/link/next":
        return this.#next(body, req, res);
      case "/link/result":
        return this.#result(body, res);
      case "/link/bye":
        if (this.session && body.session === this.session.id) this.#drop("The inlay-cam page was closed.");
        return send(res, 200, { ok: true });
      case "/peer/state":
      case "/peer/call":
        // Another copy of this relay, never a page.
        if (origin !== undefined) return send(res, 403, { error: "Not for pages." });
        if (!sameToken(body.token, this.token)) return send(res, 401, { refused: "token" });
        if (url.pathname === "/peer/state") return send(res, 200, { version: this.version, page: this.page });
        return this.run(String(body.name), body.input, typeof body.timeoutMs === "number" ? body.timeoutMs : undefined).then(
          (result) => send(res, 200, { result: result ?? null }),
          (error) => send(res, 200, { error }),
        );
      default:
        return send(res, 404, { error: "Nothing here." });
    }
  }

  #hello(body, origin, res) {
    if (!sameToken(body.token, this.token)) return send(res, 401, { refused: "token" });
    const pageId = typeof body.pageId === "string" ? body.pageId.slice(0, 80) : "";
    if (!pageId) return send(res, 400, { error: "pageId is missing" });
    const page = {
      origin: origin ?? null,
      appVersion: typeof body.appVersion === "string" ? body.appVersion.slice(0, 40) : null,
      commands: cleanCommands(body.commands),
    };
    if (this.session && this.session.pageId !== pageId) {
      // One page at a time. A page that has stopped asking gives way at once.
      if (this.session.waiting || Date.now() - this.session.lastSeen <= 1500) return send(res, 409, { refused: "taken" });
      this.#drop("Another inlay-cam page took its place.");
    }
    if (this.session) {
      this.session.page = page;
      this.session.lastSeen = Date.now();
    } else {
      this.session = { id: randomBytes(16).toString("hex"), pageId, page, queue: [], pending: new Map(), waiting: null, lastSeen: Date.now() };
      this.log(`page connected from ${origin ?? "this computer"} with ${page.commands.length} commands`);
    }
    send(res, 200, { welcome: { version: this.version, session: this.session.id } });
    this.emit("page", page);
  }

  #next(body, req, res) {
    const session = this.session;
    if (!session || body.session !== session.id) return send(res, 410, { gone: true });
    if (session.waiting) {
      clearTimeout(session.waiting.timer);
      send(session.waiting.res, 200, { idle: true });
    }
    session.lastSeen = Date.now();
    const timer = setTimeout(() => {
      if (session.waiting?.res !== res) return;
      session.waiting = null;
      session.lastSeen = Date.now();
      send(res, 200, { idle: true });
    }, this.pollMs);
    session.waiting = { res, timer };
    res.on("close", () => {
      if (session.waiting?.res !== res) return;
      clearTimeout(timer);
      session.waiting = null;
      session.lastSeen = Date.now();
    });
    this.#deliver(session);
  }

  #result(body, res) {
    const session = this.session;
    if (!session || body.session !== session.id) return send(res, 410, { gone: true });
    session.lastSeen = Date.now();
    const entry = session.pending.get(body.id);
    if (entry) {
      session.pending.delete(body.id);
      clearTimeout(entry.timer);
      if (body.error) entry.reject({ code: String(body.error.code ?? "failed"), message: String(body.error.message ?? "It failed.") });
      else entry.resolve(body.result ?? null);
    }
    send(res, 200, { ok: true });
  }

  close() {
    clearInterval(this.watch);
    this.#drop("The relay stopped.");
  }
}

function send(res, status, value) {
  if (res.writableEnded || res.destroyed) return;
  const text = JSON.stringify(value);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text), "Cache-Control": "no-store" });
  res.end(text);
}

/**
 * The link one copy of the relay uses. The copy that gets the port holds the
 * page link; a copy that finds the port taken by another inlay-cam-mcp sends
 * its calls through that one, and takes the port over when it stops. `role`
 * says which: "holder", "relay", or "none" with `error` saying why.
 */
export class SharedLink extends EventEmitter {
  constructor({ port, token, origins = [], version = "", log = () => {}, retryMs = 5000, pollMs, goneMs }) {
    super();
    this.port = port;
    this.token = token;
    this.version = version;
    this.log = log;
    this.retryMs = retryMs;
    this.role = "none";
    this.error = null;
    this.peerPage = null;
    this.holderVersion = null;
    this.closed = false;
    this.holder = new PageLink({ token, origins, version, log, pollMs, goneMs });
    this.holder.on("page", (page) => this.role === "holder" && this.emit("page", page));
    this.http = createServer((req, res) => {
      this.holder.handle(req, res).catch((e) => {
        log(`request failed: ${e?.message ?? e}`);
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
    // A request for the next command is held open on purpose.
    this.http.requestTimeout = 0;
    this.http.headersTimeout = 10_000;
    // A failed try for the port is answered where it is made (#listen).
    this.http.on("error", () => {});
    this.timer = null;
  }

  get page() {
    return this.role === "holder" ? this.holder.page : this.role === "relay" ? this.peerPage : null;
  }

  /** Takes the port, or finds who has it. Resolves once it knows which. */
  async start() {
    await this.#settle();
    this.timer = setInterval(() => this.#settle().catch(() => {}), this.retryMs);
    this.timer.unref?.();
  }

  async #settle() {
    if (this.closed || this.role === "holder") return;
    if (await this.#listen()) {
      const was = this.peerPage;
      this.role = "holder";
      this.error = null;
      this.peerPage = null;
      this.log(`listening on 127.0.0.1:${this.port}`);
      if (was) this.emit("page", null);
      return;
    }
    const state = await this.#peer("/peer/state", {}, 3000).catch((e) => ({ failed: e.message }));
    if (state.failed !== undefined || state.refused !== undefined) {
      const had = this.peerPage;
      this.role = "none";
      this.peerPage = null;
      this.error =
        state.refused !== undefined
          ? `Port ${this.port} is held by another inlay-cam-mcp with a different pairing token. Give both the same INLAY_MCP_TOKEN, or this one its own --port.`
          : `Port ${this.port} is in use by another program (${state.failed}). Start inlay-cam-mcp with another --port.`;
      if (had) this.emit("page", null);
      return;
    }
    const before = JSON.stringify(this.peerPage);
    this.role = "relay";
    this.error = null;
    this.holderVersion = typeof state.version === "string" ? state.version : null;
    this.peerPage = state.page ?? null;
    if (JSON.stringify(this.peerPage) !== before) this.emit("page", this.peerPage);
  }

  #listen() {
    return new Promise((resolve) => {
      const failed = (e) => {
        if (e.code !== "EADDRINUSE") this.error = e.message;
        resolve(false);
      };
      this.http.once("error", failed);
      this.http.listen(this.port, "127.0.0.1", () => {
        this.http.off("error", failed);
        resolve(true);
      });
    });
  }

  async #peer(path, body, timeoutMs) {
    const res = await fetch(`http://127.0.0.1:${this.port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, token: this.token }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const value = await res.json().catch(() => null);
    if (!value || typeof value !== "object") throw new Error(`HTTP ${res.status}`);
    if (res.status === 401) return { refused: "token" };
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return value;
  }

  /** Asks the page to run a command, directly or through the copy that holds the port. */
  async run(name, input, timeoutMs = CALL_MS) {
    if (this.role === "holder") return this.holder.run(name, input, timeoutMs);
    if (this.role !== "relay") throw { code: "unavailable", message: this.error ?? "No inlay-cam page is connected." };
    let answer;
    try {
      answer = await this.#peer("/peer/call", { name, input, timeoutMs }, timeoutMs + 5000);
    } catch (e) {
      throw { code: "unavailable", message: `The inlay-cam-mcp this one sends its calls through did not answer (${e.message}). If the call was a change, it may still have been made: read project_get before running it again.` };
    }
    if (answer.error) throw answer.error;
    return answer.result;
  }

  /** Resolves true once a page is connected, false when `ms` pass without one. */
  waitForPage(ms) {
    if (this.page) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (value) => {
        clearTimeout(timer);
        clearInterval(look);
        this.off("page", onPage);
        resolve(value);
      };
      const onPage = (page) => page && done(true);
      const timer = setTimeout(() => done(false), ms);
      // A copy that sends its calls through another hears of a page by asking.
      const look = setInterval(() => this.role !== "holder" && this.#settle().catch(() => {}), 1000);
      this.on("page", onPage);
    });
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.holder.close();
    this.http.close();
    this.http.closeAllConnections?.();
  }
}
