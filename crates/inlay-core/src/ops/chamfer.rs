//! A chamfer or a rounded edge, planned in a section through the edge.
//!
//! The section is taken square to the outline: `x` runs from the edge into
//! the wood that stays, depth runs down from the surface. Beside the edge,
//! where `x` is below 0, the wood has been cut away already. Each pass is one
//! trip of the bit along a track at some distance from the edge with its tip
//! at some depth; along a straight stretch of outline it cuts the same in
//! every section, so the section tells what each pass takes.
//!
//! Two limits size the passes, both from the cutting row. No pass goes more
//! than the row's stepdown deeper than the one before it on its track, and
//! none takes more wood than a full groove one stepdown deep would: that is
//! the cut a V-bit's row is sized for. A bevel widens as it deepens, so equal
//! steps would load the last passes several times over; here the steps get
//! shallower instead, as far as it takes to keep within the groove.
//!
//! A bevel wider than the bit's flank cannot be cut from one track: the
//! uncut body above the flank would run through wood. It is cut in layers
//! instead, each a tip depth, stepping from the bevel out to the edge, so
//! that each layer clears what the body of the next one passes through.

use serde::Serialize;

/// The bit, as the section sees it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum EdgeBit {
    /// A V-bit: a cone of `half_angle` from a flat tip of `tip_radius`.
    V {
        half_angle: f64,
        tip_radius: f64,
        /// Half the bit's diameter, where the cone ends.
        radius: f64,
        /// How high above the tip its cutting edges reach, when known.
        flutes: Option<f64>,
    },
    /// A corner-rounding bit: a tip of `tip_radius`, then a quarter circle of
    /// `corner` radius curving out from it.
    Round {
        tip_radius: f64,
        corner: f64,
        radius: f64,
        flutes: Option<f64>,
    },
}

impl EdgeBit {
    /// How high the cutting edges reach above the tip. Above it is the body,
    /// which does not cut.
    fn cut_height(&self) -> f64 {
        let (shape, flutes) = match *self {
            EdgeBit::V {
                half_angle,
                tip_radius,
                radius,
                flutes,
            } => ((radius - tip_radius).max(0.0) / half_angle.tan(), flutes),
            EdgeBit::Round { corner, flutes, .. } => (corner, flutes),
        };
        flutes.map_or(shape, |f| f.min(shape))
    }

    /// Half the width of the body above the cutting edges.
    fn body_radius(&self) -> f64 {
        match *self {
            EdgeBit::V { radius, .. } => radius,
            EdgeBit::Round {
                tip_radius,
                corner,
                radius,
                ..
            } => radius.max(tip_radius + corner),
        }
    }

    /// How high above the tip the bit's surface is at `rho` from its axis,
    /// cutting or not; at the body's height beyond the shape.
    fn shape(&self, rho: f64) -> f64 {
        match *self {
            EdgeBit::V {
                half_angle,
                tip_radius,
                radius,
                ..
            } => (rho.min(radius) - tip_radius).max(0.0) / half_angle.tan(),
            EdgeBit::Round {
                tip_radius, corner, ..
            } => {
                let out = (rho - tip_radius).clamp(0.0, corner);
                (corner * corner - (corner - out) * (corner - out))
                    .max(0.0)
                    .sqrt()
            }
        }
    }

    /// How high above the tip the bit's cutting surface is at `rho` from its
    /// axis. `None` beyond the cutting edges.
    fn lift(&self, rho: f64) -> Option<f64> {
        let reach = match *self {
            EdgeBit::V { radius, .. } => radius,
            EdgeBit::Round {
                tip_radius, corner, ..
            } => tip_radius + corner,
        };
        let lift = self.shape(rho);
        (rho <= reach && lift <= self.cut_height() + 1e-9).then_some(lift)
    }
}

