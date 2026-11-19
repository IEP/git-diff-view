/**
 * One file's diff as rows to draw: hunk headers, changed and context lines, and the
 * unchanged stretches between hunks ("gaps"), which can be opened a few lines at a
 * time from either end, or all at once, when both full contents are known.
 */

export type LineKind = "ctx" | "add" | "del";

export interface DiffLine {
  readonly kind: LineKind;
  readonly text: string;
  /** Line number in the base file (null for an added line). */
  readonly old: number | null;
  /** Line number in the head file (null for a removed line). */
  readonly new: number | null;
}

export interface Hunk {
  readonly header: string;
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly lines: ReadonlyArray<DiffLine>;
}

export interface ParsedPatch {
  readonly hunks: ReadonlyArray<Hunk>;
  /** `Binary files … differ`. */
  readonly binary: boolean;
  /** Mode change, rename without content change, empty file: header notes worth showing. */
  readonly notes: ReadonlyArray<string>;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** Parse a single-file unified diff (`git diff -- path`). Hunk bodies are read by their counts, never by prefix. */
export function parseFilePatch(patch: string): ParsedPatch {
  const lines = patch.split("\n");
  const hunks: Array<Hunk> = [];
  const notes: Array<string> = [];
  let binary = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i++]!;
    const m = HUNK.exec(line);
    if (!m) {
      if (/^Binary files .* differ$/.test(line)) binary = true;
      else if (/^(old mode|new mode|similarity index|rename from|rename to|copy from|copy to|new file mode|deleted file mode)/.test(line)) notes.push(line);
      continue;
    }
    const oldStart = Number(m[1]);
    const oldCount = m[2] === undefined ? 1 : Number(m[2]);
    const newStart = Number(m[3]);
    const newCount = m[4] === undefined ? 1 : Number(m[4]);
    let o = oldStart;
    let n = newStart;
    let oldLeft = oldCount;
    let newLeft = newCount;
    const body: Array<DiffLine> = [];
    while ((oldLeft > 0 || newLeft > 0) && i < lines.length) {
      const l = lines[i++]!;
      if (l.startsWith("\\")) continue;
      const text = l.slice(1);
      if (l.startsWith("-")) {
        body.push({ kind: "del", text, old: o++, new: null });
        oldLeft--;
      } else if (l.startsWith("+")) {
        body.push({ kind: "add", text, old: null, new: n++ });
        newLeft--;
      } else {
        body.push({ kind: "ctx", text, old: o++, new: n++ });
        oldLeft--;
        newLeft--;
      }
    }
    hunks.push({ header: line, oldStart, oldCount, newStart, newCount, lines: body });
  }
  return { hunks, binary, notes };
}

