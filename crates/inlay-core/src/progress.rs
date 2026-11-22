//! How far long work is, said as it goes.
//!
//! Building a file, cutting the stock with it and taking the stock through
//! the list take seconds to minutes. Whoever asks for that work can
//! [`watch`] it: the work then [`report`]s which stage it is in and, where
//! that can be counted, how much of it is done. Nobody watching, a report
//! costs a look at a thread-local and nothing else, and no result of any
//! work depends on whether it is watched.

use std::cell::RefCell;

/// What long work is doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Stage {
    /// The list is taken through, from its step `done` on: the steps
    /// before it are kept from the last time. Said once the list knows
    /// where it goes on from, when there is anything to do, and again at
    /// the end, with every step done.
    List,
    /// The list: an inlay's plug or inserts are made on their own board.
    /// Counted in the steps of the list: `done` is the inlay's place in it.
    Plug,
    /// The list: the file of a step is worked out. Counted as [`Stage::Plug`].
    Build,
    /// The list: a copy of the stock is cut with a step's file ahead of
    /// its turn, to measure what a later step finds. Counted as
    /// [`Stage::Plug`]. The cutting that follows is not of the stock.
    Ahead,
    /// The list: the stock is cut with a step, or the step is done by
    /// hand, or left out as suppressed. Counted as [`Stage::Plug`].
    Step,
    /// A file: its toolpaths are worked out. Not counted.
    Paths,
    /// A file: it is written as G-code, checked and read back. Not counted.
    Write,
    /// A board is cut with a file. Counted in the file's moves.
    Cut,
    /// A plug is fitted into its pocket. Not counted.
    Fit,
}

impl Stage {
    /// The stage's name as it crosses out of the core.
    pub fn name(self) -> &'static str {
        match self {
            Stage::List => "list",
            Stage::Plug => "plug",
            Stage::Ahead => "ahead",
            Stage::Build => "build",
            Stage::Step => "step",
            Stage::Paths => "paths",
            Stage::Write => "write",
            Stage::Cut => "cut",
            Stage::Fit => "fit",
        }
    }

    /// Whether `done` and `total` say how far the stage is.
    pub fn counted(self) -> bool {
        !matches!(self, Stage::Paths | Stage::Write | Stage::Fit)
    }
}

/// Where long work is: a stage and, for a stage that is counted, how many
/// of its `total` parts are `done`. Both are 0 for one that is not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Report {
    pub stage: Stage,
    pub done: u32,
    pub total: u32,
}

type Sink = Box<dyn FnMut(Report)>;

thread_local! {
    static SINK: RefCell<Option<Sink>> = const { RefCell::new(None) };
}

/// Puts back the watcher there was, also when the work unwinds.
struct Restore(Option<Sink>);

impl Drop for Restore {
    fn drop(&mut self) {
        let before = self.0.take();
        SINK.with(|sink| *sink.borrow_mut() = before);
    }
}

/// Does `work`, giving `sink` every report the work makes on this thread.
/// Whoever watched before watches again afterwards.
pub fn watch<T>(sink: impl FnMut(Report) + 'static, work: impl FnOnce() -> T) -> T {
    let before = SINK.with(|s| s.borrow_mut().replace(Box::new(sink)));
    let _restore = Restore(before);
    work()
}

/// Says where the work is, to whoever watches it.
pub fn report(stage: Stage, done: usize, total: usize) {
    // Taken out while it is called: a watcher that started work of its own
    // would find nobody watching, not a cell that is borrowed.
    let Some(mut sink) = SINK.with(|s| s.borrow_mut().take()) else {
        return;
    };
    let clamp = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
    sink(Report {
        stage,
        done: clamp(done.min(total)),
        total: clamp(total),
    });
    SINK.with(|s| {
        let mut slot = s.borrow_mut();
        // Left alone when the watcher changed who watches.
        if slot.is_none() {
            *slot = Some(sink);
        }
    });
}

/// How many reports a counted loop makes at most, whatever its length.
pub const MOST_REPORTS: usize = 200;

/// How many turns of a loop of `total` lie between two reports of it.
pub fn every(total: usize) -> usize {
    total.div_ceil(MOST_REPORTS).max(1)
}

