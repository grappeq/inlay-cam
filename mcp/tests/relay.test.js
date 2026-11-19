// The relay end to end: a stand-in for the page on one side, MCP messages on the other.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pairingLink, readOptions } from "../src/config.js";
import { SharedLink, hostIsLocal, originAllowed } from "../src/link.js";
import { Mcp, safeName } from "../src/mcp.js";

const TOKEN = "test-token-0123456789";
const APP = "https://grappeq.github.io";
let nextPort = 47310;
const open = [];
after(() => open.forEach((link) => link.close()));

async function relay({ port = nextPort++, remembered = [] } = {}) {
  const link = new SharedLink({ port, token: TOKEN, origins: [APP], version: "9.9.9", retryMs: 100, goneMs: 300, pollMs: 200 });
  open.push(link);
  await link.start();
  const sent = [];
  const dir = mkdtempSync(join(tmpdir(), "inlay-mcp-"));
  const mcp = new Mcp({ link, options: { app: `${APP}/inlay-cam/`, port, out: null }, token: TOKEN, version: "9.9.9", send: (m) => sent.push(m), cwd: dir, remembered });
  const ask = async (method, params) => {
    const id = sent.length + 1000;
    await mcp.handle({ jsonrpc: "2.0", id, method, params });
    const answer = sent.find((m) => m.id === id);
    assert.ok(answer, `no answer to ${method}`);
    return answer.result ?? answer;
  };
  return { link, mcp, sent, dir, port, ask };
}

const post = (port, path, body, headers = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { Origin: APP, ...headers }, body: JSON.stringify(body) });

const COMMANDS = [
  { name: "project_get", description: "The project.", inputSchema: { type: "object", properties: {} }, readOnly: true },
  { name: "drawing_import", description: "Brings in a drawing.", inputSchema: { type: "object", properties: { file: { type: "object" }, replace: { type: "boolean" } }, required: ["file"] }, takesFile: true },
  { name: "gcode_export", description: "The files.", inputSchema: { type: "object", properties: {} }, givesFiles: true },
  { name: "Bad Name", description: "Dropped." },
];

/** A page that answers each command with what `answer` gives for it. */
async function page(port, answer, pageId = "page-1") {
  const hello = await post(port, "/link/hello", { token: TOKEN, pageId, appVersion: "0.1.0", commands: COMMANDS });
  if (!hello.ok) return { status: hello.status, body: await hello.json() };
  const { session } = (await hello.json()).welcome;
  let on = true;
  const loop = (async () => {
    while (on) {
      const res = await post(port, "/link/next", { session }).catch(() => null);
      if (!res || res.status === 410) break;
      const { call } = await res.json();
      if (!call) continue;
      let body;
      try {
        body = { session, id: call.id, result: await answer(call) };
      } catch (e) {
        body = { session, id: call.id, error: { code: "invalid_input", message: e.message } };
      }
      await post(port, "/link/result", body);
    }
  })();
  return { session, stop: () => ((on = false), loop) };
}

test("options are read and refused", () => {
  assert.equal(readOptions([], {}).port, 7391);
  assert.equal(readOptions(["--port", "8123", "--app", "https://tools.example/"], {}).app, "https://tools.example/");
  assert.match(readOptions(["--port", "x"], {}).error, /not a port/);
  assert.match(readOptions(["--app", "tools.example"], {}).error, /not the address/);
  assert.match(readOptions(["--nope"], {}).error, /not an option/);
  assert.equal(pairingLink("https://grappeq.github.io/inlay-cam/", 7391, "abc"), "https://grappeq.github.io/inlay-cam/#agent=7391:abc");
});

test("who may connect", () => {
  assert.ok(originAllowed(APP, [APP]));
  assert.ok(originAllowed("http://localhost:5173", []));
  assert.ok(!originAllowed("https://evil.example", [APP]));
  assert.ok(hostIsLocal("127.0.0.1:7391"));
  assert.ok(!hostIsLocal("evil.example:7391"));
  assert.equal(safeName("../../etc/passwd"), "passwd");
  assert.equal(safeName("..\\..\\a:b.nc"), "a_b.nc");
});