/// What the edge is to be shaped to.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EdgeSpec {
    /// The bevel's width seen from above, mm. Not used by a corner-rounding
    /// bit, which cuts its own radius.
    pub width: f64,
    /// How far beyond its tip flat a V-bit's axis is kept from the edge on
    /// the last pass, mm.
    pub tip_clearance: f64,
    /// The row's stepdown, mm.
    pub stepdown: f64,
    /// The most wood one pass may take in section, mm²: a full groove one
    /// stepdown deep.
    pub groove: f64,
}

/// One trip along the outline.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pass {
    /// How far the bit's axis is from the edge, mm: beside it, where the wood
    /// is gone, when positive; over the wood when negative.
    pub aside: f64,
    /// How deep the tip goes, mm.
    pub depth: f64,
    /// The wood it takes, in section, mm².
    pub area: f64,
}

/// How an edge is cut, pass by pass, in the order they run.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgePlan {
    pub passes: Vec<Pass>,
    /// How many layers the bevel is cut in: 1 when every pass runs on the
    /// last track, beside the edge.
    pub layers: usize,
    /// The stepdown and the groove the passes were sized by.
    pub stepdown: f64,
    pub groove: f64,
    /// How far the shaped edge reaches into the wood, and how far down the
    /// wall: a bevel's width and height, or the rounding's radius twice.
    pub across: f64,
    pub down: f64,
    /// The widest bevel the bit cuts from one track, mm. Infinite for a
    /// corner-rounding bit.
    pub one_track: f64,
    /// For drawing: the section's surface after each pass, as depths of
    /// `columns` columns spread evenly over `across`.
    pub surfaces: Vec<Vec<f64>>,
    pub columns: usize,
}

impl EdgePlan {
    /// The tracks in the order they are first used, each with the depths its
    /// passes go to.
    pub fn tracks(&self) -> Vec<(f64, Vec<f64>)> {
        let mut out: Vec<(f64, Vec<f64>)> = Vec::new();
        for p in &self.passes {
            match out.last_mut() {
                Some((aside, depths)) if (*aside - p.aside).abs() < 1e-9 => depths.push(p.depth),
                _ => out.push((p.aside, vec![p.depth])),
            }
        }
        out
    }

    /// The deepest the tip goes.
    pub fn depth(&self) -> f64 {
        self.passes.iter().map(|p| p.depth).fold(0.0, f64::max)
    }
}

/// Wood taken off a section, column by column.
struct Section {
    step: f64,
    /// How deep each column has been cut, from `x = 0` on.
    cut: Vec<f64>,
}

/// What one pass did to the section.
struct Taken {
    area: f64,
    /// How deep into wood the body above the cutting edges went.
    rubbed: f64,
}

impl Section {
    fn new(across: f64, reach: f64) -> Section {
        let span = across + 2.0 * reach + 0.5;
        let step = (across / 1500.0).clamp(0.001, 0.005);
        Section {
            step,
            cut: vec![0.0; (span / step).ceil() as usize],
        }
    }

    fn x(&self, i: usize) -> f64 {
        (i as f64 + 0.5) * self.step
    }

    fn apply(&mut self, bit: &EdgeBit, pass: &Pass) -> Taken {
        let axis = -pass.aside;
        let (body, height) = (bit.body_radius(), bit.cut_height());
        let first = ((axis - body) / self.step).floor().max(0.0) as usize;
        let last = (((axis + body) / self.step).ceil().max(0.0) as usize).min(self.cut.len());
        let mut taken = Taken {
            area: 0.0,
            rubbed: 0.0,
        };
        for i in first..last {
            let rho = (self.x(i) - axis).abs();
            if rho > body {
                continue;
            }
            let here = self.cut[i];
            // Above the cutting edges the bit keeps its shape, and cuts nothing.
            let body_bottom = pass.depth - height.max(bit.shape(rho));
            taken.rubbed = taken.rubbed.max(body_bottom - here);
            if let Some(lift) = bit.lift(rho) {
                let bottom = pass.depth - lift;
                if bottom > here {
                    taken.area += (bottom - here) * self.step;
                    self.cut[i] = bottom;
                }
            }
        }
        taken
    }

