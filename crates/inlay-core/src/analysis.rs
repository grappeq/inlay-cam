//! Fit analysis for a V-carve inlay: puts the simulated plug, turned over,
//! onto the simulated pocket and measures how the two meet.
//!
//! Both parts come from simulating their G-code files, so the answer covers
//! everything between the drawing and the machine: tool shapes, stepovers,
//! rounding and any mistake in the toolpaths.

use serde::Serialize;

use crate::sim::HeightMap;

/// Gaps up to this count as the plug touching the wall, mm.
pub const CONTACT: f64 = 0.05;

/// How far below the base board's surface the finished face is judged, mm:
/// about what flattening and sanding take off after the backer is cut away.
pub const TRIM_DEPTH: f64 = 0.1;

/// What is at a point of the finished face.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Face {
    Base = 0,
    Plug = 1,
    /// Neither board reaches the face here: a visible gap, filled with glue at best.
    Void = 2,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FitReport {
    /// Height of the plug blank's face above the base board's surface when
    /// the plug rests in the pocket, mm. Negative: below the surface.
    pub resting_seat: f64,
    /// The same as designed: minus the engagement depth.
    pub intended_seat: f64,
    /// How much higher than designed the plug rests, mm.
    pub proud: f64,
    /// Where the plug touches first, on the base board.
    pub first_contact: [f64; 2],
    /// Pressed down to the designed height, the deepest the two parts would
    /// have to crush into each other, mm, and over what area, mm².
    pub press_overlap: f64,
    pub press_overlap_area: f64,
    /// Space under the plug over the pocket's flat floor at rest, mm:
    /// smallest and average. `None` when the pocket has no flat floor.
    pub glue_gap_min: Option<f64>,
    pub glue_gap_mean: Option<f64>,
    /// Share of the pocket's sloped wall, down to the engagement depth, that
    /// the plug touches at rest, 0 to 1.
    pub wall_contact: f64,
    /// Largest gap between plug and pocket wall at rest, measured straight up, mm.
    pub wall_gap_max: f64,
    /// Visible gaps in the finished face: total area, mm², and the widest, mm.
    pub void_area: f64,
    pub void_width: f64,
    /// Depth below the surface at which the face was judged, mm.
    pub trim_depth: f64,
}

/// The fit over the base board's grid.
#[derive(Debug, Clone, PartialEq)]
pub struct Fit {
    pub cell: f64,
    pub nx: usize,
    pub ny: usize,
    /// Space between the pocket and the plug above it at rest, straight up,
    /// mm. NaN where the plug blank does not cover the base board.
    pub gap: Vec<f32>,
    /// Underside of the resting plug in the base board's Z. NaN as above.
    pub plug_under: Vec<f32>,
    /// The finished face, one `Face` per cell.
    pub face: Vec<u8>,
    pub report: FitReport,
}

/// Where the plug blank lies on the base board once turned over: the base
/// point (X, Y) is under the plug blank's point (`mirror_x` - X, Y - `offset_y`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlugFrame {
    pub mirror_x: f64,
    pub offset_y: f64,
}