/// Says how far a loop of `total` turns is, at turn `at`: at the first turn
/// and then often enough to be followed, but not at every one of very many.
/// `every` is [`every`] of the total, worked out once before the loop.
pub fn turn(stage: Stage, at: usize, total: usize, every: usize) {
    if at % every == 0 {
        report(stage, at, total);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::rc::Rc;

    fn seen() -> (Rc<RefCell<Vec<Report>>>, impl FnMut(Report) + 'static) {
        let list = Rc::new(RefCell::new(Vec::new()));
        let into = list.clone();
        (list, move |r| into.borrow_mut().push(r))
    }

    #[test]
    fn a_report_with_nobody_watching_is_nothing() {
        report(Stage::Cut, 1, 2);
        turn(Stage::Cut, 0, 10, every(10));
    }

    #[test]
    fn a_loop_of_any_length_has_a_pace() {
        assert_eq!(every(0), 1);
        assert_eq!(every(1), 1);
        assert_eq!(every(MOST_REPORTS), 1);
        assert_eq!(every(MOST_REPORTS + 1), 2);
        assert_eq!(every(usize::MAX), usize::MAX / MOST_REPORTS + 1);
    }

    #[test]
    fn counts_too_large_to_cross_are_capped() {
        let (list, sink) = seen();
        watch(sink, || report(Stage::Cut, usize::MAX - 1, usize::MAX));
        let r = list.borrow()[0];
        assert_eq!((r.done, r.total), (u32::MAX, u32::MAX));
    }

    #[test]
    fn a_watcher_gets_what_the_work_reports_and_nothing_after_it() {
        let (list, sink) = seen();
        let result = watch(sink, || {
            report(Stage::Paths, 0, 0);
            report(Stage::Cut, 3, 10);
            7
        });
        report(Stage::Cut, 10, 10);
        assert_eq!(result, 7);
        assert_eq!(
            *list.borrow(),
            vec![
                Report {
                    stage: Stage::Paths,
                    done: 0,
                    total: 0
                },
                Report {
                    stage: Stage::Cut,
                    done: 3,
                    total: 10
                },
            ]
        );
    }

    #[test]
    fn done_never_passes_the_total() {
        let (list, sink) = seen();
        watch(sink, || report(Stage::Cut, 12, 10));
        assert_eq!(
            list.borrow()[0],
            Report {
                stage: Stage::Cut,
                done: 10,
                total: 10
            }
        );
    }

    #[test]
    fn the_watcher_before_watches_again_after_work_watched_inside_it() {
        let (outer, outer_sink) = seen();
        let (inner, inner_sink) = seen();
        watch(outer_sink, || {
            report(Stage::Step, 0, 2);
            watch(inner_sink, || report(Stage::Cut, 1, 2));
            report(Stage::Step, 1, 2);
        });
        assert_eq!(
            outer.borrow().iter().map(|r| r.stage).collect::<Vec<_>>(),
            vec![Stage::Step, Stage::Step]
        );
        assert_eq!(
            inner.borrow().iter().map(|r| r.stage).collect::<Vec<_>>(),
            vec![Stage::Cut]
        );
    }

    #[test]
    fn nobody_watches_after_work_that_panicked() {
        let (list, sink) = seen();
        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            watch(sink, || panic!("the work went wrong"))
        }));
        assert!(caught.is_err());
        report(Stage::Cut, 1, 2);
        assert!(list.borrow().is_empty());
    }

    #[test]
    fn a_watcher_that_reports_does_not_hear_itself() {
        let count = Rc::new(RefCell::new(0));
        let into = count.clone();
        watch(
            move |_| {
                *into.borrow_mut() += 1;
                report(Stage::Cut, 0, 1);
            },
            || report(Stage::Cut, 0, 1),
        );
        assert_eq!(*count.borrow(), 1);
    }

    #[test]
    fn a_long_loop_reports_its_first_turn_and_not_every_one() {
        let (list, sink) = seen();
        let total = 1_000_000;
        watch(sink, || {
            let pace = every(total);
            for at in 0..total {
                turn(Stage::Cut, at, total, pace);
            }
        });
        let list = list.borrow();
        assert_eq!(list[0].done, 0);
        assert!(list.len() <= MOST_REPORTS, "{} reports", list.len());
        assert!(list.len() >= MOST_REPORTS / 2);
        assert!(list.windows(2).all(|w| w[0].done < w[1].done));
    }

    #[test]
    fn a_short_loop_reports_every_turn() {
        let (list, sink) = seen();
        watch(sink, || {
            for at in 0..5 {
                turn(Stage::Cut, at, 5, every(5));
            }
        });
        assert_eq!(
            list.borrow().iter().map(|r| r.done).collect::<Vec<_>>(),
            vec![0, 1, 2, 3, 4]
        );
    }

    #[test]
    fn only_what_can_be_counted_is_said_to_be() {
        assert!(
            Stage::Cut.counted()
                && Stage::Step.counted()
                && Stage::Plug.counted()
                && Stage::Build.counted()
        );
        assert!(!Stage::Paths.counted() && !Stage::Write.counted() && !Stage::Fit.counted());
    }
}
