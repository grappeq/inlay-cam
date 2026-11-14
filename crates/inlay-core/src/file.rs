//! The envelope shared by every file the app writes, and version migration.
//!
//! A file is a JSON object:
//!
//! ```json
//! { "app": "wooden-inlays", "kind": "project", "formatVersion": 1, ...body }
//! ```
//!
//! Backward compatibility rule: a file written by any released version must
//! load in every later version. Additive changes (a new field with a default)
//! keep the version. Anything else raises the version and adds a migration
//! that rewrites the old JSON into the new shape.

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{Map, Value};

pub const APP: &str = "wooden-inlays";

/// Upgrades a whole file (envelope included) by exactly one format version.
pub type Migration = fn(Value) -> Result<Value, String>;

#[derive(Debug, Clone, PartialEq)]
pub enum FileError {
    NotJson(String),
    /// Valid JSON, but not a file written by this app.
    NotOurs,
    WrongKind {
        expected: String,
        found: String,
    },
    /// Written by a newer version of the app than this one.
    NewerVersion {
        found: u32,
        supported: u32,
    },
    Invalid(String),
}

impl std::fmt::Display for FileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FileError::NotJson(e) => write!(f, "The file is not valid JSON: {e}"),
            FileError::NotOurs => write!(f, "This is not a Wooden Inlays file."),
            FileError::WrongKind { expected, found } => {
                write!(f, "This is a {found} file, but a {expected} file is needed here.")
            }
            FileError::NewerVersion { found, supported } => write!(
                f,
                "This file was written by a newer version of the app (format {found}; this version reads up to {supported})."
            ),
            FileError::Invalid(e) => write!(f, "The file is damaged or incomplete: {e}"),
        }
    }
}

impl std::error::Error for FileError {}

/// Wraps `body` in the envelope. `body` must serialize to a JSON object.
pub fn write<T: Serialize>(kind: &str, version: u32, body: &T) -> String {
    let mut out = Map::new();
    out.insert("app".into(), APP.into());
    out.insert("kind".into(), kind.into());
    out.insert("formatVersion".into(), version.into());
    match serde_json::to_value(body).expect("file bodies always serialize") {
        Value::Object(fields) => out.extend(fields),
        _ => panic!("a file body must be a JSON object"),
    }
    serde_json::to_string_pretty(&Value::Object(out)).expect("JSON values always serialize")
}

/// Reads a file of `kind`, migrating it up to `current` first.
///
/// `migrations[i]` upgrades format version `i + 1` to `i + 2`, so there must
/// be exactly `current - 1` of them.
pub fn read<T: DeserializeOwned>(
    text: &str,
    kind: &str,
    current: u32,
    migrations: &[Migration],
) -> Result<T, FileError> {
    assert_eq!(
        migrations.len() as u32,
        current - 1,
        "one migration per format version step"
    );
    let mut value: Value =
        serde_json::from_str(text).map_err(|e| FileError::NotJson(e.to_string()))?;

    if value.get("app").and_then(Value::as_str) != Some(APP) {
        return Err(FileError::NotOurs);
    }
    let found_kind = value
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    if found_kind != kind {
        return Err(FileError::WrongKind {
            expected: kind.into(),
            found: found_kind.into(),
        });
    }
    let version = value
        .get("formatVersion")
        .and_then(Value::as_u64)
        .filter(|v| *v >= 1)
        .ok_or_else(|| FileError::Invalid("formatVersion is missing".into()))?
        as u32;
    if version > current {
        return Err(FileError::NewerVersion {
            found: version,
            supported: current,
        });
    }

    for step in version..current {
        value = migrations[(step - 1) as usize](value)
            .map_err(|e| FileError::Invalid(format!("upgrading from format {step}: {e}")))?;
    }
    serde_json::from_value(value).map_err(|e| FileError::Invalid(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    struct Body {
        label: String,
        #[serde(default)]
        count: u32,
    }

    fn sample() -> String {
        write(
            "thing",
            1,
            &Body {
                label: "a".into(),
                count: 2,
            },
        )
    }

    #[test]
    fn round_trip() {
        let body: Body = read(&sample(), "thing", 1, &[]).unwrap();
        assert_eq!(
            body,
            Body {
                label: "a".into(),
                count: 2
            }
        );
    }

    #[test]
    fn rejects_other_files() {
        assert!(matches!(
            read::<Body>("nope", "thing", 1, &[]),
            Err(FileError::NotJson(_))
        ));
        assert_eq!(
            read::<Body>("{\"a\":1}", "thing", 1, &[]),
            Err(FileError::NotOurs)
        );
        assert!(matches!(
            read::<Body>(&sample(), "other", 1, &[]),
            Err(FileError::WrongKind { .. })
        ));
    }

    #[test]
    fn rejects_files_from_a_newer_app() {
        let newer = sample().replace("\"formatVersion\": 1", "\"formatVersion\": 7");
        assert_eq!(
            read::<Body>(&newer, "thing", 1, &[]),
            Err(FileError::NewerVersion {
                found: 7,
                supported: 1
            })
        );
    }

    #[test]
    fn old_files_are_migrated_step_by_step() {
        // Version 1 called the field "name"; version 2 renamed it to "label";
        // version 3 doubled the count.
        fn v1_to_v2(mut v: Value) -> Result<Value, String> {
            let obj = v.as_object_mut().ok_or("not an object")?;
            let name = obj.remove("name").ok_or("name is missing")?;
            obj.insert("label".into(), name);
            Ok(v)
        }
        fn v2_to_v3(mut v: Value) -> Result<Value, String> {
            let count = v["count"].as_u64().unwrap_or(0);
            v["count"] = (count * 2).into();
            Ok(v)
        }
        let migrations: &[Migration] = &[v1_to_v2, v2_to_v3];

        let v1 =
            r#"{"app":"wooden-inlays","kind":"thing","formatVersion":1,"name":"old","count":2}"#;
        assert_eq!(
            read::<Body>(v1, "thing", 3, migrations).unwrap(),
            Body {
                label: "old".into(),
                count: 4
            }
        );

        let v2 =
            r#"{"app":"wooden-inlays","kind":"thing","formatVersion":2,"label":"mid","count":2}"#;
        assert_eq!(
            read::<Body>(v2, "thing", 3, migrations).unwrap(),
            Body {
                label: "mid".into(),
                count: 4
            }
        );

        let v3 =
            r#"{"app":"wooden-inlays","kind":"thing","formatVersion":3,"label":"new","count":2}"#;
        assert_eq!(
            read::<Body>(v3, "thing", 3, migrations).unwrap(),
            Body {
                label: "new".into(),
                count: 2
            }
        );
    }

    #[test]
    fn a_failed_migration_is_reported() {
        fn broken(_: Value) -> Result<Value, String> {
            Err("cannot".into())
        }
        assert!(matches!(
            read::<Body>(&sample(), "thing", 2, &[broken]),
            Err(FileError::Invalid(_))
        ));
    }
}
