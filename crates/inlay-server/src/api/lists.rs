//! Materials, profiles and groups, one at a time: the three lists of the
//! tool file besides the tools. Each is read, added to, changed and deleted
//! from like a tool, through the same write (`Api::write`), so the token,
//! dry run, diff and backup work as they do for a tool.

use super::*;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum List {
    Materials,
    Profiles,
    Groups,
}

impl List {
    pub(super) const ALL: [List; 3] = [List::Materials, List::Profiles, List::Groups];

    /// The list a path segment names.
    pub(super) fn named(segment: &str) -> Option<List> {
        List::ALL.into_iter().find(|list| list.path() == segment)
    }

    pub(super) fn path(self) -> &'static str {
        match self {
            List::Materials => "materials",
            List::Profiles => "profiles",
            List::Groups => "groups",
        }
    }

    /// One of the list, as a body names it.
    fn one(self) -> &'static str {
        match self {
            List::Materials => "material",
            List::Profiles => "profile",
            List::Groups => "group",
        }
    }

    /// The field that names one, and that never changes.
    fn key_field(self) -> &'static str {
        match self {
            List::Groups => "path",
            _ => "key",
        }
    }

    /// The list as the file holds it.
    fn values(self, library: &ToolLibrary) -> Vec<Value> {
        let all = match self {
            List::Materials => serde_json::to_value(&library.materials),
            List::Profiles => serde_json::to_value(&library.profiles),
            List::Groups => serde_json::to_value(&library.groups),
        };
        match all.expect("the lists serialize") {
            Value::Array(values) => values,
            _ => unreachable!("a list serializes as an array"),
        }
    }

    /// Puts the list back, refusing a key the model does not have.
    fn set(self, library: &mut ToolLibrary, values: Vec<Value>) -> Result<(), Refusal> {
        let values = Value::Array(values);
        match self {
            List::Materials => library.materials = strict(values, self.one())?,
            List::Profiles => library.profiles = strict(values, self.one())?,
            List::Groups => library.groups = strict(values, self.one())?,
        }
        Ok(())
    }

    /// What the tool file's own check lets through, but an item added or
    /// changed here should not be: a material that takes its feeds from
    /// itself or from one the feeds model does not know, and a group path
    /// with a part that is empty, has spaces around it, holds a control
    /// character or is "." or "..".
    fn check(self, value: &Value) -> Result<(), Refusal> {
        let key = self.key_of(value);
        match self {
            List::Materials => {
                if let Some(feeds_as) = value.get("feedsAs").and_then(Value::as_str) {
                    if feeds_as == key {
                        return Err(Refusal::invalid(format!(
                            "the material \"{key}\" cannot take its feeds from itself"
                        )));
                    }
                    if !inlay_core::feeds::covers(feeds_as) {
                        return Err(Refusal::invalid(format!(
                            "feedsAs \"{feeds_as}\" is not a material the feeds model knows"
                        )));
                    }
                }
            }
            List::Groups => {
                let bad = key.split('/').any(|part| {
                    part.trim().is_empty()
                        || part != part.trim()
                        || part == "."
                        || part == ".."
                        || part.chars().any(char::is_control)
                });
                if bad {
                    return Err(Refusal::invalid(format!(
                        "the group path \"{}\" has a part that is empty, has spaces around it, holds a control character or is \".\" or \"..\"",
                        key.escape_debug()
                    )));
                }
            }
            List::Profiles => {}
        }
        Ok(())
    }

    fn key_of(self, value: &Value) -> String {
        value
            .get(self.key_field())
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    }

    /// The tools that name it: by a cutting row, a material it is for or a
    /// wear entry, a row's profile, or the group it is in.
    fn used_by<'a>(self, library: &'a ToolLibrary, key: &str) -> Vec<&'a Tool> {
        library
            .tools
            .iter()
            .filter(|tool| match self {
                List::Materials => {
                    let wear = tool.inventory.iter().flat_map(|i| &i.log);
                    tool.cutting.iter().any(|c| c.material.key() == key)
                        || tool.recommended_for.iter().any(|m| m.key() == key)
                        || wear
                            .filter_map(|entry| entry.material.as_ref())
                            .any(|m| m.key() == key)
                }
                List::Profiles => tool
                    .cutting
                    .iter()
                    .any(|c| c.profile.as_deref() == Some(key)),
                List::Groups => tool.group.as_deref() == Some(key),
            })
            .collect()
    }

    /// Where the one a path names is in the list.
    fn find(self, values: &[Value], key: &str) -> Result<usize, Refusal> {
        values
            .iter()
            .position(|value| self.key_of(value) == key)
            .ok_or_else(|| {
                let builtin = self == List::Materials && Material::new(key).is_built_in();
                Refusal::not_found(if builtin {
                    format!("\"{key}\" is built in, and has no entry until one is added with POST /api/materials.")
                } else {
                    format!(
                        "There is no {} \"{key}\". GET /api/{} lists them.",
                        self.one(),
                        self.path()
                    )
                })
            })
    }

    /// One of the list as a read answers it: as the file holds it, and the
    /// tools that name it.
    fn view(self, library: &ToolLibrary, value: &Value) -> Map<String, Value> {
        let used: Vec<Value> = self
            .used_by(library, &self.key_of(value))
            .into_iter()
            .map(|tool| {
                json!({
                    "id": tool.id,
                    "name": tool.name,
                    "displayName": display_name(&tool.name, tool.coating.as_deref()),
                })
            })
            .collect();
        let mut out = Map::new();
        out.insert(self.one().into(), value.clone());
        out.insert("usedBy".into(), used.into());
        out
    }
}

