//! Where panels open. Panels are laid out *after* each reports its fitted size
//! (see `notify_fit`), so the arrangement respects real sizes and never overlaps
//! — unlike a fixed-step cascade, which stacked differently-sized panels on top
//! of each other.
//!
//! Two layout modes (toggled with ⌘9):
//! - **Free** (default): a right-aligned vertical column on the work area, wrapping
//!   to a new column on the left when one runs past the bottom.
//! - **Terminal**: panels pack into the screen gutters *beside* the focused terminal
//!   window (Ghostty et al.) — flush to its right edge top-down, spilling to its left
//!   edge — sized to each artifact so they never overlap, and kept in sync as the
//!   terminal moves/resizes via a background poll. Falls back to Free if no terminal.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, LogicalPosition, Manager};

/// Gap from a frame edge.
const SCREEN_MARGIN: f64 = 16.0;
/// Leave room for the menu bar at the top (screen frame only).
const TOP_MARGIN: f64 = 40.0;
/// Gap between stacked panels.
const GAP: f64 = 12.0;

/// Re-flow glide: total time and frame count (~16 ms/frame).
const ANIM_MS: u64 = 300;
const ANIM_FRAMES: u32 = 18;
/// After a programmatic move, ignore the window's own `Moved` events for this long
/// so our placement/animation is never mistaken for a user drag.
const MOVE_GRACE_MS: u64 = 220;
/// Don't animate or emit sub-pixel moves.
const MIN_MOVE: f64 = 1.0;

/// Bumped on every `arrange`; a running glide aborts when it sees a newer value,
/// so a fresh re-flow cleanly supersedes an in-flight one (no fighting tweens).
static ARRANGE_GEN: AtomicU64 = AtomicU64::new(0);

/// Lock a mutex, tolerating poisoning: a panic elsewhere (now contained by the
/// run-loop `guard`) must not turn every later lock into a fresh fatal panic.
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Where the panel column anchors.
#[derive(Clone, Copy, PartialEq, Eq, Default)]
pub enum LayoutMode {
    /// Right edge of the work area.
    #[default]
    Free,
    /// Right edge of the focused terminal window.
    Terminal,
}

/// Tracks the stable open order of artifact panels (so the column is deterministic
/// — a `HashMap`'s iteration order is not) and the current layout mode. Managed in
/// Tauri state.
#[derive(Default)]
pub struct LayoutState {
    order: Mutex<Vec<String>>,
    mode: Mutex<LayoutMode>,
    /// Panels the user has dragged off their auto slot — left untouched by re-flow.
    pinned: Mutex<HashSet<String>>,
    /// label → instant until which a `Moved` is ours (programmatic), not a drag.
    moving: Mutex<HashMap<String, Instant>>,
}

/// Remember a freshly opened panel's label, preserving open order.
pub fn record_open(app: &AppHandle, label: &str) {
    let state = app.state::<LayoutState>();
    let mut order = lock(&state.order);
    if !order.iter().any(|l| l == label) {
        order.push(label.to_string());
    }
}

/// Mark `label` as user-pinned (dragged off its auto slot): re-flow skips it from
/// now on, until the panel is closed. Idempotent; logs once on the transition.
pub fn pin(app: &AppHandle, label: &str) {
    let state = app.state::<LayoutState>();
    if lock(&state.pinned).insert(label.to_string()) {
        eprintln!("[overlay] pinned '{label}' (user-dragged; exempt from re-flow)");
    }
}

/// True while a programmatic move of `label` is still settling, so its `Moved`
/// events must not be mistaken for a user drag.
pub fn is_moving(app: &AppHandle, label: &str) -> bool {
    let state = app.state::<LayoutState>();
    let moving = lock(&state.moving)
        .get(label)
        .is_some_and(|t| Instant::now() < *t);
    moving
}

/// Record that we're moving `label` ourselves; suppresses drag-detection for the
/// grace window. Called on every programmatic `set_position` (snap or each frame).
fn mark_moving(app: &AppHandle, label: &str) {
    let state = app.state::<LayoutState>();
    lock(&state.moving).insert(
        label.to_string(),
        Instant::now() + Duration::from_millis(MOVE_GRACE_MS),
    );
}

/// Current layout mode.
pub fn current_mode(app: &AppHandle) -> LayoutMode {
    let state = app.state::<LayoutState>();
    let mode = *lock(&state.mode);
    mode
}

/// Flip Free ↔ Terminal (⌘9) and re-arrange immediately. Returns the new mode.
pub fn toggle_mode(app: &AppHandle) -> LayoutMode {
    let state = app.state::<LayoutState>();
    let mode = {
        let mut m = lock(&state.mode);
        *m = match *m {
            LayoutMode::Free => LayoutMode::Terminal,
            LayoutMode::Terminal => LayoutMode::Free,
        };
        *m
    };
    arrange(app, true);
    mode
}

