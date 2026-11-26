/**
 * Draws the state as one string per terminal row. Pure: the same state and size always
 * give the same frame, so `bun test` can check screens without a terminal.
 */
import { segments, untab, type DiffLine, type Side } from "./diffModel";
import type { SyntaxKind, SyntaxRun } from "./syntax";
import { clean, ellipsize, ellipsizeStart, fit, width, type Span, type Style } from "./ansi";
import { diffRows, emptyMessage, layoutFor, layoutOf, pickerItems, revLabel, searchRows, selectedFile, treeRows, type Layout, type State } from "./state";

// 256-colour palette, tuned for dark terminals.
const C = {
  bar: 236, barText: 252, accent: 75, dim: 244, gutter: 242, rule: 238,
  cursor: 238, cursorMark: 75,
  addBg: 22, delBg: 52, addWord: 28, delWord: 88, emptySide: 235,
  hunk: 74, hunkBg: 235, hitBg: 178, hitFg: 16, jumpMark: 178,
  add: 114, del: 174, mod: 179, ren: 74, error: 203,
};

const SYNTAX: Record<SyntaxKind, number> = {
  keyword: 176, string: 114, number: 179, comment: 245, function: 75, type: 80, attr: 180, tag: 204, meta: 109,
};

const STATUS: Record<string, { letter: string; fg: number }> = {
  added: { letter: "A", fg: C.add }, deleted: { letter: "D", fg: C.del }, modified: { letter: "M", fg: C.mod },
  renamed: { letter: "R", fg: C.ren }, copied: { letter: "C", fg: C.ren }, typechange: { letter: "T", fg: C.mod }, unknown: { letter: "?", fg: C.dim },
};

const bar: Style = { bg: C.bar, fg: C.barText };

export function frame(state: State, cols: number, rows: number): Array<string> {
  const L = layoutFor(state, cols, rows);
  const out: Array<string> = [header(state, cols)];
  let body: Array<string>;
  if (state.fatal) body = message(L.body, cols, state.fatal, C.error);
  else if (state.help) body = help(L.body, cols);
  else if (state.picker) body = picker(state, L.body, cols);
  else body = panes(state, L);
  out.push(...body, footer(state, cols));
  return out;
}

// ---------------------------------------------------------------- header / footer

/** What clicking a part of the header does. */
export type HeaderAction = "base" | "head" | "pr" | "mode";
type HeaderSpan = Span & { readonly action?: HeaderAction };

function headerParts(state: State): { left: Array<HeaderSpan>; right: string } {
  const name = state.info?.name ?? state.root.split("/").pop() ?? "";
  const left: Array<HeaderSpan> = [{ text: ` ${name} `, style: { ...bar, bold: true, fg: C.accent } }];
  if (state.pr !== null) {
    const title = state.pull ? ` ${state.pull.title}` : "";
    left.push({ text: ` #${state.pr}${title} `, style: { ...bar, bold: true }, action: "pr" });
    if (state.pull) left.push({ text: ` ${state.pull.baseRef} ← ${state.pull.headRef} `, style: { ...bar, fg: C.dim }, action: "pr" });
  } else if (state.base || state.head) {
    left.push({ text: ` ${revLabel(state.base)} `, style: { ...bar, bold: true }, action: "base" }, { text: "→", style: { ...bar, fg: C.dim } }, { text: ` ${revLabel(state.head)} `, style: { ...bar, bold: true }, action: "head" });
  }
  const files = state.compare?.files;
  if (files) {
    const add = files.reduce((n, f) => n + f.additions, 0);
    const del = files.reduce((n, f) => n + f.deletions, 0);
    left.push({ text: `  ${files.length} file${files.length === 1 ? "" : "s"} `, style: { ...bar, fg: C.dim } }, { text: `+${add}`, style: { ...bar, fg: C.add } }, { text: " ", style: bar }, { text: `−${del}`, style: { ...bar, fg: C.del } });
  }
  return { left, right: ` ${state.loading ? "loading… " : ""}${state.mode === "split" ? "side by side" : "unified"} ` };
}

