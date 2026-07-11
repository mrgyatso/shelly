// Platform detection for user-facing labels. The overlay itself is
// cross-platform; the only thing that differs in the UI is which paste chord
// we advertise next to Submit buttons and copied-toasts.

/** True when the overlay runs on macOS. */
export const IS_MAC = navigator.platform.toUpperCase().includes("MAC");

/** The paste chord to show in labels: ⌘V on macOS, Ctrl+V elsewhere. */
export const PASTE_KEY = IS_MAC ? "⌘V" : "Ctrl+V";