/// Which side of a region panels sit flush to. Columns grow away from the anchor.
#[derive(Clone, Copy)]
enum Anchor {
    Left,
    Right,
}

/// A rectangle (logical points, top-left origin) panels pack into — flush to
/// `anchor`, stacking top-down, wrapping to a new column when one fills.
#[derive(Clone, Copy)]
struct Region {
    left: f64,
    right: f64,
    top: f64,
    bottom: f64,
    anchor: Anchor,
}

/// The work-area region (anchored right — the default Free column) plus the primary
/// monitor's scale factor (window sizes come back in physical pixels).
fn screen_region(app: &AppHandle) -> Option<(Region, f64)> {
    let mon = app.primary_monitor().ok().flatten()?;
    let scale = mon.scale_factor();
    let mon_w = mon.size().width as f64 / scale;
    let mon_h = mon.size().height as f64 / scale;
    let ox = mon.position().x as f64 / scale;
    let oy = mon.position().y as f64 / scale;
    Some((
        Region {
            left: ox + SCREEN_MARGIN,
            right: ox + mon_w - SCREEN_MARGIN,
            top: oy + TOP_MARGIN,
            bottom: oy + mon_h - SCREEN_MARGIN,
            anchor: Anchor::Right,
        },
        scale,
    ))
}

/// Regions to fill, in priority order, for the current mode. Free = one screen-wide
/// column. Terminal = the gutter beside the terminal's right edge, then its left edge
/// (so panels sit *alongside* the terminal, not on top of it), each running level
/// with the terminal vertically.
fn regions_for(app: &AppHandle, screen: &Region) -> Vec<Region> {
    match current_mode(app) {
        LayoutMode::Free => vec![*screen],
        LayoutMode::Terminal => match terminal_bounds() {
            Some(t) => {
                let top = t.y.max(screen.top);
                let bottom = (t.y + t.h).min(screen.bottom);
                vec![
                    // Right gutter: flush to the terminal's right edge, growing right.
                    Region {
                        left: t.x + t.w + GAP,
                        right: screen.right,
                        top,
                        bottom,
                        anchor: Anchor::Left,
                    },
                    // Left gutter: flush to the terminal's left edge, growing left.
                    Region {
                        left: screen.left,
                        right: t.x - GAP,
                        top,
                        bottom,
                        anchor: Anchor::Right,
                    },
                ]
            }
            // Terminal not found (e.g. closed) → behave like Free.
            None => vec![*screen],
        },
    }
}

/// Lay panels into one region as top-down columns flush to `region.anchor`, wrapping
/// to a new column (away from the anchor) when one fills vertically. Returns how many
/// panels fit; the rest spill to the next region.
fn pack_region(
    app: &AppHandle,
    region: &Region,
    labels: &[String],
    scale: f64,
    moves: &mut Vec<(String, f64, f64)>,
) -> usize {
    let mut placed = 0usize;
    // The current column's edge on the anchor side.
    let mut near = match region.anchor {
        Anchor::Left => region.left,
        Anchor::Right => region.right,
    };
    let mut y = region.top;
    let mut col_w: f64 = 0.0;
    let mut col_started = false;

    for label in labels {
        let Some(win) = app.get_webview_window(label) else {
            placed += 1;
            continue;
        };
        let (w, h) = match win.outer_size() {
            Ok(s) => (s.width as f64 / scale, s.height as f64 / scale),
            Err(_) => {
                placed += 1;
                continue;
            }
        };

        // Wrap to a new column once this panel would run past the bottom.
        if col_started && y + h > region.bottom {
            near = match region.anchor {
                Anchor::Left => near + col_w + GAP,
                Anchor::Right => near - col_w - GAP,
            };
            y = region.top;
            col_w = 0.0;
            col_started = false;
        }

        let x = match region.anchor {
            Anchor::Left => near,
            Anchor::Right => near - w,
        };
        // Starting a column: if the panel won't fit horizontally, this region is full.
        let fits_h = match region.anchor {
            Anchor::Left => x + w <= region.right,
            Anchor::Right => x >= region.left,
        };
        if !col_started && !fits_h {
            break;
        }

        moves.push((label.clone(), x, y));
        y += h + GAP;
        col_w = col_w.max(w);
        col_started = true;
        placed += 1;
    }
    placed
}

