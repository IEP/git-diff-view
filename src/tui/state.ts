/**
 * The terminal viewer's state and what is derived from it (tree rows, diff rows, picker
 * entries, pane sizes). Pure: no terminal, no git. `app.ts` changes it, `view.ts` draws it.
 */
import { commitsInRange, layoutGraph, type GraphRow } from "@/lib/graph";
import { buildTree, visibleRows, type DirNode, type VisibleRow } from "@/lib/tree";
import { INDEX, isPseudoRev, PSEUDO_LABEL, WORKTREE, type CompareResponse, type GraphCommit, type FileChange, type FileDiffResponse, type PullResolved, type PullsResponse, type RefsResponse, type RepoInfo, type SearchHit, type SearchResponse } from "@/shared/api";
import { inlineMarks, splitRows, unifiedRows, type Expansions, type ParsedPatch, type Range, type SplitRow, type UnifiedRow } from "./diffModel";
import type { SyntaxRun } from "./syntax";

export type Mode = "split" | "unified";
export type Focus = "tree" | "diff";

export interface FileView {
  /** Base sha, head sha, old path and path: what this diff is of. */
  readonly key: string;
  readonly path: string;
  readonly data: FileDiffResponse;
  readonly parsed: ParsedPatch;
  readonly oldLines: ReadonlyArray<string> | null;
  readonly newLines: ReadonlyArray<string> | null;
  /** Filled in just after the file first draws (plain until then); null without a known language. */
  syntax: { readonly old: SyntaxSide | null; readonly new: SyntaxSide | null } | null;
}

export interface SyntaxSide {
  /** The text the runs were worked out from: a refresh with the same text keeps them. */
  readonly source: string;
  /** Runs per line (index 0 is line 1); null for a line left plain. */
  readonly runs: ReadonlyArray<ReadonlyArray<SyntaxRun> | null>;
}

export interface Picker {
  readonly which: "base" | "head" | "pr";
  query: string;
  cursor: number;
  scroll: number;
}

export interface GraphState {
  /** Newest first; null until the first load. */
  commits: ReadonlyArray<GraphCommit> | null;
  /** More history exists beyond `commits`. */
  truncated: boolean;
  /** Commits asked for: grows as the cursor nears the bottom. */
  limit: number;
  loading: boolean;
  error: string | null;
  cursor: number;
  scroll: number;
}

export interface SearchState {
  open: boolean;
  /** Typing in the query line. */
  editing: boolean;
  query: string;
  result: SearchResponse | null;
  cursor: number;
  scroll: number;
  busy: boolean;
  error: string | null;
  /** The hit last jumped to: its line is marked in the diff. */
  jump: SearchHit | null;
}

export interface State {
  root: string;
  info: RepoInfo | null;
  refs: RefsResponse | null;
  fatal: string | null;

  base: string;
  head: string;
  pr: number | null;
  pull: PullResolved | null;
  pullError: string | null;
  pulls: PullsResponse | null;
  pullsError: string | null;

  compare: CompareResponse | null;
  compareError: string | null;
  loading: boolean;

  focus: Focus;
  /** Sidebar columns set by dragging the divider or `<` / `>`; null is automatic. */
  sideWidth: number | null;
  /** The divider is being dragged. */
  resizing: boolean;
  filter: string;
  /** Typing in the filter line. */
  filtering: boolean;
  collapsed: Set<string>;
  treeCursor: number;
  treeScroll: number;
  selected: string | null;

  file: FileView | null;
  fileError: string | null;
  fileLoading: boolean;
  expanded: Map<string, Expansions>;
  mode: Mode;
  diffCursor: number;
  diffScroll: number;
  hscroll: number;

  search: SearchState;
  picker: Picker | null;
  /** The commit graph screen, when open. */
  graph: GraphState | null;
  help: boolean;
  /** A one-line notice in the footer, cleared by the next key. */
  message: string | null;
}

export function initialState(root: string, opts: { base?: string; head?: string; pr?: number | null; mode?: Mode } = {}): State {
  return {
    root, info: null, refs: null, fatal: null,
    base: opts.base ?? "", head: opts.head ?? "", pr: opts.pr ?? null, pull: null, pullError: null, pulls: null, pullsError: null,
    compare: null, compareError: null, loading: false,
    focus: "tree", sideWidth: null, resizing: false, filter: "", filtering: false, collapsed: new Set(), treeCursor: 0, treeScroll: 0, selected: null,
    file: null, fileError: null, fileLoading: false, expanded: new Map(), mode: opts.mode ?? "split", diffCursor: 0, diffScroll: 0, hscroll: 0,
    search: { open: false, editing: false, query: "", result: null, cursor: 0, scroll: 0, busy: false, error: null, jump: null },
    picker: null, graph: null, help: false, message: null,
  };
}

