//! The HTTP API over the tool file. `docs/api.md` is its description.
//!
//! Nothing here knows about sockets: a request comes in as a `Request` and
//! goes out as a `Response`, so every route is tested as a function.
//!
//! There is no login. What keeps other web sites out: the `Host` header must
//! name this machine (against DNS rebinding; `any_host` turns that off for a
//! server behind a proxy), and anything but a `GET` needs the header
//! `X-Inlay: 1`, which a page of another site cannot send without a
//! preflight this server never answers, and a same-origin `Origin` and
//! `Sec-Fetch-Site` when the browser sends them.

use std::sync::Mutex;
use std::time::SystemTime;

use inlay_core::export::{fusion, makera};
use inlay_core::feeds;
use inlay_core::import::tools_yaml;
use inlay_core::naming::display_name;
use inlay_core::project::Design;
use inlay_core::thumbnail::thumbnail;
use inlay_core::tools::{
    library_from_file_json, library_to_file_json, needs_attention, CutResult, CuttingSettings,
    Material, Tool, ToolLibrary,
};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::store::{is_folder_path, is_project_id, iso, Loaded, Store};
use inlay_core::project::project_from_file_json;
use lists::List;

/// The largest body of a write of the whole file, and of any other write.
const MAX_FILE_BODY: usize = 8 * 1024 * 1024;
/// The largest project: its drawing is in it.
const MAX_PROJECT_BODY: usize = 32 * 1024 * 1024;
/// What the app keeps besides tools and projects, each a text of its own.
const SETTING_KEYS: [&str; 4] = ["machine", "inlayDefaults", "lastProjectId", "view"];
const MAX_BODY: usize = 256 * 1024;
/// Characters in one query value.
const MAX_QUERY: usize = 300;
const LOCAL_HOSTS: [&str; 3] = ["localhost", "127.0.0.1", "::1"];

pub struct Request {
    pub method: String,
    /// The path as sent, without the query.
    pub path: String,
    /// Decoded.
    pub query: Vec<(String, String)>,
    /// Names in lower case.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }

    fn query(&self, name: &str) -> Option<&str> {
        self.query
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }
}

#[derive(Debug)]
pub struct Response {
    pub status: u16,
    pub content_type: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    fn json(status: u16, value: &Value) -> Response {
        Response {
            status,
            content_type: "application/json".into(),
            headers: vec![("Cache-Control".into(), "no-store".into())],
            body: serde_json::to_vec(value).expect("JSON values always serialize"),
        }
    }

    fn file(content_type: &str, name: &str, body: Vec<u8>) -> Response {
        Response {
            status: 200,
            content_type: content_type.into(),
            headers: vec![
                ("Cache-Control".into(), "no-store".into()),
                (
                    "Content-Disposition".into(),
                    format!("attachment; filename=\"{name}\""),
                ),
            ],
            body,
        }
    }
}

/// A request that is not answered, as every error of the API is written:
/// `{"error": {"code", "message", ...}}`.
#[derive(Debug)]
struct Refusal {
    status: u16,
    code: &'static str,
    message: String,
    extra: Map<String, Value>,
}

impl Refusal {
    fn new(status: u16, code: &'static str, message: impl Into<String>) -> Refusal {
        Refusal {
            status,
            code,
            message: message.into(),
            extra: Map::new(),
        }
    }

    fn bad(message: impl Into<String>) -> Refusal {
        Refusal::new(400, "bad_request", message)
    }

    fn not_found(message: impl Into<String>) -> Refusal {
        Refusal::new(404, "not_found", message)
    }

    fn invalid(message: impl Into<String>) -> Refusal {
        Refusal::new(422, "invalid", message)
    }

    fn internal(e: impl std::fmt::Display) -> Refusal {
        Refusal::new(500, "internal", e.to_string())
    }

    fn response(self) -> Response {
        let mut error = Map::new();
        error.insert("code".into(), self.code.into());
        error.insert("message".into(), self.message.into());
        error.extend(self.extra);
        Response::json(self.status, &json!({ "error": error }))
    }
}

type Answer = Result<Response, Refusal>;

/// Every route, as `GET /api` lists them.
const ROUTES: &[(&str, &str, &str)] = &[
    ("GET", "/api", "This list."),
    ("GET", "/api/health", "Liveness: {ok: true}."),
    ("GET", "/api/library", "The whole tool file, as the app writes it. Its ETag is the token."),
    ("PUT", "/api/library", "Replace the whole tool file. If-Match: the token. ?dryRun=1&diff=1"),
    ("GET", "/api/tools", "A compact tool list and the token. ?q=<words>&material=<key>"),
    ("POST", "/api/tools", "Add a tool. {token, tool, dryRun?, diff?}"),
    ("GET", "/api/tools/<tool>", "One tool with its cutting rows and their logs. <tool>: its id, name or shown name."),
    ("PATCH", "/api/tools/<tool>", "Change a tool. {token, patch, dryRun?, diff?}"),
    ("DELETE", "/api/tools/<tool>", "Delete a tool. {token, dryRun?, diff?}"),
    ("POST", "/api/tools/<tool>/rows/<row>/log", "Log a cut with a row. {token, entry: {date, outcome?, text, at?}, dryRun?, diff?}. <row>: material or material@profile."),
    ("GET", "/api/tools/<tool>/suggestions", "The feeds model's numbers for a row. ?row=<row>, &all=1 for every combination."),
    ("GET", "/api/materials", "The materials, as the file holds them, and how many tools name each."),
    ("POST", "/api/materials", "Add a material. {token, material, dryRun?, diff?}"),
    ("GET", "/api/materials/<key>", "One material and the tools that name it."),
    ("PATCH", "/api/materials/<key>", "Change a material. {token, patch, dryRun?, diff?}"),
    ("DELETE", "/api/materials/<key>", "Delete a material no tool names. {token, dryRun?, diff?}"),
    ("GET", "/api/profiles", "The profiles, and how many tools have a row on each."),
    ("POST", "/api/profiles", "Add a profile. {token, profile, dryRun?, diff?}"),
    ("GET", "/api/profiles/<key>", "One profile and the tools with a row on it."),
    ("PATCH", "/api/profiles/<key>", "Change a profile. {token, patch, dryRun?, diff?}"),
    ("DELETE", "/api/profiles/<key>", "Delete a profile no row is on. {token, dryRun?, diff?}"),
    ("GET", "/api/groups", "The groups whose ids in the Makera apps are pinned, and how many tools each holds."),
    ("POST", "/api/groups", "Pin a group's ids. {token, group: {path, ids}, dryRun?, diff?}"),
    ("GET", "/api/groups/<path>", "One group entry and its tools."),
    ("PATCH", "/api/groups/<path>", "Change a group entry. {token, patch, dryRun?, diff?}"),
    ("DELETE", "/api/groups/<path>", "Delete a group entry; its tools stay in the group. {token, dryRun?, diff?}"),
    ("GET", "/api/attention", "What wants looking at in the tool list, worst first."),
    ("GET", "/api/export", "What each library for another program would hold, with its warnings."),
    ("GET", "/api/export/<kind>", "A library as a file: tools.yaml, cam, studio, fusion."),
    ("GET", "/api/backups", "The backups kept, newest first."),
    ("GET", "/api/backups/<name>", "One backup: a tool file, to PUT back to /api/library."),
    ("GET", "/api/projects", "The projects kept, last written first: {id, name, modified, folder, steps}, and the folders they are filed in."),
    ("GET", "/api/projects/<id>", "One project file."),
    ("PUT", "/api/projects/<id>", "Keep a project file under its id. ?folder=<path>: where one that is new goes."),
    ("PATCH", "/api/projects/<id>", "File a project in another folder. {folder: <path> | \"\"}"),
    ("DELETE", "/api/projects/<id>", "Take a project off the list. Its file goes to backups/."),
    ("GET", "/api/folders", "The folders projects are filed in, with / between nested ones, and how many projects each holds."),
    ("POST", "/api/folders", "Make a folder. {path}"),
    ("PATCH", "/api/folders/<path>", "Rename a folder or move it into another, with what is in it. {path: the new one}"),
    ("DELETE", "/api/folders/<path>", "Take a folder away. Its projects stay, in no folder."),
    ("GET", "/api/settings", "What the app keeps besides: the machine, the inlay defaults, the last project, the view."),
    ("PUT", "/api/settings/<key>", "Keep one setting. {value: <text> | null}"),
];