/// Re-flow every artifact panel. Idempotent: re-running after a panel fits, opens,
/// closes, the mode flips, or the terminal moves keeps the same tidy arrangement.
pub fn arrange(app: &AppHandle, animate: bool) {
    let state = app.state::<LayoutState>();
    // Prune state to live windows, then drop user-pinned panels: they keep the
    // position the user dragged them to and never participate in re-flow.
    let labels: Vec<String> = {
        let mut order = lock(&state.order);
        order.retain(|l| app.get_webview_window(l).is_some());
        lock(&state.pinned).retain(|l| app.get_webview_window(l).is_some());
        lock(&state.moving).retain(|l, _| app.get_webview_window(l).is_some());
        let pinned = lock(&state.pinned);
        order
            .iter()
            .filter(|l| !pinned.contains(l.as_str()))
            .cloned()
            .collect()
    };
    if labels.is_empty() {
        return;
    }

    let Some((screen, scale)) = screen_region(app) else {
        return;
    };

    // Compute every target first, then apply them as one coordinated batch.
    // Fill each region in turn; whatever one can't hold spills to the next.
    let mut moves: Vec<(String, f64, f64)> = Vec::new();
    let regions = regions_for(app, &screen);
    let mut idx = 0;
    for region in &regions {
        if idx >= labels.len() {
            break;
        }
        idx += pack_region(app, region, &labels[idx..], scale, &mut moves);
    }
    // Both gutters full → drop the remainder into the screen column so nothing is lost.
    if idx < labels.len() {
        pack_region(app, &screen, &labels[idx..], scale, &mut moves);
    }

    apply_moves(app, moves, scale, animate);
}

/// Apply computed target positions. When `animate`, each currently-visible panel
/// glides to its target over `ANIM_MS` (ease-out cubic); hidden panels (just
/// created, not yet shown) and the non-animated path snap directly. Sub-pixel
/// moves are skipped, and every move is marked so it isn't read back as a drag.
fn apply_moves(app: &AppHandle, moves: Vec<(String, f64, f64)>, scale: f64, animate: bool) {
    // Supersede any in-flight glide.
    let my_gen = ARRANGE_GEN.fetch_add(1, Ordering::SeqCst) + 1;

    let mut batch: Vec<(String, (f64, f64), (f64, f64))> = Vec::new();
    for (label, tx, ty) in moves {
        let Some(win) = app.get_webview_window(&label) else {
            continue;
        };
        // Current position in logical points (outer_position is physical).
        let cur = win
            .outer_position()
            .ok()
            .map(|p| (p.x as f64 / scale, p.y as f64 / scale));
        // Already at the target → nothing to do.
        if cur.is_some_and(|(cx, cy)| (cx - tx).abs() <= MIN_MOVE && (cy - ty).abs() <= MIN_MOVE) {
            continue;
        }
        let visible = win.is_visible().unwrap_or(false);
        if animate && visible && cur.is_some() {
            batch.push((label, cur.unwrap(), (tx, ty)));
        } else {
            mark_moving(app, &label);
            let _ = win.set_position(LogicalPosition::new(tx, ty));
        }
    }

    if batch.is_empty() {
        return;
    }

    let app = app.clone();
    std::thread::spawn(move || {
        let frame = Duration::from_millis(ANIM_MS / ANIM_FRAMES as u64);
        for i in 1..=ANIM_FRAMES {
            if ARRANGE_GEN.load(Ordering::SeqCst) != my_gen {
                return; // a newer arrange superseded us
            }
            let t = i as f64 / ANIM_FRAMES as f64;
            let e = 1.0 - (1.0 - t).powi(3); // ease-out cubic; i == FRAMES → e == 1 (exact)
            for (label, (cx, cy), (tx, ty)) in &batch {
                let x = cx + (tx - cx) * e;
                let y = cy + (ty - cy) * e;
                mark_moving(&app, label);
                if let Some(win) = app.get_webview_window(label) {
                    let _ = win.set_position(LogicalPosition::new(x, y));
                }
            }
            std::thread::sleep(frame);
        }
    });
}

/// Called by the frontend once a panel has resized to its artifact's fitted size,
/// so the column can be laid out with real dimensions.
#[tauri::command]
pub fn notify_fit(app: AppHandle) {
    arrange(&app, true);
}