test("a page is turned away by a wrong token, a foreign origin, and while another is connected", async () => {
  const { port } = await relay();
  assert.equal((await post(port, "/link/hello", { token: "wrong", pageId: "p" })).status, 401);
  assert.equal((await post(port, "/link/hello", { token: TOKEN, pageId: "p" }, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await post(port, "/peer/state", { token: TOKEN })).status, 403);
  const first = await page(port, () => ({}));
  const second = await page(port, () => ({}), "page-2");
  assert.equal(second.status, 409);
  await first.stop();
});

test("the page's commands are tools, and a call goes to the page and back", async () => {
  const { port, ask, sent } = await relay();
  const before = (await ask("tools/list")).tools.map((t) => t.name);
  assert.deepEqual(before, ["inlay_status", "inlay_open", "inlay_run"]);
  assert.equal((await ask("tools/call", { name: "project_get", arguments: {} })).isError, true);

  const p = await page(port, (call) => {
    if (call.name === "project_get") return { name: "Coaster", files: [{ file: 1 }], images: [{ mimeType: "image/png", data: "AAAA", label: "The drawing" }] };
    throw new Error("width must be greater than 0");
  });
  assert.ok(sent.some((m) => m.method === "notifications/tools/list_changed"));
  const tools = (await ask("tools/list")).tools;
  assert.deepEqual(tools.map((t) => t.name).slice(3), ["project_get", "drawing_import", "gcode_export"]);
  const importer = tools.find((t) => t.name === "drawing_import").inputSchema;
  assert.deepEqual(importer.required, ["path"]);
  assert.deepEqual(Object.keys(importer.properties), ["replace", "path"]);
  assert.ok(tools.find((t) => t.name === "gcode_export").inputSchema.properties.overwrite);

  const got = await ask("tools/call", { name: "project_get", arguments: {} });
  // Only a command that gives files has `files` taken for files to write.
  assert.deepEqual(JSON.parse(got.content[0].text), { name: "Coaster", files: [{ file: 1 }] });
  assert.equal(got.isError, undefined);
  assert.deepEqual(got.content[2], { type: "image", data: "AAAA", mimeType: "image/png" });

  const viaRun = await ask("tools/call", { name: "inlay_run", arguments: { name: "project_get" } });
  assert.equal(JSON.parse(viaRun.content[0].text).name, "Coaster");

  const refused = await ask("tools/call", { name: "gcode_export", arguments: {} });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /invalid_input: width must be greater than 0/);
  assert.equal((await ask("initialize", { protocolVersion: "2025-03-26" })).protocolVersion, "2025-03-26");
  await p.stop();
});

test("a file is read here for the page, and the page's files are written here", async () => {
  const { port, ask, dir } = await relay();
  writeFileSync(join(dir, "leaf.svg"), "<svg/>");
  let seen;
  const p = await page(port, (call) => {
    seen = call.input;
    return call.name === "gcode_export" ? { files: [{ name: "../pocket.nc", text: "G0 X0\n" }] } : { shapes: 1 };
  });
  await ask("tools/call", { name: "drawing_import", arguments: { path: "leaf.svg", replace: true } });
  assert.deepEqual(seen, { replace: true, file: { name: "leaf.svg", text: "<svg/>" } });

  const first = JSON.parse((await ask("tools/call", { name: "gcode_export", arguments: { folder: "out" } })).content[0].text);
  assert.deepEqual(seen, {});
  assert.equal(first.saved[0].path, join(dir, "out", "pocket.nc"));
  assert.equal(readFileSync(first.saved[0].path, "utf8"), "G0 X0\n");
  const again = await ask("tools/call", { name: "gcode_export", arguments: { folder: "out" } });
  assert.equal(again.isError, true);
  assert.match(JSON.parse(again.content[0].text).notSaved[0].why, /there already/);
  const over = await ask("tools/call", { name: "gcode_export", arguments: { folder: "out", overwrite: true } });
  assert.equal(over.isError, undefined);
  await p.stop();
});

test("a page that stops asking is gone, and what it was running is turned down", async () => {
  const { port, link, mcp } = await relay();
  let stop;
  const p = await page(port, () => new Promise(() => stop()));
  stop = () => void p.stop();
  const answer = await mcp.call("project_get", {});
  assert.equal(answer.isError, true);
  assert.match(answer.content[0].text, /unavailable: .*stopped answering/);
  assert.equal(link.page, null);
});

test("a second copy sends its calls through the first, and takes the port over when it stops", async () => {
  const first = await relay();
  const second = await relay({ port: first.port });
  assert.equal(first.link.role, "holder");
  assert.equal(second.link.role, "relay");
  const p = await page(first.port, () => ({ name: "Coaster" }));
  assert.equal(await second.link.waitForPage(2000), true);
  const got = await second.ask("tools/call", { name: "project_get", arguments: {} });
  assert.equal(JSON.parse(got.content[0].text).name, "Coaster");
  await p.stop();
  first.link.close();
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(second.link.role, "holder");
});

test("the commands last seen are listed before a page connects", async () => {
  const { ask } = await relay({ remembered: [{ name: "project_get", description: "The project.", inputSchema: { type: "object" } }] });
  assert.ok((await ask("tools/list")).tools.some((t) => t.name === "project_get"));
});
