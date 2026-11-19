# inlay-cam-mcp

Lets an AI agent, such as Claude Code, work in [inlay-cam](https://grappeq.github.io/inlay-cam/).
This is a [Model Context Protocol](https://modelcontextprotocol.io) server that the agent
starts on your computer. The inlay-cam page open in your browser connects to it on
`127.0.0.1` and runs each call there, in front of you: the project the agent changes is the
one on your screen, saved as your own changes are.

Nothing goes anywhere but your own computer, except what the agent reads, which goes to the
agent's model provider like everything else it reads. The server has no dependencies beyond
Node.js and makes no requests of its own.

## Setting up

You need [Node.js](https://nodejs.org/) 20 or newer, and Chrome, Edge or Firefox.

**1. Add the server to the agent.** For Claude Code:

```bash
claude mcp add --scope user inlay-cam -- npx -y github:grappeq/inlay-cam
```

`--scope user` has it in every project; leave it out for this one only. `npx` fetches the
server from GitHub the first time, which takes a moment. To stay on one version, name a tag:
`github:grappeq/inlay-cam#v0.1.0`.

Any other agent that starts MCP servers over stdio takes the same command: `npx` with the
arguments `-y` and `github:grappeq/inlay-cam`.

**2. Ask the agent to open inlay-cam.** It calls `inlay_open`, which opens the app in your
default browser with the pairing in its address. The first time:

- the page asks whether an agent may work in it: allow it;
- Chrome, Edge and Firefox ask whether the site may reach apps on this device: allow it,
  that is this server.

The browser keeps the pairing, so this is done once. A chip in the app's top bar says where
the connection stands, and Settings, Agent switches it off.

To pair by hand, when the agent cannot open your browser:

```bash
npx -y github:grappeq/inlay-cam --pair
```

prints the port, the token and a link. Open the link once in the browser you use inlay-cam
in, or enter the port and token under Settings, Agent.

Safari does not let a page from the web reach the computer it runs on. Use inlay-cam served
from this computer there (see `--app`).

## Options

| Option | Environment | What |
|---|---|---|
| `--app <url>` | `INLAY_MCP_APP` | The inlay-cam page to open and to let connect. Default: the hosted app. A page on this computer (`localhost`, `127.0.0.1`) may always connect |
| `--port <number>` | `INLAY_MCP_PORT` | The port on `127.0.0.1` the page connects to. Default 7391 |
| `--out <folder>` | `INLAY_MCP_OUT` | Where exported files are written unless a call names a folder. Default: the folder the agent was started in |
| | `INLAY_MCP_TOKEN` | A pairing token of your own, in place of the one kept in the config folder |
| `--pair` | | Print the port, the token and a pairing link, and exit |

Options go after the package in the agent's setting:

```bash
claude mcp add inlay-cam -- npx -y github:grappeq/inlay-cam --app https://tools.example/
```

The token is made on the first run and kept in `%APPDATA%\inlay-cam-mcp` on Windows,
`~/Library/Application Support/inlay-cam-mcp` on macOS, and `$XDG_CONFIG_HOME/inlay-cam-mcp`
or `~/.config/inlay-cam-mcp` elsewhere.

## The tools

The server has three tools of its own:

| Tool | What |
|---|---|
| `inlay_status` | Whether a page is connected, which commands it has, where files are written, and the pairing link |
| `inlay_open` | Opens the app paired with this server, and waits for it to connect |
| `inlay_run` | Runs any of the page's commands by name |

Every command of the connected page is a tool beside them. The page says which it has when
it connects, so a newer page brings its new tools without a new server. The server remembers
the list, and offers it at the next start before a page has connected.

| Tool | What |
|---|---|
| `project_get` | The stock, the shapes with their ids and places, the steps and what each still lacks |
| `projects_list`, `project_open`, `project_new`, `project_rename` | The kept projects |
| `project_save`, `project_load` | A project as a file on disk |
| `stock_set` | The stock's size, thickness, material and colour |
| `drawing_import` | An SVG or DXF drawing from disk onto the stock |
| `shape_add` | A circle, rectangle, ellipse, polygon or outline |
| `shapes_move`, `shapes_rotate`, `shapes_scale`, `shapes_mirror`, `shapes_duplicate`, `shapes_remove` | Shapes, by id |
| `history_undo`, `history_redo` | The drawing's undo history |
| `tools_list`, `tool_get` | The user's tools and their cutting rows, to read |
| `step_settings` | The settings of each type of step, with their defaults and what they mean |
| `step_add`, `step_update`, `step_move`, `step_remove` | Inlays, operations and steps done by hand |
| `step_build` | One step's files made and simulated, and a V-carve inlay's fit |
| `timeline_build` | The stock taken through the whole list, and the files as they are run |
| `gcode_export` | The G-code files written to disk |
| `drawing_render`, `stock_render` | Pictures: the drawing with shape ids, and the cut wood from above |
| `view_show` | Turns the page to a view, a step or a stage |

What a command does and takes is in its description, which the agent reads; the commands
themselves are in `web/src/agent/commands.ts`.

- **Changes to the drawing** are each one step of the app's undo history.
- **Every change to the project** is checked by the core before it is made, as a project
  file is when it is written. A key a command does not take is refused by name.
- **The tool list is read, not changed.** Cutting numbers are the user's own.
- **A file the simulation found problems in** is not written by `gcode_export` unless asked
  for, and is named in its answer.

## Several agents

Any number of copies of the server can share one page. The first to start holds the port;
one that finds the port taken by another inlay-cam-mcp with the same token sends its calls
through that one, and takes the port over when it stops. Calls from several agents run one
after another in the page.

## How it works

```
agent  <-- MCP over stdin/stdout -->  inlay-cam-mcp  <-- HTTP on 127.0.0.1 -->  the page
```

The page calls the server, never the other way round: it says hello with the token and its
commands, then asks for the next command to run, a request the server holds until there is
one. A page that stops asking is gone. The server answers only requests whose `Host` is this
computer, and only pages from the hosted app, from this computer, or from `--app`.

To try a change from a clone: `node /path/to/inlay-cam/mcp/bin/inlay-cam-mcp.js` in place of
`npx -y github:grappeq/inlay-cam`, and `npm test` at the repository's root for its tests.
