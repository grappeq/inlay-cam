//! Starting feeds and speeds for a tool and material, sized for the Carvera
//! Air.
//!
//! The default stop is a slot-safe rule set reviewed by a machinist
//! (2026-10-20) for a Carvera Air cutting dry: no air assist or coolant, any
//! cut may be a full slot (the whole diameter engaged, no chip thinning) and
//! the plunge may be a straight drop into the material. Dry, the bigger risk
//! is a chip too thin (rubbing, built-up edge, melted plastic, burnt wood),
//! not too much force, so chip loads have floors, and the power estimate
//! (removal rate times specific cutting energy, for a full-width slot) is
//! held to a cap that falls with spindle speed.
//!
//! Four more stops move only what trades safety for removal rate: the power
//! cap, the feed cap, the depth per pass and the target chip load. Everything
//! else is the same at every stop. A ramped entry frees the plunge from the
//! drill-feed cap; the adaptive strategy reshapes an end mill's cut for
//! adaptive clearing, which this app has no toolpath for but other programs
//! have.
//!
//! These are rough starting points, never applied without the user accepting
//! them. Not modelled: coatings, helix angle, HSS cutters, workholding,
//! coolant. Titanium is a provisional class with no test cut behind it.
//!
//! This is the feeds model of `cnc-tooling-library`, kept number for number:
//! `tests/fixtures/feeds-reference.json` holds that model's answers for a
//! spread of tools, and the tests require the same ones here.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::tools::{Level, Profile, Tool, ToolKind};

pub const SPINDLE_W: f64 = 200.0;
/// The Carvera Air's range.
const RPM_MIN: i64 = 5000;
const RPM_MAX: i64 = 12000;
/// The reviewed metals' floor: below it the spindle has too little power.
const METAL_RPM_MIN: i64 = 8000;
/// A class with a hard speed limit may run over it by this much.
const SPEED_TOLERANCE: f64 = 1.05;
/// A shoulder past this many diameters cuts shallower.
const REACH_LD: f64 = 3.0;
/// The reach factor below which a tool is too slender for metal.
const SLENDER_FACTOR: f64 = 0.6;
const DIAMETER_RANGE: (f64, f64) = (0.1, 25.0);
const FLUTES_RANGE: (f64, f64) = (1.0, 8.0);
/// A V-bit this sharp engraves rather than chamfers.
const ENGRAVER_MAX_ANGLE: f64 = 45.0;
/// A 1-flute cutter in this range of diameters takes its class's own chip.
const ONE_FLUTE_D: (f64, f64) = (3.0, 4.0);
/// A thread under this major diameter is untested.
const SMALL_THREAD_D: f64 = 2.0;
/// Flute and shoulder lengths beyond this are not a real cutter.
const LENGTH_MAX: f64 = 500.0;
/// Chamfer and V-groove bits in wood and plastic: full-profile engagement.
const V_DEPTH_SHARE: f64 = 0.5;
/// A V-bit with a flat tip this wide is a corner rounder.
const CORNER_ROUNDER_TIP: f64 = 1.0;
const CORNER_ROUNDER_FEED_MAX: f64 = 1200.0;
const CORNER_ROUNDER_METAL_FEED_MAX: f64 = 450.0;
/// Brazed V-groove heads on a 6 mm shank.
const BIG_V_DIAMETER: f64 = 10.0;
const BIG_V_FEED_MAX: f64 = 1500.0;
/// A straight plunge: at most this share of a drill's feed per revolution.
const PLUNGE_SHARE: f64 = 0.5;
/// Slower than this per revolution and a small tool rubs on the way down.
const PLUNGE_MIN_PER_REV: f64 = 0.004;
/// Under this a drill's feed per revolution and peck shrink with it.
const SMALL_DRILL_D: f64 = 1.0;
/// Of the class surface speed: thread milling is a light cut.
const THREAD_SPEED_SHARE: f64 = 0.8;
const METALS: [&str; 4] = ["aluminum", "brass", "copper", "titanium"];

const ADAPTIVE_STEPOVER_PCT: f64 = 12.0;
const ADAPTIVE_DEPTH_D: f64 = 2.0;
const ADAPTIVE_DEPTH_FLUTE: f64 = 0.8;
const ADAPTIVE_THINNING_MAX: f64 = 2.0;
// Dry aluminium on the Carvera Air is limited by heat, not by the power cap.
const ALU_ADAPTIVE_DEPTH_D: f64 = 0.5;
const ALU_ADAPTIVE_DEPTH_MAX: f64 = 3.0;
const ALU_ADAPTIVE_CHIP_MIN: f64 = 0.02;
const ALU_ADAPTIVE_CHIP_D: f64 = 6.0;
const ALU_ADAPTIVE_POWER_W: f64 = 30.0;

/// What a material is to the model.
struct MaterialClass {
    name: &'static str,
    label: &'static str,
    /// Target, m/min.
    surface_speed: f64,
    /// Target chip load per mm of cutting diameter.
    chip_per_mm: f64,
    /// mm/tooth.
    chip_max: f64,
    /// Chip load floor: under 2 mm, from `.2` mm up, linear between.
    chip_floor: (f64, f64, f64),
    /// Depth per pass for a full slot, as a share of the cutting diameter.
    depth_per_d: f64,
    stepover_pct: f64,
    /// Plunge as a share of the feed.
    plunge_ratio: f64,
    /// Specific cutting energy, J/mm³.
    energy: f64,
    engrave_chip: f64,
    engrave_depth: f64,
    drill_feed_per_rev: f64,
    drill_peck: f64,
    thread_chip_min: f64,
    /// Chamfers in metal cut this fixed depth per pass.
    chamfer_depth: Option<f64>,
    rpm_min: i64,
    surface_speed_lubricated: Option<f64>,
    /// The surface speed is a hard limit.
    speed_limit: bool,
    /// A class that is itself untested: every result carries this.
    caution: Option<&'static str>,
    // Field-calibrated rules, from a first job in aluminium.
    drill_peck_per_d: Option<f64>,
    one_flute_chip: Option<(f64, f64)>,
    chamfer_chip: Option<f64>,
    adaptive_depth_d_lubricated: Option<f64>,
}

#[allow(clippy::too_many_arguments)]
const fn class(
    name: &'static str,
    label: &'static str,
    surface_speed: f64,
    chip_per_mm: f64,
    chip_max: f64,
    chip_floor: (f64, f64, f64),
    depth_per_d: f64,
    stepover_pct: f64,
    plunge_ratio: f64,
    energy: f64,
    engrave: (f64, f64),
    drill: (f64, f64),
    thread_chip_min: f64,
    chamfer_depth: Option<f64>,
) -> MaterialClass {
    MaterialClass {
        name,
        label,
        surface_speed,
        chip_per_mm,
        chip_max,
        chip_floor,
        depth_per_d,
        stepover_pct,
        plunge_ratio,
        energy,
        engrave_chip: engrave.0,
        engrave_depth: engrave.1,
        drill_feed_per_rev: drill.0,
        drill_peck: drill.1,
        thread_chip_min,
        chamfer_depth,
        rpm_min: METAL_RPM_MIN,
        surface_speed_lubricated: None,
        speed_limit: false,
        caution: None,
        drill_peck_per_d: None,
        one_flute_chip: None,
        chamfer_chip: None,
        adaptive_depth_d_lubricated: None,
    }
}

const TITANIUM_CAUTION: &str = "Untested: titanium (Grade 5) is a provisional model with no test cut behind it. Carbide, light cuts; stop at the first sign of a blued chip or a welded edge.";

#[rustfmt::skip]
const CLASSES: [MaterialClass; 9] = [
    class("softwood", "Softwood", 400.0, 0.015, 0.12, (0.01, 0.02, 2.0), 0.33, 40.0, 0.30, 0.06, (0.04, 0.3), (0.03, 1.0), 0.008, None),
    class("hardwood", "Hardwood", 300.0, 0.012, 0.10, (0.01, 0.02, 2.0), 0.30, 40.0, 0.30, 0.10, (0.04, 0.3), (0.03, 1.0), 0.008, None),
    class("plastic", "Plastic", 250.0, 0.012, 0.10, (0.01, 0.02, 2.0), 0.25, 40.0, 0.30, 0.20, (0.03, 0.3), (0.03, 1.0), 0.008, None),
    class("laminate", "Laminate", 200.0, 0.008, 0.05, (0.005, 0.005, 2.0), 0.15, 40.0, 0.30, 0.40, (0.02, 0.1), (0.02, 1.0), 0.008, None),
    class("stone", "Stone", 150.0, 0.006, 0.04, (0.004, 0.004, 2.0), 0.10, 30.0, 0.25, 0.50, (0.015, 0.1), (0.015, 0.5), 0.008, None),
    // Aluminium's field rules come from a first faceplate in 6082, all
    // lubricated by hand: a Ø1.15 drill at 0.2 mm pecks (0.29 dry snapped
    // it); a Ø3.175 1F slotting 8.5 deep at 500 mm/min, 0.2 a pass; a 90°
    // Ø3.175 2F chamfer at 600 mm/min in passes of about 0.14 mm; adaptive
    // 1 mm deep on a Ø1 and 3 mm on a Ø3.175.
    MaterialClass {
        drill_peck_per_d: Some(0.18),
        one_flute_chip: Some((2.0, 0.045)),
        chamfer_chip: Some(0.02),
        adaptive_depth_d_lubricated: Some(1.0),
        ..class("aluminum", "Aluminum", 300.0, 0.0035, 0.03, (0.005, 0.012, 3.0), 0.05, 30.0, 0.25, 1.0, (0.016, 0.05), (0.01, 1.0), 0.007, Some(0.15))
    },
    // Brass and copper run fast enough that tools up to 6 mm stay at 12 000 rpm.
    class("brass", "Brass", 300.0, 0.004, 0.02, (0.004, 0.01, 3.0), 0.04, 25.0, 0.25, 1.8, (0.016, 0.05), (0.01, 1.0), 0.005, Some(0.2)),
    class("copper", "Copper", 220.0, 0.003, 0.015, (0.004, 0.01, 3.0), 0.03, 25.0, 0.20, 2.8, (0.012, 0.03), (0.01, 1.0), 0.004, Some(0.2)),
    // Grade 5, carbide, provisional: the speed is a hard limit because
    // titanium keeps the heat in the edge; light lubrication buys 60 m/min
    // instead of 40.
    MaterialClass {
        rpm_min: RPM_MIN,
        surface_speed_lubricated: Some(60.0),
        speed_limit: true,
        caution: Some(TITANIUM_CAUTION),
        ..class("titanium", "Titanium", 40.0, 0.004, 0.03, (0.004, 0.010, 3.0), 0.03, 20.0, 0.15, 3.5, (0.010, 0.02), (0.008, 0.5), 0.005, Some(0.2))
    },
];