function header(state: State, cols: number): string {
  const { left, right } = headerParts(state);
  return fit(left, Math.max(0, cols - width(right)), bar) + fit([{ text: right, style: { ...bar, fg: C.dim } }], Math.min(cols, width(right)), bar);
}

/** The header action under a 0-based column, laid out exactly as `header` draws it. */
export function headerAction(state: State, cols: number, x: number): HeaderAction | null {
  const { left, right } = headerParts(state);
  if (x >= cols - width(right)) return "mode";
  let at = 0;
  for (const span of left) {
    const w = width(clean(span.text));
    if (x >= at && x < at + w) return span.action ?? null;
    at += w;
  }
  return null;
}

function footer(state: State, cols: number): string {
  if (state.filtering) return fit([{ text: " Filter: ", style: { ...bar, fg: C.accent, bold: true } }, { text: state.filter, style: bar }, { text: "▏", style: { ...bar, fg: C.accent } }, { text: "   enter done · esc clear", style: { ...bar, fg: C.dim } }], cols, bar);
  if (state.search.editing) return fit([{ text: " Search: ", style: { ...bar, fg: C.accent, bold: true } }, { text: state.search.query, style: bar }, { text: "▏", style: { ...bar, fg: C.accent } }, { text: "   enter to results · esc close", style: { ...bar, fg: C.dim } }], cols, bar);
  if (state.message) return fit([{ text: ` ${state.message}`, style: { ...bar, fg: C.mod } }], cols, bar);
  const hints = state.picker
    ? "type to filter · ↑↓ move · enter pick · esc cancel"
    : state.help
      ? "esc / ? close"
      : state.search.open
        ? "↑↓ hits · enter open · n/N next/prev · / edit · tab diff · esc close"
        : state.focus === "tree"
          ? "↑↓ move · ←→ fold · enter open · tab diff · f filter · / search · b/h base/head · p PRs · s layout · ? help · q quit"
          : "↑↓ scroll · ←→ pan · enter expand · [ ] hunk · , . file · tab tree · / search · s layout · ? help · q quit";
  return fit([{ text: ` ${hints}`, style: { ...bar, fg: C.dim } }], cols, bar);
}

function message(rows: number, cols: number, text: string, fg = C.dim): Array<string> {
  const out: Array<string> = [];
  for (let r = 0; r < rows; r++) out.push(r === Math.floor(rows / 2) - 1 ? fit([{ text: centered(text, cols), style: { fg } }], cols) : fit([], cols));
  return out;
}

const centered = (text: string, cols: number) => {
  const t = ellipsize(text, cols);
  return " ".repeat(Math.max(0, Math.floor((cols - width(t)) / 2))) + t;
};

// ---------------------------------------------------------------- panes

function panes(state: State, L: Layout): Array<string> {
  const left = L.side > 0 ? (state.search.open ? searchPane(state, L) : treePane(state, L)) : null;
  const right = L.diffWidth > 0 ? diffPane(state, L) : null;
  const rule = fit([{ text: "│", style: { fg: state.resizing ? C.accent : C.rule, bold: state.resizing } }], 1);
  const out: Array<string> = [];
  for (let r = 0; r < L.body; r++) out.push((left ? left[r]! + (right ? rule : "") : "") + (right ? right[r]! : ""));
  return out;
}

