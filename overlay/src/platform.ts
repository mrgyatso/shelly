// Platform detection for user-facing labels. The overlay itself is
// cross-platform; the only thing that differs in the UI is which paste chord
// we advertise next to Submit buttons and copied-toasts.

/** True when the overlay runs on macOS. */
export const IS_MAC = navigator.platform.toUpperCase().includes("MAC");

/** True when the overlay runs on Linux. The Board and History wear a NATIVE
 *  titlebar there (see `open_board_window`), so their in-page chrome — rounded
 *  transparent shell, close/collapse buttons — has to stand down or it reads as
 *  an app floating inside another app's frame. `html.linux` gates that CSS. */
export const IS_LINUX = navigator.platform.toUpperCase().includes("LINUX");

/** The paste chord to show in labels: ⌘V on macOS, Ctrl+V elsewhere. */
export const PASTE_KEY = IS_MAC ? "⌘V" : "Ctrl+V";
