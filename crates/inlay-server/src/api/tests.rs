use super::*;
use crate::store::tests::Scratch;

/// A server over a fresh folder that holds the starter set.
struct Served {
    api: Api,
    _scratch: Scratch,
}

fn served() -> Served {
    let scratch = Scratch::new();
    let store = Store::open(
        &scratch.0,
        &library_to_file_json(&inlay_core::starter::library()),
    )
    .unwrap();
    Served {
        api: Api::new(store, false),
        _scratch: scratch,
    }
}

impl Served {
    fn send(&self, method: &str, target: &str, headers: &[(&str, &str)], body: &[u8]) -> Response {
        let (path, query) = target.split_once('?').unwrap_or((target, ""));
        let mut all = vec![("host".to_string(), "localhost:8000".to_string())];
        if method != "GET" {
            all.push(("x-inlay".into(), "1".into()));
            all.push(("content-type".into(), "application/json".into()));
        }
        for (name, value) in headers {
            all.retain(|(n, _)| n != name);
            all.push((name.to_string(), value.to_string()));
        }
        self.api.handle(&Request {
            method: method.into(),
            path: path.into(),
            query: parse_query(query),
            headers: all,
            body: body.to_vec(),
        })
    }

    fn get(&self, target: &str) -> (u16, Value) {
        let response = self.send("GET", target, &[], b"");
        (
            response.status,
            serde_json::from_slice(&response.body).unwrap(),
        )
    }

    fn write(&self, method: &str, target: &str, body: Value) -> (u16, Value) {
        let response = self.send(method, target, &[], body.to_string().as_bytes());
        (
            response.status,
            serde_json::from_slice(&response.body).unwrap(),
        )
    }