/// The class a material key belongs to. A material missing here gets no
/// suggestion.
fn class_of(material: &str) -> Option<&'static MaterialClass> {
    let name = match material {
        "softwood" => "softwood",
        "hardwood" | "epoxy_tooling" => "hardwood",
        "plastic" => "plastic",
        "pcb" | "bakelite" | "carbon_fiber" => "laminate",
        "synthetic_stone" => "stone",
        "aluminum" => "aluminum",
        "brass" => "brass",
        "copper" => "copper",
        "titanium" => "titanium",
        _ => return None,
    };
    CLASSES.iter().find(|c| c.name == name)
}

fn is_metal(cls: &MaterialClass) -> bool {
    METALS.contains(&cls.name)
}

/// An aggressiveness stop: the four knobs that trade safety for removal rate.
struct Stop {
    label: &'static str,
    /// Cap at the top spindle speed, proportionally less below it.
    power_w: f64,
    feed_max: f64,
    /// On the class's depth per pass.
    depth_factor: f64,
    /// On the target chip load.
    chip_factor: f64,
    untested: bool,
}

fn stop(level: Level) -> Stop {
    let (label, power_w, feed_max, depth_factor, chip_factor, untested) = match level {
        Level::Gentle => ("Gentle", 60.0, 1500.0, 0.85, 0.75, true),
        Level::SlotSafe => ("Slot-safe", 80.0, 2000.0, 1.0, 1.0, false),
        Level::Standard => ("Standard", 100.0, 2500.0, 1.5, 1.5, false),
        Level::Firm => ("Firm", 110.0, 2750.0, 1.75, 1.75, true),
        Level::Aggressive => ("Aggressive", 120.0, 3000.0, 2.0, 2.0, true),
    };
    Stop {
        label,
        power_w,
        feed_max,
        depth_factor,
        chip_factor,
        untested,
    }
}

/// The kinds of cutter the model tells apart. A corner-rounding bit is a
/// V-bit with a wide flat tip to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Cutter {
    FlatEnd,
    BallEnd,
    VBit,
    Drill,
    ThreadMill,
}

/// A tool's shape as the model reads it. 0 means unknown or not set, as in
/// the tooling library.
#[derive(Debug, Clone, PartialEq)]
pub struct Geometry {
    pub diameter: f64,
    pub tip_diameter: f64,
    pub tip_angle: f64,
    pub flutes: f64,
    pub flute_length: f64,
    pub shoulder_length: f64,
    pub thread_diameter: f64,
    pub pitch: f64,
}

/// What a tool of the app's list is to the model.
pub fn cutter_of(tool: &Tool) -> (Cutter, Geometry) {
    let (cutter, tip, angle) = match tool.kind {
        ToolKind::FlatEnd => (Cutter::FlatEnd, tool.tip_diameter, tool.tip_angle),
        ToolKind::BallEnd => (Cutter::BallEnd, tool.tip_diameter, tool.tip_angle),
        ToolKind::Drill => (Cutter::Drill, tool.tip_diameter, tool.tip_angle),
        ToolKind::ThreadMill => (Cutter::ThreadMill, tool.tip_diameter, tool.tip_angle),
        // A V-bit without a tip is a perfect point.
        ToolKind::VBit => (
            Cutter::VBit,
            Some(tool.tip_diameter.unwrap_or(0.0)),
            tool.tip_angle,
        ),
        // The quarter circle of a corner-rounding bit rises as a 90° cone
        // of its height would, which is what the tooling library stores.
        ToolKind::CornerRound => (
            Cutter::VBit,
            Some(tool.tip_diameter.unwrap_or(0.0)),
            Some(tool.tip_angle.unwrap_or(90.0)),
        ),
    };
    let flute_length = tool.flute_length.unwrap_or(0.0);
    let geometry = Geometry {
        diameter: tool.diameter,
        tip_diameter: tip.unwrap_or(tool.diameter),
        tip_angle: angle.unwrap_or(0.0),
        flutes: tool.flutes.map_or(0.0, f64::from),
        flute_length,
        shoulder_length: tool.shoulder_length.unwrap_or(flute_length),
        thread_diameter: tool.thread_diameter.unwrap_or(0.0),
        pitch: tool.pitch.unwrap_or(0.0),
    };
    (cutter, geometry)
}

/// Which suggestion is asked for.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub level: Level,
    /// The tool goes down along a ramp, not straight.
    pub ramping: bool,
    /// For adaptive clearing.
    pub adaptive: bool,
    /// The cut gets light lubrication.
    pub lubricated: bool,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            level: Level::SlotSafe,
            ramping: false,
            adaptive: false,
            lubricated: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Ok,
    /// There are values, and a reason to distrust them.
    Caution,
    /// No values; the reason says why.
    None,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Values {
    pub rpm: i64,
    pub feed: i64,
    pub plunge: i64,
    pub stepover_pct: f64,
    pub stepover_mm: f64,
    pub stepdown: f64,
}

/// Which of the values a suggestion stands behind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Field {
    Rpm,
    Feed,
    Plunge,
    Stepover,
    Stepdown,
}

const FIELDS: [Field; 5] = [
    Field::Rpm,
    Field::Feed,
    Field::Plunge,
    Field::Stepover,
    Field::Stepdown,
];
const DRILL_FIELDS: [Field; 2] = [Field::Rpm, Field::Plunge];

/// What a row of values comes to at the cutting edge.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Readouts {
    /// mm per tooth.
    pub chip_load: f64,
    /// m/min.
    pub surface_speed: f64,
    /// W, for a full-width slot.
    pub power_w: f64,
    pub class_label: &'static str,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub status: Status,
    /// Why there is no suggestion, or why to distrust this one.
    pub reason: Option<String>,
    pub values: Option<Values>,
    pub fields: Vec<Field>,
    pub class_label: Option<&'static str>,
    pub chip_load: Option<f64>,
    pub surface_speed: Option<f64>,
    pub power_w: Option<f64>,
    pub power_limit_w: Option<f64>,
    pub spindle_w: f64,
    pub notes: Vec<String>,
    pub untested: bool,
    pub options: Options,
}

const NOTE_FLUTE_UNKNOWN: &str = "Flute length unknown: stepdown not checked against it.";
const NOTE_SMALL_PLUNGE: &str =
    "Plunge lowered to half the feed per revolution of a drill this size.";
const NOTE_FIXED: &str =
    "Drills, thread mills and engravers follow one rule at every stop; only the stop's caps apply.";
const NO_THREAD: &str =
    "No suggestion: enter the thread diameter and pitch (or name the tool M<diameter>x<pitch>).";
const THREAD_TOO_SMALL: &str = "No suggestion: the tool diameter is not below the thread diameter.";
const NO_NUMBERS: &str = "No suggestion: the model can't work with this geometry.";
const ADAPTIVE_CAUTION: &str = "Untested: a chip-thinning starting point for Adaptive clearing (12% stepover, deep stepdown, faster feed; spindle and plunge as the conventional suggestion). Test-cut it before relying on it.";

/// A number as `%g` writes it: six significant digits, no trailing zeros.
pub(crate) fn g(value: f64) -> String {
    if value == 0.0 || !value.is_finite() {
        return format!("{value}");
    }
    let exponent = value.abs().log10().floor() as i32;
    if !(-5..6).contains(&exponent) {
        return format!("{value:e}");
    }
    let decimals = (5 - exponent).max(0) as usize;
    let text = format!("{value:.decimals$}");
    if text.contains('.') {
        text.trim_end_matches('0').trim_end_matches('.').to_string()
    } else {
        text
    }
}

/// Rounds to `decimals` places as the decimal expansion of the number says,
/// ties to even.
fn round_to(value: f64, decimals: usize) -> f64 {
    format!("{value:.decimals$}").parse().unwrap_or(value)
}

/// The epsilon keeps 0.3 / 0.01 from flooring to 29.
fn floor_to(x: f64, step: f64) -> f64 {
    (x / step + 1e-9).floor() * step
}

/// A whole number out of the arithmetic, or the model has no numbers.
fn whole(value: f64) -> Result<i64, String> {
    if value.is_finite() {
        Ok(value as i64)
    } else {
        Err(NO_NUMBERS.into())
    }
}

