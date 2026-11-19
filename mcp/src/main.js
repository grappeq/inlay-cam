// inlay-cam-mcp: started by an AI agent, which talks to it over stdin and
// stdout; the inlay-cam page in the browser connects to it on 127.0.0.1.

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { openInBrowser } from "./browser.js";
import { USAGE, originOf, pairingLink, pairingToken, readOptions, rememberCommands, rememberedCommands } from "./config.js";
import { SharedLink } from "./link.js";
import { Mcp } from "./mcp.js";

export const VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

export async function main(argv) {
  const options = readOptions(argv);
  if (options.help) return void process.stdout.write(`${USAGE}\n`);
  if (options.version) return void process.stdout.write(`${VERSION}\n`);
  if (options.error) {
    process.stderr.write(`inlay-cam-mcp: ${options.error}\n\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  const token = pairingToken(options.token);
  if (options.pair) {
    process.stdout.write(`port:  ${options.port}\ntoken: ${token}\nlink:  ${pairingLink(options.app, options.port, token)}\n\nOpen the link once in the browser you use inlay-cam in.\n`);
    return;
  }

  // stdout is the protocol's: everything else goes to stderr.
  const log = (line) => process.stderr.write(`inlay-cam-mcp: ${line}\n`);
  const link = new SharedLink({ port: options.port, token, origins: [originOf(options.app)], version: VERSION, log });
  const mcp = new Mcp({
    link,
    options,
    token,
    version: VERSION,
    send: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
    open: openInBrowser,
    remembered: rememberedCommands(),
    remember: rememberCommands,
  });
  await link.start();
  if (link.error) log(link.error);

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (line.trim() === "") return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Not JSON" } })}\n`);
      return;
    }
    void mcp.handle(message);
  });
  // The agent closing its end is how it stops this server.
  lines.on("close", () => {
    link.close();
    process.exit(0);
  });
}