// ---------------------------------------------------------------- geometry

export interface Layout {
  readonly cols: number;
  readonly rows: number;
  /** Rows between the header and the footer. */
  readonly body: number;
  /** Left pane (tree or search) width, 0 when hidden; a divider column follows it. */
  readonly side: number;
  readonly diffLeft: number;
  readonly diffWidth: number;
  /** Diff text rows, below the file header. */
  readonly diffBody: number;
}

export function layoutFor(state: State, cols: number, rows: number): Layout {
  const body = Math.max(1, rows - 2);
  // Narrow terminals show one pane at a time: the focused one.
  const narrow = cols < 70;
  const side = narrow ? (state.focus === "tree" ? cols : 0) : sideWidth(state.sideWidth ?? Math.min(48, Math.max(22, Math.round(cols * 0.28))), cols);
  const diffLeft = side === 0 ? 0 : side + 1;
  return { cols, rows, body, side, diffLeft, diffWidth: Math.max(0, cols - diffLeft), diffBody: Math.max(1, body - 1) };
}

/** The sidebar's width kept within reach: room for names, and for the diff beside it. */
export const sideWidth = (want: number, cols: number) => Math.max(MIN_SIDE, Math.min(Math.round(want), cols - MIN_DIFF - 1));
const MIN_SIDE = 16;
const MIN_DIFF = 30;

// ---------------------------------------------------------------- tree

const treeCache = new WeakMap<CompareResponse, { filter: string; tree: DirNode }>();

export function filteredTree(state: State): DirNode | null {
  const cmp = state.compare;
  if (!cmp) return null;
  const hit = treeCache.get(cmp);
  if (hit && hit.filter === state.filter) return hit.tree;
  const q = state.filter.trim().toLowerCase();
  const files = q ? cmp.files.filter((f) => f.path.toLowerCase().includes(q) || (f.oldPath?.toLowerCase().includes(q) ?? false)) : cmp.files;
  const tree = buildTree(files);
  treeCache.set(cmp, { filter: state.filter, tree });
  return tree;
}

export function treeRows(state: State): Array<VisibleRow> {
  const tree = filteredTree(state);
  // A filter shows every match: collapsed folders would hide them.
  return tree ? visibleRows(tree, state.filter.trim() ? new Set() : state.collapsed) : [];
}

export const selectedFile = (state: State): FileChange | null => state.compare?.files.find((f) => f.path === state.selected) ?? null;

// ---------------------------------------------------------------- diff rows

/**
 * A new or deleted file has one side: side by side would leave half the pane empty,
 * so it gets one column, as on the web.
 */
export function layoutOf(state: State): Mode {
  const status = selectedFile(state)?.status;
  return status === "added" || status === "deleted" ? "unified" : state.mode;
}

export type DiffRows =
  | { readonly layout: "unified"; readonly rows: ReadonlyArray<UnifiedRow>; readonly marks: Map<string, Array<Range>> }
  | { readonly layout: "split"; readonly rows: ReadonlyArray<SplitRow>; readonly marks: Map<string, Array<Range>> };

const rowsCache = new WeakMap<FileView, { open: Expansions | undefined; layout: Mode; rows: DiffRows }>();

export function diffRows(state: State): DiffRows | null {
  const f = state.file;
  if (!f || f.path !== state.selected) return null;
  const open = state.expanded.get(f.path);
  const layout = layoutOf(state);
  const hit = rowsCache.get(f);
  if (hit && hit.open === open && hit.layout === layout) return hit.rows;
  const unified = unifiedRows(f.parsed, f.oldLines, f.newLines, open ?? new Map());
  const marks = inlineMarks(unified);
  const rows: DiffRows = layout === "split" ? { layout, rows: splitRows(unified), marks } : { layout, rows: unified, marks };
  rowsCache.set(f, { open, layout, rows });
  return rows;
}

/** The message drawn instead of rows, when there are none to draw. */
export function emptyMessage(state: State): string | null {
  const f = selectedFile(state);
  if (state.compareError) return state.compareError;
  if (!state.compare) return "Loading…";
  if (!f) return state.compare.files.length ? "Select a file in the tree to see its diff." : "No differences between these revisions.";
  if (state.fileError) return state.fileError;
  const file = state.file;
  if (!file || file.path !== f.path) return "Loading…";
  // Same wording as the web view's.
  if (file.data.binary) return "Binary file changed. No text diff to show.";
  if (diffRows(state)?.rows.length) return null;
  if (file.data.tooLarge) return "File too large to show.";
  if (f.status === "renamed") return "File renamed without content changes.";
  if (f.status === "copied") return "File copied without content changes.";
  if (file.data.patch.includes("old mode")) return "Only the file mode changed.";
  return "No content changes.";
}