/// A feed or plunge rate, rounded down: to 10 above 100 mm/min, else to 1.
fn rate(v: f64) -> Result<i64, String> {
    if v.is_nan() {
        return Err(NO_NUMBERS.into());
    }
    let v = v.max(1.0);
    whole(if v >= 100.0 {
        floor_to(v, 10.0)
    } else {
        v.floor()
    })
}

fn rpm_for(surface_speed: f64, diameter: f64) -> Result<i64, String> {
    let rpm = floor_to(
        surface_speed * 1000.0 / (std::f64::consts::PI * diameter),
        100.0,
    );
    if rpm.is_nan() {
        return Err(NO_NUMBERS.into());
    }
    whole(rpm.max(RPM_MIN as f64).min(RPM_MAX as f64))
}

/// The class's target surface speed: its lubricated one when asked for and
/// it has one.
fn surface_speed(cls: &MaterialClass, lubricated: bool) -> f64 {
    match cls.surface_speed_lubricated {
        Some(speed) if lubricated => speed,
        _ => cls.surface_speed,
    }
}

/// A class whose speed is a hard limit refuses a tool that runs more than
/// the tolerance over its target, and says by how much.
fn check_speed(
    cls: &MaterialClass,
    lubricated: bool,
    cut_d: f64,
    rpm: i64,
    share: f64,
) -> Result<(), String> {
    let speed = surface_speed(cls, lubricated) * share;
    let vc = std::f64::consts::PI * cut_d * rpm as f64 / 1000.0;
    if cls.speed_limit && vc > speed * SPEED_TOLERANCE {
        let mode = if lubricated && cls.surface_speed_lubricated.is_some() {
            "lubricated"
        } else {
            "dry"
        };
        let mut reason = format!(
            "No suggestion: at {rpm} rpm a {} mm tool runs {vc:.0} m/min; {} is covered to {} m/min {mode}.",
            g(round_to(cut_d, 3)),
            cls.label.to_lowercase(),
            g(speed),
        );
        if let (false, Some(lube)) = (lubricated, cls.surface_speed_lubricated) {
            reason.push_str(&format!(
                " With light lubrication (tick Lubricated) it is covered to {} m/min.",
                g(lube * share)
            ));
        }
        return Err(reason);
    }
    Ok(())
}

/// Non-metals always run at full speed; metals follow the surface speed,
/// never below the class's floor and never over a hard limit.
fn spindle(cls: &MaterialClass, lubricated: bool, cut_d: f64, share: f64) -> Result<i64, String> {
    if !is_metal(cls) {
        return Ok(RPM_MAX);
    }
    let rpm = cls
        .rpm_min
        .max(rpm_for(surface_speed(cls, lubricated) * share, cut_d)?);
    check_speed(cls, lubricated, cut_d, rpm, share)?;
    Ok(rpm)
}

/// The stop's cap at this speed: the spindle's power falls with it.
fn power_limit(stop: &Stop, rpm: i64) -> f64 {
    stop.power_w * (rpm as f64 / RPM_MAX as f64).min(1.0)
}

fn chip_floor(cls: &MaterialClass, d: f64) -> f64 {
    let (small, large, full) = cls.chip_floor;
    if d < 2.0 {
        small
    } else if d >= full {
        large
    } else {
        small + (large - small) * (d - 2.0) / (full - 2.0)
    }
}

fn reach_factor(geometry: &Geometry) -> f64 {
    let reach = geometry.shoulder_length / geometry.diameter;
    if reach > 0.0 {
        (REACH_LD / reach).min(1.0)
    } else {
        1.0
    }
}

/// Whether `name` holds the word "engraver" or "engravers", in any case.
fn named_engraver(name: &str) -> bool {
    let lower = name.to_lowercase();
    let word = |c: char| c.is_alphanumeric() || c == '_';
    lower.match_indices("engraver").any(|(at, found)| {
        let before = lower[..at].chars().next_back();
        let mut after = lower[at + found.len()..].chars();
        let mut next = after.next();
        if next == Some('s') {
            next = after.next();
        }
        !before.is_some_and(word) && !next.is_some_and(word)
    })
}

/// A V-bit that engraves rather than chamfers: sharp enough, or named an
/// engraver.
pub fn is_engraver(cutter: Cutter, geometry: &Geometry, name: Option<&str>) -> bool {
    cutter == Cutter::VBit
        && (geometry.tip_angle <= ENGRAVER_MAX_ANGLE || name.is_some_and(named_engraver))
}

fn corner_rounder(cutter: Cutter, geometry: &Geometry) -> bool {
    cutter == Cutter::VBit
        && geometry.tip_diameter >= CORNER_ROUNDER_TIP
        && geometry.tip_angle > ENGRAVER_MAX_ANGLE
}

fn tan_half(geometry: &Geometry) -> f64 {
    (geometry.tip_angle / 2.0).to_radians().tan()
}

/// Cross-section of a full-width cut: the quarter-round corner a corner
/// rounder removes, a V groove for other V-bits, a rectangle otherwise.
fn slot_area(cutter: Cutter, geometry: &Geometry, ap: f64) -> f64 {
    if corner_rounder(cutter, geometry) {
        (1.0 - std::f64::consts::PI / 4.0) * ap * ap
    } else if cutter == Cutter::VBit {
        ap * (geometry.tip_diameter + ap * tan_half(geometry))
    } else {
        geometry.diameter * ap
    }
}

/// A drill under 1 mm is weaker and has less room for chips, so its feed
/// per revolution and peck shrink with its diameter.
fn drill_scale(d: f64) -> f64 {
    (d / SMALL_DRILL_D).min(1.0)
}

/// The class's plunge share of the feed, at least 0.004 mm/rev, never above
/// the feed. A straight plunge is a drilling cut with the wrong tool: it
/// stays under half the feed per revolution of a drill its size.
fn plunge_rate(cls: &MaterialClass, rpm: i64, feed: i64, ramping: bool, scale: f64) -> f64 {
    let (rpm, feed) = (rpm as f64, feed as f64);
    let mut plunge = (cls.plunge_ratio * feed).max(PLUNGE_MIN_PER_REV * rpm);
    if !ramping {
        plunge = plunge.min(PLUNGE_SHARE * cls.drill_feed_per_rev * scale * rpm);
    }
    feed.min(plunge)
}

/// Reads `M<diameter>x<pitch>` off the start of a name.
fn thread_in_name(name: &str) -> Option<(f64, f64)> {
    fn number(text: &str) -> Option<(f64, &str)> {
        let digits = |t: &str| t.bytes().take_while(u8::is_ascii_digit).count();
        let mut end = digits(text);
        if end == 0 {
            return None;
        }
        if text[end..].starts_with('.') {
            let fraction = digits(&text[end + 1..]);
            if fraction > 0 {
                end += 1 + fraction;
            }
        }
        Some((text[..end].parse().ok()?, &text[end..]))
    }
    let (major, rest) = number(name.strip_prefix('M')?)?;
    let (pitch, _) = number(rest.strip_prefix('x')?)?;
    Some((major, pitch))
}

/// The major diameter and pitch of a thread mill: from its geometry, else
/// from its name.
fn thread_of(geometry: &Geometry, name: Option<&str>) -> Result<(f64, f64), String> {
    if geometry.thread_diameter > 0.0 && geometry.pitch > 0.0 {
        return Ok((geometry.thread_diameter, geometry.pitch));
    }
    let (major, pitch) = name.and_then(thread_in_name).ok_or(NO_THREAD)?;
    // The name is held to the relations the geometry is checked for.
    if !(0.0 < pitch && pitch < major && major <= LENGTH_MAX) {
        return Err(NO_THREAD.into());
    }
    Ok((major, pitch))
}

/// Why this geometry gets no suggestion in any material.
pub fn geometry_problem(cutter: Cutter, geometry: &Geometry, name: Option<&str>) -> Option<String> {
    let gm = geometry;
    if gm.flutes == 0.0 {
        return Some("No suggestion: flutes is 0. Enter the flute count.".into());
    }
    if !(DIAMETER_RANGE.0 <= gm.diameter && gm.diameter <= DIAMETER_RANGE.1) {
        return Some(format!(
            "No suggestion: diameter {} mm is outside the {}–{} mm the model covers.",
            g(gm.diameter),
            g(DIAMETER_RANGE.0),
            g(DIAMETER_RANGE.1)
        ));
    }
    if !(FLUTES_RANGE.0 <= gm.flutes && gm.flutes <= FLUTES_RANGE.1) {
        return Some(format!(
            "No suggestion: {} flutes is outside the {}–{} the model covers.",
            g(gm.flutes),
            FLUTES_RANGE.0,
            FLUTES_RANGE.1
        ));
    }
    if gm.flutes.fract() != 0.0 {
        return Some("No suggestion: flutes must be a whole number.".into());
    }
    if gm.flute_length.max(gm.shoulder_length) > LENGTH_MAX {
        return Some(format!(
            "No suggestion: flute or shoulder length is over the {} mm the model covers.",
            g(LENGTH_MAX)
        ));
    }
    if cutter == Cutter::VBit && gm.tip_diameter >= gm.diameter {
        return Some("No suggestion: the tip diameter is not below the diameter.".into());
    }
    if cutter == Cutter::ThreadMill {
        match thread_of(gm, name) {
            Err(reason) => return Some(reason),
            Ok((major, _)) if major <= gm.diameter => return Some(THREAD_TOO_SMALL.into()),
            Ok(_) => {}
        }
    }
    None
}

/// Values before they are finished, and what goes with them.
struct Cut {
    rpm: i64,
    feed: i64,
    plunge: i64,
    stepover_pct: f64,
    stepdown: f64,
}

