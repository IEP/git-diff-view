/**
 * The commit graph as terminal characters. `layoutGraph` (shared with the web view) gives
 * each row its lanes; this turns one row into box-drawing cells. Pure.
 *
 * Every lane takes two cells: its line, then a gap that a horizontal edge fills with `─`.
 * A row is drawn on its own, from its segments: no look at the rows around it.
 */
import type { GraphRow } from "@/lib/graph";

export interface GraphCell {
  readonly text: string;
  /** Lane colour index (cycle it through a palette), or null for an empty cell. */
  readonly color: number | null;
}

const UP = 1;
const DOWN = 2;
const LEFT = 4;
const RIGHT = 8;

const GLYPH: Record<number, string> = {
  [UP]: "│", [DOWN]: "│", [UP | DOWN]: "│",
  [LEFT]: "─", [RIGHT]: "─", [LEFT | RIGHT]: "─",
  [DOWN | RIGHT]: "╭", [DOWN | LEFT]: "╮", [UP | RIGHT]: "╰", [UP | LEFT]: "╯",
  [UP | DOWN | RIGHT]: "├", [UP | DOWN | LEFT]: "┤", [DOWN | LEFT | RIGHT]: "┬", [UP | LEFT | RIGHT]: "┴",
  [UP | DOWN | LEFT | RIGHT]: "┼",
};

/** `row.width * 2` cells: the commit's dot, its edges, and the lanes passing by. */
export function graphCells(row: GraphRow): Array<GraphCell> {
  const n = row.width;
  /** Lanes passing this row untouched: drawn as `│` even where an edge crosses them. */
  const through: Array<number | null> = Array(n).fill(null);
  const arms: Array<number> = Array(n).fill(0);
  const armColor: Array<number | null> = Array(n).fill(null);
  const gap: Array<number | null> = Array(n).fill(null);

  const horizontal = (a: number, b: number, color: number) => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    for (let i = lo; i < hi; i++) gap[i] = color;
    for (let i = lo + 1; i < hi; i++) {
      arms[i]! |= LEFT | RIGHT;
      armColor[i] ??= color;
    }
  };

  for (const s of row.segments) {
    if (s.kind === "through") {
      through[s.from] = s.color;
      continue;
    }
    // "in" comes down from the top edge at `from`; "out" leaves for the bottom edge at `to`.
    const lane = s.kind === "in" ? s.from : s.to;
    const vertical = s.kind === "in" ? UP : DOWN;
    if (lane === row.column) continue; // straight into or out of the dot
    arms[lane]! |= vertical | (lane > row.column ? LEFT : RIGHT);
    armColor[lane] = s.color;
    horizontal(lane, row.column, s.color);
  }

  const cells: Array<GraphCell> = [];
  for (let i = 0; i < n; i++) {
    if (i === row.column) cells.push({ text: "●", color: row.color });
    else if (through[i] !== null && (arms[i]! & (UP | DOWN)) === 0) cells.push({ text: "│", color: through[i]! });
    else if (arms[i] || through[i] !== null) {
      const bits = arms[i]! | (through[i] !== null ? UP | DOWN : 0);
      cells.push({ text: GLYPH[bits] ?? "│", color: armColor[i] ?? through[i]! });
    } else cells.push({ text: " ", color: null });
    cells.push(gap[i] !== null ? { text: "─", color: gap[i]! } : { text: " ", color: null });
  }
  return cells;
}
