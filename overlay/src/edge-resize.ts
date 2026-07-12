import { getCurrentWindow } from "@tauri-apps/api/window";
import { IS_LINUX } from "./platform";

// Edge-resize grips for the FRAMELESS windows on Linux — the artifact panels and
// the live surface.
//
// Those windows are built with `decorations(false)`, which on Wayland means the
// compositor draws no frame at all: no titlebar, and — the part that bites — no
// resize borders either. `resizable(true)` is not enough on its own; without
// decorations there is simply no edge for the WM to grab, so the windows could
// be moved (the `data-tauri-drag-region` bars call `start_dragging`) but never
// resized. Nothing in the frontend called `startResizeDragging`, and the
// capability wasn't even granted, so the gap was total.
//
// Draw our own grabbable edges and hand each one to the WM's resize loop. macOS
// keeps its native frameless resize behaviour and never calls this. The Board and
// History wear a real titlebar on Linux (see `open_board_window`), so the WM
// already gives them resize borders — they don't call this either.

type Dir =
  | "North" | "South" | "East" | "West"
  | "NorthEast" | "NorthWest" | "SouthEast" | "SouthWest";

/** Grip geometry: a thin band along each edge, with fatter squares at the
 *  corners so diagonal resizing is actually hittable. */
const EDGE = 6;
const CORNER = 14;

/** `inset` (top right bottom left) + cursor for each direction. Corners come
 *  last so they stack above the edges they overlap. */
const GRIPS: [Dir, string, string][] = [
  ["North", `0 ${CORNER}px auto ${CORNER}px`, "ns-resize"],
  ["South", `auto ${CORNER}px 0 ${CORNER}px`, "ns-resize"],
  ["West", `${CORNER}px auto ${CORNER}px 0`, "ew-resize"],
  ["East", `${CORNER}px 0 ${CORNER}px auto`, "ew-resize"],
  ["NorthWest", "0 auto auto 0", "nwse-resize"],
  ["NorthEast", "0 0 auto auto", "nesw-resize"],
  ["SouthWest", "auto auto 0 0", "nesw-resize"],
  ["SouthEast", "auto 0 0 auto", "nwse-resize"],
];

/** Mount the grips. No-op off Linux, and on the windows that have a real frame. */
export function initEdgeResize(): void {
  if (!IS_LINUX) return;

  const win = getCurrentWindow();

  for (const [dir, inset, cursor] of GRIPS) {
    const grip = document.createElement("div");
    const corner = dir.length > 5; // "North"/"South"/"East"/"West" are the edges
    const size = corner ? CORNER : EDGE;
    grip.style.cssText =
      `position:fixed;inset:${inset};z-index:2147483647;cursor:${cursor};` +
      (corner
        ? `width:${size}px;height:${size}px;`
        : dir === "North" || dir === "South"
          ? `height:${size}px;`
          : `width:${size}px;`);

    // pointerdown, not click: the WM takes over the pointer for the whole drag,
    // so we never see a matching pointerup. preventDefault stops the webview from
    // also starting a text selection under the cursor.
    grip.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      void win.startResizeDragging(dir).catch((err) =>
        console.error("startResizeDragging failed", dir, err),
      );
    });

    document.body.append(grip);
  }
}