/// Chip load, surface speed and full-slot power for a row of values.
#[allow(clippy::too_many_arguments)]
pub fn readouts(
    cutter: Cutter,
    geometry: &Geometry,
    material: &str,
    rpm: i64,
    feed: f64,
    plunge: f64,
    stepdown: f64,
    name: Option<&str>,
) -> Option<Readouts> {
    let cls = class_of(material)?;
    let z = (geometry.flutes as i64).max(1) as f64;
    let mut chip = feed / (rpm as f64 * z);
    if cutter == Cutter::ThreadMill {
        // At the cutting edge, not the programmed tool centre.
        let (major, _) = thread_of(geometry, name).ok()?;
        chip *= major / (major - geometry.diameter);
    }
    let vc = std::f64::consts::PI * geometry.diameter * rpm as f64 / 1000.0;
    let power = match cutter {
        Cutter::Drill => {
            cls.energy * std::f64::consts::PI * geometry.diameter.powi(2) / 4.0 * plunge / 60.0
        }
        Cutter::ThreadMill => 0.0,
        _ => cls.energy * slot_area(cutter, geometry, stepdown) * feed / 60.0,
    };
    Some(Readouts {
        chip_load: round_to(chip, 4),
        surface_speed: round_to(vc, 1),
        power_w: round_to(power, 1),
        class_label: cls.label,
    })
}

/// The largest whole number not above `value` that Makera CAM reads back:
/// one with no byte of value 13 in it.
fn cam_readable(value: i64) -> i64 {
    let mut bytes = (value.clamp(0, u32::MAX as i64) as u32).to_be_bytes();
    if let Some(at) = bytes.iter().position(|b| *b == 13) {
        bytes[at] = 12;
        for byte in &mut bytes[at + 1..] {
            *byte = 0xff;
        }
    }
    u32::from_be_bytes(bytes) as i64
}

/// End mills, ball ends, chamfer, V-groove and corner-rounding bits and
/// engravers. The last value is the chip-limited feed without the
/// field-calibrated raises, which the adaptive cut starts from.
fn mill(
    cutter: Cutter,
    geometry: &Geometry,
    cls: &MaterialClass,
    level: &Stop,
    options: &Options,
    name: Option<&str>,
) -> Result<(Cut, Vec<String>, f64, i64), String> {
    let (d, tip) = (geometry.diameter, geometry.tip_diameter);
    let z = geometry.flutes as i64;
    let v_bit = cutter == Cutter::VBit;
    let tan = if v_bit { tan_half(geometry) } else { 0.0 };
    let rounder = corner_rounder(cutter, geometry);
    let mut feed_max = level.feed_max;
    let mut notes = Vec::new();
    let engraver = is_engraver(cutter, geometry, name);
    // The chip before a field-calibrated raise, where one applies.
    let mut base_chip = None;
    let (cut_d, mut chip, mut depth);
    if engraver {
        chip = cls.engrave_chip;
        depth = cls.engrave_depth;
        // Width of the groove it cuts.
        cut_d = tip + 2.0 * depth * tan;
        notes.push(NOTE_FIXED.to_string());
    } else {
        cut_d = if v_bit { (d + tip) / 2.0 } else { d };
        chip = cls
            .chip_max
            .min(chip_floor(cls, cut_d).max(cls.chip_per_mm * cut_d * level.chip_factor));
        depth = cls.depth_per_d * level.depth_factor * cut_d;
        let f = reach_factor(geometry);
        if f < 1.0 {
            // A long reach deflects: cut shallower, and never below the chip
            // floor. In wood and plastic the chip eases off too.
            let ld = geometry.shoulder_length / d;
            if is_metal(cls) {
                if f < SLENDER_FACTOR {
                    return Err(format!(
                        "No suggestion: reach {ld:.1} × D is too slender to cut metal dry."
                    ));
                }
                depth *= f * f;
                notes.push(format!("Long reach ({ld:.1} × D): depth eased."));
            } else {
                depth *= f.sqrt();
                chip = chip_floor(cls, cut_d).max(chip * f.sqrt());
                notes.push(format!("Long reach ({ld:.1} × D): depth and chip eased."));
            }
        }
        if cutter == Cutter::BallEnd {
            depth = depth.min(d / 2.0);
        }
        if v_bit {
            let v_height = (d - tip) / 2.0 / tan;
            if rounder {
                // A form tool cuts its whole radius.
                depth = v_height;
                feed_max = if is_metal(cls) {
                    CORNER_ROUNDER_METAL_FEED_MAX
                } else {
                    CORNER_ROUNDER_FEED_MAX
                };
            } else if let Some(chamfer_depth) = cls.chamfer_depth {
                depth = chamfer_depth.min(v_height);
                if let Some(chamfer_chip) = cls.chamfer_chip {
                    base_chip = Some(chip);
                    chip = cls.chip_max.min(chip.max(chamfer_chip * level.chip_factor));
                    notes.push("A chamfer in metal cuts a shallow edge: chip load from a field result. A 90° Ø3.175 2F chamfered 6082 at 600 mm/min in passes of about 0.14 mm.".into());
                }
            } else {
                depth = (depth * V_DEPTH_SHARE).min(v_height);
            }
            if d > BIG_V_DIAMETER {
                feed_max = feed_max.min(BIG_V_FEED_MAX);
            }
        } else if let (1, true, Some((factor, one_max))) = (
            z,
            ONE_FLUTE_D.0 <= d && d <= ONE_FLUTE_D.1,
            cls.one_flute_chip,
        ) {
            base_chip = Some(chip);
            chip = one_max.min(chip.max(chip * factor));
            notes.push("A 1-flute cutter clears its chip easily: chip load raised. A Ø3.175 1F slotted 6082 8.5 mm deep at 500 mm/min, 0.2 mm a pass (0.042 mm/tooth).".into());
        }
    }
    if geometry.flute_length > 0.0 {
        depth = depth.min(geometry.flute_length);
    } else if !engraver {
        notes.push(NOTE_FLUTE_UNKNOWN.to_string());
    }
    let rpm = spindle(cls, options.lubricated, cut_d, 1.0)?;
    // What the edge allows, before the full slot's power.
    let mut feed = (chip * z as f64 * rpm as f64).min(feed_max);
    let chip_feed = match base_chip {
        None => feed,
        Some(base) => (base * z as f64 * rpm as f64).min(feed_max),
    };
    if depth.is_nan() {
        return Err(NO_NUMBERS.into());
    }
    let depth = round_to(floor_to(depth, 0.01), 2).max(0.01);
    let cap = power_limit(level, rpm);
    let power = cls.energy * slot_area(cutter, geometry, depth) * feed / 60.0;
    if power > cap {
        feed *= cap / power;
        notes.push(format!(
            "Feed lowered to stay within the {} W cap of the ~{} W spindle.",
            g(cap),
            SPINDLE_W
        ));
    }
    let feed = rate(feed)?;
    let plunge = rate(plunge_rate(cls, rpm, feed, options.ramping, drill_scale(d)))?;
    if plunge < rate(plunge_rate(cls, rpm, feed, options.ramping, 1.0))? {
        notes.push(NOTE_SMALL_PLUNGE.to_string());
    }
    let cut = Cut {
        rpm,
        feed,
        plunge,
        stepover_pct: if v_bit { 50.0 } else { cls.stepover_pct },
        stepdown: depth,
    };
    Ok((cut, notes, cap, rate(chip_feed)?))
}

fn drill(
    geometry: &Geometry,
    cls: &MaterialClass,
    level: &Stop,
    lubricated: bool,
) -> Result<(Cut, Vec<String>, f64), String> {
    let d = geometry.diameter;
    let rpm = spindle(cls, lubricated, d, 0.5)?;
    let hole = std::f64::consts::PI * d.powi(2) / 4.0;
    let scale = drill_scale(d);
    let mut plunge = cls.drill_feed_per_rev * scale * rpm as f64;
    let mut peck = cls.drill_peck * scale;
    let mut notes = vec![
        "Drills: only spindle and plunge are suggested. Feed, stepover and stepdown are filled in only where this row is empty.".to_string(),
        NOTE_FIXED.to_string(),
    ];
    if let Some(share) = cls.drill_peck_per_d {
        peck = peck.min(share * d);
        notes.push(format!(
            "Peck about {} × D, with a full retract and a 1 s dwell in the clear after each, lubricated. A Ø1.15 in 6082 snapped dry at 0.29 mm pecks; 0.2 mm, lubricated, drilled 20 holes.",
            g(share)
        ));
    }
    let peck = round_to(floor_to(peck, 0.01), 2).max(0.01);
    let cap = power_limit(level, rpm);
    if cls.energy * hole * plunge / 60.0 > cap {
        plunge = cap * 60.0 / (cls.energy * hole);
        notes.push(format!(
            "Plunge lowered to stay within the {} W cap of the ~{} W spindle.",
            g(cap),
            SPINDLE_W
        ));
    }
    let plunge = rate(plunge)?;
    let cut = Cut {
        rpm,
        feed: plunge,
        plunge,
        stepover_pct: 50.0,
        stepdown: peck,
    };
    Ok((cut, notes, cap))
}