pub struct Api {
    store: Store,
    /// Held from reading the file to writing it, so a write is one step.
    lock: Mutex<()>,
    /// Answer whatever the `Host` header says.
    any_host: bool,
    clock: fn() -> SystemTime,
}

impl Api {
    pub fn new(store: Store, any_host: bool) -> Api {
        Api {
            store,
            lock: Mutex::new(()),
            any_host,
            clock: SystemTime::now,
        }
    }

    /// The most bytes a request's body may have.
    pub fn body_limit(method: &str, path: &str) -> usize {
        if method == "PUT" && path == "/api/library" {
            MAX_FILE_BODY
        } else if method == "PUT" && path.starts_with("/api/projects/") {
            MAX_PROJECT_BODY
        } else {
            MAX_BODY
        }
    }

    /// Why a request must not be answered at all, whatever it asks for:
    /// `Some` for a `Host` that is not this machine.
    pub fn refuse_host(&self, host: Option<&str>) -> Option<Response> {
        if self.any_host
            || host
                .is_some_and(|h| LOCAL_HOSTS.contains(&host_name(h).to_ascii_lowercase().as_str()))
        {
            return None;
        }
        Some(
            Refusal::new(
                403,
                "forbidden_host",
                "This server answers only as localhost. Start it with --any-host to reach it by another name.",
            )
            .response(),
        )
    }

    pub fn handle(&self, request: &Request) -> Response {
        if let Some(refused) = self.refuse_host(request.header("host")) {
            return refused;
        }
        self.route(request).unwrap_or_else(Refusal::response)
    }

    fn route(&self, request: &Request) -> Answer {
        let decoded: Vec<String> = request
            .path
            .split('/')
            .filter(|s| !s.is_empty())
            .map(decode)
            .collect::<Option<_>>()
            .ok_or_else(|| Refusal::bad("the path is not UTF-8"))?;
        let segments: Vec<&str> = decoded.iter().map(String::as_str).collect();
        let known = query_names(&request.method, &segments);
        for (name, value) in &request.query {
            if !known.contains(&name.as_str()) {
                let takes = if known.is_empty() {
                    "it takes none".to_string()
                } else {
                    format!("it takes {}", known.join(", "))
                };
                return Err(Refusal::bad(format!(
                    "{name} is not a query parameter of this route: {takes}. A write's token, dryRun and diff go in its body."
                )));
            }
            if value.chars().count() > MAX_QUERY {
                return Err(Refusal::bad(format!(
                    "a query value has more than {MAX_QUERY} characters"
                )));
            }
        }
        let method = request.method.as_str();
        if !matches!(method, "GET" | "POST" | "PUT" | "PATCH" | "DELETE") {
            // HEAD, OPTIONS and the rest: no path has them.
            return Err(if known_path(&segments) {
                Refusal::new(
                    405,
                    "method_not_allowed",
                    format!("{method} is not a method of {}", request.path),
                )
            } else {
                Refusal::not_found(format!(
                    "There is no {}. GET /api lists the routes.",
                    request.path
                ))
            });
        }
        if method != "GET" {
            guard_write(request)?;
        }
        match (method, segments.as_slice()) {
            ("GET", ["api"]) => Ok(index()),
            ("GET", ["api", "health"]) => Ok(Response::json(
                200,
                &json!({ "ok": true, "app": "inlay-cam", "version": inlay_core::version() }),
            )),
            ("GET", ["api", "library"]) => self.library(request),
            ("PUT", ["api", "library"]) => self.replace_library(request),
            ("GET", ["api", "tools"]) => self.tools(request),
            ("POST", ["api", "tools"]) => self.add_tool(request),
            ("GET", ["api", "tools", tool]) => self.tool(tool),
            ("PATCH", ["api", "tools", tool]) => self.patch_tool(request, tool),
            ("DELETE", ["api", "tools", tool]) => self.delete_tool(request, tool),
            ("POST", ["api", "tools", tool, "rows", row, "log"]) => {
                self.log_cut(request, tool, row)
            }
            ("GET", ["api", "tools", tool, "suggestions"]) => self.suggestions(request, tool),
            ("GET", ["api", name]) if List::named(name).is_some() => {
                self.list(List::named(name).expect("matched"))
            }
            ("POST", ["api", name]) if List::named(name).is_some() => {
                self.add_list_item(request, List::named(name).expect("matched"))
            }
            ("GET", ["api", name, key]) if List::named(name).is_some() => {
                self.list_item(List::named(name).expect("matched"), key)
            }
            ("PATCH", ["api", name, key]) if List::named(name).is_some() => {
                self.patch_list_item(request, List::named(name).expect("matched"), key)
            }
            ("DELETE", ["api", name, key]) if List::named(name).is_some() => {
                self.delete_list_item(request, List::named(name).expect("matched"), key)
            }
            ("GET", ["api", "attention"]) => self.attention(),
            ("GET", ["api", "export"]) => self.exports(),
            ("GET", ["api", "export", kind]) => self.export(kind),
            ("GET", ["api", "backups"]) => self.backups(),
            ("GET", ["api", "backups", name]) => self.backup(name),
            ("GET", ["api", "projects"]) => self.projects(),
            ("GET", ["api", "projects", id]) => self.project(id),
            ("PUT", ["api", "projects", id]) => self.save_project(request, id),
            ("PATCH", ["api", "projects", id]) => self.move_project(request, id),
            ("DELETE", ["api", "projects", id]) => self.delete_project(id),
            ("GET", ["api", "folders"]) => self.folders(),
            ("POST", ["api", "folders"]) => self.add_folder(request),
            ("PATCH", ["api", "folders", path]) => self.rename_folder(request, path),
            ("DELETE", ["api", "folders", path]) => self.delete_folder(path),
            ("GET", ["api", "settings"]) => self.settings(),
            ("PUT", ["api", "settings", key]) => self.save_setting(request, key),
            (_, path) => Err(if known_path(path) {
                Refusal::new(
                    405,
                    "method_not_allowed",
                    format!("{method} is not a method of {}", request.path),
                )
            } else {
                Refusal::not_found(format!(
                    "There is no {}. GET /api lists the routes.",
                    request.path
                ))
            }),
        }
    }