function treePane(state: State, L: Layout): Array<string> {
  const w = L.side;
  const rows = treeRows(state);
  const out: Array<string> = [];
  const focused = state.focus === "tree";
  const title = state.filter ? `Files · “${state.filter}” (${rows.filter((r) => r.node.kind === "file").length})` : "Files";
  out.push(fit([{ text: ` ${title}`, style: { bold: focused, fg: focused ? C.accent : C.dim } }], w));
  const h = L.body - 1;
  if (!state.compare) {
    for (let r = 0; r < h; r++) out.push(fit(r === 0 && state.loading ? [{ text: " Loading…", style: { fg: C.dim } }] : [], w));
    return out;
  }
  if (rows.length === 0) {
    out.push(fit([{ text: state.filter ? " No files match." : " No changed files.", style: { fg: C.dim } }], w));
    for (let r = 1; r < h; r++) out.push(fit([], w));
    return out;
  }
  for (let r = 0; r < h; r++) {
    const i = state.treeScroll + r;
    const row = rows[i];
    if (!row) {
      out.push(fit([], w));
      continue;
    }
    const isCursor = i === state.treeCursor && focused;
    const base: Style = isCursor ? { bg: C.cursor } : {};
    const indent = "  ".repeat(row.depth);
    const n = row.node;
    let spans: Array<Span>;
    let stats: Array<Span> = [];
    if (n.kind === "dir") {
      const open = state.filter.trim() !== "" || !state.collapsed.has(n.path);
      spans = [{ text: ` ${indent}${open ? "▾" : "▸"} `, style: { ...base, fg: C.dim } }, { text: `${n.name}/`, style: { ...base, fg: C.accent } }];
    } else {
      const s = STATUS[n.change.status] ?? STATUS.unknown!;
      const sel = n.path === state.selected;
      spans = [{ text: ` ${indent}`, style: base }, { text: s.letter, style: { ...base, fg: s.fg, bold: true } }, { text: " ", style: base }, { text: n.name, style: { ...base, bold: sel, underline: sel && !focused } }];
      if (n.change.binary) stats = [{ text: " bin ", style: { ...base, fg: C.dim } }];
      else stats = [{ text: ` +${n.change.additions}`, style: { ...base, fg: C.add } }, { text: ` −${n.change.deletions} `, style: { ...base, fg: C.del } }];
    }
    // The name comes first: counts show only where they fit beside it.
    const nameW = spans.reduce((x, s) => x + width(clean(s.text)), 0);
    if (nameW + stats.reduce((x, s) => x + width(s.text), 0) > w) stats = [];
    const statW = stats.reduce((x, s) => x + width(s.text), 0);
    out.push(fit(spans, w - statW, base) + (statW ? fit(stats, statW, base) : ""));
  }
  return out;
}

function searchPane(state: State, L: Layout): Array<string> {
  const w = L.side;
  const s = state.search;
  const out: Array<string> = [];
  out.push(fit([{ text: " Search ", style: { bold: true, fg: C.accent } }, { text: `“${s.query}”`, style: { bold: true } }], w));
  const res = s.result;
  const summary = s.error
    ? s.error
    : s.busy
      ? "Searching…"
      : !s.query.trim()
        ? "Type to search the changed lines."
        : res && res.total > 0
          ? `${res.total} line${res.total === 1 ? "" : "s"} in ${new Set(res.hits.map((h) => h.path)).size} file${new Set(res.hits.map((h) => h.path)).size === 1 ? "" : "s"}${res.total > res.hits.length ? ` (first ${res.hits.length})` : ""}${res.partial ? " · partial" : ""}`
          : "No matches.";
  out.push(fit([{ text: ` ${summary}`, style: { fg: s.error ? C.error : C.dim } }], w));
  const rows = searchRows(res);
  const h = L.body - 2;
  const q = s.query;
  for (let r = 0; r < h; r++) {
    const row = rows[s.scroll + r];
    if (!row) {
      out.push(fit([], w));
      continue;
    }
    if (row.t === "file") {
      out.push(fit([{ text: ` ${ellipsizeStart(row.path, w - 6)}`, style: { fg: C.accent } }, { text: ` ${row.count}`, style: { fg: C.dim } }], w));
      continue;
    }
    const hit = res!.hits[row.i]!;
    const cur = row.i === s.cursor;
    const base: Style = cur ? { bg: C.cursor } : {};
    const sign = hit.side === "new" ? "+" : "−";
    const spans: Array<Span> = [{ text: `  ${sign}`, style: { ...base, fg: hit.side === "new" ? C.add : C.del } }, { text: `${String(hit.line).padStart(5)} `, style: { ...base, fg: C.gutter } }];
    // Start the snippet near the match when it would be cut off.
    let text = untab(hit.text).trimStart();
    const at = text.toLowerCase().indexOf(q.toLowerCase());
    const room = w - 9;
    if (at > 0 && at + q.length > room) text = "…" + text.slice(Math.max(0, at - Math.max(2, Math.floor((room - q.length) / 2))));
    for (const seg of segments(text, undefined, q)) spans.push({ text: seg.text, style: seg.hit ? { bg: C.hitBg, fg: C.hitFg } : base });
    out.push(fit(spans, w, base));
  }
  return out;
}