impl Api {
    pub(super) fn list(&self, list: List) -> Answer {
        let (loaded, library) = self.current()?;
        let values = list.values(&library);
        let used: Map<String, Value> = values
            .iter()
            .map(|value| {
                let key = list.key_of(value);
                let count = list.used_by(&library, &key).len();
                (key, count.into())
            })
            .collect();
        let mut body = Map::new();
        body.insert("token".into(), loaded.token.into());
        body.insert("savedAt".into(), loaded.saved_at.into());
        body.insert(list.path().into(), values.into());
        body.insert("usedBy".into(), used.into());
        Ok(Response::json(200, &Value::Object(body)))
    }

    pub(super) fn list_item(&self, list: List, key: &str) -> Answer {
        let (loaded, library) = self.current()?;
        let values = list.values(&library);
        let at = list.find(&values, key)?;
        let mut body = list.view(&library, &values[at]);
        body.insert("token".into(), loaded.token.into());
        body.insert("savedAt".into(), loaded.saved_at.into());
        Ok(Response::json(200, &Value::Object(body)))
    }

    /// Adds one at the end of its list.
    pub(super) fn add_list_item(&self, request: &Request, list: List) -> Answer {
        let mut body = body_object(request, &["token", list.one(), "dryRun", "diff"])?;
        let options = Options::of(request, &body)?;
        let Some(item @ Value::Object(_)) = body.remove(list.one()) else {
            return Err(Refusal::bad(format!(
                "{} is required, and must be an object",
                list.one()
            )));
        };
        let key = list.key_of(&item);
        if key.is_empty() {
            return Err(Refusal::bad(format!(
                "{}.{} is required",
                list.one(),
                list.key_field()
            )));
        }
        self.write(&options, |library| {
            let mut values = list.values(library);
            if values.iter().any(|value| list.key_of(value) == key) {
                return Err(Refusal::bad(format!(
                    "there is a {} \"{key}\" already: PATCH /api/{}/<key> changes it",
                    list.one(),
                    list.path()
                )));
            }
            list.check(&item)?;
            values.push(item);
            list.set(library, values)?;
            let values = list.values(library);
            Ok(list.view(library, values.last().expect("one was added")))
        })
    }

    /// A merge patch of one, as for a tool. Its key never changes.
    pub(super) fn patch_list_item(&self, request: &Request, list: List, key: &str) -> Answer {
        let mut body = body_object(request, &["token", "patch", "dryRun", "diff"])?;
        let options = Options::of(request, &body)?;
        let patch = match body.remove("patch") {
            Some(patch @ Value::Object(_)) => patch,
            _ => return Err(Refusal::bad("patch is required, and must be an object")),
        };
        if patch
            .get(list.key_field())
            .is_some_and(|k| k.as_str() != Some(key))
        {
            return Err(Refusal::bad(format!(
                "a {}'s {} cannot be changed",
                list.one(),
                list.key_field()
            )));
        }
        self.write(&options, |library| {
            let mut values = list.values(library);
            let at = list.find(&values, key)?;
            merge(&mut values[at], &patch);
            list.check(&values[at])?;
            list.set(library, values)?;
            let values = list.values(library);
            Ok(list.view(library, &values[at]))
        })
    }

    /// Deletes one. A material or profile that a tool names is not deleted:
    /// the tool's rows would be left naming nothing. Hardwood and softwood
    /// are known without an entry, and a group entry only pins the group's
    /// ids, so the tools that name those keep them.
    pub(super) fn delete_list_item(&self, request: &Request, list: List, key: &str) -> Answer {
        let body = body_object(request, &["token", "dryRun", "diff"])?;
        let options = Options::of(request, &body)?;
        self.write(&options, |library| {
            let mut values = list.values(library);
            let at = list.find(&values, key)?;
            let used = list.used_by(library, key);
            // A built-in material is known without its entry.
            let needed = match list {
                List::Groups => false,
                List::Materials => !Material::new(key).is_built_in(),
                List::Profiles => true,
            };
            if needed && !used.is_empty() {
                let names: Vec<String> = used
                    .iter()
                    .take(5)
                    .map(|tool| format!("\"{}\"", tool.name))
                    .collect();
                let more = if used.len() > 5 {
                    format!(" and {} more", used.len() - 5)
                } else {
                    String::new()
                };
                let mut refusal = Refusal::invalid(format!(
                    "The {} \"{key}\" is in use by {}{more}. Take it off those tools first.",
                    list.one(),
                    names.join(", ")
                ));
                let ids: Vec<&str> = used.iter().map(|tool| tool.id.as_str()).collect();
                refusal.extra.insert("ids".into(), json!(ids));
                return Err(refusal);
            }
            let removed = values.remove(at);
            list.set(library, values)?;
            let mut out = Map::new();
            out.insert("deleted".into(), removed);
            Ok(out)
        })
    }
}
