//! Material-removal simulation on a height map.
//!
//! A 3-axis machine cutting from above cannot make an overhang, so the stock
//! is fully described by one height per grid cell. Each move lowers the cells
//! it passes over to the height of the tool's underside, worked out exactly
//! per cell rather than by stamping the tool at steps along the move.

use std::collections::HashMap;

use crate::gcode::{Interpreted, Segment};
use crate::toolpath::P3;
use crate::tools::{Tool, ToolKind};

/// The stock's top surface as a grid of heights. Z0 is the uncut top face.
#[derive(Debug, Clone, PartialEq)]
pub struct HeightMap {
    /// Size of one square cell, mm.
    pub cell: f64,
    pub nx: usize,
    pub ny: usize,
    /// Row by row from Y = 0 upwards; within a row from X = 0. The value is
    /// the height at the centre of the cell.
    pub z: Vec<f32>,
}

impl HeightMap {
    /// A fresh block `width` by `height` mm, sampled every `cell` mm.
    pub fn new(width: f64, height: f64, cell: f64) -> Self {
        // A cell belongs to the block when its centre does. Rounding up
        // instead would add a row of cells past the edge that no cut along
        // the edge reaches, and it would show as a fin of uncut stock.
        let count = |size: f64| ((size / cell + 0.5).floor().max(1.0)) as usize;
        let (nx, ny) = (count(width), count(height));
        Self {
            cell,
            nx,
            ny,
            z: vec![0.0; nx * ny],
        }
    }

    /// A cell size that keeps the map near `target_cells`, no finer than `finest`.
    pub fn cell_for(width: f64, height: f64, target_cells: f64, finest: f64) -> f64 {
        let cell = (width * height / target_cells).sqrt().max(finest);
        (cell * 100.0).ceil() / 100.0
    }

    pub fn centre(&self, ix: usize, iy: usize) -> [f64; 2] {
        [(ix as f64 + 0.5) * self.cell, (iy as f64 + 0.5) * self.cell]
    }

    pub fn at(&self, ix: usize, iy: usize) -> f32 {
        self.z[iy * self.nx + ix]
    }

    /// Height at the cell containing (`x`, `y`), or `None` outside the stock.
    pub fn sample(&self, x: f64, y: f64) -> Option<f32> {
        if x < 0.0 || y < 0.0 {
            return None;
        }
        let (ix, iy) = ((x / self.cell) as usize, (y / self.cell) as usize);
        (ix < self.nx && iy < self.ny).then(|| self.at(ix, iy))
    }

    /// Height at any point of the block, blended between the four nearest
    /// cell centres, or `None` outside the block.
    pub fn interpolate(&self, x: f64, y: f64) -> Option<f64> {
        let (width, height) = (self.nx as f64 * self.cell, self.ny as f64 * self.cell);
        if x < 0.0 || y < 0.0 || x > width || y > height {
            return None;
        }
        // In units of cells, measured from the first cell's centre.
        let fx = (x / self.cell - 0.5).clamp(0.0, (self.nx - 1) as f64);
        let fy = (y / self.cell - 0.5).clamp(0.0, (self.ny - 1) as f64);
        let (x0, y0) = (fx.floor() as usize, fy.floor() as usize);
        let (x1, y1) = ((x0 + 1).min(self.nx - 1), (y0 + 1).min(self.ny - 1));
        let (tx, ty) = (fx - x0 as f64, fy - y0 as f64);
        let at = |ix: usize, iy: usize| self.at(ix, iy) as f64;
        let low = at(x0, y0) * (1.0 - tx) + at(x1, y0) * tx;
        let high = at(x0, y1) * (1.0 - tx) + at(x1, y1) * tx;
        Some(low * (1.0 - ty) + high * ty)
    }