fn thread_mill(
    geometry: &Geometry,
    cls: &MaterialClass,
    level: &Stop,
    name: Option<&str>,
    lubricated: bool,
) -> Result<(Cut, Vec<String>, f64), String> {
    let d = geometry.diameter;
    let (major, pitch) = thread_of(geometry, name)?;
    if major <= d {
        return Err(THREAD_TOO_SMALL.into());
    }
    // A light cut: 0.8 of the surface speed and no metal floor, but a hard
    // speed limit still holds.
    let rpm = rpm_for(surface_speed(cls, lubricated) * THREAD_SPEED_SHARE, d)?;
    check_speed(cls, lubricated, d, rpm, THREAD_SPEED_SHARE)?;
    let chip = cls
        .chip_max
        .min(cls.thread_chip_min.max(cls.chip_per_mm * d));
    let edge_feed = chip * (geometry.flutes as i64) as f64 * rpm as f64;
    // An internal thread: the cutting edge travels farther than the tool
    // centre the feed is programmed at.
    let feed = rate(edge_feed * (major - d) / major)?;
    // The plunge is the descent into a pre-drilled hole.
    let plunge = feed.max(rate(PLUNGE_MIN_PER_REV * rpm as f64)?);
    let cut = Cut {
        rpm,
        feed,
        plunge,
        stepover_pct: 10.0,
        stepdown: pitch,
    };
    let notes = vec![
        "Feed at the tool centre of an internal thread; stepdown is the pitch.".to_string(),
        NOTE_FIXED.to_string(),
    ];
    Ok((cut, notes, power_limit(level, rpm)))
}

/// Radial chip-thinning factor: how much thinner the chip is than the feed
/// per tooth at this radial engagement (1 at half the diameter or more).
pub fn thinning(stepover_pct: f64) -> f64 {
    let ae = stepover_pct / 100.0;
    if ae >= 0.5 {
        1.0
    } else {
        1.0 / (1.0 - (1.0 - 2.0 * ae).powi(2)).sqrt()
    }
}

/// Reshapes the conventional cut for adaptive clearing: its spindle and
/// plunge, a 12 % radial step, a deep stepdown and the feed raised for chip
/// thinning. Returns the cut, its notes, its power and the cap.
#[allow(clippy::too_many_arguments)]
fn adaptive(
    cutter: Cutter,
    geometry: &Geometry,
    cls: &MaterialClass,
    level: &Stop,
    base: &Cut,
    base_notes: &[String],
    chip_feed: i64,
    lubricated: bool,
) -> Result<(Cut, Vec<String>, f64, f64), String> {
    let d = geometry.diameter;
    let aluminum = cls.name == "aluminum";
    let mut notes = Vec::new();
    // The conventional feed is for near-full engagement: at 12 % the chip is
    // about 1.54 times thinner. It starts from what the edge allows: the
    // full slot's power limit is not this cut's.
    let factor = ADAPTIVE_THINNING_MAX.min(thinning(ADAPTIVE_STEPOVER_PCT));
    // A ball end stays within its radius, as its conventional depth does.
    let mut depth = if cutter == Cutter::BallEnd {
        d / 2.0
    } else {
        ADAPTIVE_DEPTH_D * d
    };
    if geometry.flute_length > 0.0 {
        depth = depth.min(ADAPTIVE_DEPTH_FLUTE * geometry.flute_length);
    } else if cutter != Cutter::BallEnd {
        notes.push(if aluminum {
            NOTE_FLUTE_UNKNOWN.to_string()
        } else {
            "Flute length unknown: stepdown is 2 × D, not checked against the flutes.".to_string()
        });
    }
    let rpm = base.rpm;
    let cap = power_limit(level, rpm);
    let mut feed = (chip_feed as f64 * factor).min(level.feed_max);
    if aluminum {
        let lube_d = cls.adaptive_depth_d_lubricated.filter(|_| lubricated);
        depth = depth
            .min(lube_d.unwrap_or(ALU_ADAPTIVE_DEPTH_D) * d)
            .min(ALU_ADAPTIVE_DEPTH_MAX);
        if lube_d.is_some() {
            notes.push("Lubricated: stepdown up to 1 × D (3 mm at most). A Ø1 ran 1 mm deep at 92 mm/min and a Ø3.175 3 mm at 300, both lubricated, in 6082.".into());
        }
        let chip_min = ALU_ADAPTIVE_CHIP_MIN * (d / ALU_ADAPTIVE_CHIP_D).min(1.0);
        let flutes = (geometry.flutes as i64) as f64;
        feed = feed.max((chip_min * factor * flutes * rpm as f64).min(level.feed_max));
        // Over the heat limit the depth gives way: a lower feed would thin
        // the chip again.
        depth = depth.min(
            ALU_ADAPTIVE_POWER_W * 60.0 / (cls.energy * ADAPTIVE_STEPOVER_PCT / 100.0 * d * feed),
        );
        notes.push(format!(
            "Dry aluminium is limited by heat: stepdown at most {} mm, less to stay within about {} W. Brush on a little lubricant (IPA or WD-40) every few minutes. A 6 mm 3-flute ran at 800 mm/min, 3 mm deep, lubricated; 550 at 6 mm, dry, welded a flute.",
            g(ALU_ADAPTIVE_DEPTH_MAX),
            g(ALU_ADAPTIVE_POWER_W)
        ));
    }
    let area = ADAPTIVE_STEPOVER_PCT / 100.0 * d * depth;
    if cls.energy * area * feed / 60.0 > cap {
        feed *= cap / (cls.energy * area * feed / 60.0);
        notes.push(format!(
            "Feed lowered to stay within the {} W cap of the ~{} W spindle.",
            g(cap),
            SPINDLE_W
        ));
    }
    let feed = rate(feed)?;
    if depth.is_nan() {
        return Err(NO_NUMBERS.into());
    }
    let depth = round_to(floor_to(depth, 0.01), 2).max(0.01);
    // The conventional flute-length note is about its own stepdown.
    notes.extend(
        base_notes
            .iter()
            .filter(|note| *note != NOTE_FLUTE_UNKNOWN)
            .cloned(),
    );
    let cut = Cut {
        rpm,
        // The conventional plunge, never above a feed the power check lowered.
        plunge: base.plunge.min(feed),
        feed,
        stepover_pct: ADAPTIVE_STEPOVER_PCT,
        stepdown: depth,
    };
    Ok((cut, notes, cls.energy * area * feed as f64 / 60.0, cap))
}

fn none(reason: String, options: &Options, cls: Option<&MaterialClass>) -> Suggestion {
    Suggestion {
        status: Status::None,
        reason: Some(reason),
        values: None,
        fields: Vec::new(),
        class_label: cls.map(|c| c.label),
        chip_load: None,
        surface_speed: None,
        power_w: None,
        power_limit_w: None,
        spindle_w: SPINDLE_W,
        notes: Vec::new(),
        untested: false,
        options: *options,
    }
}

fn join(first: &str, rest: Option<String>) -> String {
    match rest {
        None => first.to_string(),
        Some(rest) => format!("{first} {rest}"),
    }
}

fn unchecked(
    cutter: Cutter,
    geometry: &Geometry,
    material: &str,
    options: &Options,
    name: Option<&str>,
) -> Result<Suggestion, String> {
    let level = stop(options.level);
    if let Some(problem) = geometry_problem(cutter, geometry, name) {
        return Err(problem);
    }
    let cls = class_of(material).ok_or("No suggestion: the model doesn't cover this material.")?;
    let (mut cut, fields, mut notes, mut cap, chip_feed) = match cutter {
        Cutter::Drill => {
            let (cut, notes, cap) = drill(geometry, cls, &level, options.lubricated)?;
            let feed = cut.feed;
            (cut, DRILL_FIELDS.to_vec(), notes, cap, feed)
        }
        Cutter::ThreadMill => {
            let (cut, notes, cap) = thread_mill(geometry, cls, &level, name, options.lubricated)?;
            let feed = cut.feed;
            (cut, FIELDS.to_vec(), notes, cap, feed)
        }
        _ => {
            let (cut, notes, cap, chip_feed) = mill(cutter, geometry, cls, &level, options, name)?;
            (cut, FIELDS.to_vec(), notes, cap, chip_feed)
        }
    };
    // The geometry's own problems come first.
    if options.adaptive && !matches!(cutter, Cutter::FlatEnd | Cutter::BallEnd) {
        return Err(
            "No suggestion: Adaptive rows are suggested for flat and ball end mills only.".into(),
        );
    }
    let mut caution = level.untested.then(|| {
        format!(
            "Untested: the {} stop follows the model's reasoning but hasn't been test-cut on a Carvera.",
            level.label
        )
    });
    let mut power = None;
    if options.adaptive {
        let (reshaped, reshaped_notes, cut_power, reshaped_cap) = adaptive(
            cutter,
            geometry,
            cls,
            &level,
            &cut,
            &notes,
            chip_feed,
            options.lubricated,
        )?;
        (cut, notes, cap) = (reshaped, reshaped_notes, reshaped_cap);
        power = Some(cut_power);
        caution = Some(join(ADAPTIVE_CAUTION, caution));
    }
    if cutter == Cutter::ThreadMill && thread_of(geometry, name)?.0 < SMALL_THREAD_D {
        caution = Some(join(
            "Untested: the model's feed for a thread under M2 hasn't been cut. An M1.4×0.3 in 6082 ran at 20 mm/min in 3 radial passes, lubricated; start there.",
            caution,
        ));
    }
    if cutter == Cutter::Drill && geometry.diameter < SMALL_DRILL_D {
        caution = Some(join(
            &format!(
                "Untested: under Ø{} mm the feed per revolution and peck shrink with the diameter, with no test cut behind them. These drills snap easily: check the runout first.",
                g(SMALL_DRILL_D)
            ),
            caution,
        ));
    }
    if notes.iter().any(|note| note == NOTE_SMALL_PLUNGE) {
        caution = Some(join(
            &format!(
                "Untested: under Ø{} mm a straight plunge is held to half the feed per revolution of a drill this size, even under the {} mm/rev that keeps a tool from rubbing, with no test cut behind it. Ramp in if the operation can.",
                g(SMALL_DRILL_D),
                g(PLUNGE_MIN_PER_REV)
            ),
            caution,
        ));
    }
    // An untested class: its caution comes first.
    if let Some(class_caution) = cls.caution {
        caution = Some(join(class_caution, caution));
    }

    // Makera CAM misreads a byte of value 13: such numbers are rounded down.
    let values = Values {
        rpm: cam_readable(cut.rpm),
        feed: cam_readable(cut.feed),
        plunge: cam_readable(cut.plunge),
        stepover_pct: cut.stepover_pct,
        stepover_mm: round_to(cut.stepover_pct * geometry.diameter / 100.0, 4),
        stepdown: cut.stepdown,
    };
    let out = readouts(
        cutter,
        geometry,
        material,
        values.rpm,
        values.feed as f64,
        values.plunge as f64,
        values.stepdown,
        name,
    )
    .ok_or(NO_NUMBERS)?;
    Ok(Suggestion {
        status: if caution.is_some() {
            Status::Caution
        } else {
            Status::Ok
        },
        untested: caution.is_some(),
        reason: caution,
        values: Some(values),
        fields,
        class_label: Some(out.class_label),
        chip_load: Some(out.chip_load),
        surface_speed: Some(out.surface_speed),
        // A cut narrower than the full slot has its own power.
        power_w: Some(power.map_or(out.power_w, |p| round_to(p, 1))),
        power_limit_w: Some(round_to(cap, 1)),
        spindle_w: SPINDLE_W,
        notes,
        options: *options,
    })
}

