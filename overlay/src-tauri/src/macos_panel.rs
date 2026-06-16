//! macOS: turn the overlay window into a non-activating NSPanel.
//!
//! A normal `NSWindow` activates its owning app whenever it is shown or clicked,
//! which steals keyboard focus from whatever the user is typing in (their
//! terminal). An `NSPanel` with the `.nonactivatingPanel` style mask can be
//! shown, raised, dragged, scrolled, and clicked WITHOUT activating the app —
//! exactly the behavior wanted for a ghostly companion overlay.

#[cfg(target_os = "macos")]
mod imp {
    use std::ffi::c_void;
    use std::sync::OnceLock;

    use objc2::runtime::{AnyClass, Bool, ClassBuilder, Sel};
    use objc2::{sel, ClassType};
    use objc2_app_kit::{NSPanel, NSWindow, NSWindowCollectionBehavior, NSWindowStyleMask};
    use tauri::WebviewWindow;

    extern "C" {
        fn object_setClass(obj: *mut c_void, cls: *const c_void) -> *const c_void;
    }

    /// The class tao allocated the window with, captured the first time we
    /// reclass to `CompanionKeyPanel`. tao registers a single window class, so
    /// every overlay window shares it — one stored pointer restores any of
    /// them. Stored as `usize` because the class object is a stable
    /// process-global. Used by `restore_original_class` to undo the reclass
    /// before teardown.
    static ORIGINAL_CLASS: OnceLock<usize> = OnceLock::new();

    /// Process-global cache of the registered `CompanionKeyPanel` class.
    /// Registered exactly once via `ClassBuilder` (Obj-C will refuse to
    /// register the same class name twice — and `ClassBuilder::new` returns
    /// `None` in that case).
    static KEY_PANEL_CLASS: OnceLock<&'static AnyClass> = OnceLock::new();

    /// `canBecomeKeyWindow` override. Borderless `NSPanel`s return NO by
    /// default (no title bar AND no resize bar), which blocks the panel from
    /// ever becoming key. We unconditionally return YES so iframe text fields
    /// can receive `keyDown:` once the user clicks into them. Focus theft is
    /// still prevented by `becomesKeyOnlyIfNeeded = true` +
    /// `ActivationPolicy::Accessory`: the panel becomes key only on an
    /// explicit text-field click, never on auto-pop or chrome interaction.
    extern "C-unwind" fn can_become_key(_this: &NSPanel, _cmd: Sel) -> Bool {
        Bool::YES
    }

    /// `canBecomeMainWindow` override. Returning YES here mirrors
    /// `canBecomeKeyWindow` so AppKit's key/main bookkeeping stays coherent
    /// for the same reasons — without it, certain focus-chain handoffs (web
    /// view → first responder → key window) break in subtle ways.
    extern "C-unwind" fn can_become_main(_this: &NSPanel, _cmd: Sel) -> Bool {
        Bool::YES
    }