    /// Sweeps `tool` along the straight move `from` -> `to` (tool tip
    /// positions) and lowers every cell it cuts. Returns true if any
    /// material was removed.
    pub fn cut(&mut self, tool: &ToolProfile, from: P3, to: P3) -> bool {
        let r = tool.radius;
        let ix0 = (((from[0].min(to[0]) - r) / self.cell).floor().max(0.0)) as usize;
        let iy0 = (((from[1].min(to[1]) - r) / self.cell).floor().max(0.0)) as usize;
        let ix1 = (((from[0].max(to[0]) + r) / self.cell)
            .ceil()
            .min(self.nx as f64)) as usize;
        let iy1 = (((from[1].max(to[1]) + r) / self.cell)
            .ceil()
            .min(self.ny as f64)) as usize;
        if from[0].max(to[0]) + r < 0.0 || from[1].max(to[1]) + r < 0.0 {
            return false;
        }

        let (dx, dy) = (to[0] - from[0], to[1] - from[1]);
        let a = dx * dx + dy * dy;
        let dz = to[2] - from[2];
        let mut removed = false;

        for iy in iy0..iy1 {
            for ix in ix0..ix1 {
                let [cx, cy] = self.centre(ix, iy);
                // Squared horizontal distance from the cell to the tool axis at
                // parameter t along the move: a t^2 + b t + c.
                let (ex, ey) = (from[0] - cx, from[1] - cy);
                let b = 2.0 * (ex * dx + ey * dy);
                let c = ex * ex + ey * ey;
                if let Some(z) = tool.lowest_over(a, b, c, from[2], dz) {
                    let slot = &mut self.z[iy * self.nx + ix];
                    if (z as f32) < *slot {
                        *slot = z as f32;
                        removed = true;
                    }
                }
            }
        }
        removed
    }
}

/// A tool as the simulator sees it: a shape turned around its axis. The
/// underside is flat out to `tip_radius`, then rises at `slope` (height per
/// mm of radius) out to `radius`.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolProfile {
    pub radius: f64,
    pub tip_radius: f64,
    pub slope: f64,
}

impl ToolProfile {
    pub fn flat(diameter: f64) -> Self {
        Self {
            radius: diameter / 2.0,
            tip_radius: diameter / 2.0,
            slope: 0.0,
        }
    }

    /// A V-bit: `angle` is the included angle in degrees.
    pub fn v_bit(diameter: f64, tip_diameter: f64, angle: f64) -> Self {
        let half = (angle / 2.0).to_radians();
        Self {
            radius: diameter / 2.0,
            tip_radius: tip_diameter / 2.0,
            slope: 1.0 / half.tan(),
        }
    }

    pub fn of(tool: &Tool) -> Self {
        match tool.kind {
            ToolKind::FlatEnd => Self::flat(tool.diameter),
            ToolKind::VBit => Self::v_bit(
                tool.diameter,
                tool.tip_diameter.unwrap_or(0.0),
                tool.tip_angle.unwrap_or(90.0),
            ),
        }
    }

    /// Height of the tool's underside above its tip at radius `r`, or `None`
    /// outside the tool.
    pub fn height(&self, r: f64) -> Option<f64> {
        (r <= self.radius + 1e-9).then(|| (r - self.tip_radius).max(0.0) * self.slope)
    }

