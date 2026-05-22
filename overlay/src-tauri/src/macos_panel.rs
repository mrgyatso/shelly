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

    use objc2::runtime::AnyClass;
    use objc2::{msg_send, sel, ClassType};
    use objc2_app_kit::{NSPanel, NSWindow, NSWindowCollectionBehavior, NSWindowStyleMask};
    use tauri::WebviewWindow;

    extern "C" {
        fn object_setClass(obj: *mut c_void, cls: *const c_void) -> *const c_void;
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
        let cls: *const AnyClass = NSPanel::class();
        // SAFETY: `ptr` is the live NSWindow backing this Tauri window. AppKit
        // window mutation must happen on the main thread, where Tauri runs
        // `setup` and window callbacks. We only message the object for the
        // duration of these synchronous calls. NSPanel ⊂ NSWindow, so the
        // reclassed object still responds to every selector used here.
        unsafe {
            object_setClass(ptr, cls.cast());
            let panel: &NSPanel = &*(ptr as *const NSPanel);
            // Non-activating: the panel can show/become-key without activating
            // this app (so the terminal keeps focus).
            panel.setStyleMask(panel.styleMask() | NSWindowStyleMask::NonactivatingPanel);
            // Become key ONLY when a control actually needs it — so clicking the
            // chrome / scrolling the artifact does NOT pull keyboard focus.
            panel.setBecomesKeyOnlyIfNeeded(true);
            // Float above the app's normal windows.
            panel.setFloatingPanel(true);
            panel.setCollectionBehavior(
                NSWindowCollectionBehavior::CanJoinAllSpaces
                    | NSWindowCollectionBehavior::FullScreenAuxiliary,
            );
            // CRITICAL: AppKit sets the WindowServer "prevents activation" tag
            // (kCGSPreventsActivationTagBit) via the private `-_setPreventsActivation:`
            // ONLY at panel init. Flipping the nonactivating bit later with
            // `setStyleMask:` does NOT re-sync that tag, so without this the app
            // still steals focus on mouse-down even though the mask looks right.
            // Force the tag now. Guarded by respondsToSelector so it can't crash
            // if a future OS drops the private method. (This app already uses
            // macOSPrivateApi; MAS is a deliberate non-goal.)
            let responds: bool =
                msg_send![panel, respondsToSelector: sel!(_setPreventsActivation:)];
            if responds {
                let _: () = msg_send![panel, _setPreventsActivation: true];
            }
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

    pub fn order_front_without_activating(window: &WebviewWindow) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub use imp::*;
