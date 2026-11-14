//! The project: an imported design, the inlay jobs made from it, and the
//! tools those jobs use. Also the project file.

use serde::{Deserialize, Serialize};

use crate::file::{self, FileError, Migration};
use crate::geom::{Region, Ring};
use crate::tools::{validate_tools, Material, Tool};

/// Current version of the project file. Raise it, and add a migration,
/// whenever an old file could no longer be read as written.
pub const PROJECT_FORMAT_VERSION: u32 = 1;
pub const PROJECT_KIND: &str = "project";

/// Migrations for project files: entry `i` upgrades version `i + 1`.
const MIGRATIONS: &[Migration] = &[];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub design: Option<Design>,
    #[serde(default)]
    pub jobs: Vec<Job>,
    /// Copies of the tools the jobs refer to, so the project opens correctly
    /// on a machine with a different tool list.
    #[serde(default)]
    pub tools: Vec<Tool>,
}

/// An imported drawing, reduced to filled regions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Design {
    /// File name the design was imported from.
    pub source_name: String,
    /// Size of the drawing's page as imported, mm, before `scale`.
    pub width: f64,
    pub height: f64,
    /// Uniform scale applied to the regions when they are used.
    #[serde(default = "one")]
    pub scale: f64,
    /// Flip the whole design left to right. This corrects a drawing made
    /// mirrored; plugs are mirrored automatically and do not need this.
    #[serde(default)]
    pub mirror: bool,
    pub regions: Vec<DesignRegion>,
}

fn one() -> f64 {
    1.0
}

/// One filled area of the design: the unit the user selects.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignRegion {
    /// Unique within the design.
    pub id: u32,
    /// Fill colour in the drawing as `#rrggbb`, when it was a plain colour.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Outer boundary, counter-clockwise, mm, Y up, origin at the page's
    /// bottom-left corner.
    pub outer: Ring,
    /// Holes, clockwise.
    #[serde(default)]
    pub holes: Vec<Ring>,
}

impl DesignRegion {
    pub fn to_region(&self) -> Region {
        Region::with_holes(self.outer.clone(), self.holes.clone())
    }
}