    fn token(&self) -> String {
        self.get("/api/tools").1["token"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn library(&self) -> ToolLibrary {
        let response = self.send("GET", "/api/library", &[], b"");
        library_from_file_json(std::str::from_utf8(&response.body).unwrap()).unwrap()
    }
}

fn code(answer: &Value) -> &str {
    answer["error"]["code"].as_str().unwrap_or("")
}

#[test]
fn the_file_is_read_whole_with_its_token_as_etag() {
    let served = served();
    let response = served.send("GET", "/api/library", &[], b"");
    assert_eq!(response.status, 200);
    let etag = response
        .headers
        .iter()
        .find(|(n, _)| n == "ETag")
        .map(|(_, v)| v.clone())
        .unwrap();
    assert_eq!(etag, format!("\"{}\"", served.token()));
    assert_eq!(served.library().tools.len(), 50);
    // Asked for again by someone who has it: nothing is sent.
    let again = served.send("GET", "/api/library", &[("if-none-match", &etag)], b"");
    assert_eq!(again.status, 304);
    assert!(again.body.is_empty());
}

#[test]
fn tools_are_found_by_words_and_material() {
    let served = served();
    let (_, all) = served.get("/api/tools");
    assert_eq!(all["count"], 50);
    assert_eq!(all["materials"][0], "hardwood");
    let (_, found) = served.get("/api/tools?q=ball+dlc");
    assert_eq!(found["count"], 3);
    assert_eq!(found["tools"][0]["id"], "starter-22");
    assert_eq!(
        found["tools"][0]["displayName"],
        "Ø1 Ball S3.175 2F 38L DLC"
    );
    assert!(found["tools"][0]["rows"]
        .as_array()
        .unwrap()
        .contains(&json!("hardwood")));
    // The kind is found as it is said, and a material narrows the list.
    assert_eq!(served.get("/api/tools?q=thread%20mill").1["count"], 3);
    assert_eq!(served.get("/api/tools?q=drill&material=pcb").1["count"], 12);
    assert_eq!(
        served.get("/api/tools?q=thread%20mill&material=hardwood").1["count"],
        0
    );
    let (status, answer) = served.get("/api/tools?name=x");
    assert_eq!((status, code(&answer)), (400, "bad_request"));
}

#[test]
fn a_tool_is_named_by_id_name_or_shown_name() {
    let served = served();
    for reference in ["starter-04", "Ø3.175×12 1F Upcut", "Ø3.175×12 1F Upcut DLC"] {
        let encoded: String = reference.bytes().map(|b| format!("%{b:02X}")).collect();
        let (status, answer) = served.get(&format!("/api/tools/{encoded}"));
        assert_eq!(status, 200, "{reference}");
        assert_eq!(answer["tool"]["id"], "starter-04");
        assert_eq!(answer["displayName"], "Ø3.175×12 1F Upcut DLC");
        assert_eq!(answer["rows"][0]["row"], "hardwood");
    }
    let (status, answer) = served.get("/api/tools/nothing");
    assert_eq!((status, code(&answer)), (404, "not_found"));
}

#[test]
fn a_patch_changes_what_it_names_and_nothing_else() {
    let served = served();
    let before = served.library();
    let (status, answer) = served.write(
        "PATCH",
        "/api/tools/starter-04",
        json!({
            "token": served.token(),
            "diff": true,
            "patch": {
                "note": "The one for pockets.",
                "coating": null,
                "source": { "url": "https://example.com/bit" },
                "cutting": { "hardwood": { "rpm": 11000 }, "softwood": null },
            },
        }),
    );
    assert_eq!(status, 200, "{answer}");
    assert_eq!(answer["ok"], true);
    assert_eq!(answer["unchanged"], false);
    assert_eq!(answer["token"], served.token());
    let diff = answer["diff"].as_str().unwrap();
    assert!(
        diff.starts_with("--- a/tools.json\n+++ b/tools.json\n"),
        "{diff}"
    );
    assert!(
        diff.contains("+      \"note\": \"The one for pockets.\""),
        "{diff}"
    );

    let after = served.library();
    let (was, is) = (&before.tools[3], &after.tools[3]);
    assert_eq!(is.note.as_deref(), Some("The one for pockets."));
    assert_eq!(is.coating, None);
    assert_eq!(
        is.source.as_ref().unwrap().url.as_deref(),
        Some("https://example.com/bit")
    );
    assert_eq!(is.cutting.len(), was.cutting.len() - 1);
    assert_eq!(is.cutting[0].rpm, 11000);
    assert_eq!(is.cutting[0].feed, was.cutting[0].feed);
    assert!(is.cutting.iter().all(|c| c.material.key() != "softwood"));
    // Every other tool is as it was.
    for (i, tool) in after.tools.iter().enumerate() {
        if i != 3 {
            assert_eq!(*tool, before.tools[i]);
        }
    }
}

#[test]
fn a_patch_adds_a_row_that_is_not_there() {
    let served = served();
    let row = json!({ "rpm": 12000, "feed": 600, "plunge": 200, "stepover": 1.2, "stepdown": 1.5 });
    let (status, answer) = served.write(
        "PATCH",
        "/api/tools/starter-04",
        json!({ "token": served.token(), "patch": { "cutting": { "hardwood@clearing": row } } }),
    );
    assert_eq!(status, 200, "{answer}");
    let tool = &served.library().tools[3];
    let added = tool.cutting.last().unwrap();
    assert_eq!(
        (added.material.key(), added.profile.as_deref()),
        ("hardwood", Some("clearing"))
    );
    assert_eq!(added.feed, 600.0);
    // A row with numbers missing is not a row.
    let (status, answer) = served.write(
        "PATCH",
        "/api/tools/starter-04",
        json!({ "token": served.token(), "patch": { "cutting": { "softwood@clearing": { "rpm": 9000 } } } }),
    );
    assert_eq!((status, code(&answer)), (400, "bad_request"));
    // A profile the list does not have is refused by the file's own check.
    let (status, answer) = served.write(
        "PATCH",
        "/api/tools/starter-04",
        json!({ "token": served.token(), "patch": { "cutting": { "hardwood@nowhere": row } } }),
    );
    assert_eq!((status, code(&answer)), (422, "invalid"));
}

#[test]
fn a_patch_with_a_misspelt_key_is_refused() {
    let served = served();
    let (status, answer) = served.write(
        "PATCH",
        "/api/tools/starter-04",
        json!({ "token": served.token(), "patch": { "fluteLenght": 14 } }),
    );
    assert_eq!((status, code(&answer)), (400, "bad_request"));
    assert!(answer["error"]["message"]
        .as_str()
        .unwrap()
        .contains("fluteLenght"));
    let (status, _) = served.write(
        "PATCH",
        "/api/tools/starter-04",
        json!({ "token": served.token(), "patch": { "cutting": { "hardwood": { "rmp": 1 } } } }),
    );
    assert_eq!(status, 400);
    let (status, answer) = served.write(
        "PATCH",
        "/api/tools/starter-04",
        json!({ "token": served.token(), "patch": { "id": "another" } }),
    );
    assert_eq!((status, code(&answer)), (400, "bad_request"));
}

#[test]
fn a_change_that_leaves_the_tool_wrong_is_not_written() {
    let served = served();
    let token = served.token();
    let (status, answer) = served.write(
        "PATCH",
        "/api/tools/starter-04",
        json!({ "token": token, "patch": { "diameter": -1 } }),
    );
    assert_eq!((status, code(&answer)), (422, "invalid"));
    assert!(answer["error"]["message"]
        .as_str()
        .unwrap()
        .contains("diameter"));
    assert_eq!(served.token(), token);
    assert_eq!(served.get("/api/backups").1["backups"], json!([]));
}

#[test]
fn a_write_with_an_old_token_is_a_conflict() {
    let served = served();
    let old = served.token();
    let patch = |token: &str| json!({ "token": token, "patch": { "note": "x" } });
    assert_eq!(
        served
            .write("PATCH", "/api/tools/starter-04", patch(&old))
            .0,
        200
    );
    let (status, answer) = served.write("PATCH", "/api/tools/starter-05", patch(&old));
    assert_eq!((status, code(&answer)), (409, "conflict"));
    assert_eq!(answer["error"]["token"], served.token());
    assert_eq!(
        served.library().tools[4].note,
        inlay_core::starter::library().tools[4].note
    );
    // Without any token at all it is not a write.
    let (status, answer) = served.write("PATCH", "/api/tools/starter-05", json!({ "patch": {} }));
    assert_eq!((status, code(&answer)), (400, "bad_request"));
}

#[test]
fn a_dry_run_answers_as_the_write_would_and_writes_nothing() {
    let served = served();
    let token = served.token();
    let (status, answer) = served.write(
        "PATCH",
        "/api/tools/starter-04",
        json!({ "token": token, "dryRun": true, "diff": true, "patch": { "flutes": 2 } }),
    );
    assert_eq!(status, 200, "{answer}");
    assert_eq!(answer["dryRun"], true);
    assert_eq!(answer["token"], token);
    assert_eq!(answer["tool"]["flutes"], 2);
    assert!(answer["diff"]
        .as_str()
        .unwrap()
        .contains("+      \"flutes\": 2"));
    assert_eq!(served.token(), token);
    assert_eq!(served.library().tools[3].flutes, Some(1));
}

#[test]
fn a_write_keeps_a_backup_that_can_be_put_back() {
    let served = served();
    let first = served.token();
    let (_, answer) = served.write(
        "PATCH",
        "/api/tools/starter-04",
        json!({ "token": first, "patch": { "note": "changed" } }),
    );
    let backup = answer["backup"].as_str().unwrap().to_string();
    let (_, list) = served.get("/api/backups");
    assert_eq!(list["backups"][0]["name"], backup.as_str());
    let kept = served.send("GET", &format!("/api/backups/{backup}"), &[], b"");
    assert_eq!(crate::store::token_of(&kept.body), first);

    // Put back: the file is as it was, and what it replaced is kept in turn.
    let etag = format!("\"{}\"", served.token());
    let response = served.send("PUT", "/api/library", &[("if-match", &etag)], &kept.body);
    assert_eq!(response.status, 200);
    assert_eq!(served.token(), first);
    assert_eq!(
        served.get("/api/backups").1["backups"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    // A change that changes nothing keeps none.
    let (_, answer) = served.write(
        "PATCH",
        "/api/tools/starter-04",
        json!({ "token": first, "patch": { "flutes": 1 } }),
    );
    assert_eq!(answer["unchanged"], true);
    assert_eq!(answer["backup"], Value::Null);
}

#[test]
fn the_whole_file_is_replaced_only_by_a_tool_file() {
    let served = served();
    let etag = format!("\"{}\"", served.token());
    let response = served.send(
        "PUT",
        "/api/library",
        &[("if-match", &etag)],
        b"{\"tools\": []}",
    );
    assert_eq!(response.status, 422);
    let response = served.send("PUT", "/api/library", &[], b"{}");
    assert_eq!(response.status, 400);
    let mut library = served.library();
    library.tools.truncate(2);
    let text = library_to_file_json(&library);
    let stale = served.send(
        "PUT",
        "/api/library",
        &[("if-match", "\"0\"")],
        text.as_bytes(),
    );
    assert_eq!(stale.status, 409);
    let dry = served.send(
        "PUT",
        "/api/library?dryRun=1",
        &[("if-match", &etag)],
        text.as_bytes(),
    );
    assert_eq!(dry.status, 200);
    assert_eq!(served.library().tools.len(), 50);
    let response = served.send(
        "PUT",
        "/api/library",
        &[("if-match", &etag)],
        text.as_bytes(),
    );
    assert_eq!(response.status, 200);
    assert_eq!(served.library().tools.len(), 2);
}

#[test]
fn a_cut_is_logged_at_the_rows_numbers() {
    let served = served();
    let (status, answer) = served.write(
        "POST",
        "/api/tools/starter-04/rows/hardwood/log",
        json!({
            "token": served.token(),
            "entry": { "date": "2026-11-18", "outcome": "failed", "text": "Burnt at the corners." },
        }),
    );
    assert_eq!(status, 200, "{answer}");
    let tool = &served.library().tools[3];
    let row = &tool.cutting[0];
    assert_eq!(row.log.len(), 1);
    assert_eq!(row.log[0].at, Some(row.values()));
    assert_eq!(answer["logged"]["at"]["rpm"], row.rpm);
    // The result counts for the row as it is, and the tool wants a look.
    assert_eq!(answer["rows"][0]["result"]["outcome"], "failed");
    assert_eq!(answer["attention"][0]["kind"], "failed");
    let (_, attention) = served.get("/api/attention");
    assert_eq!(attention["items"][0]["toolId"], "starter-04");

    // Cut at other numbers: those are what is kept.
    let at = json!({ "rpm": 9000, "feed": 300, "plunge": 100, "stepover": 1, "stepdown": 1 });
    let (status, answer) = served.write(
        "POST",
        "/api/tools/starter-04/rows/hardwood/log",
        json!({ "token": served.token(), "entry": { "date": "2026-11-19", "outcome": "ok", "text": "Slower: clean.", "at": at } }),
    );
    assert_eq!(status, 200, "{answer}");
    assert_eq!(
        served.library().tools[3].cutting[0].log[1]
            .at
            .as_ref()
            .unwrap()
            .rpm,
        9000
    );
    // The row's result is still the failure: the second cut was not at its numbers.
    assert_eq!(answer["rows"][0]["result"]["outcome"], "failed");

    let entry = json!({ "date": "18.11.2026", "text": "x" });
    let (status, _) = served.write(
        "POST",
        "/api/tools/starter-04/rows/hardwood/log",
        json!({ "token": served.token(), "entry": entry }),
    );
    assert_eq!(status, 422);
    let (status, answer) = served.write(
        "POST",
        "/api/tools/starter-04/rows/titanium/log",
        json!({ "token": served.token(), "entry": { "date": "2026-11-18", "text": "x" } }),
    );
    assert_eq!((status, code(&answer)), (404, "not_found"));
}

#[test]
fn a_tool_is_added_after_its_group_and_deleted() {
    let served = served();
    let (status, answer) = served.write(
        "POST",
        "/api/tools",
        json!({
            "token": served.token(),
            "tool": { "name": "Ø6×20 2F", "kind": "flat_end", "diameter": 6, "shankDiameter": 6, "group": "End mills" },
        }),
    );
    assert_eq!(status, 200, "{answer}");
    let id = answer["tool"]["id"].as_str().unwrap().to_string();
    assert_eq!(id.len(), 32);
    let library = served.library();
    // The end mills are the first 21 of the starter set.
    assert_eq!(library.tools[21].id, id);
    assert_eq!(library.tools.len(), 51);

    let (status, answer) = served.write(
        "POST",
        "/api/tools",
        json!({ "token": served.token(), "tool": { "name": "No size", "kind": "flat_end" } }),
    );
    assert_eq!((status, code(&answer)), (400, "bad_request"));

    // A delete can carry its token in If-Match, with no body.
    let etag = format!("\"{}\"", served.token());
    let response = served.send(
        "DELETE",
        &format!("/api/tools/{id}"),
        &[("if-match", &etag), ("content-type", "")],
        b"",
    );
    assert_eq!(response.status, 200);
    let answer: Value = serde_json::from_slice(&response.body).unwrap();
    assert_eq!(answer["deleted"]["name"], "Ø6×20 2F");
    assert_eq!(served.library().tools.len(), 50);
}

#[test]
fn suggestions_are_the_feeds_models() {
    let served = served();
    let (status, answer) = served.get("/api/tools/starter-04/suggestions?row=hardwood");
    assert_eq!(status, 200, "{answer}");
    assert_eq!(answer["covered"], true);
    let library = served.library();
    let entry = feeds::suggest_entry(
        &library.tools[3],
        "hardwood",
        None,
        feeds::Spindle::default(),
    );
    assert_eq!(answer["combination"], entry.default.as_str());
    assert_eq!(
        answer["suggestion"],
        serde_json::to_value(&entry.combos[&entry.default]).unwrap()
    );
    let (_, all) = served.get("/api/tools/starter-04/suggestions?row=hardwood@clearing&all=1");
    assert!(all["entry"]["combos"].as_object().unwrap().len() >= 20);
    assert_eq!(served.get("/api/tools/starter-04/suggestions").0, 400);
    assert_eq!(
        served
            .get("/api/tools/starter-04/suggestions?row=hardwood@nowhere")
            .0,
        404
    );
}

#[test]
fn the_libraries_for_other_programs_are_what_the_core_writes() {
    let served = served();
    let library = served.library();
    let yaml = served.send("GET", "/api/export/tools.yaml", &[], b"");
    assert_eq!(
        yaml.body,
        tools_yaml::write_tools_yaml(&library).into_bytes()
    );
    let cam = served.send("GET", "/api/export/cam", &[], b"");
    assert_eq!(
        cam.body,
        makera::write(&makera::build_cam(&library).unwrap().0)
    );
    let fusion = served.send("GET", "/api/export/fusion", &[], b"");
    assert_eq!(
        fusion.body,
        fusion::build_fusion(&library).library.into_bytes()
    );
    assert_eq!(
        served.send("GET", "/api/export/studio", &[], b"").status,
        200
    );
    let (_, summary) = served.get("/api/export");
    // Makera's own bits are in the Makera apps already, and go to neither.
    assert_eq!(summary["exports"][0]["kind"], "cam");
    assert_eq!(summary["exports"][0]["tools"], 0);
    assert_eq!(summary["exports"][2]["kind"], "fusion");
    assert_eq!(summary["exports"][2]["tools"], 50);
    assert_eq!(served.get("/api/export/other").0, 404);
}

#[test]
fn only_this_servers_own_page_may_write() {
    let served = served();
    let body = json!({ "token": served.token(), "patch": { "note": "x" } }).to_string();
    let send = |headers: &[(&str, &str)]| {
        let response = served.send("PATCH", "/api/tools/starter-04", headers, body.as_bytes());
        let answer: Value = serde_json::from_slice(&response.body).unwrap();
        (response.status, code(&answer).to_string())
    };
    assert_eq!(send(&[("x-inlay", "0")]), (403, "forbidden_origin".into()));
    assert_eq!(
        send(&[("origin", "https://elsewhere.example")]),
        (403, "forbidden_origin".into())
    );
    assert_eq!(
        send(&[("sec-fetch-site", "cross-site")]),
        (403, "forbidden_origin".into())
    );
    assert_eq!(
        send(&[("content-type", "text/plain")]),
        (415, "unsupported_media_type".into())
    );
    assert_eq!(
        send(&[("host", "evil.example")]),
        (403, "forbidden_host".into())
    );
    // Reads are refused under another name too: that is DNS rebinding.
    assert_eq!(
        served
            .send("GET", "/api/tools", &[("host", "evil.example")], b"")
            .status,
        403
    );
    assert_eq!(
        served.library().tools[3].note,
        inlay_core::starter::library().tools[3].note
    );
    // The page itself, as a browser sends it.
    assert_eq!(
        send(&[
            ("origin", "http://localhost:8000"),
            ("sec-fetch-site", "same-origin")
        ])
        .0,
        200
    );
}

#[test]
fn behind_a_proxy_any_host_is_answered() {
    let scratch = Scratch::new();
    let store = Store::open(&scratch.0, &library_to_file_json(&ToolLibrary::default())).unwrap();
    let api = Api::new(store, true);
    let response = api.handle(&Request {
        method: "GET".into(),
        path: "/api/health".into(),
        query: Vec::new(),
        headers: vec![("host".into(), "cnc.example".into())],
        body: Vec::new(),
    });
    assert_eq!(response.status, 200);
}

#[test]
fn a_file_that_cannot_be_read_is_said_and_left_alone() {
    let scratch = Scratch::new();
    let store = Store::open(&scratch.0, "not a tool file").unwrap();
    let served = Served {
        api: Api::new(store, false),
        _scratch: scratch,
    };
    let (status, answer) = served.get("/api/tools");
    assert_eq!((status, code(&answer)), (422, "load_error"));
    let (status, answer) = served.write("POST", "/api/tools", json!({ "token": "x", "tool": {} }));
    assert_eq!(status, 400, "{answer}");
    assert_eq!(served.get("/api/health").0, 200);
}

#[test]
fn unknown_paths_and_methods_are_told_apart() {
    let served = served();
    let (status, answer) = served.get("/api/nothing");
    assert_eq!((status, code(&answer)), (404, "not_found"));
    let (status, answer) = served.write("POST", "/api/attention", json!({}));
    assert_eq!((status, code(&answer)), (405, "method_not_allowed"));
    let (_, index) = served.get("/api");
    assert_eq!(index["routes"].as_array().unwrap().len(), ROUTES.len());
}

#[test]
fn paths_and_queries_are_decoded() {
    assert_eq!(decode("%C3%981%C3%973").as_deref(), Some("Ø1×3"));
    assert_eq!(decode("100%").as_deref(), Some("100%"));
    assert_eq!(decode("%ff"), None);
    assert_eq!(
        parse_query("q=flat+two&material=aluminum&x"),
        [
            ("q".to_string(), "flat two".to_string()),
            ("material".into(), "aluminum".into()),
            ("x".into(), "".into())
        ]
    );
    assert_eq!(host_name("localhost:8000"), "localhost");
    assert_eq!(host_name("[::1]:8000"), "::1");
    assert_eq!(host_name("cnc.example"), "cnc.example");
}

#[test]
fn projects_are_kept_listed_and_taken_off() {
    let served = served();
    assert_eq!(served.get("/api/projects").1["projects"], json!([]));
    let mut project = inlay_core::project::project_from_file_json(include_str!(
        "../../../inlay-core/tests/fixtures/project-v2.json"
    ))
    .unwrap();
    project.id = "p-1".into();
    project.name = "A box lid".into();
    let text = inlay_core::project::project_to_file_json(&project);
    let response = served.send("PUT", "/api/projects/p-1", &[], text.as_bytes());
    assert_eq!(
        response.status,
        200,
        "{}",
        String::from_utf8_lossy(&response.body)
    );
    let (_, list) = served.get("/api/projects");
    assert_eq!(list["projects"][0]["id"], "p-1");
    assert_eq!(list["projects"][0]["name"], "A box lid");
    assert!(list["projects"][0]["modified"].as_u64().unwrap() > 0);
    let read = served.send("GET", "/api/projects/p-1", &[], b"");
    assert_eq!(read.body, text.as_bytes());

    // Under another id, or not a project at all, it is not kept.
    assert_eq!(
        served
            .send("PUT", "/api/projects/p-2", &[], text.as_bytes())
            .status,
        400
    );
    assert_eq!(
        served.send("PUT", "/api/projects/p-1", &[], b"{}").status,
        422
    );
    assert_eq!(
        served
            .send(
                "PUT",
                "/api/projects/p-1",
                &[("x-inlay", "")],
                text.as_bytes()
            )
            .status,
        403
    );
    assert_eq!(served.get("/api/projects/p-9").0, 404);
    assert_eq!(served.get("/api/projects/..%2Ftools").0, 404);

    assert_eq!(
        served
            .send("DELETE", "/api/projects/p-1", &[("content-type", "")], b"")
            .status,
        200
    );
    assert_eq!(
        served
            .send("DELETE", "/api/projects/p-1", &[("content-type", "")], b"")
            .status,
        404
    );
    assert_eq!(served.get("/api/projects").1["projects"], json!([]));
}

#[test]
fn settings_are_kept_one_text_per_key() {
    let served = served();
    assert_eq!(served.get("/api/settings").1, json!({}));
    assert_eq!(
        served
            .write(
                "PUT",
                "/api/settings/machine",
                json!({ "value": "{\"maxRpm\":12000}" })
            )
            .0,
        200
    );
    assert_eq!(
        served
            .write(
                "PUT",
                "/api/settings/lastProjectId",
                json!({ "value": "p-1" })
            )
            .0,
        200
    );
    assert_eq!(
        served.get("/api/settings").1,
        json!({ "machine": "{\"maxRpm\":12000}", "lastProjectId": "p-1" })
    );
    assert_eq!(
        served
            .write(
                "PUT",
                "/api/settings/lastProjectId",
                json!({ "value": null })
            )
            .0,
        200
    );
    assert_eq!(
        served.get("/api/settings").1,
        json!({ "machine": "{\"maxRpm\":12000}" })
    );
    assert_eq!(
        served
            .write("PUT", "/api/settings/other", json!({ "value": "x" }))
            .0,
        404
    );
    assert_eq!(
        served
            .write("PUT", "/api/settings/machine", json!({ "value": 5 }))
            .0,
        400
    );
}

#[test]
fn a_file_that_cannot_be_read_is_put_right_by_replacing_it() {
    let served = served();
    let (_, good) = served.get("/api/library");
    let good = serde_json::to_string(&good).unwrap();
    std::fs::write(served.api.store.path(), "{").unwrap();

    let (status, body) = served.get("/api/library");
    assert_eq!(
        (status, &body["error"]["code"]),
        (422, &json!("load_error"))
    );
    let token = body["error"]["token"].as_str().unwrap().to_string();
    // One tool cannot be changed in a file that is no tool file.
    let (status, _) = served.write(
        "PATCH",
        "/api/tools/starter-01",
        json!({ "token": token, "patch": { "note": "x" } }),
    );
    assert_eq!(status, 422);
    let put = served.send(
        "PUT",
        "/api/library",
        &[("if-match", "wrong")],
        good.as_bytes(),
    );
    assert_eq!(put.status, 409);
    let put = served.send(
        "PUT",
        "/api/library",
        &[("if-match", &token)],
        good.as_bytes(),
    );
    assert_eq!(put.status, 200, "{}", String::from_utf8_lossy(&put.body));
    assert_eq!(
        served.get("/api/tools").1["tools"]
            .as_array()
            .unwrap()
            .len(),
        50
    );
    // What could not be read is kept all the same.
    assert_eq!(
        served.get("/api/backups").1["backups"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn settings_that_cannot_be_read_are_set_aside() {
    let served = served();
    let settings = served.api.store.path().with_file_name("settings.json");
    std::fs::write(&settings, "not json").unwrap();
    assert_eq!(served.get("/api/settings").0, 422);
    assert_eq!(
        served
            .write("PUT", "/api/settings/machine", json!({ "value": "m" }))
            .0,
        200
    );
    assert_eq!(served.get("/api/settings").1, json!({ "machine": "m" }));
}

#[test]
fn a_query_parameter_a_route_does_not_read_is_refused() {
    let served = served();
    let token = served.token();
    let delete = served.send(
        "DELETE",
        "/api/tools/starter-01?dryRun=1",
        &[("if-match", &token), ("content-type", "")],
        b"",
    );
    assert_eq!(delete.status, 400);
    assert_eq!(served.get("/api/tools/starter-01").0, 200);
    assert_eq!(served.get("/api/attention?x=1").0, 400);
    assert_eq!(served.get("/api/tools?q=drill").0, 200);
}

#[test]
fn materials_profiles_and_groups_are_listed_with_what_names_them() {
    let served = served();
    let (status, materials) = served.get("/api/materials");
    assert_eq!(status, 200);
    let keys: Vec<&str> = materials["materials"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["key"].as_str().unwrap())
        .collect();
    assert!(keys.contains(&"aluminum"), "{keys:?}");
    assert!(materials["usedBy"]["aluminum"].as_u64().unwrap() > 0);
    let (status, one) = served.get("/api/materials/aluminum");
    assert_eq!(status, 200);
    assert_eq!(one["material"]["key"], "aluminum");
    assert!(!one["usedBy"].as_array().unwrap().is_empty());
    // Built in, and so known without its entry, which can go though tools
    // name it; then said so.
    let (status, _) = served.write(
        "DELETE",
        "/api/materials/hardwood",
        json!({"token": served.token()}),
    );
    assert_eq!(status, 200);
    let (status, answer) = served.get("/api/materials/hardwood");
    assert_eq!(status, 404);
    assert!(answer["error"]["message"]
        .as_str()
        .unwrap()
        .contains("built in"));
    assert_eq!(served.get("/api/profiles").0, 200);
    assert_eq!(served.get("/api/groups").0, 200);
    assert_eq!(served.get("/api/profiles/nothing").0, 404);
}

#[test]
fn a_material_is_added_changed_and_deleted_one_at_a_time() {
    let served = served();
    let token = served.token();
    let (status, added) = served.write(
        "POST",
        "/api/materials",
        json!({"token": token, "material": {"key": "walnut", "label": "Walnut", "feedsAs": "hardwood"}}),
    );
    assert_eq!(status, 200, "{added}");
    assert_eq!(added["material"]["label"], "Walnut");
    assert_eq!(added["usedBy"], json!([]));
    assert!(added["backup"].is_string());
    let library = served.library();
    assert_eq!(library.materials.last().unwrap().key.key(), "walnut");
    // Added twice, or with a key the model does not have: refused.
    let (status, answer) = served.write(
        "POST",
        "/api/materials",
        json!({"token": served.token(), "material": {"key": "walnut"}}),
    );
    assert_eq!((status, code(&answer)), (400, "bad_request"));
    let (status, answer) = served.write(
        "POST",
        "/api/materials",
        json!({"token": served.token(), "material": {"key": "oak", "lable": "Oak"}}),
    );
    assert_eq!((status, code(&answer)), (400, "bad_request"));
    assert!(answer["error"]["message"].as_str().unwrap().contains("lable"));

    let (status, changed) = served.write(
        "PATCH",
        "/api/materials/walnut",
        json!({"token": served.token(), "patch": {"label": "Black walnut"}, "diff": true}),
    );
    assert_eq!(status, 200, "{changed}");
    assert_eq!(changed["material"]["label"], "Black walnut");
    assert_eq!(changed["material"]["feedsAs"], "hardwood");
    assert!(changed["diff"].as_str().unwrap().contains("Black walnut"));
    let (status, answer) = served.write(
        "PATCH",
        "/api/materials/walnut",
        json!({"token": served.token(), "patch": {"key": "oak"}}),
    );
    assert_eq!((status, code(&answer)), (400, "bad_request"));

    // A material a tool names stays.
    let (status, answer) = served.write(
        "DELETE",
        "/api/materials/aluminum",
        json!({"token": served.token()}),
    );
    assert_eq!((status, code(&answer)), (422, "invalid"));
    assert!(!answer["error"]["ids"].as_array().unwrap().is_empty());
    let (status, deleted) = served.write(
        "DELETE",
        "/api/materials/walnut",
        json!({"token": served.token()}),
    );
    assert_eq!(status, 200, "{deleted}");
    assert_eq!(deleted["deleted"]["key"], "walnut");
    assert!(!served
        .library()
        .materials
        .iter()
        .any(|m| m.key.key() == "walnut"));
}

#[test]
fn a_profile_is_checked_as_the_app_checks_one() {
    let served = served();
    let (status, added) = served.write(
        "POST",
        "/api/profiles",
        json!({"token": served.token(), "profile": {"key": "finish", "label": "Finishing", "level": "gentle"}, "dryRun": true}),
    );
    assert_eq!(status, 200, "{added}");
    assert_eq!(added["dryRun"], true);
    assert!(served.library().profile("finish").is_none());
    let (status, answer) = served.write(
        "POST",
        "/api/profiles",
        json!({"token": served.token(), "profile": {"key": "Finish!", "label": "Finishing"}}),
    );
    assert_eq!((status, code(&answer)), (422, "invalid"));
    let (status, _) = served.write(
        "POST",
        "/api/profiles",
        json!({"token": served.token(), "profile": {"key": "finish", "label": "Finishing"}}),
    );
    assert_eq!(status, 200);
    // A profile a row is on stays.
    let token = served.token();
    let (status, _) = served.write(
        "PATCH",
        "/api/tools/starter-04",
        json!({"token": token, "patch": {"cutting": {"hardwood@finish": {"rpm": 10000, "feed": 800, "plunge": 200, "stepover": 1, "stepdown": 0.5}}}}),
    );
    assert_eq!(status, 200);
    let (status, answer) = served.write(
        "DELETE",
        "/api/profiles/finish",
        json!({"token": served.token()}),
    );
    assert_eq!((status, code(&answer)), (422, "invalid"));
    assert_eq!(answer["error"]["ids"], json!(["starter-04"]));
    let (_, one) = served.get("/api/profiles/finish");
    assert_eq!(one["usedBy"][0]["id"], "starter-04");
}

#[test]
fn a_group_entry_goes_without_its_tools() {
    let served = served();
    let library = served.library();
    let group = library.groups[0].path.clone();
    let encoded: String = group.bytes().map(|b| format!("%{b:02X}")).collect();
    // Pinned once only.
    let (status, _) = served.write(
        "POST",
        "/api/groups",
        json!({"token": served.token(), "group": {"path": group}}),
    );
    assert_eq!(status, 400);
    let (_, one) = served.get(&format!("/api/groups/{encoded}"));
    assert!(!one["usedBy"].as_array().unwrap().is_empty());
    let (status, _) = served.write(
        "DELETE",
        &format!("/api/groups/{encoded}"),
        json!({"token": served.token()}),
    );
    assert_eq!(status, 200);
    let library = served.library();
    assert!(library.groups.iter().all(|g| g.path != group));
    assert!(library
        .tools
        .iter()
        .any(|t| t.group.as_deref() == Some(group.as_str())));
    let (status, _) = served.write(
        "POST",
        "/api/groups",
        json!({"token": served.token(), "group": {"path": group}}),
    );
    assert_eq!(status, 200);
    // A write with an old token is refused here as for a tool.
    let (status, answer) = served.write(
        "POST",
        "/api/groups",
        json!({"token": "old", "group": {"path": "x"}}),
    );
    assert_eq!((status, code(&answer)), (409, "conflict"));
}

#[test]
fn a_project_saved_elsewhere_is_not_written_over() {
    let served = served();
    let mut project = inlay_core::project::project_from_file_json(include_str!(
        "../../../inlay-core/tests/fixtures/project-v2.json"
    ))
    .unwrap();
    project.id = "p-1".into();
    let first = inlay_core::project::project_to_file_json(&project);
    let saved = served.send("PUT", "/api/projects/p-1", &[], first.as_bytes());
    let token: Value = serde_json::from_slice(&saved.body).unwrap();
    let token = token["token"].as_str().unwrap().to_string();
    let read = served.send("GET", "/api/projects/p-1", &[], b"");
    let etag = read
        .headers
        .iter()
        .find(|(n, _)| n == "ETag")
        .map(|(_, v)| v.clone())
        .unwrap();
    assert_eq!(etag, format!("\"{token}\""));

    // Saved from a second place, over the version it read.
    project.name = "Second".into();
    let second = inlay_core::project::project_to_file_json(&project);
    let response = served.send("PUT", "/api/projects/p-1", &[("if-match", &etag)], second.as_bytes());
    assert_eq!(response.status, 200);
    // The first place, still on the first version, is refused.
    project.name = "Third".into();
    let third = inlay_core::project::project_to_file_json(&project);
    let response = served.send("PUT", "/api/projects/p-1", &[("if-match", &etag)], third.as_bytes());
    assert_eq!(response.status, 409);
    let answer: Value = serde_json::from_slice(&response.body).unwrap();
    assert_eq!(code(&answer), "conflict");
    assert_eq!(
        served.send("GET", "/api/projects/p-1", &[], b"").body,
        second.as_bytes()
    );
    // Without If-Match, the last write is kept, as before.
    let response = served.send("PUT", "/api/projects/p-1", &[], third.as_bytes());
    assert_eq!(response.status, 200);
}