/// A starting point for one tool and material at one stop. A status of
/// `None` says why there is none. What comes back keeps its promises:
/// finite numbers, within the power cap.
pub fn suggest(
    cutter: Cutter,
    geometry: &Geometry,
    material: &str,
    options: &Options,
    name: Option<&str>,
) -> Suggestion {
    let s = match unchecked(cutter, geometry, material, options, name) {
        Ok(s) => s,
        Err(reason) => return none(reason, options, None),
    };
    let finite = s.values.as_ref().is_some_and(|v| {
        [v.stepover_pct, v.stepover_mm, v.stepdown]
            .iter()
            .chain(&[s.chip_load, s.surface_speed, s.power_w].map(|n| n.unwrap_or(f64::NAN)))
            .all(|n| n.is_finite())
    });
    if !finite {
        return none(NO_NUMBERS.into(), options, None);
    }
    // The feed can't go below 1 mm/min to fit.
    if s.power_w > s.power_limit_w {
        return none(
            "No suggestion: no cut with this geometry stays within the power cap.".into(),
            options,
            None,
        );
    }
    s
}

/// A suggestion for a tool of the app's list.
pub fn suggest_for(tool: &Tool, material: &str, options: &Options) -> Suggestion {
    let (cutter, geometry) = cutter_of(tool);
    suggest(cutter, &geometry, material, options, Some(&tool.name))
}

/// Whether lubrication can change this material's suggestion.
pub fn lubrication_matters(material: &str) -> bool {
    class_of(material).is_some_and(|cls| {
        cls.surface_speed_lubricated.is_some() || cls.adaptive_depth_d_lubricated.is_some()
    })
}

/// Whether the model covers a material at all.
pub fn covers(material: &str) -> bool {
    class_of(material).is_some()
}

/// A conventional end-mill suggestion as a full-width cut: a stepover of
/// the whole diameter. The model already sizes every conventional cut for a
/// full slot, so only the stepover moves; an adaptive one keeps its own.
pub fn as_slot(mut suggestion: Suggestion, geometry: &Geometry) -> Suggestion {
    if suggestion.options.adaptive {
        return suggestion;
    }
    if let Some(values) = &mut suggestion.values {
        values.stepover_pct = 100.0;
        values.stepover_mm = round_to(geometry.diameter, 4);
    }
    suggestion
}

/// The suggestion at each of the five stops, gentlest first.
pub fn suggest_stops(
    tool: &Tool,
    material: &str,
    ramping: bool,
    adaptive: bool,
    lubricated: bool,
) -> Vec<Suggestion> {
    [
        Level::Gentle,
        Level::SlotSafe,
        Level::Standard,
        Level::Firm,
        Level::Aggressive,
    ]
    .into_iter()
    .map(|level| {
        let options = Options {
            level,
            ramping,
            adaptive,
            lubricated,
        };
        suggest_for(tool, material, &options)
    })
    .collect()
}

/// The cross-section of a full slot as a row's own power is worked out from
/// it: `depth × (width + depth × tan)`, or `round × depth²` for a corner
/// rounder.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotShape {
    pub width: f64,
    pub tan: f64,
    pub round: f64,
}

/// What a row's own values are checked against, outside any stop: the
/// class's chip-load band at this cutting diameter, its specific cutting
/// energy with the full slot's cross-section, and the hardest stop's power
/// cap at the top spindle speed (proportionally less below it).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub class_label: &'static str,
    pub chip_floor: f64,
    pub chip_max: f64,
    /// The diameter the band is for: a V-bit's is halfway between its tip
    /// and its body.
    pub cut_diameter: f64,
    pub energy: f64,
    pub slot: SlotShape,
    pub power_cap_w: f64,
    pub rpm_max: i64,
}

/// The limits for a cutter in a material. `None` where there is no model,
/// and for drills, thread mills and engravers, which follow one fixed rule.
pub fn limits(
    cutter: Cutter,
    geometry: &Geometry,
    material: &str,
    name: Option<&str>,
) -> Option<Limits> {
    if !matches!(cutter, Cutter::FlatEnd | Cutter::BallEnd | Cutter::VBit)
        || geometry_problem(cutter, geometry, None).is_some()
    {
        return None;
    }
    let cls = class_of(material)?;
    if is_engraver(cutter, geometry, name) {
        return None;
    }
    let v_bit = cutter == Cutter::VBit;
    let one_flute = !v_bit
        && geometry.flutes as i64 == 1
        && ONE_FLUTE_D.0 <= geometry.diameter
        && geometry.diameter <= ONE_FLUTE_D.1;
    // What the 1-flute suggestion may reach, where it applies.
    let chip_max = cls
        .one_flute_chip
        .filter(|_| one_flute)
        .map_or(cls.chip_max, |(_, one_max)| one_max);
    let cut_d = if v_bit {
        (geometry.diameter + geometry.tip_diameter) / 2.0
    } else {
        geometry.diameter
    };
    let slot = if corner_rounder(cutter, geometry) {
        SlotShape {
            width: 0.0,
            tan: 0.0,
            round: round_to(1.0 - std::f64::consts::FRAC_PI_4, 6),
        }
    } else {
        SlotShape {
            width: if v_bit {
                geometry.tip_diameter
            } else {
                geometry.diameter
            },
            tan: if v_bit {
                round_to((geometry.tip_angle / 2.0).to_radians().tan(), 6)
            } else {
                0.0
            },
            round: 0.0,
        }
    };
    let out = Limits {
        class_label: cls.label,
        chip_floor: round_to(chip_floor(cls, cut_d), 4),
        chip_max,
        cut_diameter: cut_d,
        energy: cls.energy,
        slot,
        power_cap_w: stop(Level::Aggressive).power_w,
        rpm_max: RPM_MAX,
    };
    let finite = [
        out.chip_floor,
        out.chip_max,
        out.energy,
        out.slot.width,
        out.slot.tan,
        out.slot.round,
    ]
    .iter()
    .all(|n| n.is_finite());
    finite.then_some(out)
}

const LEVELS: [Level; 5] = [
    Level::Gentle,
    Level::SlotSafe,
    Level::Standard,
    Level::Firm,
    Level::Aggressive,
];

/// The key of one combination of stop and ways of cutting among a row's
/// suggestions, such as `firm+ramp+adaptive+lube`.
pub fn combo_key(options: &Options) -> String {
    let level = match options.level {
        Level::Gentle => "gentle",
        Level::SlotSafe => "slot_safe",
        Level::Standard => "standard",
        Level::Firm => "firm",
        Level::Aggressive => "aggressive",
    };
    format!(
        "{level}{}{}{}",
        if options.ramping { "+ramp" } else { "" },
        if options.adaptive { "+adaptive" } else { "" },
        if options.lubricated { "+lube" } else { "" }
    )
}

/// Everything the model has for one cutting row, so that a screen can switch
/// between the combinations without asking again.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// Whether the model knows the material at all.
    pub covered: bool,
    /// The combination to start from: the profile's, or the plain Slot-safe.
    pub default: String,
    /// Every stop, with and without a ramped entry and adaptive clearing
    /// and, where lubrication changes anything, with and without it: 40
    /// suggestions, else 20, by `combo_key` (without `+lube` in the latter
    /// case).
    pub combos: BTreeMap<String, Suggestion>,
    pub limits: Option<Limits>,
    /// Whether lubrication changes anything for this material.
    pub lubrication: bool,
}