    /// Register (once) and return a custom `NSPanel` subclass that overrides
    /// `canBecomeKeyWindow` and `canBecomeMainWindow` to return YES. Reclassing
    /// the tao-created `NSWindow` to *this* (rather than plain `NSPanel`) is
    /// what lets keystrokes reach the WKWebView → iframe → textarea chain.
    fn key_panel_class() -> &'static AnyClass {
        KEY_PANEL_CLASS.get_or_init(|| {
            let superclass: &AnyClass = NSPanel::class();
            let mut builder = ClassBuilder::new(c"CompanionKeyPanel", superclass)
                .expect("CompanionKeyPanel class registration failed");
            // SAFETY: Both overrides match NSWindow's existing selector
            // encodings exactly: zero args, `BOOL` (= `Bool`) return, with the
            // standard `(self, _cmd)` receiver/selector pair.
            // The `fn(_, _) -> _` underscore form is intentional — the explicit
            // `fn(&NSPanel, Sel) -> Bool` cast captures a specific lifetime on
            // `&NSPanel` and fails the `for<'a>` HRTB on `MethodImplementation`.
            // Inference resolves to the higher-rank form objc2 expects.
            unsafe {
                builder.add_method(
                    sel!(canBecomeKeyWindow),
                    can_become_key as extern "C-unwind" fn(_, _) -> _,
                );
                builder.add_method(
                    sel!(canBecomeMainWindow),
                    can_become_main as extern "C-unwind" fn(_, _) -> _,
                );
            }
            builder.register()
        })
    }

    /// Reclass the window's backing `NSWindow` to `NSPanel` and give it the
    /// non-activating style plus cross-Space / over-fullscreen collection
    /// behavior. `NSPanel` is a subclass of `NSWindow`, so Tauri's own window
    /// ops (show/hide/setSize/level/transparency) keep working on the same
    /// object. Call once, on the main thread, after the window exists.
    pub fn make_nonactivating_panel(window: &WebviewWindow) {
        let Ok(ptr) = window.ns_window() else { return };
        if ptr.is_null() {
            return;
        }
        // Reclass to our `CompanionKeyPanel : NSPanel` subclass (NOT plain
        // NSPanel) so `canBecomeKeyWindow` returns YES — required for the
        // WKWebView → iframe → textarea focus chain to receive keystrokes.
        let cls: *const AnyClass = key_panel_class();
        // SAFETY: `ptr` is the live NSWindow backing this Tauri window. AppKit
        // window mutation must happen on the main thread, where Tauri runs
        // `setup` and window callbacks. We only message the object for the
        // duration of these synchronous calls. CompanionKeyPanel ⊂ NSPanel ⊂
        // NSWindow, so the reclassed object still responds to every selector
        // used here.
        unsafe {
            let old_class = object_setClass(ptr, cls.cast());
            // Remember what tao gave us so we can reclass back before teardown
            // (see `restore_original_class`). First window wins; all share it.
            let _ = ORIGINAL_CLASS.set(old_class as usize);
            let panel: &NSPanel = &*(ptr as *const NSPanel);
            // Lifecycle stays with Tauri, NOT AppKit. A programmatically-created
            // NSPanel defaults to `releasedWhenClosed = true`, so closing it makes
            // AppKit release/dealloc the object — but Tauri still owns and tears
            // down the same NSWindow. The double disposal raises a foreign Obj-C
            // NSException during native teardown, which Rust cannot catch, so the
            // whole daemon aborts (close one panel → all panels die). Hand the
            // lifecycle entirely to Tauri so AppKit never releases out from under it.
            panel.setReleasedWhenClosed(false);
            // Non-activating: the panel can show/become-key without activating
            // this app (so the terminal keeps focus).
            //
            // ALSO Resizable: defense in depth. The reclass to
            // `CompanionKeyPanel` is what actually guarantees
            // `canBecomeKeyWindow == YES`; the Resizable flag is a redundant
            // secondary signal (NSPanel's default returns YES when title-bar
            // OR resize-bar is set), kept in case some AppKit internal also
            // consults the style mask directly. Visually borderless because
            // there's no chrome to draw the resize affordance on.
            panel.setStyleMask(
                panel.styleMask()
                    | NSWindowStyleMask::NonactivatingPanel
                    | NSWindowStyleMask::Resizable,
            );
            // Become key ONLY when a control actually needs it — so clicking the
            // chrome / scrolling the artifact does NOT pull keyboard focus.
            // Combined with `canBecomeKeyWindow == YES` (from the
            // `CompanionKeyPanel` subclass), this gives the floating-palette
            // pattern: text-field click ⇒ panel becomes key for typing, every
            // other click leaves the terminal key.
            panel.setBecomesKeyOnlyIfNeeded(true);
            // Float above the app's normal windows.
            panel.setFloatingPanel(true);
            panel.setCollectionBehavior(
                NSWindowCollectionBehavior::CanJoinAllSpaces
                    | NSWindowCollectionBehavior::FullScreenAuxiliary,
            );
            // NOTE: previously we also called `-_setPreventsActivation: true`
            // (a private WindowServer-level tag) here as a belt-and-suspenders
            // focus-theft guard. That tag is too strong for interactive review
            // artifacts: it blocks the panel from EVER becoming the key window,
            // even when `becomesKeyOnlyIfNeeded` would otherwise route a text-
            // field click into making the panel key (without activating the app).
            // The combination still in place — `nonactivatingPanel` style mask
            // + `becomesKeyOnlyIfNeeded(true)` + `ActivationPolicy::Accessory`
            // (set in lib.rs) — is the canonical floating-palette pattern and
            // should prevent focus theft for normal pop / drag / chrome clicks
            // while permitting key for text inputs. If focus regression appears,
            // restore the private call but gate it on a per-panel opt-in (e.g.
            // a `prevents-activation` arg in the window builder URL).
        }
    }

    /// The Board is the **focal** surface (unlike the ghost panels). Its spatial
    /// keyboard nav (↑↓←→ / Tab / Enter / F) only works if the Board is the key
    /// window of the *active* app — i.e. clicking it must make Companion frontmost
    /// and route keystrokes to the Board. We still reclass to `CompanionKeyPanel`
    /// because the window is borderless (a borderless `NSWindow` returns NO for
    /// `canBecomeKeyWindow`). But unlike `make_nonactivating_panel` we do NOT set
    /// the `NonactivatingPanel` mask and we set `becomesKeyOnlyIfNeeded(false)`, so
    /// ANY click — not just a text field — makes the Board key and activates the
    /// app. Pair with `show()` + `set_focus()` at the call site to focus on open.
    pub fn make_board_window(window: &WebviewWindow) {
        let Ok(ptr) = window.ns_window() else { return };
        if ptr.is_null() {
            return;
        }
        let cls: *const AnyClass = key_panel_class();
        // SAFETY: identical invariants to `make_nonactivating_panel` — `ptr` is the
        // live NSWindow, this runs on the main thread, and CompanionKeyPanel ⊂
        // NSPanel ⊂ NSWindow responds to every selector used here.
        unsafe {
            let old_class = object_setClass(ptr, cls.cast());
            let _ = ORIGINAL_CLASS.set(old_class as usize);
            let panel: &NSPanel = &*(ptr as *const NSPanel);
            panel.setReleasedWhenClosed(false);
            // Resizable reinforces `canBecomeKeyWindow`; deliberately NO
            // `NonactivatingPanel` — the Board is allowed to activate + own focus.
            panel.setStyleMask(panel.styleMask() | NSWindowStyleMask::Resizable);
            // Become key on ANY click (not only text fields) so keyboard nav works.
            panel.setBecomesKeyOnlyIfNeeded(false);
            panel.setCollectionBehavior(
                NSWindowCollectionBehavior::CanJoinAllSpaces
                    | NSWindowCollectionBehavior::FullScreenAuxiliary,
            );
        }
    }

    /// Reclass the window's NSWindow BACK to the class tao created it with, to be
    /// called right before the window tears down (on `CloseRequested`). We reclass
    /// each window to `NSPanel` via `object_setClass`, but `NSPanel` and tao's own
    /// window subclass are *siblings* under `NSWindow`, so disposing the object
    /// while it still claims to be `NSPanel` runs the wrong AppKit teardown path
    /// and raises a foreign Obj-C `NSException` — which Rust cannot catch, so it
    /// aborts the whole daemon (close one panel → every panel dies). Restoring the
    /// original class first lets tao dispose a window of the exact class it
    /// allocated. No-op if we never reclassed (e.g. `ns_window` unavailable).
    pub fn restore_original_class(window: &WebviewWindow) {
        let Some(&old) = ORIGINAL_CLASS.get() else {
            return;
        };
        let Ok(ptr) = window.ns_window() else { return };
        if ptr.is_null() {
            return;
        }
        // SAFETY: runs on the main thread (CloseRequested dispatch). `ptr` is the
        // live NSWindow backing this Tauri window, and `old` is exactly the class
        // pointer `object_setClass` returned when we reclassed this same object,
        // so it is a valid class for it.
        unsafe {
            object_setClass(ptr, old as *const c_void);
        }
    }

    /// Show + raise the panel WITHOUT activating the app, so the terminal keeps
    /// keyboard focus. Use everywhere instead of `show()` + `set_focus()`.
    ///
    /// `show()` keeps Tauri's visibility state correct (and reveals panels we
    /// created hidden); under `ActivationPolicy::Prohibited` the app can never
    /// activate, so neither `show()` nor the native order-front can pull keyboard
    /// focus from the terminal. AppKit window ordering MUST run on the main
    /// thread: callers here (single-instance arg-forward, global-shortcut
    /// handler) fire on tokio worker threads, and unlike Tauri's own `show()`
    /// (which marshals internally), a raw `orderFrontRegardless` off the main
    /// thread aborts with SIGILL ("must only be used from the main thread"). So
    /// hop to the main thread explicitly for the order-front.
    pub fn order_front_without_activating(window: &WebviewWindow) {
        let _ = window.show();
        let win = window.clone();
        let _ = window.run_on_main_thread(move || {
            let Ok(ptr) = win.ns_window() else { return };
            if ptr.is_null() {
                return;
            }
            // SAFETY: see `make_nonactivating_panel`; this runs on the main thread.
            unsafe {
                let w: &NSWindow = &*(ptr as *const NSWindow);
                w.orderFrontRegardless();
            }
        });
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use tauri::WebviewWindow;

    pub fn make_nonactivating_panel(_window: &WebviewWindow) {}

    pub fn make_board_window(window: &WebviewWindow) {
        let _ = window.show();
        let _ = window.set_focus();
    }

    pub fn restore_original_class(_window: &WebviewWindow) {}

    pub fn order_front_without_activating(window: &WebviewWindow) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub use imp::*;