/// Lowers the plug onto the pocket and measures the fit. `engagement` is how
/// deep the plug is designed to go in and `pocket_depth` the depth of the
/// pocket's flat floor. Returns `None` when the plug does not cover any of
/// the base board.
pub fn fit(
    pocket: &HeightMap,
    plug: &HeightMap,
    frame: PlugFrame,
    engagement: f64,
    pocket_depth: f64,
) -> Option<Fit> {
    let cells = pocket.nx * pocket.ny;
    // Height of the plug's cut surface above the base cell, in plug terms
    // (0 at its face, negative where cut), or NaN where there is no plug.
    let mut over: Vec<f32> = Vec::with_capacity(cells);
    for iy in 0..pocket.ny {
        for ix in 0..pocket.nx {
            let [x, y] = pocket.centre(ix, iy);
            over.push(
                plug.interpolate(frame.mirror_x - x, y - frame.offset_y)
                    .map_or(f32::NAN, |h| h as f32),
            );
        }
    }

    // Turned over, a plug point cut to height h sits at seat - h. It rests
    // where the first such point meets the pocket: seat = max(pocket + h).
    let mut resting = f64::NEG_INFINITY;
    let mut first = 0;
    for (i, h) in over.iter().enumerate() {
        if !h.is_nan() {
            let seat = pocket.z[i] as f64 + *h as f64;
            if seat > resting {
                resting = seat;
                first = i;
            }
        }
    }
    if !resting.is_finite() {
        return None;
    }
    let intended = -engagement;
    let cell_area = pocket.cell * pocket.cell;

    let mut gap = vec![f32::NAN; cells];
    let mut plug_under = vec![f32::NAN; cells];
    let mut face = vec![Face::Base as u8; cells];
    let (mut press_overlap, mut press_cells) = (0.0f64, 0usize);
    let (mut glue_min, mut glue_sum, mut glue_cells) = (f64::INFINITY, 0.0f64, 0usize);
    let (mut wall_cells, mut wall_touching, mut wall_gap_max) = (0usize, 0usize, 0.0f64);
    let trim = -TRIM_DEPTH;
    for i in 0..cells {
        let base = pocket.z[i] as f64;
        if over[i].is_nan() {
            if base < trim {
                face[i] = Face::Void as u8;
            }
            continue;
        }
        let h = over[i] as f64;
        let under = resting - h;
        let g = under - base;
        gap[i] = g as f32;
        plug_under[i] = under as f32;

        let overlap = base + h - intended;
        // Less than this is rounding in the simulation, not wood.
        if overlap > 0.01 {
            press_overlap = press_overlap.max(overlap);
            press_cells += 1;
        }
        let on_floor = base <= -pocket_depth + 0.02;
        // The wall the plug is meant to bear on: below the surface, above
        // where the plug's own face ends up.
        let on_wall = base < -0.02 && base > intended + 0.02;
        if on_floor && h > -0.02 {
            glue_min = glue_min.min(g);
            glue_sum += g;
            glue_cells += 1;
        }
        if on_wall {
            wall_cells += 1;
            if g <= CONTACT {
                wall_touching += 1;
            }
            wall_gap_max = wall_gap_max.max(g);
        }
        face[i] = if base >= trim {
            Face::Base
        } else if under <= trim {
            Face::Plug
        } else {
            Face::Void
        } as u8;
    }

    let void_cells = face.iter().filter(|f| **f == Face::Void as u8).count();
    let report = FitReport {
        resting_seat: resting,
        intended_seat: intended,
        proud: resting - intended,
        first_contact: pocket.centre(first % pocket.nx, first / pocket.nx),
        press_overlap,
        press_overlap_area: press_cells as f64 * cell_area,
        glue_gap_min: (glue_cells > 0).then_some(glue_min),
        glue_gap_mean: (glue_cells > 0).then(|| glue_sum / glue_cells as f64),
        wall_contact: if wall_cells > 0 {
            wall_touching as f64 / wall_cells as f64
        } else {
            0.0
        },
        wall_gap_max,
        void_area: void_cells as f64 * cell_area,
        void_width: widest(&face, pocket.nx, pocket.ny, Face::Void as u8) * pocket.cell,
        trim_depth: TRIM_DEPTH,
    };
    Some(Fit {
        cell: pocket.cell,
        nx: pocket.nx,
        ny: pocket.ny,
        gap,
        plug_under,
        face,
        report,
    })
}