    /// Lowest height the tool's underside reaches over one point during a
    /// move, where the point's squared distance to the tool axis is
    /// `a t² + b t + c` and the tip height is `z0 + dz t`, for t in 0..=1.
    /// `None` when the tool never passes over the point.
    ///
    /// The underside height over the point is convex in t on each stretch
    /// where the tool covers it, so the minimum is at an end of the move,
    /// where the tool's edge or tip flat crosses the point, or where the cone
    /// part's slope cancels the move's descent. Those are all tried.
    fn lowest_over(&self, a: f64, b: f64, c: f64, z0: f64, dz: f64) -> Option<f64> {
        let mut candidates = [
            0.0,
            1.0,
            f64::NAN,
            f64::NAN,
            f64::NAN,
            f64::NAN,
            f64::NAN,
            f64::NAN,
            f64::NAN,
        ];
        let mut n = 2;
        let mut add = |t: f64| {
            if t > 0.0 && t < 1.0 && n < candidates.len() {
                candidates[n] = t;
                n += 1;
            }
        };

        if a > 0.0 {
            // Where the tool's edge, and the edge of its tip flat, cross the point.
            for radius in [self.radius, self.tip_radius] {
                let disc = b * b - 4.0 * a * (c - radius * radius);
                if disc >= 0.0 {
                    let root = disc.sqrt();
                    add((-b - root) / (2.0 * a));
                    add((-b + root) / (2.0 * a));
                }
            }
            // Closest approach. On a sloped move it is the lowest point only
            // for a cell right under a pointed tip's path, where the height
            // has a kink that none of the other candidates finds reliably.
            add(-b / (2.0 * a));
            if self.slope > 0.0 && dz != 0.0 {
                {
                    // d/dt [dz t + slope * sqrt(q)] = 0, with q = a t² + b t + c.
                    let k2 = self.slope * self.slope;
                    let s2 = dz * dz;
                    let (qa, qb, qc) = (
                        a * (a * k2 - s2),
                        b * (a * k2 - s2),
                        b * b * k2 / 4.0 - s2 * c,
                    );
                    if qa.abs() > 1e-12 {
                        let disc = qb * qb - 4.0 * qa * qc;
                        if disc >= 0.0 {
                            let root = disc.sqrt();
                            for t in [(-qb - root) / (2.0 * qa), (-qb + root) / (2.0 * qa)] {
                                // Squaring added a false root: keep the one where the
                                // distance changes against the descent.
                                if (2.0 * a * t + b) * dz <= 0.0 {
                                    add(t);
                                }
                            }
                        }
                    }
                }
            }
        }

        let mut best: Option<f64> = None;
        for &t in &candidates[..n] {
            let d = (a * t * t + b * t + c).max(0.0).sqrt();
            if let Some(h) = self.height(d) {
                let z = z0 + dz * t + h;
                best = Some(best.map_or(z, |current: f64| current.min(z)));
            }
        }
        best
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SimProblem {
    /// Line of the G-code file, starting at 1.
    pub line: u32,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Simulation {
    pub map: HeightMap,
    pub problems: Vec<SimProblem>,
}

/// Cuts a fresh block with an interpreted program. `tools` maps the
/// program's tool numbers to tools; `thickness` is the stock's thickness.
pub fn simulate(
    program: &Interpreted,
    tools: &HashMap<u32, Tool>,
    width: f64,
    height: f64,
    thickness: f64,
    cell: f64,
) -> Simulation {
    let mut map = HeightMap::new(width, height, cell);
    let mut problems: Vec<SimProblem> = Vec::new();
    // One report per line and kind is enough to find the cause.
    let mut report = |line: u32, message: String| {
        if problems.len() < 50
            && !problems
                .iter()
                .any(|p| p.line == line && p.message == message)
        {
            problems.push(SimProblem { line, message });
        }
    };
    let mut profiles: HashMap<u32, Option<(ToolProfile, Option<f64>)>> = HashMap::new();

    for segment in &program.segments {
        let Segment {
            from,
            to,
            rapid,
            tool,
            line,
            ..
        } = *segment;
        let entry = profiles.entry(tool).or_insert_with(|| {
            tools
                .get(&tool)
                .map(|t| (ToolProfile::of(t), t.flute_length))
        });
        let Some((profile, flute_length)) = entry else {
            report(line, format!("tool T{tool} is used but not defined"));
            continue;
        };

        let lowest = from[2].min(to[2]);
        if !rapid {
            if lowest < -thickness - 1e-9 {
                report(
                    line,
                    format!(
                        "cuts {:.2} mm below the bottom of the stock",
                        -thickness - lowest
                    ),
                );
            }
            if let Some(flutes) = *flute_length {
                if -lowest > flutes + 1e-9 {
                    report(line, format!("cuts {:.2} mm deep, but the tool's cutting edges are only {flutes:.2} mm long", -lowest));
                }
            }
        }
        let removed = map.cut(profile, from, to);
        if rapid && removed {
            report(line, "a rapid move goes through the stock".into());
        }
    }
    Simulation { map, problems }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gcode::interpret;
    use crate::tools::fixtures::{end_mill, v_bit};

    const CELL: f64 = 0.05;

    fn close(actual: f32, expected: f64, tolerance: f64) {
        assert!(
            (actual as f64 - expected).abs() <= tolerance,
            "{actual} is not within {tolerance} of {expected}"
        );
    }

    #[test]
    fn flat_tool_cuts_a_slot_exactly_as_wide_as_itself() {
        let mut map = HeightMap::new(30.0, 20.0, CELL);
        assert!(map.cut(
            &ToolProfile::flat(4.0),
            [5.0, 10.0, -1.5],
            [25.0, 10.0, -1.5]
        ));
        for iy in 0..map.ny {
            for ix in 0..map.nx {
                let [x, y] = map.centre(ix, iy);
                // Distance from the cell to the slot's centre line.
                let d = if x < 5.0 {
                    (x - 5.0).hypot(y - 10.0)
                } else if x > 25.0 {
                    (x - 25.0).hypot(y - 10.0)
                } else {
                    (y - 10.0).abs()
                };
                let expected = if d <= 2.0 { -1.5 } else { 0.0 };
                assert_eq!(
                    map.at(ix, iy) as f64,
                    expected,
                    "at ({x}, {y}), {d} from the centre line"
                );
            }
        }
    }

    #[test]
    fn v_bit_cuts_a_groove_with_its_own_cross_section() {
        // 60 degree bit with a 0.1 mm tip flat, tip 2 mm below the surface.
        let tool = ToolProfile::v_bit(12.0, 0.1, 60.0);
        let mut map = HeightMap::new(30.0, 20.0, CELL);
        map.cut(&tool, [5.0, 10.0, -2.0], [25.0, 10.0, -2.0]);
        let slope = 1.0 / 30f64.to_radians().tan();
        for iy in 0..map.ny {
            let [_, y] = map.centre(300, iy);
            let d = (y - 10.0).abs();
            let expected = (-2.0 + (d - 0.05).max(0.0) * slope).min(0.0);
            close(map.at(300, iy), expected, 1e-5);
        }
        // Width at the surface: tip flat plus 2 mm depth on each wall.
        let half_width = 0.05 + 2.0 * 30f64.to_radians().tan();
        assert!(map.sample(15.0, 10.0 + half_width - 0.06).unwrap() < 0.0);
        assert_eq!(map.sample(15.0, 10.0 + half_width + 0.06).unwrap(), 0.0);
    }

    #[test]
    fn a_sloped_flat_tool_move_leaves_its_deepest_reach_at_each_point() {
        // Ramp from the surface down to -2 over 20 mm, tool diameter 4.
        let mut map = HeightMap::new(30.0, 20.0, CELL);
        map.cut(
            &ToolProfile::flat(4.0),
            [5.0, 10.0, 0.0],
            [25.0, 10.0, -2.0],
        );
        // On the centre line the deepest point of the flat bottom is its
        // leading edge, 2 mm ahead of the axis.
        for x in [8.0_f64, 12.0, 18.0, 22.0] {
            let leading: f64 = ((x + 2.0).min(25.0) - 5.0) / 20.0 * -2.0;
            let cell_x = ((x / CELL) as usize as f64 + 0.5) * CELL;
            let exact: f64 = ((cell_x + 2.0).min(25.0) - 5.0) / 20.0 * -2.0;
            // Cell centres sit 0.025 mm off the centre line, which shortens the reach a hair.
            close(map.sample(x, 10.0).unwrap(), exact, 1e-4);
            assert!((exact - leading).abs() < 0.01);
        }
    }

    #[test]
    fn a_sloped_v_bit_move_matches_a_brute_force_sweep() {
        let tool = ToolProfile::v_bit(6.0, 0.2, 60.0);
        let (from, to) = ([4.0, 3.0, -0.5], [16.0, 9.0, -3.0]);
        let mut map = HeightMap::new(20.0, 12.0, 0.1);
        map.cut(&tool, from, to);
        for iy in 0..map.ny {
            for ix in 0..map.nx {
                let [x, y] = map.centre(ix, iy);
                let mut brute = 0.0f64;
                for k in 0..=4000 {
                    let t = k as f64 / 4000.0;
                    let p = [
                        from[0] + (to[0] - from[0]) * t,
                        from[1] + (to[1] - from[1]) * t,
                        from[2] + (to[2] - from[2]) * t,
                    ];
                    if let Some(h) = tool.height((p[0] - x).hypot(p[1] - y)) {
                        brute = brute.min(p[2] + h);
                    }
                }
                // The exact answer can only be at or below a sampled sweep, and close to it.
                let exact = map.at(ix, iy) as f64;
                assert!(
                    exact <= brute + 1e-6 && brute - exact < 0.01,
                    "at ({x}, {y}): exact {exact}, brute force {brute}"
                );
            }
        }
    }

    #[test]
    fn a_plunge_cuts_the_tool_footprint() {
        let mut map = HeightMap::new(10.0, 10.0, CELL);
        map.cut(&ToolProfile::flat(3.0), [5.0, 5.0, 2.0], [5.0, 5.0, -1.0]);
        close(map.sample(5.0, 5.0).unwrap(), -1.0, 1e-6);
        close(map.sample(6.4, 5.0).unwrap(), -1.0, 1e-6);
        assert_eq!(map.sample(6.6, 5.0).unwrap(), 0.0);
    }

    #[test]
    fn cutting_never_raises_the_surface_and_order_does_not_matter() {
        let tool = ToolProfile::flat(3.0);
        let moves = [
            ([2.0, 2.0, -2.0], [8.0, 8.0, -2.0]),
            ([2.0, 8.0, -1.0], [8.0, 2.0, -1.0]),
        ];
        let mut forward = HeightMap::new(10.0, 10.0, CELL);
        let mut backward = forward.clone();
        for (from, to) in moves {
            forward.cut(&tool, from, to);
        }
        for (from, to) in moves.iter().rev() {
            backward.cut(&tool, *from, *to);
        }
        assert_eq!(forward, backward);
        assert!(forward.z.iter().all(|z| *z <= 0.0));
        close(forward.sample(5.0, 5.0).unwrap(), -2.0, 1e-6);
    }

    #[test]
    fn moves_outside_the_stock_are_ignored() {
        let mut map = HeightMap::new(10.0, 10.0, CELL);
        assert!(!map.cut(
            &ToolProfile::flat(3.0),
            [-20.0, -20.0, -1.0],
            [-10.0, -20.0, -1.0]
        ));
        assert!(!map.cut(
            &ToolProfile::flat(3.0),
            [50.0, 5.0, -1.0],
            [60.0, 5.0, -1.0]
        ));
        assert!(map.z.iter().all(|z| *z == 0.0));
    }

    fn tools() -> HashMap<u32, Tool> {
        HashMap::from([(7, end_mill()), (8, v_bit())])
    }

    fn run(body: &str) -> Simulation {
        let text = format!("G90 G94\nG21\nM6 T7\nS12000 M3\nG54\nG0 X10.000 Y10.000\nG0 Z5.000\n{body}G0 Z5.000\nM5\nG28\nM30\n");
        simulate(&interpret(&text).unwrap(), &tools(), 40.0, 20.0, 10.0, 0.1)
    }

    #[test]
    fn a_clean_program_cuts_with_no_problems() {
        let sim = run("G1 Z-1.000 F90\nG1 X30.000 F600\n");
        assert_eq!(sim.problems, []);
        close(sim.map.sample(20.0, 10.0).unwrap(), -1.0, 1e-6);
        assert_eq!(sim.map.sample(20.0, 15.0).unwrap(), 0.0);
    }

    #[test]
    fn a_rapid_through_the_stock_is_reported_with_its_line() {
        let sim = run("G1 Z-1.000 F90\nG0 X30.000\n");
        assert_eq!(
            sim.problems,
            [SimProblem {
                line: 9,
                message: "a rapid move goes through the stock".into()
            }]
        );
    }

    #[test]
    fn cutting_through_the_stock_or_past_the_flutes_is_reported() {
        let sim = run("G1 Z-10.500 F90\n");
        assert!(sim.problems[0].message.contains("0.50 mm below the bottom"));

        // The end mill fixture has 22 mm flutes; give it thicker stock.
        let text = "G90 G94\nG21\nM6 T7\nS12000 M3\nG54\nG0 X10.000 Y10.000\nG0 Z5.000\nG1 Z-23.000 F90\nG0 Z5.000\nM5\nG28\nM30\n";
        let sim = simulate(&interpret(text).unwrap(), &tools(), 40.0, 20.0, 30.0, 0.1);
        assert!(sim.problems[0]
            .message
            .contains("cutting edges are only 22.00 mm"));
    }

    #[test]
    fn an_undefined_tool_is_reported() {
        let text = "G90 G94\nG21\nM6 T9\nS12000 M3\nG54\nG0 X10.000 Y10.000\nG0 Z5.000\nG1 Z-1.000 F90\nG0 Z5.000\nM5\nG28\nM30\n";
        let sim = simulate(&interpret(text).unwrap(), &tools(), 40.0, 20.0, 10.0, 0.1);
        assert!(sim.problems[0]
            .message
            .contains("T9 is used but not defined"));
    }

    #[test]
    fn cell_size_tracks_the_stock_size() {
        assert_eq!(HeightMap::cell_for(100.0, 80.0, 2_000_000.0, 0.05), 0.07);
        assert_eq!(HeightMap::cell_for(20.0, 20.0, 2_000_000.0, 0.05), 0.05);
    }

    #[test]
    fn a_pointed_bit_on_a_sloped_move_cuts_to_its_tip_right_under_the_path() {
        // Ramp from 2 mm deep up to the surface along a diagonal.
        let bit = ToolProfile::v_bit(12.0, 0.0, 60.0);
        let mut map = HeightMap::new(10.0, 10.0, 0.05);
        map.cut(&bit, [2.0, 8.0, -2.0], [8.0, 2.0, 0.0]);
        for i in 1..10 {
            let t = i as f64 / 10.0;
            let (x, y) = (2.0 + 6.0 * t, 8.0 - 6.0 * t);
            let z = map.interpolate(x, y).unwrap();
            // Sampled up to half a cell off the path, where the cone is 0.04 higher.
            assert!((z - (-2.0 + 2.0 * t)).abs() < 0.06, "at {t}: {z}");
        }
    }
}