// ---------------------------------------------------------------- diff

function diffPane(state: State, L: Layout): Array<string> {
  const w = L.diffWidth;
  const out: Array<string> = [];
  const f = selectedFile(state);
  const focused = state.focus === "diff";
  if (f) {
    const s = STATUS[f.status] ?? STATUS.unknown!;
    const name = f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;
    const stats = f.binary ? " binary " : ` +${f.additions} −${f.deletions} `;
    out.push(fit([{ text: ` ${s.letter} `, style: { fg: s.fg, bold: true } }, { text: ellipsizeStart(name, Math.max(1, w - width(stats) - 4)), style: { bold: true, fg: focused ? C.accent : undefined } }, { text: stats, style: { fg: C.dim } }], w));
  } else out.push(fit([], w));

  const h = L.diffBody;
  const empty = emptyMessage(state);
  if (empty) {
    const failed = empty === state.compareError || empty === state.fileError;
    return [...out, ...message(h, w, empty, failed ? C.error : C.dim)];
  }
  const built = diffRows(state);
  const file = state.file;
  if (!built || !file) return [...out, ...message(h, w, "")];
  const docs = file.syntax;
  const runs = (side: "old" | "new", n: number): ReadonlyArray<SyntaxRun> | null | undefined => (side === "old" ? docs?.old : docs?.new)?.runs[n - 1];
  const query = state.search.open ? state.search.query.trim() : "";
  const jump = state.search.jump && state.search.jump.path === file.path ? state.search.jump : null;

  // Line numbers fit the longest file.
  const maxLine = Math.max(file.oldLines?.length ?? 0, file.newLines?.length ?? 0, ...file.parsed.hunks.map((h) => Math.max(h.oldStart + h.oldCount, h.newStart + h.newCount)));
  const nw = Math.max(3, String(maxLine).length);

  for (let r = 0; r < h; r++) {
    const i = state.diffScroll + r;
    const row = built.rows[i];
    if (!row) {
      out.push(fit([], w));
      continue;
    }
    const isCursor = focused && i === state.diffCursor;
    const mark: Span = { text: isCursor ? "▌" : " ", style: { fg: C.cursorMark } };
    if (row.t === "hunk") {
      out.push(fit([mark, { text: ` ${row.text}`, style: { fg: C.hunk, bg: C.hunkBg } }], w, { bg: C.hunkBg }));
      continue;
    }
    if (row.t === "gap") {
      out.push(fit([mark, ...gapSpans(row.hidden, isCursor)], w, { bg: C.hunkBg }));
      continue;
    }
    if (row.t === "line") {
      const line = row.line;
      const jumped = jump !== null && (jump.side === "old" ? line.old === jump.line && line.kind === "del" : line.new === jump.line && line.kind === "add");
      const gutter = `${line.old === null ? "".padStart(nw) : String(line.old).padStart(nw)} ${line.new === null ? "".padStart(nw) : String(line.new).padStart(nw)} `;
      const textW = Math.max(0, w - 1 - width(gutter));
      out.push(fit([isCursor ? mark : jumped ? { text: "▌", style: { fg: C.jumpMark } } : mark, { text: gutter, style: { fg: C.gutter, bg: lineBg(line.kind) } }], 1 + width(gutter)) + lineText(line.kind, line.text, line.kind === "del" ? "old" : "new", line.kind === "del" ? line.old! : line.new!, built.marks, query, runs, textW, state.hscroll));
      continue;
    }
    // Side by side: the left half is the base file, the right half the head file.
    const leftW = Math.floor((w - 2) / 2);
    const rightW = w - 2 - leftW;
    const jumpedLeft = jump !== null && jump.side === "old" && row.left?.kind === "del" && row.left.n === jump.line;
    const jumpedRight = jump !== null && jump.side === "new" && row.right?.kind === "add" && row.right.n === jump.line;
    const m = isCursor ? mark : jumpedLeft || jumpedRight ? { text: "▌", style: { fg: C.jumpMark } } : mark;
    out.push(fit([m], 1) + half(row.left, "old", leftW, nw, built.marks, query, runs, state.hscroll) + fit([{ text: "│", style: { fg: C.rule } }], 1) + half(row.right, "new", rightW, nw, built.marks, query, runs, state.hscroll));
  }
  return out;
}

