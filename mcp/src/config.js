// What the relay is started with: its options, and the folder it keeps its
// pairing token and the page's last command list in.

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The hosted app. A page from here may connect without being named. */
export const HOSTED_APP = "https://grappeq.github.io/inlay-cam/";
export const DEFAULT_PORT = 7391;

export const USAGE = `\
inlay-cam-mcp: lets an AI agent drive the inlay-cam page open in your browser

  --app <url>     the inlay-cam page to open and to let connect
                  (default: ${HOSTED_APP}). A page on this computer
                  (localhost, 127.0.0.1) may always connect.
  --port <number> the port on 127.0.0.1 the page connects to (default: ${DEFAULT_PORT})
  --out <folder>  where exported files are written unless a call names a
                  folder (default: the folder the agent was started in)
  --pair          print the port, the pairing token and a pairing link, and exit
  --version       print the version and exit

Each has an environment variable too: INLAY_MCP_APP, INLAY_MCP_PORT,
INLAY_MCP_OUT, and INLAY_MCP_TOKEN for a pairing token of your own.`;

/** The folder the token is kept in, by the platform's custom. */
export function configDir(env = process.env, platform = process.platform) {
  if (env.INLAY_MCP_CONFIG) return env.INLAY_MCP_CONFIG;
  if (platform === "win32" && env.APPDATA) return join(env.APPDATA, "inlay-cam-mcp");
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "inlay-cam-mcp");
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "inlay-cam-mcp");
}

/** The origin of a URL as a browser sends it in its Origin header; null for what is no http(s) URL. */
export function originOf(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/**
 * Reads the options. Answers `{ error }` for one that cannot be used,
 * `{ help: true }` or `{ version: true }` when only that was asked.
 */
export function readOptions(argv, env = process.env) {
  const out = {
    app: env.INLAY_MCP_APP || HOSTED_APP,
    port: env.INLAY_MCP_PORT || String(DEFAULT_PORT),
    out: env.INLAY_MCP_OUT || null,
    token: env.INLAY_MCP_TOKEN || null,
    pair: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    try {
      if (arg === "--app") out.app = value();
      else if (arg === "--port") out.port = value();
      else if (arg === "--out") out.out = value();
      else if (arg === "--pair") out.pair = true;
      else if (arg === "--help" || arg === "-h") return { help: true };
      else if (arg === "--version" || arg === "-v") return { version: true };
      else return { error: `${arg} is not an option` };
    } catch (e) {
      return { error: e.message };
    }
  }
  const port = Number(out.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: `${out.port} is not a port` };
  if (!originOf(out.app)) return { error: `${out.app} is not the address of a page (http:// or https://)` };
  if (out.token !== null && !/^[A-Za-z0-9_-]{16,}$/.test(out.token)) return { error: "INLAY_MCP_TOKEN must be 16 or more letters, digits, - or _" };
  return { ...out, port, out: out.out ? resolve(out.out) : null };
}

/** The pairing token: the one given, else the one kept in the config folder, made on first use. */
export function pairingToken(given, dir = configDir()) {
  if (given) return given;
  const file = join(dir, "token");
  try {
    const kept = readFileSync(file, "utf8").trim();
    if (/^[A-Za-z0-9_-]{16,}$/.test(kept)) return kept;
  } catch {
    // None kept yet.
  }
  const made = randomBytes(24).toString("base64url");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${made}\n`, { mode: 0o600 });
  } catch {
    // Without a place to keep it, it lasts as long as this run.
  }
  return made;
}

/** The link that opens the app already paired with this relay. */
export function pairingLink(app, port, token) {
  const url = new URL(app);
  url.hash = `agent=${port}:${token}`;
  return url.href;
}

/**
 * The commands the page last said it has, so that they are listed before a
 * page connects. Before any page has, the ones this server was shipped with:
 * the page's of the same version (commands.json beside this file, kept in
 * step with web/src/agent/commands.ts by a test there).
 */
export function rememberedCommands(dir = configDir(), shipped = new URL("./commands.json", import.meta.url)) {
  for (const file of [join(dir, "commands.json"), shipped]) {
    try {
      const kept = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(kept) && kept.length > 0) return kept;
    } catch {
      // Not there, or not readable: the next.
    }
  }
  return [];
}

export function rememberCommands(commands, dir = configDir()) {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "commands.json"), JSON.stringify(commands));
  } catch {
    // Not kept: the next start lists them once a page has connected.
  }
}