/// The suggestions for a row of a tool: in `material` (one the model knows),
/// on `profile` when it has one. A profile for full-width cuts gives end
/// mills a stepover of the whole diameter.
pub fn suggest_entry(tool: &Tool, material: &str, profile: Option<&Profile>) -> Entry {
    let (cutter, geometry) = cutter_of(tool);
    let name = Some(tool.name.as_str());
    let lubrication = lubrication_matters(material);
    let slot =
        profile.is_some_and(|p| p.slot) && matches!(cutter, Cutter::FlatEnd | Cutter::BallEnd);
    let mut combos = BTreeMap::new();
    for level in LEVELS {
        for ramping in [false, true] {
            for adaptive in [false, true] {
                for lubricated in [false, true] {
                    if lubricated && !lubrication {
                        continue;
                    }
                    let options = Options {
                        level,
                        ramping,
                        adaptive,
                        lubricated,
                    };
                    let mut s = suggest(cutter, &geometry, material, &options, name);
                    if slot {
                        s = as_slot(s, &geometry);
                    }
                    combos.insert(combo_key(&options), s);
                }
            }
        }
    }
    let default = profile.map_or_else(Options::default, |p| Options {
        level: p.level.unwrap_or(Level::SlotSafe),
        ramping: p.ramping,
        adaptive: p.is_adaptive(),
        lubricated: p.lubricated,
    });
    Entry {
        covered: covers(material),
        default: combo_key(&default),
        combos,
        limits: limits(cutter, &geometry, material, name),
        lubrication,
    }
}

/// What a row's own numbers come to, and what the model has against them.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowCheck {
    /// Whether the model knows the material at all.
    pub covered: bool,
    /// Whether lubrication changes this material's suggestions.
    pub lubrication_matters: bool,
    pub class_label: Option<&'static str>,
    /// mm per tooth.
    pub chip_load: Option<f64>,
    /// m/min.
    pub surface_speed: Option<f64>,
    /// W, were the row run as a full-width slot.
    pub power_w: Option<f64>,
    /// The band a chip load should stay in. `None` for drills, thread mills
    /// and engravers, which follow one fixed rule, and where the model has
    /// nothing to say about the geometry.
    pub chip_floor: Option<f64>,
    pub chip_max: Option<f64>,
    /// The most a full-width slot may take at the row's spindle speed: the
    /// cap of the hardest stop.
    pub power_cap_w: Option<f64>,
    /// What is wrong with the numbers, in plain words.
    pub warnings: Vec<String>,
}

