//! Serves the built app and one shared tool file.
//!
//! ```text
//! inlay-server --web web/dist --data data
//! ```
//!
//! The app's pages are the files of `--web`; the tool list is `tools.json`
//! in `--data`, read and written through the API under `/api` (`api.rs`,
//! described in `docs/api.md`). The page finds the API at start and then
//! keeps its tool list there, in place of the browser's own storage.

mod api;
mod store;

use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use api::{Api, Request, Response};
use tiny_http::{Header, Server, StatusCode};

const USAGE: &str = "\
inlay-server: the inlay-cam app with one shared tool file

  --web <folder>    the built app (web/dist). Without it, only the API is served.
  --data <folder>   where tools.json and its backups are kept (default: data)
  --host <address>  the address to listen on (default: 127.0.0.1)
  --port <number>   (default: 8000)
  --any-host        answer whatever name the server is reached by. Needed behind
                    a proxy or on a network; see the README for what it opens.
  --health          ask the server on --port of this machine whether it is up,
                    and exit with 0 if it is. For a container's health check.

Each has an environment variable too: INLAY_WEB, INLAY_DATA, INLAY_HOST,
INLAY_PORT, and INLAY_ANY_HOST=1.";

struct Settings {
    web: Option<PathBuf>,
    data: PathBuf,
    host: String,
    port: u16,
    any_host: bool,
    health: bool,
}

fn settings() -> Result<Settings, String> {
    let env = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
    let mut out = Settings {
        web: env("INLAY_WEB").map(PathBuf::from),
        data: env("INLAY_DATA").map_or_else(|| PathBuf::from("data"), PathBuf::from),
        host: env("INLAY_HOST").unwrap_or_else(|| "127.0.0.1".into()),
        port: match env("INLAY_PORT") {
            Some(port) => port
                .parse()
                .map_err(|_| format!("INLAY_PORT: {port} is not a port"))?,
            None => 8000,
        },
        any_host: env("INLAY_ANY_HOST").is_some_and(|v| v == "1"),
        health: false,
    };
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let mut value = || args.next().ok_or_else(|| format!("{arg} needs a value"));
        match arg.as_str() {
            "--web" => out.web = Some(PathBuf::from(value()?)),
            "--data" => out.data = PathBuf::from(value()?),
            "--host" => out.host = value()?,
            "--port" => {
                let port = value()?;
                out.port = port.parse().map_err(|_| format!("{port} is not a port"))?;
            }
            "--any-host" => out.any_host = true,
            "--health" => out.health = true,
            "--help" | "-h" => return Err(String::new()),
            other => return Err(format!("{other} is not an option")),
        }
    }
    Ok(out)
}

fn main() {
    let settings = match settings() {
        Ok(settings) => settings,
        Err(problem) => {
            if !problem.is_empty() {
                eprintln!("{problem}\n");
            }
            eprintln!("{USAGE}");
            std::process::exit(if problem.is_empty() { 0 } else { 2 });
        }
    };
    if settings.health {
        std::process::exit(if is_up(settings.port) { 0 } else { 1 });
    }
    let empty = inlay_core::tools::library_to_file_json(&Default::default());
    let store = match store::Store::open(&settings.data, &empty) {
        Ok(store) => store,
        Err(e) => {
            eprintln!(
                "The data folder {} cannot be used: {e}",
                settings.data.display()
            );
            std::process::exit(1);
        }
    };
    if let Some(web) = &settings.web {
        if !web.join("index.html").is_file() {
            eprintln!(
                "{} has no index.html: build the app first (npm run build in web).",
                web.display()
            );
            std::process::exit(1);
        }
    }
    let address = format!("{}:{}", settings.host, settings.port);
    let server = match Server::http(&address) {
        Ok(server) => Arc::new(server),
        Err(e) => {
            eprintln!("Cannot listen on {address}: {e}");
            std::process::exit(1);
        }
    };
    eprintln!(
        "inlay-server on http://{address}, tool file {}",
        store.path().display()
    );
    let api = Arc::new(Api::new(store, settings.any_host));
    let web = Arc::new(settings.web);
    // Requests are short; a few threads keep one slow client from holding
    // up the rest.
    let workers: Vec<_> = (0..4)
        .map(|_| {
            let (server, api, web) = (server.clone(), api.clone(), web.clone());
            std::thread::spawn(move || {
                while let Ok(request) = server.recv() {
                    serve(request, &api, web.as_deref());
                }
            })
        })
        .collect();
    for worker in workers {
        let _ = worker.join();
    }
}