    /// The file as it is, and the tool list in it.
    fn current(&self) -> Result<(Loaded, ToolLibrary), Refusal> {
        let loaded = self.store.load().map_err(Refusal::internal)?;
        let library = library_from_file_json(&loaded.text).map_err(|e| {
            let mut refusal = Refusal::new(
                422,
                "load_error",
                format!("The tool file on the server cannot be read: {e}. PUT /api/library with this token replaces it; the backups are under /api/backups."),
            );
            refusal
                .extra
                .insert("token".into(), loaded.token.clone().into());
            refusal
        })?;
        Ok((loaded, library))
    }

    fn library(&self, request: &Request) -> Answer {
        let (loaded, _) = self.current()?;
        let etag = format!("\"{}\"", loaded.token);
        let unchanged = request
            .header("if-none-match")
            .is_some_and(|sent| sent.split(',').any(|tag| tag.trim() == etag));
        Ok(Response {
            status: if unchanged { 304 } else { 200 },
            content_type: "application/json".into(),
            headers: vec![
                ("Cache-Control".into(), "no-cache".into()),
                ("ETag".into(), etag),
                ("X-Saved-At".into(), loaded.saved_at),
            ],
            body: if unchanged {
                Vec::new()
            } else {
                loaded.text.into_bytes()
            },
        })
    }

    fn replace_library(&self, request: &Request) -> Answer {
        let token = request
            .header("if-match")
            .map(|tag| tag.trim().trim_matches('"').to_string())
            .or_else(|| request.query("token").map(str::to_string));
        let flag = |name: &str| match request.query(name) {
            None | Some("0") | Some("false") => Ok(false),
            Some("1") | Some("true") => Ok(true),
            Some(_) => Err(Refusal::bad(format!("{name} must be 1 or 0"))),
        };
        let options = Options {
            token: token.ok_or_else(|| {
                Refusal::bad("If-Match is required: the token of the tool file as you read it")
            })?,
            dry_run: flag("dryRun")?,
            diff: flag("diff")?,
        };
        let text = std::str::from_utf8(&request.body)
            .map_err(|_| Refusal::bad("the body is not UTF-8"))?;
        let replacement =
            library_from_file_json(text).map_err(|e| Refusal::invalid(e.to_string()))?;
        self.write_over(&options, true, |library| {
            *library = replacement;
            Ok(Map::new())
        })
    }

    fn tools(&self, request: &Request) -> Answer {
        for (name, _) in &request.query {
            if name != "q" && name != "material" {
                return Err(Refusal::bad(format!(
                    "{name} is not a parameter of /api/tools: it takes q and material"
                )));
            }
        }
        let (loaded, library) = self.current()?;
        let words: Vec<String> = request
            .query("q")
            .unwrap_or("")
            .split_whitespace()
            .map(str::to_lowercase)
            .collect();
        let material = request.query("material");
        let attention = needs_attention(&library.tools);
        let tools: Vec<Value> = library
            .tools
            .iter()
            .filter(|tool| {
                material.is_none_or(|m| tool.cutting.iter().any(|c| c.material.key() == m))
            })
            .filter(|tool| {
                let shown = display_name(&tool.name, tool.coating.as_deref());
                let kind = kind_word(tool);
                let text = [
                    tool.name.as_str(),
                    shown.as_str(),
                    tool.group.as_deref().unwrap_or(""),
                    kind.as_str(),
                    tool.coating.as_deref().unwrap_or(""),
                    tool.style.as_deref().unwrap_or(""),
                ]
                .join("\n")
                .to_lowercase();
                words.iter().all(|word| text.contains(word))
            })
            .map(|tool| {
                json!({
                    "id": tool.id,
                    "name": tool.name,
                    "displayName": display_name(&tool.name, tool.coating.as_deref()),
                    "group": tool.group,
                    "kind": tool.kind,
                    "coating": tool.coating,
                    "style": tool.style,
                    "diameter": tool.diameter,
                    "shankDiameter": tool.shank_diameter,
                    "fluteLength": tool.flute_length,
                    "length": tool.length,
                    "flutes": tool.flutes,
                    "recommendedFor": tool.recommended_for,
                    "rows": tool.cutting.iter().map(row_key).collect::<Vec<_>>(),
                    "attention": attention.iter().filter(|a| a.tool_id == tool.id).count(),
                })
            })
            .collect();
        let materials: Vec<&str> = ["hardwood", "softwood"]
            .into_iter()
            .chain(library.materials.iter().map(|m| m.key.key()))
            .fold(Vec::new(), |mut keys, key| {
                if !keys.contains(&key) {
                    keys.push(key);
                }
                keys
            });
        Ok(Response::json(
            200,
            &json!({
                "token": loaded.token,
                "savedAt": loaded.saved_at,
                "count": tools.len(),
                "materials": materials,
                "profiles": library.profiles.iter().map(|p| &p.key).collect::<Vec<_>>(),
                "tools": tools,
            }),
        ))
    }

    fn tool(&self, reference: &str) -> Answer {
        let (loaded, library) = self.current()?;
        let tool = &library.tools[find(&library, reference)?];
        let mut body = tool_view(&library, tool);
        body.insert("token".into(), loaded.token.into());
        body.insert("savedAt".into(), loaded.saved_at.into());
        Ok(Response::json(200, &Value::Object(body)))
    }

    fn add_tool(&self, request: &Request) -> Answer {
        let mut body = body_object(request, &["token", "tool", "dryRun", "diff"])?;
        let options = Options::of(request, &body)?;
        let Some(Value::Object(mut given)) = body.remove("tool") else {
            return Err(Refusal::bad("tool is required, and must be an object"));
        };
        let own_id = given.get("id").is_some_and(|id| id.as_str() != Some(""));
        if !own_id {
            given.insert("id".into(), "".into());
        }
        let mut tool: Tool = strict(Value::Object(given), "tool")?;
        let now = (self.clock)();
        self.write(&options, |library| {
            if !own_id {
                tool.id = new_id(library, &tool.name, now);
            } else if library.tools.iter().any(|t| t.id == tool.id) {
                return Err(Refusal::bad(format!(
                    "a tool has the id \"{}\" already; leave id out to be given one",
                    tool.id
                )));
            }
            // After the last tool of its group, so that a file read by eye
            // keeps a group's tools together.
            let place = library
                .tools
                .iter()
                .rposition(|t| t.group == tool.group)
                .map_or(library.tools.len(), |i| i + 1);
            library.tools.insert(place, tool);
            Ok(tool_view(library, &library.tools[place]))
        })
    }

