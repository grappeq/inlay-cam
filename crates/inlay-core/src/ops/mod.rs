//! Toolpath operations: each turns geometry into moves.

pub mod chamfer;
pub mod clear;
pub mod profile;
pub mod vcarve;

/// How many passes of at most `step` it takes to cover `span`, at least one.
/// A span that is a whole number of steps takes that many, though the
/// subtraction that gave it was a hair off: 1.0 - 0.7 is 0.30000000000000004,
/// which is still three passes of 0.1, not four of 0.075.
pub(crate) fn pass_count(span: f64, step: f64) -> usize {
    (span / step - 1e-9).ceil().max(1.0) as usize
}

#[cfg(test)]
mod tests {
    use super::pass_count;

    #[test]
    fn a_whole_number_of_steps_takes_that_many_passes() {
        assert_eq!(pass_count(1.0 - 0.7, 0.1), 3);
        assert_eq!(pass_count(0.3, 0.1), 3);
        assert_eq!(pass_count(0.7 - 0.4, 0.1), 3);
        assert_eq!(pass_count(2.0 - 1.4, 0.2), 3);
        assert_eq!(pass_count(1.0, 0.5), 2);
    }

    #[test]
    fn a_little_over_takes_one_more() {
        assert_eq!(pass_count(0.31, 0.1), 4);
        assert_eq!(pass_count(1.01, 0.5), 3);
        // Past float noise, however little: one more, so none is deeper than a step.
        assert_eq!(pass_count(0.3 + 1e-6, 0.1), 4);
        assert_eq!(pass_count(20.0 + 1e-6, 0.001), 20001);
    }

    #[test]
    fn less_than_a_step_takes_one() {
        assert_eq!(pass_count(0.05, 0.1), 1);
        assert_eq!(pass_count(0.0, 0.1), 1);
        assert_eq!(pass_count(-0.2, 0.1), 1);
        assert_eq!(pass_count(5.0, f64::INFINITY), 1);
    }
}
