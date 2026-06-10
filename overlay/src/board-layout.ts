// Board layout helpers — masonry distribution, the responsive column count, and
// the bento geometry. Pure layout math kept out of board.ts so the main module
// stays focused on data wiring + interaction. Mirrors the design's distribute()
// and density model (board.jsx); the unit/gap/pane-gap match board.css.

/** Bento unit + gaps (gridDensity=cozy; must match board.css :root tokens). */
export const DENSITY = { u: 156, gap: 12, pane: 22 } as const;

/** A pane's worth of layout data the distributor needs. */
export interface PaneWeight {
  /** The source slug (or UNSOURCED) — identifies the pane. */
  source: string;
  /** Columns this pane's bento spans. */
  cols: number;
  /** Total bento area (sum of cspan*rspan) of its tiles. */
  area: number;
}

/** One slot in a masonry column: an agent pane or the trailing empty slot. */
export type Slot = { type: "pane"; source: string } | { type: "empty" };

/**
 * Balanced masonry: keep each pane intact, pack columns by accumulated height so
 * the heaviest panes land along the top row and there are no dead gaps. Returns
 * `numCols` columns, each an ordered list of slots. A single trailing "empty"
 * slot (the idle-agent affordance) is distributed too. Ported from board.jsx.
 */
export function distribute(panes: PaneWeight[], numCols: number): Slot[][] {
  const items = panes.map((p) => ({
    slot: { type: "pane", source: p.source } as Slot,
    weight: Math.ceil(p.area / Math.max(1, p.cols)) + 1,
  }));
  items.push({ slot: { type: "empty" }, weight: 2 });

  const cols = Array.from({ length: Math.max(1, numCols) }, () => ({
    items: [] as Slot[],
    h: 0,
  }));
  for (const it of items) {
    let m = 0;
    for (let i = 1; i < cols.length; i++) if (cols[i].h < cols[m].h) m = i;
    cols[m].items.push(it.slot);
    cols[m].h += it.weight;
  }
  return cols.map((c) => c.items);
}

/**
 * Responsive masonry column count from the board's inner width. A pane is up to
 * 2 bento units wide; we fit as many side-by-side as the surface allows, clamped
 * to [1, 5]. Mirrors the design's measure() in board.jsx.
 */
export function columnCount(boardWidth: number): number {
  const paneW = DENSITY.u * 2 + DENSITY.gap;
  const w = boardWidth - 52; // .panes-scroll horizontal padding (26 * 2)
  const n = Math.floor((w + DENSITY.pane) / (paneW + DENSITY.pane));
  return Math.max(1, Math.min(5, n));
}

/** One bento cell in px (unit + gap), for converting a pixel drag → a span. */
export function cellPx(): number {
  return DENSITY.u + DENSITY.gap;
}