    fn patch_tool(&self, request: &Request, reference: &str) -> Answer {
        let mut body = body_object(request, &["token", "patch", "dryRun", "diff"])?;
        let options = Options::of(request, &body)?;
        let patch = body
            .remove("patch")
            .ok_or_else(|| Refusal::bad("patch is required"))?;
        self.write(&options, |library| {
            let at = find(library, reference)?;
            library.tools[at] = patched(&library.tools[at], &patch)?;
            Ok(tool_view(library, &library.tools[at]))
        })
    }

    fn delete_tool(&self, request: &Request, reference: &str) -> Answer {
        let body = body_object(request, &["token", "dryRun", "diff"])?;
        let options = Options::of(request, &body)?;
        self.write(&options, |library| {
            let tool = library.tools.remove(find(library, reference)?);
            let mut out = Map::new();
            out.insert(
                "deleted".into(),
                json!({
                    "id": tool.id,
                    "name": tool.name,
                    "displayName": display_name(&tool.name, tool.coating.as_deref()),
                    "group": tool.group,
                }),
            );
            Ok(out)
        })
    }

    fn log_cut(&self, request: &Request, reference: &str, row: &str) -> Answer {
        let mut body = body_object(request, &["token", "entry", "dryRun", "diff"])?;
        let options = Options::of(request, &body)?;
        let entry = body
            .remove("entry")
            .filter(Value::is_object)
            .ok_or_else(|| Refusal::bad("entry is required, and must be an object"))?;
        let mut entry: CutResult = strict(entry, "entry")?;
        self.write(&options, |library| {
            let at = find(library, reference)?;
            let settings = find_row(&mut library.tools[at], row)?;
            // A result is about the numbers it was cut at: the row's own,
            // unless the cut was made at others.
            entry.at.get_or_insert_with(|| settings.values());
            settings.log.push(entry);
            let logged = serde_json::to_value(settings.log.last()).expect("log entries serialize");
            let mut out = tool_view(library, &library.tools[at]);
            out.insert("logged".into(), logged);
            Ok(out)
        })
    }

    fn suggestions(&self, request: &Request, reference: &str) -> Answer {
        let (loaded, library) = self.current()?;
        let tool = &library.tools[find(&library, reference)?];
        let row = request
            .query("row")
            .ok_or_else(|| Refusal::bad("row is required: a material, or material@profile"))?;
        let (material, profile) = split_row(row);
        let profile =
            match profile {
                None => None,
                Some(key) => Some(library.profile(key).ok_or_else(|| {
                    Refusal::not_found(format!("There is no profile \"{key}\"."))
                })?),
            };
        // A material of the owner's cuts like the one it names.
        let cuts_like = library
            .materials
            .iter()
            .find(|m| m.key.key() == material)
            .and_then(|m| m.feeds_as.as_ref())
            .map_or(material, |m| m.key());
        let entry = feeds::suggest_entry(tool, cuts_like, profile, feeds::Spindle::default());
        let mut body = Map::new();
        body.insert("token".into(), loaded.token.into());
        body.insert("tool".into(), tool.name.clone().into());
        body.insert("row".into(), row.into());
        body.insert("cutsLike".into(), cuts_like.into());
        if request
            .query("all")
            .is_some_and(|v| v == "1" || v == "true")
        {
            body.insert(
                "entry".into(),
                serde_json::to_value(&entry).expect("entries serialize"),
            );
        } else {
            body.insert("covered".into(), entry.covered.into());
            body.insert("combination".into(), entry.default.clone().into());
            body.insert(
                "suggestion".into(),
                serde_json::to_value(entry.combos.get(&entry.default))
                    .expect("suggestions serialize"),
            );
            body.insert(
                "limits".into(),
                serde_json::to_value(&entry.limits).expect("limits serialize"),
            );
        }
        Ok(Response::json(200, &Value::Object(body)))
    }

    fn attention(&self) -> Answer {
        let (loaded, library) = self.current()?;
        let items = needs_attention(&library.tools);
        Ok(Response::json(
            200,
            &json!({ "token": loaded.token, "count": items.len(), "items": items }),
        ))
    }

    fn exports(&self) -> Answer {
        let (loaded, library) = self.current()?;
        let now = iso((self.clock)());
        let count = |built: &makera::Library| {
            let tools: usize = built.groups.iter().map(|g| g.tools.len()).sum();
            let settings: usize = built
                .groups
                .iter()
                .flat_map(|g| &g.tools)
                .map(|t| t.settings.len())
                .sum();
            (tools, settings)
        };
        let cam = match makera::build_cam(&library) {
            Ok((built, warnings)) => {
                let (tools, settings) = count(&built);
                json!({ "kind": "cam", "for": "Makera CAM", "path": "/api/export/cam", "tools": tools, "settings": settings, "warnings": warnings })
            }
            Err(e) => json!({ "kind": "cam", "for": "Makera CAM", "error": e }),
        };
        let (built, warnings) = makera::build_studio(&library, &now);
        let (tools, settings) = count(&built);
        let studio = json!({ "kind": "studio", "for": "Makera Studio", "path": "/api/export/studio", "tools": tools, "settings": settings, "warnings": warnings });
        let built = fusion::build_fusion(&library);
        let fusion = json!({ "kind": "fusion", "for": "Fusion 360", "path": "/api/export/fusion", "tools": built.tools, "settings": built.presets, "warnings": built.warnings });
        let yaml = json!({ "kind": "tools.yaml", "for": "the tooling library", "path": "/api/export/tools.yaml", "tools": library.tools.len() });
        Ok(Response::json(
            200,
            &json!({ "token": loaded.token, "exports": [cam, studio, fusion, yaml] }),
        ))
    }

    fn export(&self, kind: &str) -> Answer {
        let (_, library) = self.current()?;
        Ok(match kind {
            "tools.yaml" => Response::file(
                "application/yaml; charset=utf-8",
                "tools.yaml",
                tools_yaml::write_tools_yaml(&library).into_bytes(),
            ),
            "cam" => {
                let (built, _) = makera::build_cam(&library)
                    .map_err(|e| Refusal::new(422, "export_failed", e))?;
                Response::file(
                    "application/octet-stream",
                    "tools-makera-cam.tlslibrary",
                    makera::write(&built),
                )
            }
            "studio" => {
                let (built, _) = makera::build_studio(&library, &iso((self.clock)()));
                Response::file(
                    "application/octet-stream",
                    "tools-makera-studio.tlslibrary",
                    makera::write(&built),
                )
            }
            "fusion" => Response::file(
                "application/json",
                "tools-fusion-360.json",
                fusion::build_fusion(&library).library.into_bytes(),
            ),
            _ => {
                return Err(Refusal::not_found(format!(
                "There is no export \"{kind}\": tools.yaml, cam, studio and fusion are the four."
            )))
            }
        })
    }