/** What clicking part of a `⋯` row does: 20 more lines from its top or bottom, or all. */
export type GapAction = "down" | "up" | "all";
type GapSpan = Span & { readonly action: GapAction };

/** A gap row after its cursor mark: the count, then the buttons (partial ones only when they'd leave some hidden). */
function gapSpans(hidden: number, isCursor: boolean): Array<GapSpan> {
  const bg = C.hunkBg;
  const spans: Array<GapSpan> = [{ text: ` ⋯ ${hidden} unchanged line${hidden === 1 ? "" : "s"}  `, style: { fg: C.dim, bg }, action: "all" }];
  const button = (text: string, action: GapAction): GapSpan => ({ text: ` ${text} `, style: { fg: isCursor ? C.accent : C.gutter, bg: C.bar }, action });
  const gapAfter: GapSpan = { text: " ", style: { bg }, action: "all" };
  if (hidden > GAP_STEP) spans.push(button(`↓ ${GAP_STEP}`, "down"), gapAfter, button(`↑ ${GAP_STEP}`, "up"), gapAfter);
  spans.push(button("all", "all"));
  if (isCursor) spans.push({ text: hidden > GAP_STEP ? "   enter all · J / K 20 down / up" : "   enter", style: { fg: C.gutter, bg }, action: "all" });
  return spans;
}
const GAP_STEP = 20;

/** The gap action under a 0-based column of the diff pane (column 0 is the cursor mark). */
export function gapAction(hidden: number, x: number): GapAction {
  let at = 1;
  for (const span of gapSpans(hidden, false)) {
    const w = width(span.text);
    if (x >= at && x < at + w) return span.action;
    at += w;
  }
  return "all";
}

const lineBg = (kind: DiffLine["kind"]) => (kind === "add" ? C.addBg : kind === "del" ? C.delBg : undefined);

function half(
  side: Side | null,
  which: "old" | "new",
  w: number,
  nw: number,
  marks: Map<string, Array<readonly [number, number]>>,
  query: string,
  runs: (side: "old" | "new", n: number) => ReadonlyArray<SyntaxRun> | null | undefined,
  hscroll: number,
): string {
  if (!side) return fit([], w, { bg: C.emptySide });
  const gutter = `${String(side.n).padStart(nw)} `;
  const gw = Math.min(w, width(gutter));
  return fit([{ text: gutter, style: { fg: C.gutter, bg: lineBg(side.kind) } }], gw) + lineText(side.kind, side.text, which, side.n, marks, query, runs, w - gw, hscroll);
}

function lineText(
  kind: DiffLine["kind"],
  raw: string,
  side: "old" | "new",
  n: number,
  marks: Map<string, Array<readonly [number, number]>>,
  query: string,
  runs: (side: "old" | "new", n: number) => ReadonlyArray<SyntaxRun> | null | undefined,
  w: number,
  hscroll: number,
): string {
  if (w <= 0) return "";
  const bg = lineBg(kind);
  const word = kind === "add" ? C.addWord : kind === "del" ? C.delWord : undefined;
  const sign = kind === "add" ? "+" : kind === "del" ? "-" : " ";
  const text = untab(raw);
  const changed = kind === "ctx" ? undefined : marks.get(`${kind}${n}`);
  const spans: Array<Span> = [];
  for (const seg of segments(text, changed, query, runs(side, n))) {
    const style: Style = seg.hit
      ? { bg: C.hitBg, fg: C.hitFg }
      : { bg: seg.changed ? word : bg, fg: seg.kind ? SYNTAX[seg.kind] : undefined };
    spans.push({ text: seg.text, style });
  }
  return fit([{ text: sign, style: { bg, fg: kind === "add" ? C.add : kind === "del" ? C.del : C.gutter } }], 1) + fit(spans, w - 1, { bg }, hscroll);
}

