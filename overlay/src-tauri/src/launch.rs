//! Which surface a `companion …` invocation — or a bare re-launch — should bring up.
//!
//! This lives outside the `#[cfg(not(debug_assertions))]` gate on the single-instance
//! plugin registration that consumes it. That is the whole point of the module: a test
//! build never compiles that gated closure, so nothing could reach the branch that
//! regressed in 0.4.8, where a bare re-launch raised only the artifact panels. Those
//! panels no longer exist, so it surfaced nothing at all — double-clicking the app was
//! a guaranteed no-op, and it was invisible for a day. Keeping the *decision* out here
//! makes it a unit test; the caller keeps only a one-site `match`.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Surface {
    History,
    Live,
    Board,
}

/// The one surface an invocation asks for.
// The only non-test caller sits behind `cfg(not(debug_assertions))`, so a plain debug
// build (`npm run tauri dev`) sees no caller at all. That gate is the whole reason this
// function exists; a test build keeps it alive through the tests below.
#[cfg_attr(all(debug_assertions, not(test)), allow(dead_code))]
pub fn surface_for_args(args: &[String]) -> Surface {
    if args.iter().any(|a| a == "history") {
        Surface::History
    } else if args.iter().any(|a| a == "live") {
        Surface::Live
    } else {
        // Everything else lands on the Board: `companion board`, `companion open
        // <artifact>` (the Board is the single surface and ingests it — there is no
        // standalone artifact window), and a bare re-launch (double-click, `open -a`,
        // or a newly installed bundle at a different path).
        Surface::Board
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// argv as the plugin delivers it — argv[0] is the binary itself.
    fn argv(rest: &[&str]) -> Vec<String> {
        std::iter::once("/Applications/Companion Overlay.app/Contents/MacOS/companion-overlay")
            .chain(rest.iter().copied())
            .map(String::from)
            .collect()
    }

    #[test]
    fn a_bare_relaunch_surfaces_the_board() {
        // The 0.4.8 regression, pinned: opening the app a second time did nothing.
        assert_eq!(surface_for_args(&argv(&[])), Surface::Board);
    }

    #[test]
    fn opening_an_artifact_surfaces_the_board_not_a_standalone_window() {
        assert_eq!(
            surface_for_args(&argv(&["open", "/tmp/x.html"])),
            Surface::Board
        );
    }

    #[test]
    fn an_explicit_board_arg_surfaces_the_board() {
        assert_eq!(surface_for_args(&argv(&["board"])), Surface::Board);
    }

    #[test]
    fn history_and_live_keep_their_own_surfaces() {
        assert_eq!(surface_for_args(&argv(&["history"])), Surface::History);
        assert_eq!(surface_for_args(&argv(&["live"])), Surface::Live);
    }

    #[test]
    fn history_wins_when_both_history_and_live_are_passed() {
        // Not a meaningful invocation, but pin the precedence so that reordering the
        // branches is a test failure rather than a surprise.
        assert_eq!(
            surface_for_args(&argv(&["live", "history"])),
            Surface::History
        );
    }
}