// ---------------------------------------------------------------- pickers

export interface PickerItem {
  readonly label: string;
  readonly detail: string;
  /** A revision, a pull request number, or "stop" (leave pull request mode). */
  readonly value: string;
  readonly group: string;
}

export function pickerItems(state: State, picker: Picker): Array<PickerItem> {
  const q = picker.query.trim().toLowerCase();
  const match = (...texts: Array<string>) => !q || texts.some((t) => t.toLowerCase().includes(q));
  const items: Array<PickerItem> = [];
  if (picker.which === "pr") {
    if (state.pr !== null) items.push({ label: `Stop comparing #${state.pr}`, detail: "", value: "stop", group: "" });
    for (const p of state.pulls?.pulls ?? []) {
      if (!match(`#${p.number}`, p.title, p.author, p.headRef, p.baseRef)) continue;
      items.push({ label: `#${p.number} ${p.title}`, detail: `${p.baseRef} ← ${p.headRef} · ${p.author}${p.isDraft ? " · draft" : ""}`, value: String(p.number), group: "Pull requests" });
    }
    return items;
  }
  const refs = state.refs;
  const exact = refs && [...refs.branches, ...refs.remoteBranches, ...refs.tags].some((r) => r.name === picker.query.trim());
  if (q && !exact) items.push({ label: `Use “${picker.query.trim()}”`, detail: "any revision: HEAD~3, a sha, a tag…", value: picker.query.trim(), group: "" });
  for (const rev of [WORKTREE, INDEX] as const) if (match(PSEUDO_LABEL[rev])) items.push({ label: PSEUDO_LABEL[rev], detail: rev === WORKTREE ? "files on disk, untracked included" : "what the next commit holds", value: rev, group: "Local changes" });
  for (const b of refs?.branches ?? []) if (match(b.name, b.subject)) items.push({ label: b.name, detail: b.subject, value: b.name, group: "Branches" });
  for (const b of refs?.remoteBranches ?? []) if (match(b.name, b.subject)) items.push({ label: b.name, detail: b.subject, value: b.name, group: "Remote branches" });
  for (const t of refs?.tags ?? []) if (match(t.name, t.subject)) items.push({ label: t.name, detail: t.subject, value: t.name, group: "Tags" });
  for (const c of refs?.commits ?? []) if (match(c.shortSha, c.sha, c.subject, c.author)) items.push({ label: c.shortSha, detail: `${c.subject} · ${c.author}`, value: c.sha, group: "Commits" });
  return items;
}

/** A revision as people read it: "Working tree", a branch name, or a short sha. */
export function revLabel(rev: string): string {
  if (rev === WORKTREE || rev === INDEX) return PSEUDO_LABEL[rev];
  return /^[0-9a-f]{40,64}$/.test(rev) ? rev.slice(0, 8) : rev;
}

// ---------------------------------------------------------------- graph

const graphCache = new WeakMap<ReadonlyArray<GraphCommit>, Array<GraphRow>>();

/** The loaded history with a column and lanes per commit (worked out once per load). */
export function graphRows(graph: GraphState): Array<GraphRow> {
  const commits = graph.commits;
  if (!commits) return [];
  let rows = graphCache.get(commits);
  if (!rows) graphCache.set(commits, (rows = layoutGraph(commits)));
  return rows;
}

/**
 * The commits on screen as A and B, and the ones the current diff spans (`git log A..B`).
 * Uncommitted changes sit on top of HEAD, so a working tree or index side counts as HEAD.
 */
export function graphMarks(state: State): { base: string | null; head: string | null; range: Set<string> } {
  const commits = state.graph?.commits;
  const cmp = state.compare;
  if (!commits || !cmp) return { base: null, head: null, range: new Set() };
  const real = (sha: string) => (isPseudoRev(sha) ? state.info?.headSha ?? null : sha);
  const base = real(cmp.base.sha);
  const head = real(cmp.head.sha);
  return { base, head, range: commitsInRange(commits, base, head) };
}

// ---------------------------------------------------------------- search

export type SearchRow = { readonly t: "file"; readonly path: string; readonly count: number } | { readonly t: "hit"; readonly i: number };

/** Hits grouped under their file, as the panel lists them. */
export function searchRows(result: SearchResponse | null): Array<SearchRow> {
  const rows: Array<SearchRow> = [];
  const hits = result?.hits ?? [];
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i]!;
    if (i === 0 || hits[i - 1]!.path !== h.path) {
      let count = 0;
      for (let k = i; k < hits.length && hits[k]!.path === h.path; k++) count++;
      rows.push({ t: "file", path: h.path, count });
    }
    rows.push({ t: "hit", i });
  }
  return rows;
}