/// A terminal window's on-screen rectangle (logical points, top-left origin —
/// matching `CGWindowListCopyWindowInfo`'s and Tauri's coordinate convention).
#[derive(Clone, Copy, PartialEq)]
struct Bounds {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// Background thread that keeps the column docked while in Terminal mode. Polls the
/// terminal's bounds at ~40 Hz so dragging the terminal feels like the column is
/// attached; cheap (a mutex check) while Free. Runs for the life of the process.
#[cfg(target_os = "macos")]
pub fn start_follow_poll(app: AppHandle) {
    use std::time::Duration;
    std::thread::spawn(move || {
        let mut last: Option<Bounds> = None;
        loop {
            std::thread::sleep(Duration::from_millis(25));
            if current_mode(&app) != LayoutMode::Terminal {
                last = None;
                continue;
            }
            let now = terminal_bounds();
            if now != last {
                last = now;
                // Live tracking of the terminal — snap instantly (not a discrete
                // re-flow; a glide here would lag behind the drag).
                arrange(&app, false);
            }
        }
    });
}

/// Bounds of the focused/largest allowlisted terminal window, via the window server
/// (`CGWindowListCopyWindowInfo`). Permission-free: we read only owner name + bounds,
/// never window titles (which would require Screen Recording). `None` if none found.
#[cfg(target_os = "macos")]
fn terminal_bounds() -> Option<Bounds> {
    use core_foundation::array::{CFArray, CFArrayRef};
    use core_foundation::base::TCFType;
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::number::{CFNumber, CFNumberRef};
    use core_foundation::string::{CFString, CFStringRef};
    use std::os::raw::c_void;

    const ON_SCREEN: u32 = 1 << 0; // kCGWindowListOptionOnScreenOnly
    const EXCLUDE_DESKTOP: u32 = 1 << 4; // kCGWindowListExcludeDesktopElements
                                         // Preference order: Ghostty first (the headline target), then common terminals.
    const ALLOW: &[&str] = &[
        "Ghostty",
        "Terminal",
        "iTerm2",
        "Alacritty",
        "kitty",
        "WezTerm",
        "Warp",
        "tuicommander",
    ];

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGWindowListCopyWindowInfo(option: u32, relative_to_window: u32) -> CFArrayRef;
    }

    fn value(dict: &CFDictionary, key: &str) -> Option<*const c_void> {
        let k = CFString::new(key);
        dict.find(k.as_concrete_TypeRef() as *const c_void)
            .map(|v| *v)
    }
    fn number(dict: &CFDictionary, key: &str) -> Option<f64> {
        let p = value(dict, key)?;
        if p.is_null() {
            return None;
        }
        unsafe { CFNumber::wrap_under_get_rule(p as CFNumberRef) }.to_f64()
    }
    fn string(dict: &CFDictionary, key: &str) -> Option<String> {
        let p = value(dict, key)?;
        if p.is_null() {
            return None;
        }
        Some(unsafe { CFString::wrap_under_get_rule(p as CFStringRef) }.to_string())
    }

    let arr_ref = unsafe { CGWindowListCopyWindowInfo(ON_SCREEN | EXCLUDE_DESKTOP, 0) };
    if arr_ref.is_null() {
        return None;
    }
    let arr: CFArray = unsafe { CFArray::wrap_under_create_rule(arr_ref) };

    // Best candidate: lowest allowlist rank (Ghostty wins), then largest area.
    let mut best: Option<(usize, f64, Bounds)> = None;
    for item in arr.iter() {
        let dict_ref = *item as CFDictionaryRef;
        if dict_ref.is_null() {
            continue;
        }
        let dict = unsafe { CFDictionary::wrap_under_get_rule(dict_ref) };

        // Layer 0 = normal app windows (skips menu bar, dock, shadows, etc.).
        if number(&dict, "kCGWindowLayer").unwrap_or(1.0) != 0.0 {
            continue;
        }
        let owner = match string(&dict, "kCGWindowOwnerName") {
            Some(o) => o,
            None => continue,
        };
        let Some(rank) = ALLOW.iter().position(|a| a.eq_ignore_ascii_case(&owner)) else {
            continue;
        };

        let Some(bp) = value(&dict, "kCGWindowBounds") else {
            continue;
        };
        if bp.is_null() {
            continue;
        }
        let bounds_dict = unsafe { CFDictionary::wrap_under_get_rule(bp as CFDictionaryRef) };
        let (Some(x), Some(y), Some(w), Some(h)) = (
            number(&bounds_dict, "X"),
            number(&bounds_dict, "Y"),
            number(&bounds_dict, "Width"),
            number(&bounds_dict, "Height"),
        ) else {
            continue;
        };
        // Skip tiny helper/utility windows.
        if w < 200.0 || h < 120.0 {
            continue;
        }
        let area = w * h;
        let better = match best {
            None => true,
            Some((br, ba, _)) => rank < br || (rank == br && area > ba),
        };
        if better {
            best = Some((rank, area, Bounds { x, y, w, h }));
        }
    }
    best.map(|(_, _, b)| b)
}

#[cfg(not(target_os = "macos"))]
fn terminal_bounds() -> Option<Bounds> {
    None
}