    /// How deep the cut is at `x`.
    fn at(&self, x: f64) -> f64 {
        let i = ((x / self.step).floor().max(0.0) as usize).min(self.cut.len() - 1);
        self.cut[i]
    }
}

/// Wood that rubbing deeper than this leaves alone, mm: the section's own
/// rounding.
const RUB_TOLERANCE: f64 = 1e-3;
/// How many passes an edge may take before the plan is given up on.
const MAX_PASSES: usize = 2000;
const TOO_MANY: &str =
    "The edge would take more passes than a file can sensibly hold. Use a larger bit, or a row with a deeper stepdown.";
/// How far over a groove a pass may go to save a pass that would take a
/// sliver: the plan's own rounding, not a load anyone would notice.
const GROOVE_SLACK: f64 = 1.01;

/// Why the passes on one track will not do.
enum OneTrack {
    /// The body above the cutting edges would run through wood.
    Rubs,
    TooMany,
}
use OneTrack::{Rubs, TooMany};

/// The widest bevel a V-bit cuts from the one track beside the edge, its
/// tip `tip_clearance` clear of it, mm: as far as its cutting edges reach
/// across. Infinite for a corner-rounding bit, which has no width.
pub fn one_track_width(bit: &EdgeBit, tip_clearance: f64) -> f64 {
    match *bit {
        EdgeBit::V { half_angle, .. } => {
            (bit.cut_height() * half_angle.tan() - tip_clearance).max(0.0)
        }
        EdgeBit::Round { .. } => f64::INFINITY,
    }
}

/// Plans the passes that shape an edge, or says why it cannot be done.
pub fn plan(bit: &EdgeBit, spec: &EdgeSpec) -> Result<EdgePlan, String> {
    if spec.stepdown <= 0.0 || spec.groove <= 0.0 {
        return Err("The cutting row's stepdown must be greater than 0.".into());
    }
    let (across, down, aside, one_track) = match *bit {
        EdgeBit::V {
            half_angle,
            tip_radius,
            ..
        } => {
            let aside = tip_radius + spec.tip_clearance;
            (
                spec.width,
                spec.width / half_angle.tan(),
                aside,
                one_track_width(bit, spec.tip_clearance),
            )
        }
        EdgeBit::Round {
            tip_radius, corner, ..
        } => (corner, corner, tip_radius, f64::INFINITY),
    };
    if across <= 0.0 {
        return Err("The edge has nothing to cut: its width is 0.".into());
    }
    let last = match *bit {
        EdgeBit::V { half_angle, .. } => (spec.width + spec.tip_clearance) / half_angle.tan(),
        EdgeBit::Round { corner, .. } => corner,
    };

    let (passes, layers) = match (one_track_levels(bit, aside, last, spec), *bit) {
        (Ok(passes), _) => (passes, 1),
        (
            Err(Rubs),
            EdgeBit::V {
                half_angle,
                tip_radius,
                ..
            },
        ) => layered(bit, half_angle.tan(), tip_radius, aside, last, spec)?,
        // A corner-rounding bit whose cutting edges stop short of its radius.
        (Err(Rubs), EdgeBit::Round { .. }) => {
            return Err(format!(
                "The cutting edges reach {} mm up, short of the bit's {} mm radius.",
                round2(bit.cut_height()),
                round2(across)
            ))
        }
        (Err(TooMany), _) => return Err(TOO_MANY.into()),
    };

    if passes.is_empty() {
        return Err("The edge has nothing to cut: the bit goes no depth into it.".into());
    }
    // Run once more in a fresh section, for what each pass takes and for
    // drawing.
    let mut section = Section::new(across, bit.body_radius());
    let columns = 96;
    let mut surfaces = Vec::with_capacity(passes.len());
    let mut done = Vec::with_capacity(passes.len());
    for p in passes {
        let taken = section.apply(bit, &p);
        done.push(Pass {
            area: taken.area,
            ..p
        });
        surfaces.push(
            (0..=columns)
                .map(|i| section.at(across * i as f64 / columns as f64))
                .collect(),
        );
    }
    Ok(EdgePlan {
        passes: done,
        layers,
        stepdown: spec.stepdown,
        groove: spec.groove,
        across,
        down,
        one_track,
        surfaces,
        columns,
    })
}