/// Whether a server on this machine answers `/api/health`.
fn is_up(port: u16) -> bool {
    use std::io::Write;
    use std::time::Duration;
    let ask = || -> std::io::Result<String> {
        let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
        let mut stream = std::net::TcpStream::connect_timeout(&address, Duration::from_secs(3))?;
        stream.set_read_timeout(Some(Duration::from_secs(3)))?;
        stream.write_all(b"GET /api/health HTTP/1.0\r\nHost: localhost\r\n\r\n")?;
        let mut answer = String::new();
        stream.read_to_string(&mut answer)?;
        Ok(answer)
    };
    ask().is_ok_and(|answer| {
        answer.starts_with("HTTP/1.0 200") || answer.starts_with("HTTP/1.1 200")
    })
}

fn serve(mut incoming: tiny_http::Request, api: &Api, web: Option<&Path>) {
    let method = incoming.method().as_str().to_uppercase();
    let url = incoming.url().to_string();
    let (path, query) = url.split_once('?').unwrap_or((&url, ""));
    let headers: Vec<(String, String)> = incoming
        .headers()
        .iter()
        .map(|h| {
            (
                h.field.as_str().as_str().to_lowercase(),
                h.value.as_str().to_string(),
            )
        })
        .collect();
    let host = headers
        .iter()
        .find(|(n, _)| n == "host")
        .map(|(_, v)| v.as_str());

    let response = if let Some(refused) = api.refuse_host(host) {
        refused
    } else if path == "/api" || path.starts_with("/api/") {
        let limit = Api::body_limit(&method, path);
        let mut body = Vec::new();
        let read = if incoming.body_length().is_some_and(|length| length > limit) {
            Err(())
        } else {
            // One byte over the limit tells a body that is too long from
            // one that just fits, for a client that gave no length.
            incoming
                .as_reader()
                .take(limit as u64 + 1)
                .read_to_end(&mut body)
                .map_err(|_| ())
                .and_then(|read| if read > limit { Err(()) } else { Ok(()) })
        };
        match read {
            Ok(()) => api.handle(&Request {
                method: method.clone(),
                path: path.to_string(),
                query: api::parse_query(query),
                headers,
                body,
            }),
            Err(()) => plain(413, &format!("{{\"error\":{{\"code\":\"too_large\",\"message\":\"The body may have {limit} bytes at most.\"}}}}"), "application/json"),
        }
    } else if method != "GET" && method != "HEAD" {
        plain(405, "Method not allowed", "text/plain; charset=utf-8")
    } else {
        match web {
            Some(web) => page(web, path),
            None => plain(
                404,
                "This server has no pages, only the API under /api.",
                "text/plain; charset=utf-8",
            ),
        }
    };

    eprintln!("{method} {} {}", printable(path), response.status);
    let mut out =
        tiny_http::Response::from_data(response.body).with_status_code(StatusCode(response.status));
    let fixed = [
        ("Content-Type", response.content_type.as_str()),
        ("X-Content-Type-Options", "nosniff"),
        ("Referrer-Policy", "no-referrer"),
    ];
    let given = response
        .headers
        .iter()
        .map(|(n, v)| (n.as_str(), v.as_str()));
    for (name, value) in fixed.into_iter().chain(given) {
        if let Ok(header) = Header::from_bytes(name.as_bytes(), value.as_bytes()) {
            out.add_header(header);
        }
    }
    let _ = incoming.respond(out);
}

fn plain(status: u16, text: &str, content_type: &str) -> Response {
    Response {
        status,
        content_type: content_type.into(),
        headers: vec![("Cache-Control".into(), "no-store".into())],
        body: text.as_bytes().to_vec(),
    }
}

/// A file of the built app. Only a path made of plain names reaches the
/// folder, so nothing outside it can be asked for.
fn page(web: &Path, path: &str) -> Response {
    let not_found = || plain(404, "Not found", "text/plain; charset=utf-8");
    let Some(decoded) = api::decode(path) else {
        return not_found();
    };
    let relative = Path::new(decoded.trim_start_matches('/'));
    if !relative
        .components()
        .all(|c| matches!(c, Component::Normal(_)))
    {
        return not_found();
    }
    let mut file = web.join(relative);
    if file.is_dir() {
        file.push("index.html");
    }
    let Ok(body) = std::fs::read(&file) else {
        return not_found();
    };
    let content_type = match file.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "wasm" => "application/wasm",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "dxf" | "txt" | "cnc" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    };
    // The build names everything under assets/ by its content, so those
    // never change; everything else is asked for again each time.
    let cache = if relative.starts_with("assets") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    Response {
        status: 200,
        content_type: content_type.into(),
        headers: vec![("Cache-Control".into(), cache.into())],
        body,
    }
}

/// A request path for the log, with control characters written out so a
/// client cannot put terminal escape sequences into it.
fn printable(path: &str) -> String {
    path.chars()
        .flat_map(|c| {
            if c.is_control() {
                c.escape_default().collect::<Vec<_>>()
            } else {
                vec![c]
            }
        })
        .collect()
}