/// One inlay to make: a pocket and its matching plug or insert.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub name: String,
    /// Chooses which cutting settings of each tool are used.
    pub material: Material,
    /// The design regions this inlay covers.
    pub region_ids: Vec<u32>,
    pub inlay: Inlay,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Inlay {
    #[serde(rename_all = "camelCase")]
    Vcarve {
        /// How deep the plug sits in the pocket, mm.
        engagement_depth: f64,
        /// Space left under the plug for glue, mm.
        glue_gap: f64,
        /// Space between the pocket surface and the plug's backer, mm.
        saw_gap: f64,
        /// Flat end mills that clear the pocket floor, largest first. A list
        /// so that several tools can share the work later.
        #[serde(default)]
        clearing_tool_ids: Vec<String>,
        #[serde(default)]
        vbit_tool_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Flat {
        pocket_depth: f64,
        /// Total gap between insert and pocket wall, split between the two, mm.
        allowance: f64,
        /// Hold the insert to its stock with tabs while it is cut out.
        #[serde(default)]
        tabs: bool,
        #[serde(default)]
        tool_id: Option<String>,
    },
}

impl Inlay {
    pub fn default_vcarve() -> Self {
        Inlay::Vcarve {
            engagement_depth: 3.0,
            glue_gap: 0.3,
            saw_gap: 1.5,
            clearing_tool_ids: Vec::new(),
            vbit_tool_id: None,
        }
    }

    pub fn default_flat() -> Self {
        Inlay::Flat {
            pocket_depth: 3.0,
            allowance: 0.1,
            tabs: false,
            tool_id: None,
        }
    }

    /// Ids of every tool this inlay refers to.
    pub fn tool_ids(&self) -> Vec<&str> {
        match self {
            Inlay::Vcarve {
                clearing_tool_ids,
                vbit_tool_id,
                ..
            } => clearing_tool_ids
                .iter()
                .chain(vbit_tool_id.iter())
                .map(String::as_str)
                .collect(),
            Inlay::Flat { tool_id, .. } => tool_id.iter().map(String::as_str).collect(),
        }
    }

    fn validate(&self) -> Result<(), String> {
        fn check(ok: bool, message: &str) -> Result<(), String> {
            if ok {
                Ok(())
            } else {
                Err(message.into())
            }
        }
        match *self {
            Inlay::Vcarve {
                engagement_depth,
                glue_gap,
                saw_gap,
                ..
            } => {
                check(
                    engagement_depth.is_finite() && engagement_depth > 0.0,
                    "engagement depth must be greater than 0",
                )?;
                check(
                    glue_gap.is_finite() && glue_gap >= 0.0,
                    "glue gap must be 0 or more",
                )?;
                check(
                    saw_gap.is_finite() && saw_gap > 0.0,
                    "saw gap must be greater than 0",
                )
            }
            Inlay::Flat {
                pocket_depth,
                allowance,
                ..
            } => {
                check(
                    pocket_depth.is_finite() && pocket_depth > 0.0,
                    "pocket depth must be greater than 0",
                )?;
                check(
                    allowance.is_finite() && allowance >= 0.0,
                    "allowance must be 0 or more",
                )
            }
        }
    }
}

impl Project {
    /// Checks the project is consistent: valid numbers, unique ids, and no
    /// reference to a region that does not exist.
    pub fn validate(&self) -> Result<(), String> {
        if self.id.is_empty() {
            return Err("the project has no id".into());
        }
        validate_tools(&self.tools)?;

        let region_ids: Vec<u32> = self
            .design
            .iter()
            .flat_map(|d| d.regions.iter().map(|r| r.id))
            .collect();
        if let Some(design) = &self.design {
            if !(design.scale.is_finite() && design.scale > 0.0) {
                return Err("design scale must be greater than 0".into());
            }
            for (i, id) in region_ids.iter().enumerate() {
                if region_ids[..i].contains(id) {
                    return Err(format!("two design regions share the id {id}"));
                }
            }
            for region in &design.regions {
                if region.outer.len() < 3 || region.holes.iter().any(|h| h.len() < 3) {
                    return Err(format!(
                        "design region {} has a boundary with fewer than 3 points",
                        region.id
                    ));
                }
            }
        }

        for (i, job) in self.jobs.iter().enumerate() {
            let fail = |e: String| format!("inlay \"{}\": {e}", job.name);
            if job.id.is_empty() || self.jobs[..i].iter().any(|other| other.id == job.id) {
                return Err(fail("its id is missing or used twice".into()));
            }
            job.inlay.validate().map_err(fail)?;
            if let Some(missing) = job.region_ids.iter().find(|id| !region_ids.contains(id)) {
                return Err(fail(format!(
                    "it refers to region {missing}, which is not in the design"
                )));
            }
        }
        Ok(())
    }
}

#[derive(Serialize, Deserialize)]
struct ProjectBody {
    project: Project,
}

/// Writes a project as a project file.
pub fn project_to_file_json(project: &Project) -> String {
    file::write(
        PROJECT_KIND,
        PROJECT_FORMAT_VERSION,
        &ProjectBody {
            project: project.clone(),
        },
    )
}

/// Reads a project file written by this or any earlier version of the app.
pub fn project_from_file_json(text: &str) -> Result<Project, FileError> {
    let body: ProjectBody = file::read(text, PROJECT_KIND, PROJECT_FORMAT_VERSION, MIGRATIONS)?;
    body.project.validate().map_err(FileError::Invalid)?;
    Ok(body.project)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::fixtures::{end_mill, v_bit};

    fn sample() -> Project {
        Project {
            id: "p1".into(),
            name: "Coaster".into(),
            design: Some(Design {
                source_name: "coaster.svg".into(),
                width: 100.0,
                height: 100.0,
                scale: 1.0,
                mirror: false,
                regions: vec![
                    DesignRegion {
                        id: 0,
                        color: Some("#000000".into()),
                        outer: vec![[10.0, 10.0], [40.0, 10.0], [40.0, 40.0], [10.0, 40.0]],
                        holes: vec![vec![[20.0, 20.0], [20.0, 30.0], [30.0, 30.0], [30.0, 20.0]]],
                    },
                    DesignRegion {
                        id: 1,
                        color: None,
                        outer: vec![[60.0, 60.0], [90.0, 60.0], [75.0, 90.0]],
                        holes: vec![],
                    },
                ],
            }),
            jobs: vec![
                Job {
                    id: "j1".into(),
                    name: "Walnut square".into(),
                    material: Material::Hardwood,
                    region_ids: vec![0],
                    inlay: Inlay::Vcarve {
                        engagement_depth: 3.0,
                        glue_gap: 0.3,
                        saw_gap: 1.5,
                        clearing_tool_ids: vec!["t-endmill".into()],
                        vbit_tool_id: Some("t-vbit".into()),
                    },
                },
                Job {
                    id: "j2".into(),
                    name: "Maple triangle".into(),
                    material: Material::Softwood,
                    region_ids: vec![1],
                    inlay: Inlay::Flat {
                        pocket_depth: 2.5,
                        allowance: 0.1,
                        tabs: true,
                        tool_id: Some("t-endmill".into()),
                    },
                },
            ],
            tools: vec![end_mill(), v_bit()],
        }
    }

    #[test]
    fn project_round_trips() {
        let project = sample();
        let text = project_to_file_json(&project);
        assert_eq!(project_from_file_json(&text).unwrap(), project);
    }

    #[test]
    fn empty_project_round_trips() {
        let project = Project {
            id: "p".into(),
            name: "New".into(),
            design: None,
            jobs: vec![],
            tools: vec![],
        };
        assert_eq!(
            project_from_file_json(&project_to_file_json(&project)).unwrap(),
            project
        );
    }

    #[test]
    fn a_job_pointing_at_a_missing_region_is_rejected() {
        let mut project = sample();
        project.jobs[0].region_ids.push(99);
        assert!(project.validate().is_err());
        assert!(matches!(
            project_from_file_json(&project_to_file_json(&project)),
            Err(FileError::Invalid(_))
        ));
    }

    #[test]
    fn negative_depths_are_rejected() {
        let mut project = sample();
        project.jobs[1].inlay = Inlay::Flat {
            pocket_depth: -1.0,
            allowance: 0.1,
            tabs: false,
            tool_id: None,
        };
        assert!(project.validate().is_err());
    }

    #[test]
    fn inlay_lists_its_tools() {
        let project = sample();
        assert_eq!(
            project.jobs[0].inlay.tool_ids(),
            vec!["t-endmill", "t-vbit"]
        );
        assert_eq!(project.jobs[1].inlay.tool_ids(), vec!["t-endmill"]);
    }

    /// Files from every released format version must keep loading.
    #[test]
    fn version_1_fixture_loads() {
        let project =
            project_from_file_json(include_str!("../tests/fixtures/project-v1.json")).unwrap();
        assert_eq!(project.name, "Coaster");
        assert_eq!(project.jobs.len(), 2);
        assert_eq!(project.design.as_ref().unwrap().regions.len(), 2);
        assert!(matches!(
            project.jobs[1].inlay,
            Inlay::Flat { tabs: true, .. }
        ));
    }

    /// Regenerates the fixtures from the samples above. Run by hand, once per
    /// format version, never to "fix" a failing fixture test:
    /// `cargo test -p inlay-core write_fixtures -- --ignored`
    #[test]
    #[ignore]
    fn write_fixtures() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(
            format!("{dir}/project-v{PROJECT_FORMAT_VERSION}.json"),
            project_to_file_json(&sample()),
        )
        .unwrap();
        std::fs::write(
            format!(
                "{dir}/tool-library-v{}.json",
                crate::tools::TOOL_LIBRARY_FORMAT_VERSION
            ),
            crate::tools::tools_to_file_json(&[end_mill(), v_bit()]),
        )
        .unwrap();
    }
}