    fn backups(&self) -> Answer {
        let backups: Vec<Value> = self
            .store
            .backups()
            .map_err(Refusal::internal)?
            .iter()
            .map(|b| json!({ "name": b.name, "size": b.size, "path": format!("/api/backups/{}", b.name) }))
            .collect();
        Ok(Response::json(200, &json!({ "backups": backups })))
    }

    fn backup(&self, name: &str) -> Answer {
        let text = self
            .store
            .backup(name)
            .map_err(Refusal::internal)?
            .ok_or_else(|| Refusal::not_found(format!("There is no backup \"{name}\".")))?;
        Ok(Response {
            status: 200,
            content_type: "application/json".into(),
            headers: vec![("Cache-Control".into(), "no-store".into())],
            body: text.into_bytes(),
        })
    }

    fn projects(&self) -> Answer {
        // Read under the lock, like the folders and a single project
        // below: a list made while a folder is renamed would miss what is
        // in it, and a project read while it is moved would not be found.
        let _held = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut projects: Vec<(u64, Value)> = self
            .store
            .projects()
            .map_err(Refusal::internal)?
            .iter()
            .map(|kept| {
                // The name and the steps are read from the file as plain
                // JSON, so that a project of an older format is listed
                // without being upgraded. Its steps were once its `jobs`.
                let project = serde_json::from_str::<Value>(&kept.text)
                    .ok()
                    .and_then(|mut file| file.get_mut("project").map(Value::take));
                let name = project
                    .as_ref()
                    .and_then(|project| project.get("name")?.as_str())
                    .unwrap_or_default();
                let steps = project
                    .as_ref()
                    .and_then(|project| project.get("steps").or_else(|| project.get("jobs")))
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len);
                // A small picture of its drawing; null for one without, and
                // left out for a drawing this core cannot read.
                let thumb = project.as_ref().and_then(|project| project.get("design")).map(|design| {
                    if design.is_null() {
                        Some(Value::Null)
                    } else {
                        Design::deserialize(design)
                            .ok()
                            .map(|design| serde_json::to_value(thumbnail(&design)).unwrap_or(Value::Null))
                    }
                });
                let mut listed = json!({ "id": kept.id, "name": name, "modified": kept.modified, "folder": kept.folder, "steps": steps });
                if let Some(Some(thumb)) = thumb {
                    listed["thumb"] = thumb;
                }
                (kept.modified, listed)
            })
            .collect();
        projects.sort_by_key(|project| std::cmp::Reverse(project.0));
        let projects: Vec<Value> = projects.into_iter().map(|(_, project)| project).collect();
        let folders = self.store.folders().map_err(Refusal::internal)?;
        Ok(Response::json(
            200,
            &json!({ "projects": projects, "folders": folders }),
        ))
    }

    fn folders(&self) -> Answer {
        let _held = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let kept = self.store.projects().map_err(Refusal::internal)?;
        let folders: Vec<Value> = self
            .store
            .folders()
            .map_err(Refusal::internal)?
            .into_iter()
            .map(|path| {
                let projects = kept.iter().filter(|kept| kept.folder == path).count();
                json!({ "path": path, "projects": projects })
            })
            .collect();
        Ok(Response::json(200, &json!({ "folders": folders })))
    }

    fn add_folder(&self, request: &Request) -> Answer {
        let mut body = body_object(request, &["path"])?;
        let path = folder_of(body.remove("path"), "path", false)?;
        let _held = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let folder = self.store.create_folder(&path).map_err(folder_refusal)?;
        Ok(Response::json(
            201,
            &json!({ "ok": true, "folder": folder }),
        ))
    }

    fn rename_folder(&self, request: &Request, path: &str) -> Answer {
        let mut body = body_object(request, &["path"])?;
        let to = folder_of(body.remove("path"), "path", false)?;
        if !is_folder_path(path) {
            return Err(Refusal::not_found(format!(
                "There is no folder \"{path}\"."
            )));
        }
        let _held = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let folder = self
            .store
            .rename_folder(path, &to)
            .map_err(folder_refusal)?;
        Ok(Response::json(
            200,
            &json!({ "ok": true, "folder": folder }),
        ))
    }

    fn delete_folder(&self, path: &str) -> Answer {
        if !is_folder_path(path) {
            return Err(Refusal::not_found(format!(
                "There is no folder \"{path}\"."
            )));
        }
        let _held = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let (folder, moved) = self.store.delete_folder(path).map_err(folder_refusal)?;
        Ok(Response::json(
            200,
            &json!({ "ok": true, "deleted": folder, "moved": moved }),
        ))
    }

    /// Files a project in another folder, or in none: `{"folder": ""}`.
    /// Its file is renamed, not written, so its token and its time of
    /// writing stay, and a copy of it open somewhere saves as before.
    fn move_project(&self, request: &Request, id: &str) -> Answer {
        let mut body = body_object(request, &["folder"])?;
        let folder = folder_of(body.remove("folder"), "folder", true)?;
        let _held = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let moved = if is_project_id(id) {
            self.store
                .move_project(id, &folder)
                .map_err(folder_refusal)?
        } else {
            None
        };
        match moved {
            Some(folder) => Ok(Response::json(
                200,
                &json!({ "ok": true, "id": id, "folder": folder }),
            )),
            None => Err(Refusal::not_found(format!("There is no project \"{id}\"."))),
        }
    }

    fn project(&self, id: &str) -> Answer {
        let none = || Refusal::not_found(format!("There is no project \"{id}\"."));
        if !is_project_id(id) {
            return Err(none());
        }
        let _held = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let kept = self
            .store
            .project(id)
            .map_err(Refusal::internal)?
            .ok_or_else(none)?;
        Ok(Response {
            status: 200,
            content_type: "application/json".into(),
            headers: vec![
                ("Cache-Control".into(), "no-store".into()),
                (
                    "ETag".into(),
                    format!("\"{}\"", crate::store::token_of(kept.text.as_bytes())),
                ),
                ("X-Modified".into(), kept.modified.to_string()),
            ],
            body: kept.text.into_bytes(),
        })
    }

    /// Keeps a project file under its id. With `If-Match`, only over the
    /// version that names: a project open in two places is not written over
    /// by the one that has not seen the other's change. Without it, the last
    /// write is the one kept.
    fn save_project(&self, request: &Request, id: &str) -> Answer {
        let text = std::str::from_utf8(&request.body)
            .map_err(|_| Refusal::bad("the body is not UTF-8"))?;
        let project = project_from_file_json(text).map_err(|e| Refusal::invalid(e.to_string()))?;
        if project.id != id {
            return Err(Refusal::bad(format!(
                "the file is the project \"{}\", not \"{id}\"",
                project.id
            )));
        }
        if !is_project_id(id) {
            return Err(Refusal::bad(
                "a project's id must be 1 to 64 letters, digits, - or _ to be kept here",
            ));
        }
        let folder = folder_of(
            request.query("folder").map(|path| path.into()),
            "folder",
            true,
        )?;
        let based_on = request
            .header("if-match")
            .map(|tag| tag.trim().trim_matches('"').to_string());
        let _held = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(based_on) = based_on {
            // A project deleted meanwhile is kept again: nothing is lost.
            if let Some(kept) = self.store.project(id).map_err(Refusal::internal)? {
                let token = crate::store::token_of(kept.text.as_bytes());
                if token != based_on {
                    let mut refusal = Refusal::new(
                        409,
                        "conflict",
                        "The project was saved from somewhere else since it was read. Read it again, or write without If-Match to put this version in its place.",
                    );
                    refusal.extra.insert("token".into(), token.into());
                    refusal
                        .extra
                        .insert("modified".into(), kept.modified.into());
                    return Err(refusal);
                }
            }
        }
        let (modified, folder) = self
            .store
            .save_project(id, text, &folder)
            .map_err(folder_refusal)?;
        let token = crate::store::token_of(text.as_bytes());
        Ok(Response::json(
            200,
            &json!({ "ok": true, "id": id, "name": project.name, "modified": modified, "token": token, "folder": folder }),
        ))
    }

    fn delete_project(&self, id: &str) -> Answer {
        let _held = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let deleted = is_project_id(id)
            && self
                .store
                .delete_project(id, (self.clock)())
                .map_err(Refusal::internal)?;
        if !deleted {
            return Err(Refusal::not_found(format!("There is no project \"{id}\".")));
        }
        Ok(Response::json(200, &json!({ "ok": true, "deleted": id })))
    }

    fn read_settings(&self) -> Result<Map<String, Value>, Refusal> {
        let text = self.store.settings().map_err(Refusal::internal)?;
        match serde_json::from_str(&text) {
            Ok(Value::Object(settings)) => Ok(settings),
            _ => Err(Refusal::new(
                422,
                "load_error",
                "settings.json on the server cannot be read.",
            )),
        }
    }

    fn settings(&self) -> Answer {
        Ok(Response::json(200, &Value::Object(self.read_settings()?)))
    }

    /// Keeps one setting: `{"value": <text>}`, or `null` to forget it. What
    /// the text holds is the app's own matter, as it is in a browser's
    /// storage.
    fn save_setting(&self, request: &Request, key: &str) -> Answer {
        if !SETTING_KEYS.contains(&key) {
            return Err(Refusal::not_found(format!(
                "There is no setting \"{key}\": {} are the ones kept.",
                SETTING_KEYS.join(", ")
            )));
        }
        let mut body = body_object(request, &["value"])?;
        let value = match body.remove("value") {
            Some(value @ (Value::String(_) | Value::Null)) => value,
            _ => return Err(Refusal::bad("value is required: a text, or null")),
        };
        let _held = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        // Settings that cannot be read are set aside, not left to refuse
        // every setting from then on.
        let mut settings = match self.read_settings() {
            Ok(settings) => settings,
            Err(_) => {
                self.store
                    .set_settings_aside((self.clock)())
                    .map_err(Refusal::internal)?;
                Map::new()
            }
        };
        if value.is_null() {
            settings.remove(key);
        } else {
            settings.insert(key.to_string(), value);
        }
        let text =
            serde_json::to_string_pretty(&Value::Object(settings)).expect("JSON values serialize");
        self.store.save_settings(&text).map_err(Refusal::internal)?;
        Ok(Response::json(200, &json!({ "ok": true })))
    }

    /// One write: the file is read, the token held against it, the change
    /// made to the tool list and checked, and the file written, with nobody
    /// else writing in between. `change` gives what the answer holds besides
    /// the token. A dry run stops short of writing.
    fn write(
        &self,
        options: &Options,
        change: impl FnOnce(&mut ToolLibrary) -> Result<Map<String, Value>, Refusal>,
    ) -> Answer {
        self.write_over(options, false, change)
    }

    /// `whole` is for a change that replaces the whole list. It goes
    /// through over a file that cannot be read as a tool file, which is how
    /// such a file is put right: the token is of its bytes, readable or not.
    fn write_over(
        &self,
        options: &Options,
        whole: bool,
        change: impl FnOnce(&mut ToolLibrary) -> Result<Map<String, Value>, Refusal>,
    ) -> Answer {
        let _held = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let (loaded, mut library) = match self.current() {
            Err(refusal) if whole && refusal.code == "load_error" => (
                self.store.load().map_err(Refusal::internal)?,
                ToolLibrary::default(),
            ),
            other => other?,
        };
        if options.token != loaded.token {
            let mut refusal = Refusal::new(
                409,
                "conflict",
                "The tool file changed since it was read. Read it again, and make the change to what is there now.",
            );
            refusal.extra.insert("token".into(), loaded.token.into());
            refusal
                .extra
                .insert("savedAt".into(), loaded.saved_at.into());
            return Err(refusal);
        }
        let mut body = change(&mut library)?;
        library.validate().map_err(Refusal::invalid)?;
        let text = library_to_file_json(&library);
        body.insert("ok".into(), true.into());
        if options.diff {
            let diff = similar::TextDiff::from_lines(&loaded.text, &text)
                .unified_diff()
                .header("a/tools.json", "b/tools.json")
                .to_string();
            body.insert("diff".into(), diff.into());
        }
        if options.dry_run {
            body.insert("dryRun".into(), true.into());
            body.insert("token".into(), loaded.token.into());
            body.insert("unchanged".into(), (text == loaded.text).into());
        } else {
            let saved = self
                .store
                .save(&text, (self.clock)())
                .map_err(Refusal::internal)?;
            body.insert("token".into(), saved.token.into());
            body.insert("savedAt".into(), saved.saved_at.into());
            body.insert("unchanged".into(), saved.backup.is_none().into());
            body.insert("backup".into(), saved.backup.into());
        }
        Ok(Response::json(200, &Value::Object(body)))
    }
}

