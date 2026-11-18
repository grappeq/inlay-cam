//! Cutting parts out of a board: the tool runs around each part with its
//! edge on the part's outline, going deeper each time round until it is
//! through.
//!
//! A part's holes are cut first, while the part is still held by the board.
//! With tabs, short stretches of the last passes are left uncut so the part
//! stays attached until it is broken or sawn free.

use crate::geom::offset::offset;
use crate::geom::{distance, Point, Region, Ring};
use crate::ops::clear::{nearest_vertex, ramp_in, ring_run};
use crate::toolpath::PathBuilder;

#[derive(Debug, Clone, PartialEq)]
pub struct ProfileParams {
    pub tool_diameter: f64,
    /// How deep to cut below Z0: the board's thickness plus a little. Positive.
    pub depth: f64,
    /// Largest depth per pass, mm.
    pub stepdown: f64,
    pub feed: f64,
    pub plunge: f64,
    pub tabs: Option<Tabs>,
    /// Depth gained per mm of travel when the tool goes down into wood along
    /// its path. 0 to plunge straight down.
    pub ramp: f64,
    /// Wood left on the parts' edges while cutting down, and taken off in one
    /// pass at the end. 0 to cut on the outline from the start.
    pub finish: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Tabs {
    /// How far above the cut's full depth the top of a tab is, mm.
    pub height: f64,
    /// Width of wood left in each tab, mm.
    pub width: f64,
    /// Roughly how far apart tabs are along the outline, mm.
    pub spacing: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ProfileError {
    /// Two parts are closer together than the tool is wide, so the tool
    /// cannot pass between them.
    PartsTooClose,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct ProfileReport {
    /// Tabs left on each part, in the order the parts were given.
    pub tabs: Vec<usize>,
}

/// Appends the moves that cut `parts` out. The tool must already be loaded
/// and spinning.
pub fn profile(
    path: &mut PathBuilder,
    parts: &[Region],
    p: &ProfileParams,
) -> Result<ProfileReport, ProfileError> {
    let radius = p.tool_diameter / 2.0;
    // Grown together, parts closer than the tool's width merge.
    if offset(parts, radius).len() < parts.len() {
        return Err(ProfileError::PartsTooClose);
    }
    let tracks: Vec<Vec<Region>> = parts
        .iter()
        .map(|part| offset(std::slice::from_ref(part), radius))
        .collect();
    // Cutting down a little further out leaves the edge for one clean pass.
    // Not where that would close the way between two parts.
    let further = radius + p.finish;
    let rough: Option<Vec<Vec<Region>>> =
        (p.finish > 0.0 && offset(parts, further).len() >= parts.len()).then(|| {
            parts
                .iter()
                .map(|part| offset(std::slice::from_ref(part), further))
                .collect()
        });
    Ok(follow(path, &tracks, rough.as_deref(), p))
}

/// A ring's holes first, then its outline: the waste in a hole is not what
/// holds a part. The flag says which is the outline.
fn rings_of(track: &Region) -> impl Iterator<Item = (&Ring, bool)> {
    track
        .holes
        .iter()
        .map(|ring| (ring, false))
        .chain(std::iter::once((&track.outer, true)))
}

/// Appends the moves that take the tool's centre along ready-made tracks,
/// one set of tracks per part, going deeper each time round. Tabs, when
/// asked for, are left on the outer ring of each track.
///
/// With `rough`, a second set of tracks per part that keep a little further
/// from the wood that stays, those are cut first, down to where the tabs
/// start. The tracks proper then take what is left on the wall in one pass at
/// that depth, and cut the rest, with the tabs, alone.
pub fn follow(
    path: &mut PathBuilder,
    parts: &[Vec<Region>],
    rough: Option<&[Vec<Region>]>,
    p: &ProfileParams,
) -> ProfileReport {
    let mut report = ProfileReport::default();
    let tab_top = p.tabs.map_or(p.depth, |t| p.depth - t.height);

    // Round a ring from depth `from` to depth `to`, a stepdown at a time.
    let descend = |path: &mut PathBuilder,
                   ring: &Ring,
                   stations: &[(Point, f64)],
                   start: usize,
                   tabs: &[(f64, f64)],
                   from: f64,
                   to: f64| {
        if to - from < 1e-9 {
            return;
        }
        let length = stations.last().map_or(0.0, |s| s.1);
        let passes = ((to - from) / p.stepdown).ceil().max(1.0) as usize;
        for pass in 1..=passes {
            let z = from + (to - from) * pass as f64 / passes as f64;
            let above = from + (to - from) * (pass - 1) as f64 / passes as f64;
            // Below the top of the tabs the way down must keep off them: it
            // has only the stretch between the last tab and the start.
            let limit = match tabs.last() {
                Some(last) if z > tab_top + 1e-9 => (length - last.1).max(0.0),
                _ => f64::INFINITY,
            };
            let needed = if p.ramp > 0.0 {
                (z - above) / p.ramp
            } else {
                0.0
            };
            let run = ring_run(ring, start, needed.min(limit));
            ramp_in(path, &run, -above, -z, p.ramp, limit, p.feed, p.plunge);
            cut_round(path, stations, z, tab_top, tabs, p);
        }
    };

    for (i, part) in parts.iter().enumerate() {
        let mut tabs_left = 0;
        let roughed = match rough.and_then(|r| r.get(i)) {
            Some(further) if tab_top > 1e-9 => {
                for track in further {
                    for (ring, _) in rings_of(track) {
                        let start = nearest_vertex(ring, path.position().map(|q| [q[0], q[1]]));
                        descend(path, ring, &stations(ring, start), start, &[], 0.0, tab_top);
                    }
                }
                tab_top
            }
            _ => 0.0,
        };
        for track in part {
            for (ring, outline) in rings_of(track) {
                let start = nearest_vertex(ring, path.position().map(|q| [q[0], q[1]]));
                let stations = stations(ring, start);
                let length = stations.last().map_or(0.0, |s| s.1);
                let tabs = match p.tabs {
                    Some(tabs) if outline => tab_stretches(length, p.tool_diameter, tabs),
                    _ => Vec::new(),
                };
                tabs_left += tabs.len();
                if roughed > 0.0 {
                    // What was left on the wall, in one pass down its whole height.
                    let needed = if p.ramp > 0.0 { roughed / p.ramp } else { 0.0 };
                    let run = ring_run(ring, start, needed);
                    ramp_in(
                        path,
                        &run,
                        0.0,
                        -roughed,
                        p.ramp,
                        f64::INFINITY,
                        p.feed,
                        p.plunge,
                    );
                    cut_round(path, &stations, roughed, tab_top, &[], p);
                }
                descend(path, ring, &stations, start, &tabs, roughed, p.depth);
            }
        }
        report.tabs.push(tabs_left);
        path.retract();
    }
    report
}

/// Takes the tool's centre round every ring of `tracks`, once at each of
/// `depths` in turn, going straight down at the start of each round. No tabs
/// and no finishing pass: for shaping an edge, whose depths are planned for
/// it (`ops::chamfer`).
pub fn follow_depths(
    path: &mut PathBuilder,
    tracks: &[Region],
    depths: &[f64],
    feed: f64,
    plunge: f64,
) {
    let p = ProfileParams {
        tool_diameter: 0.0,
        depth: depths.iter().copied().fold(0.0, f64::max),
        stepdown: f64::INFINITY,
        feed,
        plunge,
        tabs: None,
        ramp: 0.0,
        finish: 0.0,
    };
    for track in tracks {
        for (ring, _) in rings_of(track) {
            let start = nearest_vertex(ring, path.position().map(|q| [q[0], q[1]]));
            let stations = stations(ring, start);
            let mut above = 0.0;
            for &z in depths {
                let run = ring_run(ring, start, 0.0);
                ramp_in(path, &run, -above, -z, 0.0, f64::INFINITY, feed, plunge);
                cut_round(path, &stations, z, z, &[], &p);
                above = z;
            }
        }
    }
    path.retract();
}

/// The ring's points from `start` round to `start` again, each with its
/// distance along the ring.
fn stations(ring: &Ring, start: usize) -> Vec<(Point, f64)> {
    let mut out = Vec::with_capacity(ring.len() + 1);
    let mut along = 0.0;
    out.push((ring[start], 0.0));
    for i in 1..=ring.len() {
        let (a, b) = (
            ring[(start + i - 1) % ring.len()],
            ring[(start + i) % ring.len()],
        );
        along += distance(a, b);
        out.push((b, along));
    }
    out
}

/// Stretches of the outline, as distances along it, over which the tool
/// lifts to leave a tab. Each is the tab's width plus the tool's, since the
/// tool cuts half its width into both ends. None when the outline is too
/// short to hold two.
fn tab_stretches(length: f64, tool_diameter: f64, tabs: Tabs) -> Vec<(f64, f64)> {
    let stretch = tabs.width + tool_diameter;
    let wanted = (length / tabs.spacing).ceil().max(3.0) as usize;
    // Leave at least as much cut as tab, and keep clear of the start point.
    let count = wanted.min((length / (2.0 * stretch)).floor() as usize);
    if count < 2 {
        return Vec::new();
    }
    (0..count)
        .map(|i| {
            let centre = (i as f64 + 0.5) * length / count as f64;
            (centre - stretch / 2.0, centre + stretch / 2.0)
        })
        .collect()
}

/// One trip round the ring at depth `z`, lifting to `tab_top` over the tab
/// stretches when `z` is below it.
fn cut_round(
    path: &mut PathBuilder,
    stations: &[(Point, f64)],
    z: f64,
    tab_top: f64,
    tabs: &[(f64, f64)],
    p: &ProfileParams,
) {
    let lifting = z > tab_top + 1e-9;
    for pair in stations.windows(2) {
        let ((a, s0), (b, s1)) = (pair[0], pair[1]);
        // Break the segment wherever a tab starts or ends inside it.
        let mut stops = vec![s0];
        if lifting {
            for &(from, to) in tabs {
                for s in [from, to] {
                    if s > s0 + 1e-9 && s < s1 - 1e-9 {
                        stops.push(s);
                    }
                }
            }
            stops.sort_by(f64::total_cmp);
        }
        stops.push(s1);
        for piece in stops.windows(2) {
            let at = |s: f64| -> Point {
                let t = if s1 > s0 { (s - s0) / (s1 - s0) } else { 0.0 };
                [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
            };
            let middle = (piece[0] + piece[1]) / 2.0;
            let over_tab = lifting && tabs.iter().any(|&(from, to)| middle > from && middle < to);
            let depth = if over_tab { tab_top } else { z };
            let (from, to) = (at(piece[0]), at(piece[1]));
            // Straight up or down at the ends of a tab.
            path.feed_to([from[0], from[1], -depth], p.plunge);
            path.feed_to([to[0], to[1], -depth], p.feed);
        }
    }
    // A pass that ends over a tab would leave the next plunge off depth.
    if let Some(&(last, _)) = stations.last() {
        path.feed_to([last[0], last[1], -z], p.plunge);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::fixtures::*;
    use crate::toolpath::Move;
    use crate::toolpath::PLUNGE_CLEARANCE;

    fn params(tabs: bool) -> ProfileParams {
        ProfileParams {
            tool_diameter: 3.0,
            depth: 4.2,
            stepdown: 1.5,
            feed: 600.0,
            plunge: 100.0,
            tabs: tabs.then_some(Tabs {
                height: 1.0,
                width: 4.0,
                spacing: 40.0,
            }),
            ramp: 0.0,
            finish: 0.0,
        }
    }

    fn run(parts: &[Region], p: &ProfileParams) -> (Vec<Move>, ProfileReport) {
        let mut path = PathBuilder::new(5.0);
        path.start_tool(1, 12000);
        let report = profile(&mut path, parts, p).unwrap();
        (path.finish(), report)
    }

    fn feeds(moves: &[Move]) -> Vec<[f64; 3]> {
        moves
            .iter()
            .filter_map(|m| match m {
                Move::Feed { to, .. } => Some(*to),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn the_tool_stays_its_radius_outside_the_part_and_inside_its_holes() {
        let part = Region::with_holes(
            rect(0.0, 0.0, 40.0, 30.0),
            vec![rect_cw(10.0, 10.0, 25.0, 20.0)],
        );
        let (moves, _) = run(std::slice::from_ref(&part), &params(false));
        let cuts = feeds(&moves);
        assert!(!cuts.is_empty());
        let (mut outside, mut inside) = (0, 0);
        for q in &cuts {
            let xy = [q[0], q[1]];
            assert!(
                !part.contains(xy),
                "tool centre is inside the part at {xy:?}"
            );
            assert!(
                (part.distance_to_boundary(xy) - 1.5).abs() < 0.01,
                "tool is not on the outline at {xy:?}"
            );
            if xy[0] > 10.0 && xy[0] < 25.0 && xy[1] > 10.0 && xy[1] < 20.0 {
                inside += 1;
            } else {
                outside += 1;
            }
        }
        assert!(inside > 0 && outside > 0);
        // The hole is finished before the outline is started.
        let first_outside = cuts
            .iter()
            .position(|q| !(q[0] > 10.0 && q[0] < 25.0 && q[1] > 10.0 && q[1] < 20.0))
            .unwrap();
        assert!(cuts[..first_outside]
            .iter()
            .any(|q| (q[2] + 4.2).abs() < 1e-9));
    }

    #[test]
    fn goes_through_in_even_passes() {
        let (moves, report) = run(&[Region::new(rect(0.0, 0.0, 30.0, 20.0))], &params(false));
        let mut depths: Vec<f64> = feeds(&moves).iter().map(|q| -q[2]).collect();
        depths.sort_by(f64::total_cmp);
        depths.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
        assert_eq!(depths.len(), 3);
        for (d, e) in depths.iter().zip([1.4, 2.8, 4.2]) {
            assert!((d - e).abs() < 1e-9);
        }
        assert_eq!(report.tabs, [0]);
    }

    #[test]
    fn tabs_are_left_on_the_outline_in_the_last_millimetre() {
        let part = Region::new(rect(0.0, 0.0, 60.0, 40.0));
        let (moves, report) = run(std::slice::from_ref(&part), &params(true));
        // 212 mm round the tool's track at 40 mm apart: six tabs.
        assert_eq!(report.tabs, [6]);
        let cuts = feeds(&moves);
        // Level cutting moves at the tab height on the last pass only.
        let mut tab_length = 0.0;
        let mut previous: Option<[f64; 3]> = None;
        for q in &cuts {
            if let Some(a) = previous {
                if (a[2] + 3.2).abs() < 1e-9 && (q[2] + 3.2).abs() < 1e-9 {
                    tab_length += distance([a[0], a[1]], [q[0], q[1]]);
                }
            }
            previous = Some(*q);
        }
        // Six stretches of tab width plus tool width.
        assert!(
            (tab_length - 6.0 * 7.0).abs() < 1e-6,
            "tab length {tab_length}"
        );
        // Nothing is ever cut shallower than a tab once below it, and the
        // full depth is reached between tabs.
        assert!(cuts.iter().any(|q| (q[2] + 4.2).abs() < 1e-9));
    }

    /// Every cutting move with where it started, to tell plunges from ramps.
    fn cuts_with_starts(moves: &[Move]) -> Vec<([f64; 3], [f64; 3])> {
        let mut at: Option<[f64; 3]> = None;
        let mut out = Vec::new();
        for m in moves {
            let to = match m {
                Move::Feed { to, .. } | Move::Rapid { to } => *to,
                _ => continue,
            };
            if let (Some(a), Move::Feed { .. }) = (at, m) {
                out.push((a, to));
            }
            at = Some(to);
        }
        out
    }

    #[test]
    fn the_tool_ramps_down_along_the_outline_and_keeps_off_the_tabs() {
        let part = Region::new(rect(0.0, 0.0, 60.0, 40.0));
        let p = ProfileParams {
            ramp: 0.0875,
            ..params(true)
        };
        let (moves, report) = run(std::slice::from_ref(&part), &p);
        assert_eq!(report.tabs, [6]);
        let mut tab_length = 0.0;
        for (a, to) in cuts_with_starts(&moves) {
            let across = distance([a[0], a[1]], [to[0], to[1]]);
            let down = a[2] - to[2];
            // Below the surface the tool only goes down while moving along,
            // except at the ends of a tab, where it steps over wood it leaves.
            if down > 1e-9 && to[2] < -1e-9 && across < 1e-9 {
                assert!(
                    (a[2] + 3.2).abs() < 1e-9,
                    "a straight plunge from {a:?} to {to:?}"
                );
            }
            if down > 1e-9 && across > 1e-9 {
                assert!(down / across <= 0.0875 + 1e-6);
            }
            // Always on the outline's track.
            assert!((part.distance_to_boundary([to[0], to[1]]) - 1.5).abs() < 0.01);
            if (a[2] + 3.2).abs() < 1e-9 && (to[2] + 3.2).abs() < 1e-9 {
                tab_length += across;
            }
        }
        // The tabs are whole: six stretches of tab width plus tool width.
        assert!(
            (tab_length - 6.0 * 7.0).abs() < 1e-6,
            "tab length {tab_length}"
        );
    }

    #[test]
    fn with_an_allowance_the_edge_is_cut_in_one_pass_at_the_end() {
        let part = Region::with_holes(
            rect(0.0, 0.0, 60.0, 40.0),
            vec![rect_cw(20.0, 15.0, 40.0, 25.0)],
        );
        for tabs in [false, true] {
            let p = ProfileParams {
                finish: 0.2,
                ..params(tabs)
            };
            let (moves, report) = run(std::slice::from_ref(&part), &p);
            assert_eq!(report.tabs, [if tabs { 6 } else { 0 }]);
            // Down to where the tabs start, the cutting is 0.2 mm further out;
            // on the outline's own track there is one pass at that depth and
            // only what is below it after that.
            let rough_to = if tabs { 3.2 } else { 4.2 };
            let (mut further, mut on_track) = (0, 0);
            for (a, to) in cuts_with_starts(&moves) {
                let xy = [to[0], to[1]];
                assert!(!part.contains(xy));
                let off = part.distance_to_boundary(xy);
                let level = (a[2] - to[2]).abs() < 1e-9 && distance([a[0], a[1]], xy) > 1e-9;
                if (off - 1.7).abs() < 0.01 {
                    assert!(
                        to[2] >= -rough_to - 1e-9,
                        "roughing below the tabs' top at {to:?}"
                    );
                    further += 1;
                } else {
                    assert!((off - 1.5).abs() < 0.01, "{off} mm from the part at {xy:?}");
                    if level {
                        assert!(
                            to[2] <= -rough_to + 1e-9,
                            "a shallow pass on the edge at {to:?}"
                        );
                        on_track += 1;
                    }
                }
            }
            assert!(further > 0 && on_track > 0);
        }
    }

    #[test]
    fn a_part_too_small_for_tabs_gets_none() {
        let (_, report) = run(&[Region::new(rect(0.0, 0.0, 4.0, 4.0))], &params(true));
        assert_eq!(report.tabs, [0]);
    }

    #[test]
    fn parts_the_tool_cannot_pass_between_are_refused() {
        let mut path = PathBuilder::new(5.0);
        let parts = [
            Region::new(rect(0.0, 0.0, 10.0, 10.0)),
            Region::new(rect(12.0, 0.0, 22.0, 10.0)),
        ];
        assert_eq!(
            profile(&mut path, &parts, &params(false)),
            Err(ProfileError::PartsTooClose)
        );
    }

    #[test]
    fn rapids_never_enter_uncut_wood() {
        let (moves, _) = run(&[Region::new(star(0.0, 0.0, 20.0, 10.0))], &params(true));
        let mut lowest_cut: f64 = 0.0;
        for m in &moves {
            match m {
                Move::Feed { to, .. } => lowest_cut = lowest_cut.min(to[2]),
                Move::Rapid { to } => assert!(to[2] >= lowest_cut + PLUNGE_CLEARANCE - 1e-9),
                _ => {}
            }
        }
    }
}
