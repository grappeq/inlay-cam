# The server's HTTP API

`inlay-server` serves the app and keeps what the app would otherwise keep in a browser: one
tool file, `tools.json`, the projects and the settings, for everyone who opens it. The page
reads and writes them through this API, and the tool file is there for an agent or a script
as well. Routing and every route are in `crates/inlay-server/src/api.rs`; the files on disk
and the backups are in `store.rs`.

The tool file is the app's own tool-library file, described in
[formats.md](formats.md#tool-library-kind-tool-library). Everything the API answers about a
tool is in that file's words: `fluteLength`, `shankDiameter`, `cutting`, and so on. Lengths are
mm, `rpm` is rev/min, `feed` and `plunge` are mm/min, and a row's `stepover` is mm whatever
its `stepoverUnit` says.

## Conventions

**No login.** Whoever reaches the server can read and change the tool file. Two checks keep
other web sites out:

- The `Host` header must be `localhost`, `127.0.0.1` or `::1`, unless the server runs with
  `--any-host`. That stops DNS rebinding.
- Anything but a `GET` needs the header `X-Inlay: 1` and `Content-Type: application/json`,
  and, when the browser sends them, an `Origin` that is the server's own and a
  `Sec-Fetch-Site` of `same-origin` or `none`.

**The token.** Every read answers `token`: the SHA-256 of the tool file as it is. Every
write sends back the token of the read it is based on, as `token` in the body or as
`If-Match: "<token>"`. If the file has changed since, the answer is `409 conflict` with the
present token, and nothing is written. Every write answers the token of the file after it.

**Dry run and diff.** Every write takes `"dryRun": true`: the same checks, the same answer,
and nothing written. `"diff": true` adds `diff`, the unified diff of `tools.json` that the
write makes or would make (`""` when it changes nothing). `PUT /api/library` takes both as
`?dryRun=1&diff=1`.

**Backups.** A write that changes the file first keeps the file as it was in `backups/` of
the data folder and answers its name as `backup`. A write that changes nothing answers
`"unchanged": true` and keeps none. The newest 30 backups are all kept; of older ones, the
last of each day, for 60 days. The file is replaced by renaming a finished copy over it, so
a snapshot of the folder never holds half a file.

**A write's answer.**

```json
{"ok": true, "token": "9f2c…", "savedAt": "2026-11-18T09:12:03Z", "unchanged": false,
 "backup": "tools-20261118-091203-000.json", "diff": "--- a/tools.json\n+++ b/tools.json\n…"}
```

plus what the route adds (`tool`, `deleted`, `logged`). A dry run has `"dryRun": true`, the
present `token`, and neither `savedAt` nor `backup`.

**Errors.** Every refusal is a JSON envelope:

```json
{"error": {"code": "invalid", "message": "tool \"Ø6×20 2F\": diameter must be greater than 0"}}
```

| Status | `code` | When | Extra fields |
|---|---|---|---|
| 400 | `bad_request` | A malformed body, a missing or misspelt key, a name that several tools have | `ids` (for the last) |
| 403 | `forbidden_host`, `forbidden_origin` | The `Host`, `X-Inlay`, `Origin` or `Sec-Fetch-Site` check failed | |
| 404 | `not_found` | No such path, tool, row, profile, export or backup | |
| 405 | `method_not_allowed` | A path that exists, with a method it does not have | |
| 409 | `conflict` | The tool file changed since `token` was read | `token`, `savedAt` |
| 413 | `too_large` | A body over 256 KB; over 8 MB for `PUT /api/library`; over 32 MB for a project | |
| 415 | `unsupported_media_type` | A write without `Content-Type: application/json` | |
| 422 | `invalid` | The write would leave the tool file invalid | |
| 422 | `load_error` | The tool file on the server cannot be read, so nothing can be answered from it | |
| 422 | `export_failed` | Makera CAM could not read the library that would be written | |
| 500 | `internal` | The data folder could not be read or written | |

A key the tool model does not have is a `400` that names it, in a patch, a new tool or a log
entry: a misspelt key is never dropped in silence.

## Routes

`<tool>` names a tool by its `id`, or else by its name, or else by the name the Makera apps
show (the name with its coating). A name that several tools have is a `400` listing their
ids. `<row>` names a cutting row: its material's key for the plain row, or
`material@profile` for a row on a profile. Both are percent-encoded in a path.

| Method | Path | Body | Answer |
|---|---|---|---|
| GET | `/api` | | Every route with a one-line summary |
| GET | `/api/health` | | `{"ok": true, "app": "inlay-cam", "version"}` |
| GET | `/api/library` | | The tool file itself. `ETag` is the token; `If-None-Match` gives `304` |
| PUT | `/api/library` | a tool file | Replaces the whole file. Needs `If-Match` |
| GET | `/api/tools?q=<words>&material=<key>` | | A compact tool list |
| POST | `/api/tools` | `{token, tool}` | Adds a tool |
| GET | `/api/tools/<tool>` | | One tool |
| PATCH | `/api/tools/<tool>` | `{token, patch}` | Changes a tool |
| DELETE | `/api/tools/<tool>` | `{token}`, or none with `If-Match` | Deletes a tool |
| POST | `/api/tools/<tool>/rows/<row>/log` | `{token, entry}` | Logs a cut with a row |
| GET | `/api/tools/<tool>/suggestions?row=<row>` | | The feeds model's numbers for a row |
| GET | `/api/attention` | | What wants looking at, worst first |
| GET | `/api/export` | | What each library for another program would hold |
| GET | `/api/export/<kind>` | | A library as a file: `tools.yaml`, `cam`, `studio`, `fusion` |
| GET | `/api/backups` | | The backups kept, newest first |
| GET | `/api/backups/<name>` | | One backup: a tool file |
| GET | `/api/projects` | | The projects kept, last written first |
| GET, PUT, DELETE | `/api/projects/<id>` | a project file | One project: read, kept, taken off the list |
| GET | `/api/settings` | | The settings kept, one text per key |
| PUT | `/api/settings/<key>` | `{value}` | Keeps one setting |

### `GET /api/library` and `PUT /api/library`

The page's own two routes. `GET` answers the file's text as it is on disk, with
`ETag: "<token>"` and `X-Saved-At`. `PUT` takes a whole tool file, checks it as the app
checks an imported one, and writes it in the app's own layout. This is also how materials,
profiles and groups are changed, and how a backup is put back: `GET /api/backups/<name>`,
then `PUT` its text.

### `GET /api/tools?q=ball%20dlc&material=aluminum`

```json
{"token": "9f2c…", "savedAt": "2026-11-18T09:12:03Z", "count": 3,
 "materials": ["hardwood", "softwood", "aluminum", "…"], "profiles": ["clearing", "facing"],
 "tools": [{"id": "starter-22", "name": "Ø1 Ball S3.175 2F 38L", "displayName": "Ø1 Ball S3.175 2F 38L DLC",
            "group": "Ball nose", "kind": "ball_end", "coating": "DLC", "style": null,
            "diameter": 1, "shankDiameter": 3.175, "fluteLength": 3, "length": 38, "flutes": 2,
            "recommendedFor": ["hardwood", "softwood", "aluminum", "brass", "copper", "plastic"],
            "rows": ["hardwood", "softwood", "aluminum", "brass", "copper", "plastic"], "attention": 0},
           "…"]}
```

`q` holds words that must all appear, in any case, in a tool's name, shown name, group, kind
(`flat end`, `thread mill`), coating or style. `material` keeps the tools with a cutting row
for that material. Any other parameter is a `400`. `rows` are the keys of the tool's cutting
rows, and `attention` counts what wants looking at on it.

### `GET /api/tools/<tool>`

```json
{"token": "9f2c…", "savedAt": "…", "displayName": "Ø3.175×12 1F Upcut DLC",
 "tool": {"id": "starter-04", "name": "Ø3.175×12 1F Upcut", "kind": "flat_end", "diameter": 3.175,
          "cutting": [{"material": "hardwood", "rpm": 10000, "feed": 1000, "plunge": 300,
                       "stepover": 1.999996, "stepoverUnit": "percent", "stepdown": 1, "log": [...]}],
          "…": "…"},
 "rows": [{"row": "hardwood", "result": {"date": "2026-11-18", "outcome": "failed", "at": {...}, "text": "…"}}],
 "attention": [{"toolId": "starter-04", "kind": "failed", "material": "hardwood", "…": "…"}]}
```

`tool` is the tool as the file holds it. `rows` gives, for each cutting row, its result as it
stands: the newest log entry that was cut at the row's present numbers, or `null`. An entry
cut at other numbers is history, and says nothing about the row as it is.

### `PATCH /api/tools/<tool>`

```json
{"token": "9f2c…", "dryRun": true, "diff": true,
 "patch": {"fluteLength": 14, "coating": null, "source": {"url": "https://…"},
           "cutting": {"hardwood": {"rpm": 11000},
                       "aluminum@clearing": {"rpm": 12000, "feed": 900, "plunge": 150, "stepover": 0.6, "stepdown": 3},
                       "softwood": null}}}
```

The patch is a JSON merge patch (RFC 7396) of the tool as the file holds it: it names only
what changes, a key set to `null` is removed, an object is gone into, and a list is replaced
whole. `cutting` is the exception: in a patch it is an object by row key, and each value is a
merge patch of that row. A row the tool does not have is added, and needs all its numbers;
`null` removes one. A tool's `id` cannot be changed.

The answer adds the tool as it is after the change, in the shape of `GET /api/tools/<tool>`.

### `POST /api/tools` and `DELETE /api/tools/<tool>`

```json
{"token": "9f2c…", "tool": {"name": "Ø6×20 2F", "kind": "flat_end", "diameter": 6, "shankDiameter": 6,
                             "group": "End mills"}}
```

`tool` is a tool as the file holds one; `name`, `kind`, `diameter` and `shankDiameter` are
needed. Without an `id` it is given one. It goes after the last tool of its group. The answer
adds the tool as `GET /api/tools/<tool>` gives it.

`DELETE` answers `deleted`: `{"id", "name", "displayName", "group"}`. It takes a dry run like
any write.

### `POST /api/tools/<tool>/rows/<row>/log`

```json
{"token": "9f2c…", "entry": {"date": "2026-11-18", "outcome": "ok", "text": "Clean edges."}}
```

Adds one entry to a row's log. `date` is `YYYY-MM-DD`; `outcome` is `ok`, `provisional`
(it worked, still to confirm) or `failed`, and is left out for a plain remark; `text` is
needed. `at` holds the numbers of that cut: `{"rpm", "feed", "plunge", "stepover",
"stepdown"}`, with `stepoverUnit` and `passes` where the row has them. Left out, it is the
row's present numbers, which is right for a cut made with the row as it is. The answer adds
`logged`, the entry as kept, and the tool. With `"diff": true`:

```json
{"ok": true, "token": "…", "savedAt": "…", "unchanged": false, "backup": "tools-20261118-091203-000.json",
 "logged": {"date": "2026-11-18", "outcome": "ok", "text": "Clean edges.",
            "at": {"rpm": 10000, "feed": 1000, "plunge": 300, "stepover": 1.999996, "stepoverUnit": "percent",
                   "stepdown": 1}},
 "diff": "--- a/tools.json\n+++ b/tools.json\n@@ -462,6 +462,21 @@\n …\n+          \"log\": [\n …",
 "tool": {...}, "displayName": "…", "rows": [...], "attention": [...]}
```

### `GET /api/tools/<tool>/suggestions?row=aluminum`

```json
{"token": "9f2c…", "tool": "Ø3.175×12 1F Upcut", "row": "aluminum", "cutsLike": "aluminum",
 "covered": true, "combination": "slot_safe",
 "suggestion": {"status": "ok", "untested": false, "reason": null,
                "values": {"rpm": 12000, "feed": 280, "plunge": 60, "stepoverMm": 0.9525, "stepoverPct": 30,
                           "stepdown": 0.1},
                "chipLoad": 0.0233, "powerW": 1.5, "powerLimitW": 80,
                "notes": ["Long reach (3.8 × D): depth eased.", "…"], "…": "…"},
 "limits": {"classLabel": "Aluminum", "chipFloor": 0.012, "chipMax": 0.045, "powerCapW": 120, "…": "…"}}
```

What the feeds model gives for that row: the combination it starts from (the profile's, or
the plain Slot-safe) and its numbers, with the limits a row's own numbers are checked
against. `&all=1` answers `entry` instead, with every combination: each of the five stops
with and without a ramped entry, adaptive clearing and lubrication. A material of the
owner's is suggested for as the material it is set to cut like (`cutsLike`). The numbers are
for a Carvera Air's spindle; the machine set in a browser is not known to the server.

### Projects and settings

The page's own routes, for what it keeps besides the tool list. They take no token: the
last write is the one kept, as between two tabs of one browser.

`GET /api/projects` answers `{"projects": [{"id", "name", "modified"}]}`, `modified` in
milliseconds since 1970. `GET /api/projects/<id>` answers the project file's text, with
`X-Modified`. `PUT` takes a project file, checks it as the app checks an opened one and
that its id is the path's, and keeps it as `projects/<id>.json`; an id is 1 to 64 letters,
digits, `-` or `_`. Up to 32 MB. `DELETE` moves the file to `backups/` as
`project-<date>-<time>-<id>.json`.

`GET /api/settings` answers an object of texts by key: `machine`, `inlayDefaults`,
`lastProjectId` and `view` (what the screens remember, such as the tool list's sort order).
`PUT /api/settings/<key>` takes `{"value": "<text>"}`, or `null` to forget the key. What a
text holds is the page's own matter, as in a browser's storage; the server keeps it as
given, in `settings.json`.

### `GET /api/export` and `GET /api/export/<kind>`

The libraries for other programs, made from the tool file as it is at that moment; nothing
is kept on the server. `/api/export` answers, for each of `cam`, `studio`, `fusion` and
`tools.yaml`, how many tools and settings it would hold and the warnings of writing it.
`/api/export/<kind>` answers the file itself, as the app's own export menu writes it.
