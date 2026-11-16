import type { GraphCommit } from "@/shared/api";

/**
 * One drawn segment inside a row. Rows are drawn independently; each segment
 * runs between a column at the row's top edge, its middle (the commit dot) and
 * its bottom edge.
 *   - "through": a lane passing this row untouched, top → bottom
 *   - "in":      a child's lane arriving at this commit, top → middle
 *   - "out":     an edge to one of this commit's parents, middle → bottom
 */
export interface GraphSegment {
  readonly kind: "through" | "in" | "out";
  readonly from: number;
  readonly to: number;
  readonly color: number;
}

export interface GraphRow {
  readonly commit: GraphCommit;
  readonly column: number;
  readonly color: number;
  readonly segments: ReadonlyArray<GraphSegment>;
  /** Columns this row spans (including passing lanes). */
  readonly width: number;
}

interface Lane {
  /** The commit this lane is waiting to reach. */
  readonly sha: string;
  readonly color: number;
}

/**
 * Assign every commit a column, `git log --graph` style.
 *
 * `commits` must list children before their parents (`--date-order` or
 * `--topo-order`). Lanes never shift sideways once placed, so passing lanes are
 * always vertical; a freed column is reused by the next new lane. Parents
 * outside the loaded window keep their lane open to the bottom.
 */
export function layoutGraph(commits: ReadonlyArray<GraphCommit>): Array<GraphRow> {
  let lanes: Array<Lane | null> = [];
  let nextColor = 0;
  const rows: Array<GraphRow> = [];

  for (const commit of commits) {
    const before = lanes;
    const arriving: Array<number> = [];
    before.forEach((l, i) => l?.sha === commit.sha && arriving.push(i));

    // Continue the leftmost child's lane, or open a new one (a branch tip).
    let column = arriving[0] ?? -1;
    let color: number;
    if (column >= 0) {
      color = before[column]!.color;
    } else {
      column = firstFree(before);
      color = nextColor++;
    }

    const after = before.slice();
    for (const i of arriving) after[i] = null;
    while (after.length <= column) after.push(null);

    const outs: Array<GraphSegment> = [];
    commit.parents.forEach((parent, p) => {
      // Another child already reserved a lane for this parent: join it.
      let target = after.findIndex((l) => l?.sha === parent);
      if (target < 0) {
        // The first parent stays in this commit's column; others branch out.
        target = p === 0 && after[column] === null ? column : firstFree(after);
        after[target] = { sha: parent, color: target === column ? color : nextColor++ };
      }
      outs.push({ kind: "out", from: column, to: target, color: after[target]!.color });
    });

    while (after.length > 0 && after[after.length - 1] === null) after.pop();

    const segments: Array<GraphSegment> = [];
    before.forEach((l, i) => {
      if (l && l.sha !== commit.sha) segments.push({ kind: "through", from: i, to: i, color: l.color });
    });
    for (const i of arriving) segments.push({ kind: "in", from: i, to: column, color: before[i]!.color });
    segments.push(...outs);

    rows.push({ commit, column, color, segments, width: Math.max(before.length, after.length, column + 1) });
    lanes = after;
  }
  return rows;
}

function firstFree(lanes: ReadonlyArray<Lane | null>): number {
  const i = lanes.indexOf(null);
  return i < 0 ? lanes.length : i;
}