/// A length as the messages give it: to the hundredth, without trailing zeros.
fn round2(v: f64) -> String {
    let s = format!("{:.2}", (v * 100.0).round() / 100.0);
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// The depths of the passes on the one track beside the edge, from its
/// surface down to `last`: each at most a stepdown deeper, each taking at
/// most a groove, and as evenly loaded as that number of passes allows.
fn one_track_levels(
    bit: &EdgeBit,
    aside: f64,
    last: f64,
    spec: &EdgeSpec,
) -> Result<Vec<Pass>, OneTrack> {
    // What the bit takes from fresh wood with its tip at depth z is a sum
    // over columns of how far z is below the cutter's surface there.
    let mut section = Section::new(0.0, bit.body_radius());
    let mut lifts: Vec<f64> = (0..section.cut.len())
        .filter_map(|i| bit.lift((section.x(i) + aside).abs()))
        .collect();
    lifts.sort_by(f64::total_cmp);
    let mut sums = vec![0.0];
    for l in &lifts {
        sums.push(sums.last().unwrap() + l);
    }
    let step = section.step;
    let taken = |z: f64| -> f64 {
        let k = lifts.partition_point(|&l| l < z);
        step * (k as f64 * z - sums[k])
    };

    let levels = |cap: f64| -> Option<Vec<f64>> {
        let mut out = Vec::new();
        let mut z = 0.0f64;
        while z < last - 1e-9 {
            let hi = (z + spec.stepdown).min(last);
            let next = if taken(hi) - taken(z) <= cap {
                hi
            } else {
                let (mut lo, mut up) = (z, hi);
                for _ in 0..40 {
                    let mid = (lo + up) / 2.0;
                    if taken(mid) - taken(z) <= cap {
                        lo = mid;
                    } else {
                        up = mid;
                    }
                }
                lo
            };
            let next = if next > last - 1e-6 { last } else { next };
            if next <= z + 1e-7 || out.len() >= MAX_PASSES {
                return None;
            }
            z = next;
            out.push(z);
        }
        Some(out)
    };

    let fewest = levels(spec.groove * GROOVE_SLACK).ok_or(TooMany)?;
    // The smallest load that still needs no more passes than that: the last
    // passes then share what is left, instead of one taking a sliver.
    let (mut lo, mut hi) = (0.0, spec.groove * GROOVE_SLACK);
    for _ in 0..30 {
        let mid = (lo + hi) / 2.0;
        match levels(mid) {
            Some(l) if l.len() <= fewest.len() => hi = mid,
            _ => lo = mid,
        }
    }
    let depths = levels(hi).unwrap_or(fewest);
    let passes: Vec<Pass> = depths
        .into_iter()
        .map(|depth| Pass {
            aside,
            depth,
            area: 0.0,
        })
        .collect();
    for p in &passes {
        let t = section.apply(bit, p);
        if t.rubbed > RUB_TOLERANCE {
            return Err(Rubs);
        }
    }
    Ok(passes)
}

/// The passes of a bevel too wide for one track, in layers of equal depth.
/// In each layer the first track has its flank on the bevel and the last
/// runs beside the edge; those between are close enough that the ridges they
/// leave stay clear of the next layer's body.
fn layered(
    bit: &EdgeBit,
    tan: f64,
    tip_radius: f64,
    aside: f64,
    last: f64,
    spec: &EdgeSpec,
) -> Result<(Vec<Pass>, usize), String> {
    let height = bit.cut_height();
    let build = |t: f64| layered_build(bit, tan, tip_radius, aside, last, spec, t);
    let fits = |passes: &[Pass]| -> bool {
        let mut section = Section::new(spec.width, bit.body_radius());
        passes.iter().all(|p| {
            let t = section.apply(bit, p);
            t.rubbed <= RUB_TOLERANCE && t.area <= spec.groove * GROOVE_SLACK
        })
    };

    // Of the layer depths, the one with the fewest passes that fits: the
    // candidates are cheap to lay out, and only checked in that order.
    let top = spec.stepdown.min(height / 2.0);
    let mut candidates: Vec<(Vec<Pass>, usize)> = (0..40)
        .filter_map(|k| build(top * 0.9f64.powi(k)))
        .collect();
    candidates.sort_by_key(|(passes, _)| passes.len());
    candidates
        .into_iter()
        .find(|(passes, _)| fits(passes))
        .ok_or_else(|| TOO_MANY.into())
}

/// The layers of `layered` for a layer depth `t`, and how many there are.
/// `None` when they would take too many passes.
fn layered_build(
    bit: &EdgeBit,
    tan: f64,
    tip_radius: f64,
    aside: f64,
    last: f64,
    spec: &EdgeSpec,
    t: f64,
) -> Option<(Vec<Pass>, usize)> {
    let height = bit.cut_height();
    let bevel_height = spec.width / tan;
    // Ridges between tracks stand (gap/2 - tip radius)/tan above the layer;
    // with the layer's depth they must stay within the flank.
    let half_gap = (tip_radius + t * tan).min(tip_radius + (height - t) * tan);
    let gap = 2.0 * half_gap;
    if gap < 1e-3 {
        return None;
    }
    let count = (last / t - 1e-9).ceil().max(1.0) as usize;
    let mut passes = Vec::new();
    for j in 1..=count {
        let z = last * j as f64 / count as f64;
        let inner = (bevel_height - z) * tan - tip_radius;
        let outer = -aside;
        if inner <= outer + 1e-9 {
            if passes.len() >= MAX_PASSES {
                return None;
            }
            passes.push(Pass {
                aside,
                depth: z,
                area: 0.0,
            });
            continue;
        }
        let k = (((inner - outer) / gap - 1e-9).ceil() as usize + 1).max(2);
        for i in 0..k {
            let x = inner + (outer - inner) * i as f64 / (k - 1) as f64;
            passes.push(Pass {
                aside: -x,
                depth: z,
                area: 0.0,
            });
        }
    }
    Some((passes, count))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vbit(diameter: f64, angle: f64, tip: f64) -> EdgeBit {
        EdgeBit::V {
            half_angle: (angle / 2.0).to_radians(),
            tip_radius: tip / 2.0,
            radius: diameter / 2.0,
            flutes: None,
        }
    }

    /// The groove a V-bit's row is sized for.
    fn groove(bit: &EdgeBit, stepdown: f64) -> f64 {
        match *bit {
            EdgeBit::V {
                half_angle,
                tip_radius,
                ..
            } => stepdown * (2.0 * tip_radius + stepdown * half_angle.tan()),
            EdgeBit::Round { tip_radius, .. } => stepdown * (2.0 * tip_radius + stepdown),
        }
    }

    fn spec(bit: &EdgeBit, width: f64, stepdown: f64) -> EdgeSpec {
        EdgeSpec {
            width,
            tip_clearance: 0.2,
            stepdown,
            groove: groove(bit, stepdown),
        }
    }

    /// Runs a plan in a fresh section and checks what every plan must keep:
    /// within both limits, the body clear of wood, and the edge shaped.
    fn check(bit: &EdgeBit, spec: &EdgeSpec, plan: &EdgePlan, want: impl Fn(f64) -> f64) {
        let mut section = Section::new(plan.across, bit.body_radius());
        for p in &plan.passes {
            let t = section.apply(bit, p);
            assert!(t.rubbed <= RUB_TOLERANCE, "body in wood by {}", t.rubbed);
            assert!(
                t.area <= spec.groove * GROOVE_SLACK,
                "{} over {}",
                t.area,
                spec.groove
            );
        }
        // Each depth, on one track or as a layer, at most a stepdown below the one before.
        let mut depths: Vec<f64> = plan.passes.iter().map(|p| p.depth).collect();
        depths.sort_by(f64::total_cmp);
        depths.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
        let mut above = 0.0;
        for d in depths {
            assert!(d - above <= spec.stepdown + 1e-9, "{above} to {d}");
            above = d;
        }
        // From just inside the wall, where a rounding stands upright.
        let mut x = 0.025;
        while x < plan.across {
            let err = (section.at(x) - want(x)).abs();
            assert!(err < 0.02, "at {x}: {} against {}", section.at(x), want(x));
            x += 0.05;
        }
    }

    #[test]
    fn passes_get_shallower_as_the_bevel_widens() {
        let bit = vbit(6.0, 90.0, 0.2);
        let s = spec(&bit, 2.5, 0.5);
        let plan = plan(&bit, &s).unwrap();
        assert_eq!(plan.layers, 1);
        // 0.5 mm steps while the bevel is narrow, then smaller and smaller.
        let steps: Vec<f64> = std::iter::once(0.0)
            .chain(plan.passes.iter().map(|p| p.depth))
            .collect::<Vec<_>>()
            .windows(2)
            .map(|w| w[1] - w[0])
            .collect();
        assert!((steps[0] - 0.5).abs() < 1e-6, "{steps:?}");
        assert!(steps.windows(2).all(|w| w[1] <= w[0] + 1e-6), "{steps:?}");
        assert!(
            steps.last().unwrap() > &0.05,
            "no sliver at the end: {steps:?}"
        );
        assert_eq!(plan.passes.len(), 10);
        check(&bit, &s, &plan, |x| (2.5 - x).max(0.0));
    }

    #[test]
    fn equal_steps_would_take_several_grooves_at_the_bottom() {
        // What the plan is for: the last of six equal steps takes nearly three.
        let bit = vbit(6.0, 90.0, 0.2);
        let s = spec(&bit, 2.5, 0.5);
        let mut section = Section::new(2.5, 3.0);
        let last = 2.7;
        let mut worst: f64 = 0.0;
        for k in 1..=6 {
            let t = section.apply(
                &bit,
                &Pass {
                    aside: 0.3,
                    depth: last * k as f64 / 6.0,
                    area: 0.0,
                },
            );
            worst = worst.max(t.area / s.groove);
        }
        assert!(worst > 2.5, "{worst}");
        let planned = plan(&bit, &s).unwrap();
        assert!(planned
            .passes
            .iter()
            .all(|p| p.area <= s.groove * GROOVE_SLACK));
    }

    #[test]
    fn a_narrow_bevel_in_a_deep_stepdown_is_one_pass() {
        let bit = vbit(6.0, 90.0, 0.2);
        let s = spec(&bit, 0.5, 1.5);
        let plan = plan(&bit, &s).unwrap();
        assert_eq!(plan.passes.len(), 1);
        assert!((plan.passes[0].depth - 0.7).abs() < 1e-9);
    }

    #[test]
    fn a_bevel_wider_than_the_flank_is_cut_in_layers() {
        for (d, angle, tip, width, stepdown) in [
            (6.0, 90.0, 0.2, 6.0, 1.0),
            (6.0, 90.0, 0.2, 10.0, 1.0),
            (3.175, 60.0, 0.1, 3.0, 0.5),
            (6.0, 60.0, 0.2, 4.0, 0.8),
            (3.175, 60.0, 0.2, 8.0, 0.3),
        ] {
            let bit = vbit(d, angle, tip);
            let s = spec(&bit, width, stepdown);
            let plan = plan(&bit, &s).unwrap();
            assert!(plan.layers > 1, "{d} {angle} {width}");
            assert!(width > plan.one_track);
            let tan = (angle / 2.0).to_radians().tan();
            check(&bit, &s, &plan, |x| ((width - x) / tan).max(0.0));
            // The last pass runs beside the edge, as a one-track chamfer's does.
            let end = plan.passes.last().unwrap();
            assert!((end.aside - (tip / 2.0 + 0.2)).abs() < 1e-9);
        }
    }

    #[test]
    fn short_flutes_make_a_bevel_wide() {
        let mut bit = vbit(6.0, 90.0, 0.2);
        let s = spec(&bit, 2.5, 1.0);
        assert_eq!(plan(&bit, &s).unwrap().layers, 1);
        if let EdgeBit::V { flutes, .. } = &mut bit {
            *flutes = Some(1.5);
        }
        let plan = plan(&bit, &s).unwrap();
        assert!(plan.layers > 1);
        check(&bit, &s, &plan, |x| (2.5 - x).max(0.0));
    }

    #[test]
    fn a_corner_rounding_bit_rounds_in_passes_within_the_row() {
        let bit = EdgeBit::Round {
            tip_radius: 1.5,
            corner: 3.0,
            radius: 4.5,
            flutes: None,
        };
        let s = spec(&bit, 0.0, 1.0);
        let plan = plan(&bit, &s).unwrap();
        assert_eq!(plan.layers, 1);
        // Three stepdowns: the groove of a 90° cone 1 mm deep is more than any of them takes.
        assert_eq!(plan.passes.len(), 3);
        assert!(plan.passes.iter().all(|p| (p.aside - 1.5).abs() < 1e-9));
        assert!((plan.depth() - 3.0).abs() < 1e-9);
        // A quarter circle about (3, 3), from the wall at 3 deep to the surface 3 in.
        check(&bit, &s, &plan, |x| {
            3.0 - (9.0 - (3.0 - x) * (3.0 - x)).max(0.0).sqrt()
        });
        // On a shallow stepdown the stepdown binds: 15 steps of 0.2 mm.
        let fine = super::plan(&bit, &spec(&bit, 0.0, 0.2)).unwrap();
        check(&bit, &spec(&bit, 0.0, 0.2), &fine, |x| {
            3.0 - (9.0 - (3.0 - x) * (3.0 - x)).max(0.0).sqrt()
        });
        assert_eq!(fine.passes.len(), 15);
        // A small one in a deep stepdown is one pass.
        let small = EdgeBit::Round {
            tip_radius: 1.5,
            corner: 1.0,
            radius: 2.5,
            flutes: None,
        };
        let one = super::plan(&small, &spec(&small, 0.0, 1.5)).unwrap();
        assert_eq!(one.passes.len(), 1);
    }

    #[test]
    fn a_corner_rounding_bit_with_short_flutes_is_refused() {
        let bit = EdgeBit::Round {
            tip_radius: 1.5,
            corner: 3.0,
            radius: 4.5,
            flutes: Some(2.0),
        };
        let err = plan(&bit, &spec(&bit, 0.0, 1.0)).unwrap_err();
        assert!(err.contains("short of the bit's 3 mm radius"), "{err}");
    }

    #[test]
    fn the_drawing_ends_on_the_edge() {
        let bit = vbit(6.0, 90.0, 0.2);
        let plan = plan(&bit, &spec(&bit, 2.0, 0.5)).unwrap();
        assert_eq!(plan.surfaces.len(), plan.passes.len());
        let last = plan.surfaces.last().unwrap();
        assert_eq!(last.len(), plan.columns + 1);
        assert!((last[0] - 2.0).abs() < 0.02);
        assert!(last[plan.columns].abs() < 0.02);
    }
}