// ---------------------------------------------------------------- overlays

function picker(state: State, rows: number, cols: number): Array<string> {
  const p = state.picker!;
  const items = pickerItems(state, p);
  const title = p.which === "pr" ? "Pull request" : p.which === "base" ? "Base revision (A)" : "Head revision (B)";
  const current = p.which === "base" ? revLabel(state.base) : p.which === "head" ? revLabel(state.head) : state.pr !== null ? `#${state.pr}` : "";
  const out: Array<string> = [];
  out.push(fit([{ text: ` ${title}`, style: { bold: true, fg: C.accent } }, { text: current ? `  now: ${current}` : "", style: { fg: C.dim } }], cols));
  out.push(fit([{ text: " › ", style: { fg: C.accent, bold: true } }, { text: p.query }, { text: "▏", style: { fg: C.accent } }], cols));
  const note = p.which === "pr" ? (state.pullsError ?? (state.pulls === null ? "Loading pull requests…" : state.pulls.github === null ? "No GitHub remote (upstream or origin)." : items.length === 0 ? "No open pull requests match." : "")) : items.length === 0 ? "Nothing matches." : "";
  out.push(fit([{ text: note ? ` ${note}` : "", style: { fg: state.pullsError && p.which === "pr" ? C.error : C.dim } }], cols));
  const h = rows - 3;
  for (let r = 0; r < h; r++) {
    const i = p.scroll + r;
    const it = items[i];
    if (!it) {
      out.push(fit([], cols));
      continue;
    }
    const cur = i === p.cursor;
    const base: Style = cur ? { bg: C.cursor } : {};
    const groupW = 17;
    out.push(fit([{ text: cur ? "▌" : " ", style: { ...base, fg: C.cursorMark } }, { text: it.group.padEnd(groupW).slice(0, groupW), style: { ...base, fg: C.gutter } }, { text: it.label, style: { ...base, bold: true } }, { text: it.detail ? `  ${it.detail}` : "", style: { ...base, fg: C.dim } }], cols, base));
  }
  return out;
}

const HELP: ReadonlyArray<readonly [string, string]> = [
  ["", "Anywhere"],
  ["tab", "switch between the file list and the diff"],
  ["b / h", "pick the base (A) / head (B) revision: branches, tags, commits, working tree, index"],
  ["x", "swap base and head"],
  ["p", "pick a GitHub pull request (needs `gh`)"],
  ["/", "search the changed lines of the whole comparison"],
  ["n / N", "next / previous search hit"],
  [", .", "previous / next file (also Shift+F7 / F7)"],
  ["s", "side by side ↔ unified"],
  ["< >  =", "narrower / wider sidebar, automatic width (or drag the │ divider)"],
  ["r", "reload now (live comparisons also refresh every 2 s)"],
  ["q  ctrl+c", "quit"],
  ["mouse", "click a file, a ⋯ row, a search hit or a picker entry; click the revisions or the layout in the top bar; the wheel scrolls"],
  ["", ""],
  ["", "File list"],
  ["↑ ↓  j k", "move · Home / End"],
  ["← →", "collapse / expand a folder"],
  ["enter", "open the file (or fold a folder)"],
  ["f", "filter files by path (esc clears)"],
  ["", ""],
  ["", "Diff"],
  ["↑ ↓  j k", "move · PgUp / PgDn · g / G top / bottom"],
  ["← →", "scroll long lines sideways (0 resets)"],
  ["[ ]", "previous / next change"],
  ["enter", "on a ⋯ row: show the hidden lines (J / K, or click ↓ 20 / ↑ 20: 20 more from the top / bottom)"],
];

function help(rows: number, cols: number): Array<string> {
  const out: Array<string> = [];
  for (let r = 0; r < rows; r++) {
    const e = HELP[r];
    if (!e) out.push(fit([], cols));
    else if (!e[0]) out.push(fit([{ text: ` ${e[1]}`, style: { bold: true, fg: C.accent } }], cols));
    else out.push(fit([{ text: `   ${e[0].padEnd(12)}`, style: { bold: true } }, { text: e[1], style: { fg: C.dim } }], cols));
  }
  return out;
}