/// A refusal made outside the routes, in the same envelope.
pub fn refusal(status: u16, code: &'static str, message: &str) -> Response {
    Refusal::new(status, code, message).response()
}

/// The query parameters a route reads. One it does not read is refused: a
/// `?dryRun=1` passed over in silence would write what was only to be tried.
fn query_names(method: &str, segments: &[&str]) -> &'static [&'static str] {
    match (method, segments) {
        ("GET", ["api", "tools"]) => &["q", "material"],
        ("GET", ["api", "tools", _, "suggestions"]) => &["row", "all"],
        ("PUT", ["api", "library"]) => &["token", "dryRun", "diff"],
        ("PUT", ["api", "projects", _]) => &["folder"],
        _ => &[],
    }
}

/// A folder path out of a request: a text that `is_folder_path` takes, or,
/// where `none` allows it, the empty text or nothing at all for no folder.
fn folder_of(value: Option<Value>, key: &str, none: bool) -> Result<String, Refusal> {
    match value {
        None if none => Ok(String::new()),
        Some(Value::String(path)) if (none && path.is_empty()) || is_folder_path(&path) => Ok(path),
        Some(Value::String(_)) => Err(Refusal::bad(format!(
            "{key} is not a folder path: one to four names with / between them, each 1 to 60 characters, without / \\ : * ? \" < > |, a dot at either end, a space at either end, or a name Windows keeps (CON, NUL, COM1 …)"
        ))),
        _ => Err(Refusal::bad(format!("{key} is required: a folder path"))),
    }
}