/** A file's lines without the empty string after a final newline. */
export function splitLines(content: string | null): Array<string> | null {
  if (content === null) return null;
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

/** Unchanged lines between two hunks (or before the first / after the last). */
export interface Gap {
  /** Stable while the hunks around it stay put: the head-side line range. */
  readonly key: string;
  readonly oldFrom: number;
  readonly newFrom: number;
  readonly count: number;
}

/** How much of each gap is open: lines shown from its top and from its bottom. */
export type Expansions = ReadonlyMap<string, { readonly top: number; readonly bottom: number }>;

export type UnifiedRow =
  | { readonly t: "hunk"; readonly text: string }
  | { readonly t: "gap"; readonly gap: Gap; readonly hidden: number }
  | { readonly t: "line"; readonly line: DiffLine };

export interface Side {
  readonly kind: LineKind;
  readonly n: number;
  readonly text: string;
}

export type SplitRow =
  | { readonly t: "hunk"; readonly text: string }
  | { readonly t: "gap"; readonly gap: Gap; readonly hidden: number }
  | { readonly t: "pair"; readonly left: Side | null; readonly right: Side | null };

/** Where a hunk starts and ends on each side. A zero-length side sits *after* its start line. */
function span(h: Hunk) {
  const os = h.oldCount === 0 ? h.oldStart + 1 : h.oldStart;
  const ns = h.newCount === 0 ? h.newStart + 1 : h.newStart;
  return { os, ns, oe: os + h.oldCount, ne: ns + h.newCount };
}

/**
 * The hunks and gaps in file order, as unified rows. Gaps need the head file's text
 * (or the base file's, for a deleted file); without it, only hunks are listed.
 */
export function unifiedRows(
  parsed: ParsedPatch,
  oldLines: ReadonlyArray<string> | null,
  newLines: ReadonlyArray<string> | null,
  open: Expansions,
): Array<UnifiedRow> {
  const rows: Array<UnifiedRow> = [];
  const text = newLines ?? oldLines;
  const fromNew = newLines !== null;
  let prevOld = 1;
  let prevNew = 1;

  const gap = (oldFrom: number, newFrom: number, count: number) => {
    if (count <= 0 || text === null) return false;
    const g: Gap = { key: `${newFrom}+${count}`, oldFrom, newFrom, count };
    const e = open.get(g.key) ?? { top: 0, bottom: 0 };
    const top = Math.min(e.top, count);
    const bottom = Math.min(e.bottom, count - top);
    const ctx = (k: number): UnifiedRow => {
      const o = oldFrom + k;
      const n = newFrom + k;
      return { t: "line", line: { kind: "ctx", text: text[(fromNew ? n : o) - 1] ?? "", old: o, new: n } };
    };
    for (let k = 0; k < top; k++) rows.push(ctx(k));
    if (top + bottom < count) rows.push({ t: "gap", gap: g, hidden: count - top - bottom });
    for (let k = count - bottom; k < count; k++) rows.push(ctx(k));
    return true;
  };

  for (const h of parsed.hunks) {
    const { os, ns, oe, ne } = span(h);
    const shown = gap(prevOld, prevNew, ns - prevNew);
    // The header is only useful where something is hidden above it.
    if (!shown || rows[rows.length - 1]?.t === "gap" || text === null) rows.push({ t: "hunk", text: h.header });
    for (const line of h.lines) rows.push({ t: "line", line });
    prevOld = oe;
    prevNew = ne;
  }
  // After the last hunk: only known when the head file is (a deleted file has nothing after).
  if (newLines !== null && parsed.hunks.length > 0) gap(prevOld, prevNew, newLines.length - prevNew + 1);
  return rows;
}

/** The same rows side by side: removed lines pair with the added lines that follow them. */
export function splitRows(unified: ReadonlyArray<UnifiedRow>): Array<SplitRow> {
  const out: Array<SplitRow> = [];
  let dels: Array<DiffLine> = [];
  let adds: Array<DiffLine> = [];
  const flush = () => {
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      const d = dels[k];
      const a = adds[k];
      out.push({
        t: "pair",
        left: d ? { kind: "del", n: d.old!, text: d.text } : null,
        right: a ? { kind: "add", n: a.new!, text: a.text } : null,
      });
    }
    dels = [];
    adds = [];
  };
  for (const row of unified) {
    if (row.t === "line" && row.line.kind === "del") {
      if (adds.length) flush();
      dels.push(row.line);
    } else if (row.t === "line" && row.line.kind === "add") {
      adds.push(row.line);
    } else {
      flush();
      if (row.t === "line") {
        out.push({ t: "pair", left: { kind: "ctx", n: row.line.old!, text: row.line.text }, right: { kind: "ctx", n: row.line.new!, text: row.line.text } });
      } else out.push(row);
    }
  }
  flush();
  return out;
}

/** Open `lines` more of a gap from one end, or all of it. */
export function expand(open: Expansions, gap: Gap, how: "up" | "down" | "all", lines = 20): Map<string, { top: number; bottom: number }> {
  const next = new Map(open);
  const e = next.get(gap.key) ?? { top: 0, bottom: 0 };
  if (how === "all") next.set(gap.key, { top: gap.count, bottom: 0 });
  else if (how === "down") next.set(gap.key, { top: e.top + lines, bottom: e.bottom });
  else next.set(gap.key, { top: e.top, bottom: e.bottom + lines });
  return next;
}

/** Row index of a line, for jumping to a search hit. */
export function findLine(rows: ReadonlyArray<UnifiedRow>, side: "old" | "new", line: number): number {
  return rows.findIndex((r) => r.t === "line" && (side === "old" ? r.line.old === line && r.line.kind !== "add" : r.line.new === line && r.line.kind !== "del"));
}

export function findPair(rows: ReadonlyArray<SplitRow>, side: "old" | "new", line: number): number {
  return rows.findIndex((r) => r.t === "pair" && (side === "old" ? r.left?.n === line && r.left.kind !== "ctx" : r.right?.n === line && r.right.kind !== "ctx"));
}

/** Text draws a tab as nothing: pad each to the next 4-column stop. */
export const untab = (text: string) => (text.includes("\t") ? text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd(s.length - 1 - ((s.length - 1) % 4) + 4)) : text);

/** A half-open character range `[from, to)` in a line's drawn (untabbed) text. */
export type Range = readonly [number, number];

// Words (letters, digits, `_`, anything non-ASCII), runs of spaces, or one punctuation mark.
const TOKEN = /[A-Za-z0-9_\u0080-￿]+|\s+|[^A-Za-z0-9_\s\u0080-￿]/g;
const MAX_INLINE_CHARS = 1000;
const MAX_INLINE_TOKENS = 300;

