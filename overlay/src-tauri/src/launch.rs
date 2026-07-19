//! Which surface a `shelly …` invocation — or a bare re-launch — should bring up.
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

/// A `shelly handoff <file> [--dir <dir>] [--agent <claude|codex>]` request:
/// spawn a fresh Board session in `dir` and drop the handoff at `file` into it.
/// `dir`/`agent` are optional — the frontend picker fills in whatever is missing
/// (so a bare `shelly handoff <file>` still works and just asks for the rest).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct HandoffRequest {
    pub file: String,
    pub dir: Option<String>,
    pub agent: Option<String>,
}

/// Parse a `handoff` invocation, or `None` if these args aren't one. The single
/// positional after the verb is the handoff file (resolved against `cwd` when
/// relative, mirroring `artifact::parse_open_args`); `--dir`/`--agent` are the
/// optional target folder and agent CLI. An unrecognised agent is dropped to
/// `None` so the picker asks rather than spawning the wrong CLI.
pub fn handoff_for_args(args: &[String], cwd: Option<&str>) -> Option<HandoffRequest> {
    let start = args.iter().position(|a| a == "handoff")? + 1;
    let rest = &args[start..];

    let mut file: Option<String> = None;
    let mut dir: Option<String> = None;
    let mut agent: Option<String> = None;
    let mut i = 0;
    while i < rest.len() {
        match rest[i].as_str() {
            "--dir" => {
                dir = rest.get(i + 1).cloned();
                i += 2;
            }
            "--agent" => {
                agent = rest.get(i + 1).cloned();
                i += 2;
            }
            other => {
                if file.is_none() && !other.starts_with("--") {
                    file = Some(other.to_string());
                }
                i += 1;
            }
        }
    }

    let file = file?;
    let file = if std::path::Path::new(&file).is_absolute() {
        file
    } else if let Some(c) = cwd {
        std::path::Path::new(c)
            .join(&file)
            .to_string_lossy()
            .into_owned()
    } else {
        file
    };

    let agent = match agent.as_deref() {
        Some("codex") => Some("codex".to_string()),
        Some("claude") => Some("claude".to_string()),
        _ => None,
    };

    Some(HandoffRequest { file, dir, agent })
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
        // Everything else lands on the Board: `shelly board`, `shelly open
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
        std::iter::once("/Applications/Shelly.app/Contents/MacOS/shelly")
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

    #[test]
    fn non_handoff_args_are_not_a_handoff() {
        assert_eq!(handoff_for_args(&argv(&[]), None), None);
        assert_eq!(handoff_for_args(&argv(&["board"]), None), None);
        // `handoff` with no file is not a valid request (nothing to seed).
        assert_eq!(handoff_for_args(&argv(&["handoff"]), None), None);
    }

    #[test]
    fn handoff_parses_file_dir_and_agent() {
        let req = handoff_for_args(
            &argv(&["handoff", "/wiki/h.md", "--dir", "/repo", "--agent", "codex"]),
            None,
        )
        .expect("a handoff request");
        assert_eq!(req.file, "/wiki/h.md");
        assert_eq!(req.dir.as_deref(), Some("/repo"));
        assert_eq!(req.agent.as_deref(), Some("codex"));
    }

    #[test]
    fn handoff_with_only_a_file_leaves_dir_and_agent_for_the_picker() {
        let req = handoff_for_args(&argv(&["handoff", "/wiki/h.md"]), None).expect("a request");
        assert_eq!(req.file, "/wiki/h.md");
        assert_eq!(req.dir, None);
        assert_eq!(req.agent, None);
    }

    #[test]
    fn handoff_resolves_a_relative_file_against_cwd() {
        let req = handoff_for_args(&argv(&["handoff", "h.md"]), Some("/tmp/proj")).expect("a request");
        assert_eq!(req.file, "/tmp/proj/h.md");
    }

    #[test]
    fn handoff_drops_an_unknown_agent_so_the_picker_asks() {
        let req = handoff_for_args(
            &argv(&["handoff", "/h.md", "--agent", "gpt"]),
            None,
        )
        .expect("a request");
        assert_eq!(req.agent, None);
    }
}
