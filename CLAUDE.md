# Working on inlay-cam

## Every change

1. **Tests.** Cover what was built or mended with tests, in the suite of the part changed:
   - `web/`: `npm test` (vitest, no DOM: keep what is to be tested free of the window)
   - `crates/`: `cargo test`
   - `mcp/`: `npm test` at the root
2. **Independent testing and review.** When the work is done and its tests pass, start two
   agents on a cheaper model than the session's (`sonnet`, say), at the same time:
   - **A tester**, who runs the suites, tries the change as a user would, and looks for the
     cases that break it.
   - **A reviewer**, who reads the diff for bugs, for what it breaks elsewhere, and for
     what is not tested.

   Give each the goal and the diff, not your own conclusions about it.
3. **Mend what they find**, with a test for each bug, and tell the user what was found and
   what was left as it is, and why.