/// Why a folder could not be made, renamed, removed or moved into.
fn folder_refusal(e: std::io::Error) -> Refusal {
    match e.kind() {
        std::io::ErrorKind::NotFound => Refusal::not_found(e.to_string()),
        std::io::ErrorKind::AlreadyExists => Refusal::new(409, "exists", e.to_string()),
        std::io::ErrorKind::DirectoryNotEmpty => Refusal::new(409, "not_empty", e.to_string()),
        std::io::ErrorKind::InvalidInput => Refusal::bad(e.to_string()),
        _ => Refusal::internal(e),
    }
}

/// What every write takes besides its change.
struct Options {
    token: String,
    dry_run: bool,
    diff: bool,
}

impl Options {
    fn of(request: &Request, body: &Map<String, Value>) -> Result<Options, Refusal> {
        let header = request
            .header("if-match")
            .map(|tag| tag.trim().trim_matches('"').to_string());
        let token = match body.get("token") {
            Some(Value::String(token)) => {
                if header.as_ref().is_some_and(|tag| tag != token) {
                    return Err(Refusal::bad(
                        "token and If-Match name different versions: send one of them",
                    ));
                }
                token.clone()
            }
            Some(_) => return Err(Refusal::bad("token must be a string")),
            None => request
                .header("if-match")
                .map(|tag| tag.trim().trim_matches('"').to_string())
                .ok_or_else(|| {
                    Refusal::bad("token is required: the token of the tool file as you read it")
                })?,
        };
        let flag = |name: &str| match body.get(name) {
            None => Ok(false),
            Some(Value::Bool(value)) => Ok(*value),
            Some(_) => Err(Refusal::bad(format!("{name} must be true or false"))),
        };
        Ok(Options {
            token,
            dry_run: flag("dryRun")?,
            diff: flag("diff")?,
        })
    }
}

fn index() -> Response {
    let routes: Vec<Value> = ROUTES
        .iter()
        .map(
            |(method, path, summary)| json!({ "method": method, "path": path, "summary": summary }),
        )
        .collect();
    Response::json(
        200,
        &json!({
            "name": "inlay-cam",
            "version": inlay_core::version(),
            "docs": "docs/api.md in https://github.com/grappeq/inlay-cam",
            "writes": "Send X-Inlay: 1, Content-Type: application/json, and the token of your last read. dryRun: true checks without writing; diff: true answers the change to the file.",
            "routes": routes,
        }),
    )
}

/// Whether some method has this path.
fn known_path(segments: &[&str]) -> bool {
    if let ["api", name] | ["api", name, _] = segments {
        if List::named(name).is_some() {
            return true;
        }
    }
    matches!(
        segments,
        ["api"]
            | [
                "api",
                "health"
                    | "library"
                    | "tools"
                    | "attention"
                    | "export"
                    | "backups"
                    | "projects"
                    | "folders"
                    | "settings"
            ]
            | [
                "api",
                "tools" | "export" | "backups" | "projects" | "folders" | "settings",
                _
            ]
            | ["api", "tools", _, "suggestions"]
            | ["api", "tools", _, "rows", _, "log"]
    )
}

/// What keeps a page of another site from writing: see the top of the file.
fn guard_write(request: &Request) -> Result<(), Refusal> {
    let forbidden = |message: &str| Refusal::new(403, "forbidden_origin", message);
    if request.header("x-inlay") != Some("1") {
        return Err(forbidden("A write needs the header X-Inlay: 1."));
    }
    if let Some(origin) = request.header("origin") {
        let host = request.header("host").unwrap_or("");
        let same = origin
            .split_once("://")
            .is_some_and(|(_, rest)| rest.eq_ignore_ascii_case(host));
        if !same {
            return Err(forbidden("A write must come from this server's own page."));
        }
    }
    if let Some(site) = request.header("sec-fetch-site") {
        if site != "same-origin" && site != "none" {
            return Err(forbidden("A write must come from this server's own page."));
        }
    }
    let json = request.header("content-type").is_some_and(|t| {
        t.split(';')
            .next()
            .unwrap_or("")
            .trim()
            .eq_ignore_ascii_case("application/json")
    });
    if !json && !(request.method == "DELETE" && request.body.is_empty()) {
        return Err(Refusal::new(
            415,
            "unsupported_media_type",
            "A write needs Content-Type: application/json.",
        ));
    }
    Ok(())
}

/// The name in a `Host` header, without the port.
fn host_name(host: &str) -> &str {
    if let Some(rest) = host.strip_prefix('[') {
        return rest.split(']').next().unwrap_or("");
    }
    host.rsplit_once(':').map_or(host, |(name, port)| {
        if port.bytes().all(|b| b.is_ascii_digit()) {
            name
        } else {
            host
        }
    })
}

/// A write's body: a JSON object with no key but those named. An empty body
/// is an empty object, for a `DELETE` whose token is in `If-Match`.
fn body_object(request: &Request, keys: &[&str]) -> Result<Map<String, Value>, Refusal> {
    if request.body.is_empty() {
        return Ok(Map::new());
    }
    let Ok(Value::Object(body)) = serde_json::from_slice(&request.body) else {
        return Err(Refusal::bad("the body must be a JSON object"));
    };
    if let Some(key) = body.keys().find(|key| !keys.contains(&key.as_str())) {
        return Err(Refusal::bad(format!(
            "{key} is not a key of this request: it takes {}",
            keys.join(", ")
        )));
    }
    Ok(body)
}

/// Reads a value of the tool model, refusing a key the model does not have:
/// a misspelt key would otherwise be dropped without a word.
fn strict<T: DeserializeOwned>(value: Value, what: &str) -> Result<T, Refusal> {
    let mut unknown = Vec::new();
    let read: T = serde_ignored::deserialize(value, |path| unknown.push(path.to_string()))
        .map_err(|e| Refusal::bad(format!("{what}: {e}")))?;
    match unknown.as_slice() {
        [] => Ok(read),
        keys => Err(Refusal::bad(format!(
            "{what}: {} {} not of the tool model",
            keys.join(", "),
            if keys.len() == 1 { "is" } else { "are" }
        ))),
    }
}