/// Holds a cutting row of a tool against the model: its chip load against
/// the material's band, and a full slot's power against the hardest stop's
/// cap. A row within both may still be far from any suggestion; the stops
/// say where it sits.
///
/// A row for adaptive clearing (`adaptive`) is never run as a full slot: its
/// power is that of its own `stepover` (mm), and its chip, thinned by the
/// light sideways cut, is not held to the band.
#[allow(clippy::too_many_arguments)]
pub fn check_row(
    tool: &Tool,
    material: &str,
    rpm: u32,
    feed: f64,
    plunge: f64,
    stepover: f64,
    stepdown: f64,
    adaptive: bool,
) -> RowCheck {
    let (cutter, geometry) = cutter_of(tool);
    let name = Some(tool.name.as_str());
    let mut check = RowCheck {
        covered: covers(material),
        lubrication_matters: lubrication_matters(material),
        class_label: None,
        chip_load: None,
        surface_speed: None,
        power_w: None,
        chip_floor: None,
        chip_max: None,
        power_cap_w: None,
        warnings: Vec::new(),
    };
    let Some(cls) = class_of(material) else {
        return check;
    };
    check.class_label = Some(cls.label);
    if rpm == 0 || geometry_problem(cutter, &geometry, name).is_some() {
        return check;
    }
    let Some(out) = readouts(
        cutter,
        &geometry,
        material,
        i64::from(rpm),
        feed,
        plunge,
        stepdown,
        name,
    ) else {
        return check;
    };
    let finite = [out.chip_load, out.surface_speed, out.power_w]
        .iter()
        .all(|n| n.is_finite());
    if !finite {
        return check;
    }
    check.chip_load = Some(out.chip_load);
    check.surface_speed = Some(out.surface_speed);
    let power = if adaptive {
        round_to(cls.energy * stepover * stepdown * feed / 60.0, 1)
    } else {
        out.power_w
    };
    if !power.is_finite() {
        return check;
    }
    check.power_w = Some(power);

    let judged = matches!(cutter, Cutter::FlatEnd | Cutter::BallEnd | Cutter::VBit)
        && !is_engraver(cutter, &geometry, name);
    if !judged {
        return check;
    }
    let v_bit = cutter == Cutter::VBit;
    let cut_d = if v_bit {
        (geometry.diameter + geometry.tip_diameter) / 2.0
    } else {
        geometry.diameter
    };
    let one_flute = !v_bit
        && geometry.flutes as i64 == 1
        && ONE_FLUTE_D.0 <= geometry.diameter
        && geometry.diameter <= ONE_FLUTE_D.1;
    let floor = round_to(chip_floor(cls, cut_d), 4);
    // What the 1-flute suggestion may reach, where it applies.
    let max = cls
        .one_flute_chip
        .filter(|_| one_flute)
        .map_or(cls.chip_max, |(_, one_max)| one_max);
    let cap = round_to(power_limit(&stop(Level::Aggressive), i64::from(rpm)), 1);
    check.power_cap_w = Some(cap);
    if adaptive {
        if power > cap {
            check.warnings.push(format!(
                "At this stepover and depth the cut takes about {} W, over the {} W the hardest stop allows at {rpm} rpm. Cut shallower or feed slower.",
                g(power),
                g(cap)
            ));
        }
        return check;
    }
    check.chip_floor = Some(floor);
    check.chip_max = Some(max);

    if out.chip_load < floor {
        check.warnings.push(format!(
            "The chip is {} mm per tooth, under the {} mm this tool needs in {}: it may rub and burn. Feed faster, or turn the spindle slower.",
            g(out.chip_load),
            g(floor),
            cls.label.to_lowercase()
        ));
    } else if out.chip_load > max {
        check.warnings.push(format!(
            "The chip is {} mm per tooth, over the {} mm the model allows in {}. Feed slower.",
            g(out.chip_load),
            g(max),
            cls.label.to_lowercase()
        ));
    }
    if power > cap {
        check.warnings.push(format!(
            "As a full-width cut this takes about {} W, over the {} W the hardest stop allows at {rpm} rpm. Cut shallower or feed slower.",
            g(power),
            g(cap)
        ));
    }
    check
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn end_mill() -> Tool {
        let mut tool = Tool::new("Ø6×18 3F", ToolKind::FlatEnd, 6.0);
        tool.flutes = Some(3);
        tool.flute_length = Some(18.0);
        tool
    }

    #[test]
    fn the_stops_run_from_gentle_to_aggressive() {
        let stops = suggest_stops(&end_mill(), "hardwood", false, false, false);
        let feeds: Vec<i64> = stops
            .iter()
            .map(|s| s.values.as_ref().unwrap().feed)
            .collect();
        assert_eq!(stops.len(), 5);
        assert!(feeds.windows(2).all(|pair| pair[0] <= pair[1]), "{feeds:?}");
        assert_eq!(stops[1].status, Status::Ok);
        assert_eq!(stops[1].options.level, Level::SlotSafe);
        assert_eq!(stops[0].status, Status::Caution);
        // A material the model does not know has no stops to offer.
        let none = suggest_stops(&end_mill(), "oak", false, false, false);
        assert!(none.iter().all(|s| s.status == Status::None));
    }

    #[test]
    fn a_suggested_row_passes_its_own_check() {
        for material in ["softwood", "hardwood", "plastic", "aluminum", "brass"] {
            for s in suggest_stops(&end_mill(), material, false, false, false) {
                let v = s.values.unwrap();
                let check = check_row(
                    &end_mill(),
                    material,
                    v.rpm as u32,
                    v.feed as f64,
                    v.plunge as f64,
                    2.4,
                    v.stepdown,
                    false,
                );
                assert_eq!(check.warnings, Vec::<String>::new(), "{material}");
                assert_eq!(check.chip_load, s.chip_load);
                assert_eq!(check.power_w, s.power_w);
            }
        }
    }

    #[test]
    fn a_row_is_held_to_the_chip_band_and_the_power_cap() {
        let tool = end_mill();
        let rubbing = check_row(&tool, "hardwood", 12000, 300.0, 100.0, 2.4, 1.0, false);
        assert_eq!(rubbing.chip_load, Some(0.0083));
        assert_eq!(
            (rubbing.chip_floor, rubbing.chip_max),
            (Some(0.02), Some(0.1))
        );
        assert!(rubbing.warnings[0].contains("may rub"), "{rubbing:?}");

        let heavy = check_row(&tool, "hardwood", 12000, 2400.0, 200.0, 2.4, 12.0, false);
        assert_eq!(heavy.power_cap_w, Some(120.0));
        assert!(heavy.warnings.iter().any(|w| w.contains("over the 120 W")));

        // At a lower speed the spindle has less to give.
        let slow = check_row(&tool, "hardwood", 6000, 1200.0, 200.0, 2.4, 1.0, false);
        assert_eq!(slow.power_cap_w, Some(60.0));

        let thick = check_row(&tool, "aluminum", 12000, 2000.0, 200.0, 2.4, 0.1, false);
        assert!(thick.warnings[0].contains("Feed slower"), "{thick:?}");
    }

    #[test]
    fn an_adaptive_row_is_judged_at_its_own_stepover() {
        let tool = end_mill();
        // 800 mm/min, 3 mm deep: far over the cap as a slot, well under it
        // at a stepover of 0.72 mm.
        let slot = check_row(&tool, "aluminum", 12000, 800.0, 180.0, 0.72, 3.0, false);
        assert!(slot.warnings.iter().any(|w| w.contains("full-width")));
        let adaptive = check_row(&tool, "aluminum", 12000, 800.0, 180.0, 0.72, 3.0, true);
        assert_eq!(adaptive.power_w, Some(28.8));
        assert_eq!(adaptive.warnings, Vec::<String>::new());
        assert_eq!(
            (adaptive.chip_floor, adaptive.power_cap_w),
            (None, Some(120.0))
        );
        let heavy = check_row(&tool, "aluminum", 12000, 3000.0, 180.0, 3.0, 6.0, true);
        assert!(heavy.warnings[0].contains("At this stepover"), "{heavy:?}");
    }

    #[test]
    fn what_the_model_cannot_judge_gets_numbers_at_most() {
        // A material it does not know.
        let unknown = check_row(&end_mill(), "oak", 12000, 600.0, 100.0, 2.4, 1.0, false);
        assert!(!unknown.covered && unknown.chip_load.is_none());
        assert!(unknown.warnings.is_empty());

        // A drill follows one fixed rule: numbers, no band.
        let mut drill = Tool::new("Ø2.7 Drill", ToolKind::Drill, 2.7);
        drill.flutes = Some(2);
        drill.tip_angle = Some(118.0);
        let check = check_row(&drill, "aluminum", 12000, 100.0, 100.0, 2.4, 0.4, false);
        assert!(check.covered && check.lubrication_matters);
        assert!(check.surface_speed.is_some() && check.chip_floor.is_none());

        // Without a flute count there is no chip to speak of.
        let mut bare = end_mill();
        bare.flutes = None;
        let check = check_row(&bare, "hardwood", 12000, 600.0, 100.0, 2.4, 1.0, false);
        assert!(check.covered && check.chip_load.is_none());
        assert!(
            !check_row(
                &end_mill(),
                "hardwood",
                12000,
                600.0,
                100.0,
                2.4,
                1.0,
                false
            )
            .lubrication_matters
        );
    }

    #[test]
    fn a_tool_of_the_list_is_read_as_the_tooling_library_stores_it() {
        // A V-bit without a tip is a point; a corner-rounding bit is a V-bit
        // with a flat tip, which the model takes for a corner rounder.
        let mut v_bit = Tool::new("60° V", ToolKind::VBit, 12.0);
        v_bit.tip_angle = Some(60.0);
        let (cutter, geometry) = cutter_of(&v_bit);
        assert_eq!((cutter, geometry.tip_diameter), (Cutter::VBit, 0.0));

        let mut fillet = Tool::new("R1 Corner Round", ToolKind::CornerRound, 4.0);
        fillet.tip_diameter = Some(2.0);
        fillet.corner_radius = Some(1.0);
        fillet.flutes = Some(4);
        let (cutter, geometry) = cutter_of(&fillet);
        assert_eq!((cutter, geometry.tip_angle), (Cutter::VBit, 90.0));
        assert!(corner_rounder(cutter, &geometry));
        // It cuts its whole radius in one pass.
        let s = suggest_for(&fillet, "hardwood", &Options::default());
        assert_eq!(s.values.unwrap().stepdown, 1.0);

        // An end mill's shoulder is its flute length unless it says otherwise.
        let (_, geometry) = cutter_of(&end_mill());
        assert_eq!(geometry.shoulder_length, 18.0);
        assert_eq!(geometry.tip_diameter, 6.0);
    }

    /// The answers of the tooling library's own model for a spread of
    /// made-up tools, in every material class and at every stop.
    const REFERENCE: &str = include_str!("../tests/fixtures/feeds-reference.json");

    fn number(value: &Value) -> f64 {
        value
            .as_f64()
            .unwrap_or_else(|| panic!("not a number: {value}"))
    }

    #[test]
    fn the_model_answers_as_the_tooling_library_does() {
        let reference: Value = serde_json::from_str(REFERENCE).unwrap();
        let strings: Vec<&str> = reference["strings"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap())
            .collect();
        let text = |index: &Value| index.as_u64().map(|i| strings[i as usize].to_string());
        let results = reference["results"].as_array().unwrap();
        let rows = reference["rows"].as_array().unwrap();
        assert!(rows.len() > 400);

        let mut wrong = Vec::new();
        let mut count = 0;
        for row in rows {
            let cutter = match row[0].as_str().unwrap() {
                "flat_end" => Cutter::FlatEnd,
                "ball_end" => Cutter::BallEnd,
                "v_bit" => Cutter::VBit,
                "drill" => Cutter::Drill,
                "thread_mill" => Cutter::ThreadMill,
                other => panic!("unknown cutter {other}"),
            };
            let name = row[1].as_str();
            let shape: Vec<f64> = row[2].as_array().unwrap().iter().map(number).collect();
            let geometry = Geometry {
                diameter: shape[0],
                tip_diameter: shape[1],
                tip_angle: shape[2],
                flutes: shape[3],
                flute_length: shape[4],
                shoulder_length: shape[5],
                thread_diameter: shape[6],
                pitch: shape[7],
            };
            let material = row[3].as_str().unwrap();

            let expected = row[4].as_array().map(|l| Limits {
                class_label: "",
                chip_floor: number(&l[1]),
                chip_max: number(&l[2]),
                cut_diameter: 0.0,
                energy: number(&l[3]),
                slot: SlotShape {
                    width: number(&l[4]),
                    tan: number(&l[5]),
                    round: number(&l[6]),
                },
                power_cap_w: number(&l[7]),
                rpm_max: l[8].as_i64().unwrap(),
            });
            let label = row[4]
                .as_array()
                .map(|l| l[0].as_str().unwrap().to_string());
            let got = limits(cutter, &geometry, material, name);
            let got_label = got.as_ref().map(|l| l.class_label.to_string());
            let bare = got.clone().map(|l| Limits {
                class_label: "",
                cut_diameter: 0.0,
                ..l
            });
            if bare != expected || got_label != label {
                wrong.push(format!("limits of {row}\n  got {got:?}"));
            }

            // Every combination, in the order the fixture was written in.
            let mut at = 0;
            for level in LEVELS {
                for ramping in [false, true] {
                    for adaptive in [false, true] {
                        for lubricated in [false, true] {
                            let case = &results[row[5][at].as_u64().unwrap() as usize];
                            at += 1;
                            count += 1;
                            let options = Options {
                                level,
                                ramping,
                                adaptive,
                                lubricated,
                            };
                            let got = suggest(cutter, &geometry, material, &options, name);
                            let status = match case[0].as_str().unwrap() {
                                "ok" => Status::Ok,
                                "caution" => Status::Caution,
                                _ => Status::None,
                            };
                            let values = case[2].as_array().map(|v| Values {
                                rpm: v[0].as_i64().unwrap(),
                                feed: v[1].as_i64().unwrap(),
                                plunge: v[2].as_i64().unwrap(),
                                stepover_pct: number(&v[3]),
                                stepover_mm: number(&v[4]),
                                stepdown: number(&v[5]),
                            });
                            let notes: Vec<String> = case[8]
                                .as_array()
                                .unwrap()
                                .iter()
                                .filter_map(text)
                                .collect();
                            let same = got.status == status
                                && got.reason == text(&case[1])
                                && got.values == values
                                && got.fields.len() as u64 == case[3].as_u64().unwrap()
                                && got.chip_load == case[4].as_f64()
                                && got.surface_speed == case[5].as_f64()
                                && got.power_w == case[6].as_f64()
                                && got.power_limit_w == case[7].as_f64()
                                && got.notes == notes
                                && got.untested == case[9].as_bool().unwrap();
                            if !same {
                                wrong.push(format!(
                                    "{} {material} {options:?}: {case}\n  got {got:?}",
                                    row[0]
                                ));
                            }
                        }
                    }
                }
            }
        }
        assert!(count > 16000);
        assert!(
            wrong.is_empty(),
            "{} of {} differ, the first:\n{}",
            wrong.len(),
            count,
            wrong[..wrong.len().min(3)].join("\n")
        );
    }

    #[test]
    fn a_row_gets_every_combination_and_starts_at_its_profile() {
        let tool = end_mill();
        let plain = suggest_entry(&tool, "hardwood", None);
        assert_eq!(
            (plain.default.as_str(), plain.combos.len()),
            ("slot_safe", 20)
        );
        assert!(plain.covered && !plain.lubrication && plain.limits.is_some());
        assert!(plain.combos.contains_key("firm+ramp+adaptive"));
        // Where lubrication changes the answer, every combination comes with and without it.
        let alu = suggest_entry(&tool, "aluminum", None);
        assert_eq!(alu.combos.len(), 40);
        assert!(alu.lubrication && alu.combos.contains_key("gentle+ramp+adaptive+lube"));

        let profile = |key: &str, slot: bool| Profile {
            key: key.into(),
            label: key.into(),
            note: None,
            level: Some(Level::Firm),
            ramping: true,
            adaptive: None,
            lubricated: false,
            slot,
        };
        // The profile with the key `adaptive` is for adaptive clearing unless it says otherwise.
        let adaptive = suggest_entry(&tool, "hardwood", Some(&profile("adaptive", false)));
        assert_eq!(adaptive.default, "firm+ramp+adaptive");
        // A profile for full-width cuts takes the whole diameter, except where the cut is adaptive.
        let slot = suggest_entry(&tool, "hardwood", Some(&profile("contour", true)));
        assert_eq!(slot.default, "firm+ramp");
        let values = |key: &str| slot.combos[key].values.clone().unwrap();
        assert_eq!(
            (
                values("slot_safe").stepover_pct,
                values("slot_safe").stepover_mm
            ),
            (100.0, 6.0)
        );
        assert_eq!(values("slot_safe+adaptive").stepover_pct, 12.0);
        assert_eq!(
            values("slot_safe").feed,
            plain.combos["slot_safe"].values.clone().unwrap().feed
        );

        let unknown = suggest_entry(&tool, "oak", None);
        assert!(!unknown.covered && unknown.limits.is_none());
        assert!(unknown.combos.values().all(|s| s.status == Status::None));
    }
}