/**
 * The words that differ between a removed line and the added line that replaced it,
 * as ranges on each side. Null when the lines are too long to compare or mostly
 * different: then the whole-line tint already says everything.
 */
export function inlineChanges(before: string, after: string): { readonly del: Array<Range>; readonly add: Array<Range> } | null {
  if (before === after || before.length > MAX_INLINE_CHARS || after.length > MAX_INLINE_CHARS) return null;
  const a = before.match(TOKEN) ?? [];
  const b = after.match(TOKEN) ?? [];
  if (a.length > MAX_INLINE_TOKENS || b.length > MAX_INLINE_TOKENS) return null;

  // Longest common token subsequence, filled from the end so the walk below goes forward.
  const w = b.length + 1;
  const lcs = new Uint16Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
    }
  }
  const del: Array<[number, number]> = [];
  const add: Array<[number, number]> = [];
  const mark = (out: Array<[number, number]>, from: number, len: number) => {
    const last = out[out.length - 1];
    if (last && last[1] === from) last[1] = from + len;
    else out.push([from, from + len]);
  };
  let i = 0, j = 0, x = 0, y = 0, same = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      same += a[i]!.trim() ? a[i]!.length : 0;
      x += a[i++]!.length;
      y += b[j++]!.length;
    } else if (j < b.length && (i === a.length || lcs[i * w + j + 1]! >= lcs[(i + 1) * w + j]!)) {
      mark(add, y, b[j]!.length);
      y += b[j++]!.length;
    } else {
      mark(del, x, a[i]!.length);
      x += a[i++]!.length;
    }
  }
  // Less than half of the shorter line's visible text kept: it was rewritten, not edited.
  const visible = Math.min(before.replace(/\s/g, "").length, after.replace(/\s/g, "").length);
  if (same * 2 < visible || (del.length === 0 && add.length === 0)) return null;
  return { del, add };
}

/**
 * Changed-word ranges for every removed and added line that has a partner, keyed
 * `del<old>` / `add<new>`. Lines pair up the way `splitRows` pairs them, so both
 * layouts mark the same words. Ranges are on the untabbed text, as drawn.
 */
export function inlineMarks(unified: ReadonlyArray<UnifiedRow>): Map<string, Array<Range>> {
  const marks = new Map<string, Array<Range>>();
  let dels: Array<DiffLine> = [];
  let adds: Array<DiffLine> = [];
  const flush = () => {
    for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
      const d = dels[k]!;
      const a = adds[k]!;
      const c = inlineChanges(untab(d.text), untab(a.text));
      if (!c) continue;
      if (c.del.length) marks.set(`del${d.old}`, c.del);
      if (c.add.length) marks.set(`add${a.new}`, c.add);
    }
    dels = [];
    adds = [];
  };
  for (const row of unified) {
    if (row.t === "line" && row.line.kind === "del") {
      if (adds.length) flush();
      dels.push(row.line);
    } else if (row.t === "line" && row.line.kind === "add") adds.push(row.line);
    else flush();
  }
  flush();
  return marks;
}

/** A piece of a drawn line: inside a changed word, a search match, both or neither. */
export interface Segment {
  readonly text: string;
  readonly changed: boolean;
  readonly hit: boolean;
}

/** Cut `text` where changed-word ranges and case-insensitive matches of `query` start and end. */
export function segments(text: string, changed: ReadonlyArray<Range> | undefined, query: string): Array<Segment> {
  const hits: Array<Range> = [];
  const q = query.toLowerCase();
  if (q) {
    const lower = text.toLowerCase();
    // Lower-casing can change a string's length (rare): then skip marking matches.
    if (lower.length === text.length) for (let at = lower.indexOf(q); at >= 0; at = lower.indexOf(q, at + q.length)) hits.push([at, at + q.length]);
  }
  const cuts = new Set<number>([0, text.length]);
  for (const [f, t] of changed ?? []) cuts.add(f).add(t);
  for (const [f, t] of hits) cuts.add(f).add(t);
  const points = [...cuts].filter((p) => p >= 0 && p <= text.length).sort((x, y) => x - y);
  const inside = (ranges: ReadonlyArray<Range>, p: number) => ranges.some(([f, t]) => p >= f && p < t);
  const out: Array<Segment> = [];
  for (let k = 0; k + 1 < points.length; k++) {
    const from = points[k]!;
    const seg = { text: text.slice(from, points[k + 1]), changed: inside(changed ?? [], from), hit: inside(hits, from) };
    const last = out[out.length - 1];
    if (last && last.changed === seg.changed && last.hit === seg.hit) out[out.length - 1] = { ...last, text: last.text + seg.text };
    else out.push(seg);
  }
  return out.length ? out : [{ text, changed: false, hit: false }];
}