/// The tool a path names: by id, else by name, else by shown name.
fn find(library: &ToolLibrary, reference: &str) -> Result<usize, Refusal> {
    if let Some(at) = library.tools.iter().position(|t| t.id == reference) {
        return Ok(at);
    }
    let named = |shown: bool| -> Vec<usize> {
        library
            .tools
            .iter()
            .enumerate()
            .filter(|(_, t)| {
                if shown {
                    display_name(&t.name, t.coating.as_deref()) == reference
                } else {
                    t.name == reference
                }
            })
            .map(|(i, _)| i)
            .collect()
    };
    for found in [named(false), named(true)] {
        match found.as_slice() {
            [] => {}
            [at] => return Ok(*at),
            several => {
                let mut refusal = Refusal::bad(format!(
                    "{} tools are called \"{reference}\". Name the one you mean by its id.",
                    several.len()
                ));
                let ids: Vec<&str> = several
                    .iter()
                    .map(|i| library.tools[*i].id.as_str())
                    .collect();
                refusal.extra.insert("ids".into(), json!(ids));
                return Err(refusal);
            }
        }
    }
    Err(Refusal::not_found(format!(
        "There is no tool \"{reference}\". GET /api/tools?q=<words> finds tools."
    )))
}

/// A row's key: its material, with `@profile` for a row on a profile.
fn row_key(row: &CuttingSettings) -> String {
    match &row.profile {
        None => row.material.key().to_string(),
        Some(profile) => format!("{}@{profile}", row.material.key()),
    }
}

fn split_row(key: &str) -> (&str, Option<&str>) {
    match key.split_once('@') {
        Some((material, profile)) => (material, Some(profile)),
        None => (key, None),
    }
}

fn find_row<'a>(tool: &'a mut Tool, key: &str) -> Result<&'a mut CuttingSettings, Refusal> {
    let name = tool.name.clone();
    tool.cutting
        .iter_mut()
        .find(|row| row_key(row) == key)
        .ok_or_else(|| Refusal::not_found(format!("\"{name}\" has no cutting row \"{key}\".")))
}

/// A tool's kind as it is written in a file, to be found by.
fn kind_word(tool: &Tool) -> String {
    serde_json::to_value(tool.kind)
        .ok()
        .and_then(|v| v.as_str().map(|s| s.replace('_', " ")))
        .unwrap_or_default()
}

/// One tool as a read answers it: the tool as the file holds it, the name
/// the Makera apps show, what each row's result is at its present numbers,
/// and what wants looking at.
fn tool_view(library: &ToolLibrary, tool: &Tool) -> Map<String, Value> {
    let rows: Vec<Value> = tool
        .cutting
        .iter()
        .map(|row| json!({ "row": row_key(row), "result": row.current_result() }))
        .collect();
    let attention: Vec<_> = needs_attention(&library.tools)
        .into_iter()
        .filter(|a| a.tool_id == tool.id)
        .collect();
    let mut out = Map::new();
    out.insert(
        "tool".into(),
        serde_json::to_value(tool).expect("tools serialize"),
    );
    out.insert(
        "displayName".into(),
        display_name(&tool.name, tool.coating.as_deref()).into(),
    );
    out.insert("rows".into(), rows.into());
    out.insert(
        "attention".into(),
        serde_json::to_value(attention).expect("attention serializes"),
    );
    out
}

/// JSON merge patch (RFC 7396): a key set to `null` is removed, an object is
/// gone into, and anything else takes the place of what was there.
fn merge(target: &mut Value, patch: &Value) {
    let Value::Object(patch) = patch else {
        *target = patch.clone();
        return;
    };
    if !target.is_object() {
        *target = Value::Object(Map::new());
    }
    let fields = target.as_object_mut().expect("made an object above");
    for (key, value) in patch {
        if value.is_null() {
            fields.remove(key);
        } else {
            merge(fields.entry(key.clone()).or_insert(Value::Null), value);
        }
    }
}

/// A tool with a patch made to it. The patch is a merge patch of the tool as
/// the file holds it, but for `cutting`: there it is an object by row key,
/// whose values are merge patches of the rows. A row that is not there is
/// added, and `null` removes one.
fn patched(tool: &Tool, patch: &Value) -> Result<Tool, Refusal> {
    let Value::Object(patch) = patch else {
        return Err(Refusal::bad("patch must be an object"));
    };
    let mut rest = patch.clone();
    if rest
        .remove("id")
        .is_some_and(|id| id.as_str() != Some(tool.id.as_str()))
    {
        return Err(Refusal::bad("a tool's id cannot be changed"));
    }
    let cutting = rest.remove("cutting");
    let mut value = serde_json::to_value(tool).expect("tools serialize");
    merge(&mut value, &Value::Object(rest));
    match cutting {
        None => {}
        Some(Value::Object(changes)) => {
            let mut rows: Vec<CuttingSettings> = tool.cutting.clone();
            let mut values: Vec<Value> = rows
                .iter()
                .map(|row| serde_json::to_value(row).expect("rows serialize"))
                .collect();
            for (key, change) in &changes {
                let at = rows.iter().position(|row| row_key(row) == *key);
                match (at, change) {
                    (Some(at), Value::Null) => {
                        rows.remove(at);
                        values.remove(at);
                    }
                    (None, Value::Null) => {
                        return Err(Refusal::not_found(format!(
                            "\"{}\" has no cutting row \"{key}\" to remove.",
                            tool.name
                        )))
                    }
                    (Some(at), Value::Object(_)) => merge(&mut values[at], change),
                    (None, Value::Object(_)) => {
                        let (material, profile) = split_row(key);
                        let mut row = json!({ "material": material });
                        if let Some(profile) = profile {
                            row["profile"] = profile.into();
                        }
                        merge(&mut row, change);
                        values.push(row);
                    }
                    _ => {
                        return Err(Refusal::bad(format!(
                            "cutting.{key} must be an object, or null to remove the row"
                        )))
                    }
                }
            }
            value["cutting"] = Value::Array(values);
        }
        Some(_) => {
            return Err(Refusal::bad(
                "cutting must be an object by row key, such as {\"hardwood\": {\"rpm\": 11000}}",
            ))
        }
    }
    strict(value, "patch")
}

/// An id for a tool added here: 32 hex digits no tool of the list has.
fn new_id(library: &ToolLibrary, name: &str, now: SystemTime) -> String {
    let since = now
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut salt = 0u32;
    loop {
        let id =
            crate::store::token_of(format!("{name}\n{since}\n{salt}").as_bytes())[..32].to_string();
        if !library.tools.iter().any(|t| t.id == id) {
            return id;
        }
        salt += 1;
    }
}

/// Percent-decodes a path segment or a query value. `None` when the result
/// is not UTF-8. A `%` not followed by two hex digits stands for itself.
pub fn decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        match (bytes[i], bytes.get(i + 1), bytes.get(i + 2)) {
            (b'%', Some(&high), Some(&low)) if hex(high).is_some() && hex(low).is_some() => {
                out.push((hex(high).unwrap() * 16 + hex(low).unwrap()) as u8);
                i += 3;
            }
            (byte, _, _) => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

/// A query string as names and values, decoded, with `+` as a space.
pub fn parse_query(query: &str) -> Vec<(String, String)> {
    query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .filter_map(|pair| {
            let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
            Some((
                decode(&name.replace('+', " "))?,
                decode(&value.replace('+', " "))?,
            ))
        })
        .collect()
}

mod lists;

#[cfg(test)]
mod tests;