/// Width, in cells, of the widest part of the cells equal to `value`: twice
/// the largest distance from such a cell's centre to the nearest other cell,
/// less the one cell that distance overshoots by.
fn widest(cells: &[u8], nx: usize, ny: usize, value: u8) -> f64 {
    const DIAGONAL: f32 = std::f32::consts::SQRT_2;
    // Distance to the nearest cell that is not `value`, by two sweeps.
    let mut d: Vec<f32> = cells
        .iter()
        .map(|c| if *c == value { f32::INFINITY } else { 0.0 })
        .collect();
    let at = |d: &Vec<f32>, x: isize, y: isize| -> f32 {
        if x < 0 || y < 0 || x >= nx as isize || y >= ny as isize {
            0.0
        } else {
            d[y as usize * nx + x as usize]
        }
    };
    for y in 0..ny as isize {
        for x in 0..nx as isize {
            let i = y as usize * nx + x as usize;
            if d[i] > 0.0 {
                d[i] = d[i]
                    .min(at(&d, x - 1, y) + 1.0)
                    .min(at(&d, x, y - 1) + 1.0)
                    .min(at(&d, x - 1, y - 1) + DIAGONAL)
                    .min(at(&d, x + 1, y - 1) + DIAGONAL);
            }
        }
    }
    let mut most = 0.0f32;
    for y in (0..ny as isize).rev() {
        for x in (0..nx as isize).rev() {
            let i = y as usize * nx + x as usize;
            if d[i] > 0.0 {
                d[i] = d[i]
                    .min(at(&d, x + 1, y) + 1.0)
                    .min(at(&d, x, y + 1) + 1.0)
                    .min(at(&d, x + 1, y + 1) + DIAGONAL)
                    .min(at(&d, x - 1, y + 1) + DIAGONAL);
                most = most.max(d[i]);
            }
        }
    }
    if most == 0.0 {
        0.0
    } else {
        (2.0 * most as f64 - 1.0).max(1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A base board 20 x 10 with a 60 degree V-groove along Y = 5, `depth`
    /// deep, flat-bottomed below `floor`.
    fn grooved(depth: f64, floor: f64) -> HeightMap {
        let mut map = HeightMap::new(20.0, 10.0, 0.05);
        let tan = 30f64.to_radians().tan();
        for iy in 0..map.ny {
            for ix in 0..map.nx {
                let [_, y] = map.centre(ix, iy);
                let from_edge = depth * tan - (y - 5.0).abs();
                let z = -(from_edge / tan).clamp(0.0, floor);
                map.z[iy * map.nx + ix] = z as f32;
            }
        }
        map
    }

    /// The matching plug: a ridge along Y = 5 standing in a blank cut
    /// `engagement + saw` deep, as wide as the groove at `engagement`.
    fn ridged(groove_depth: f64, engagement: f64, saw: f64) -> HeightMap {
        let mut map = HeightMap::new(20.0, 10.0, 0.05);
        let tan = 30f64.to_radians().tan();
        for iy in 0..map.ny {
            for ix in 0..map.nx {
                let [_, y] = map.centre(ix, iy);
                let outside = (y - 5.0).abs() - groove_depth * tan;
                let z = -(engagement + outside / tan).clamp(0.0, engagement + saw);
                map.z[iy * map.nx + ix] = z as f32;
            }
        }
        map
    }

    const FRAME: PlugFrame = PlugFrame {
        mirror_x: 20.0,
        offset_y: 0.0,
    };

    #[test]
    fn a_matching_plug_seats_at_the_engagement_depth_with_the_glue_gap_under_it() {
        // Groove 4 mm wide at the surface cut 2.3 deep; plug goes in 2.
        let pocket = grooved(4.0 / (2.0 * 30f64.to_radians().tan()), 2.3);
        let plug = ridged(4.0 / (2.0 * 30f64.to_radians().tan()), 2.0, 1.5);
        let fit = fit(&pocket, &plug, FRAME, 2.0, 2.3).unwrap();
        let r = &fit.report;
        assert!(r.proud.abs() < 0.01, "proud {}", r.proud);
        assert!((r.glue_gap_mean.unwrap() - 0.3).abs() < 0.01);
        assert!(r.wall_contact > 0.95, "wall contact {}", r.wall_contact);
        assert!(r.press_overlap < 0.01);
        assert_eq!(r.void_area, 0.0);
        // The face is plug over the groove and base beside it.
        let mid = fit.face[(fit.ny / 2) * fit.nx + fit.nx / 2];
        assert_eq!(mid, Face::Plug as u8);
        assert_eq!(fit.face[0], Face::Base as u8);
    }

    #[test]
    fn a_plug_that_is_too_wide_rides_high_and_one_too_narrow_leaves_a_gap() {
        let tan = 30f64.to_radians().tan();
        let groove = 4.0 / (2.0 * tan);
        let pocket = grooved(groove, 2.3);

        // 0.2 mm too wide on each side: stops 0.2 / tan higher.
        let wide = ridged(groove + 0.2 / tan, 2.0, 1.5);
        let r = fit(&pocket, &wide, FRAME, 2.0, 2.3).unwrap().report;
        assert!((r.proud - 0.2 / tan).abs() < 0.02, "proud {}", r.proud);
        assert!((r.press_overlap - 0.2 / tan).abs() < 0.02);
        assert!(r.void_area < 1e-9);

        // 0.3 mm too narrow on each side: drops until its top meets the
        // floor, 0.3 lower than designed, and still clear of both walls.
        let narrow = ridged(groove - 0.3 / tan, 2.0, 1.5);
        let fit = fit(&pocket, &narrow, FRAME, 2.0, 2.3).unwrap();
        let r = &fit.report;
        assert!((r.proud + 0.3).abs() < 0.02, "proud {}", r.proud);
        assert!(r.glue_gap_min.unwrap() < 0.01);
        assert!(r.wall_contact < 0.05);
        // Straight up, the wall gap is what the plug lacks in height, less its drop.
        assert!(
            (r.wall_gap_max - (0.3 / tan - 0.3)).abs() < 0.02,
            "{}",
            r.wall_gap_max
        );
    }

    #[test]
    fn a_pocket_the_plug_does_not_cover_shows_as_a_gap() {
        let pocket = grooved(3.0, 2.3);
        let plug = ridged(3.0, 2.0, 1.5);
        // Shifted 10 mm along the groove: half the groove has no plug over it.
        let shifted = PlugFrame {
            mirror_x: 30.0,
            offset_y: 0.0,
        };
        let r = fit(&pocket, &plug, shifted, 2.0, 2.3).unwrap().report;
        assert!(r.void_area > 10.0, "void area {}", r.void_area);
        assert!(r.void_width > 1.0);
        // Nowhere near: no fit at all.
        let away = PlugFrame {
            mirror_x: 100.0,
            offset_y: 0.0,
        };
        assert!(fit(&pocket, &plug, away, 2.0, 2.3).is_none());
    }

    #[test]
    fn widest_measures_strips_and_blobs() {
        // A 3-cell-wide strip in a 9 x 9 grid.
        let mut cells = vec![0u8; 81];
        for y in 0..9 {
            for x in 3..6 {
                cells[y * 9 + x] = 2;
            }
        }
        assert!((widest(&cells, 9, 9, 2) - 3.0).abs() < 1e-6);
        assert_eq!(widest(&[0u8; 81], 9, 9, 2), 0.0);
        let mut one = vec![0u8; 81];
        one[40] = 2;
        assert!((widest(&one, 9, 9, 2) - 1.0).abs() < 1e-6);
    }
}
