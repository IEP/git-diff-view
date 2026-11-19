// git-diff-view inside Herdr: compare any two revisions of the space's repository
// (branches, tags, commits, the working tree, the index, pull requests) with a commit
// graph, file tree, unified or side-by-side diff, and search over the changed lines.
//
// Three ways in:
//   - the Diff button beside the tab bar (this mod with props { mode: "toolbar" }, placed
//     by `bun run install:herdr` in a personal copy of the layout);
//   - mod.open:git-diff (a key or `herdr-app do`), an invisible popup that closes itself;
//   - both open the tab "Diff · <repo>" for the focused pane's repository, or switch to it
//     when the space already has one. That tab is this mod as a pane, props { folder, on }.
//
// Everything runs git through Herdr's exec (on the space's machine), read-only.
// Source: the git-diff-view repository's herdr/ folder; core.js is bundled from herdr/src.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, VirtualListScrollHandle } from "gpui-base";
import { checking, closeOverlay, exec, focused, nextCommand, notify, panes, props, readTextFile, run, spaces, theme, watchFolder } from "herdr";
import { buildIndex, defaultRefs, expand, filesInTreeOrder, buildTree, isPseudoRev, OBJECT_ID, openRepo, parseFilePatch, search, splitLines, splitRows, unifiedRows, inlineMarks, languageFor, SyntaxDoc, MAX_SYNTAX_CHARS, untab, WORKTREE } from "./core.js";
import { button, icon, separator } from "./ui.js";
import { renderGraph, graphKeys, graphRows, finishDrag } from "./graph.js";
import { renderTree, treeKeys } from "./tree.js";
import { renderDiff } from "./diff.js";
import { renderSearch, searchKeys } from "./search.js";
import { renderPicker, renderPullPicker, pickerKeys, pickCurrent, refLabel } from "./picker.js";

const GRAPH_PAGE = 500;
const SEARCH_LINES = 200_000;

// ---------------------------------------------------------------- launcher

/** Where the person is: the focused pane's folder and machine. */
function here() {
  const f = focused();
  const space = spaces().find((s) => s.id === f?.space) ?? spaces().find((s) => s.active);
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  return { space, folder: pane?.cwd || f?.cwd || space?.folder || null, on: space?.machine ?? null };
}

const tabName = (root) => `Diff · ${root.split("/").pop()}`;

/** The space's diff tab for the focused repository: switched to if it exists, else opened. */
async function openDiff() {
  const { space, folder, on } = here();
  if (!space || !folder) throw new Error("No folder to compare: focus a terminal inside a repository.");
  const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder, on });
  if (r.code !== 0) throw new Error(`Not a git repository: ${folder}`);
  const root = r.stdout.trim();
  const existing = space.tabs.find((t) => t.name === tabName(root));
  if (existing) run("tab.select", { id: existing.id });
  else run("tab.new", { name: tabName(root), space: space.id, mod: "git-diff", props: { folder: root, on } });
}

function failed(e) {
  notify({ title: "Diff viewer", body: String(e?.message ?? e), level: "error" });
}

// ---------------------------------------------------------------- viewer

export default class GitDiff extends View {
  init(_props, cx) {
    const p = props() ?? {};
    if (p.mode === "toolbar") {
      this.toolbar = true;
      return;
    }
    if (p.overlay) {
      this.launcher = true;
      if (checking()) return;
      cx.spawn(async () => {
        try {
          await openDiff();
        } catch (e) {
          failed(e);
        } finally {
          closeOverlay(p.overlay);
        }
      });
      return;
    }

    // Where: the props the launcher gave this pane, else wherever the person is now.
    const at = here();
    this.folder = p.folder ?? at.folder;
    this.on = p.folder ? (p.on ?? null) : at.on;

    // props may name a comparison (`{ base, head }` or `{ pr }`); else the last one in this tab.
    const saved = this.load();
    const given = p.pr || (p.base && p.head);
    this.base = given ? (p.base ?? "") : (saved.base ?? "");
    this.head = given ? (p.head ?? "") : (saved.head ?? "");
    this.pr = given ? (p.pr ?? null) : (saved.pr ?? null);
    this.selected = saved.file ?? null;
    this.mode = saved.mode ?? "split";
    this.wrap = saved.wrap ?? false;
    this.showGraph = saved.graph ?? true;
    this.treeWidth = saved.treeWidth ?? 300;
    this.graphHeight = saved.graphHeight ?? 260;

    this.repo = null;
    this.info = null;
    this.refs = null;
    this.graph = null;
    this.graphLimit = GRAPH_PAGE;
    this.compare = null;
    this.compareError = null;
    this.fatal = null;
    this.marked = { base: null, head: null };
    this.pulls = null;
    this.pullsError = null;
    this.pull = null;
    this.pullError = null;
    this.file = null; // { key, data, parsed, oldLines, newLines }
    this.fileError = null;
    this.expanded = new Map(); // path → Expansions
    this.rowsCache = null;
    this.version = 0; // bumps on every comparison pick: late results of older picks are dropped
    this.size = { width: 1200, height: 800 };
    this.splitter = null; // { kind: "tree" | "graph", from, start }

    this.tree = { collapsed: new Set(), filterInput: InputState.new({ placeholder: "Filter files" }), filter: "", cursor: null, handle: cx.focus_handle(), scroll: VirtualListScrollHandle.new() };
    this.tree.filterInput.on("change", (_e, cx) => {
      this.tree.filter = this.tree.filterInput.value();
      cx.notify();
    });
    this.searchState = { open: false, query: "", settled: "", input: InputState.new({ placeholder: "Search changed lines" }), index: null, result: null, cursor: 0, jump: null, busy: false, error: null, scroll: VirtualListScrollHandle.new() };
    this.searchState.input.on("change", (_e, cx) => this.onQuery(cx));
    // Enter reaches a focused Input as "submit", not as a key on the elements around it.
    this.searchState.input.on("submit", (_e, cx) => {
      const s = this.searchState;
      const hit = s.result?.hits[s.cursor];
      if (hit) this.openHit(cx, hit);
    });
    this.graphUI = { anchor: null, notice: null, focused: 0, drag: null, handle: cx.focus_handle(), offset: 0, scrolled: false };
    this.picker = null; // { which: "base" | "head" | "pr", input, query, cursor }
    this.diffScroll = VirtualListScrollHandle.new();
    this.handle = cx.focus_handle();

    if (checking()) return;
    this.start(cx);
    this.commands(cx);
  }

  /** Key commands for keys.json ("mod:git-diff" or global): "git-diff.next-file" and the rest. */
  commands(cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") this.handle.focus();
        else if (c === "next-file") this.go(cx, 1);
        else if (c === "prev-file") this.go(cx, -1);
        else if (c === "search") this.toggleSearch(cx, true);
        else if (c === "graph") this.setPref(cx, "showGraph", !this.showGraph);
        else if (c === "split" || c === "unified") this.setPref(cx, "mode", c);
        else if (c === "wrap") this.setPref(cx, "wrap", !this.wrap);
        else if (c === "reload") this.refresh(cx);
        else if (c === "pick-base" || c === "pick-head" || c === "pick-pr") this.openPicker(cx, c.slice(5));
        cx.notify();
      }
    });
  }

  // ---------------------------------------------------------------- persistence

  load() {
    try {
      return JSON.parse(localStorage.getItem("state") ?? "{}") ?? {};
    } catch {
      return {};
    }
  }

  save() {
    try {
      localStorage.setItem("state", JSON.stringify({
        base: this.base, head: this.head, pr: this.pr, file: this.selected, mode: this.mode, wrap: this.wrap,
        graph: this.showGraph, treeWidth: this.treeWidth, graphHeight: this.graphHeight,
      }));
    } catch {
      /* storage unavailable: the view just starts fresh next time */
    }
  }

  // ---------------------------------------------------------------- loading

  host() {
    const cwd = this.folder, on = this.on;
    return {
      run: (cmd, args, o) => exec(cmd, args, { cwd, on, timeout: o?.timeout ?? 60_000 }),
      readFile: (path) => readTextFile(path, { on }),
    };
  }

  start(cx) {
    if (!this.folder) {
      this.fatal = "No folder: open the diff viewer from a terminal inside a repository.";
      return;
    }
    cx.spawn(async (cx) => {
      try {
        this.repo = await openRepo(this.host());
        const [info, refs] = await Promise.all([this.repo.info(), this.repo.refs()]);
        this.info = info;
        this.refs = refs;
        if (this.pr) this.loadPull(cx, this.pr);
        else {
          const d = defaultRefs(info, refs);
          if (!this.base) this.base = d.base;
          if (!this.head) this.head = d.head;
          await this.loadCompare(cx);
        }
        if (this.showGraph) this.loadGraph(cx);
        this.loadPulls(cx);
        this.watch(cx);
      } catch (e) {
        this.fatal = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  /** Branch names, HEAD and the working tree move; two commit ids never do. */
  live() {
    return Boolean(this.base && this.head) && ![this.base, this.head].every((r) => OBJECT_ID.test(r));
  }

  async loadCompare(cx, { quiet = false } = {}) {
    const version = this.version;
    const base = this.base, head = this.head;
    if (!base || !head) return;
    if (!quiet) this.loading = true;
    cx.notify();
    try {
      const next = await this.repo.compare(base, head);
      if (version !== this.version) return;
      const sig = JSON.stringify(next);
      const changed = sig !== this.compareSig;
      this.compareSig = sig;
      this.compareError = null;
      this.marked = { base: next.base.sha, head: next.head.sha };
      if (changed) {
        this.compare = next;
        this.ordered = filesInTreeOrder(buildTree(next.files));
        if (!this.selected || !next.files.some((f) => f.path === this.selected)) this.selected = this.ordered[0]?.path ?? null;
        this.save();
      }
      // The selected file may change without the list changing (same counts, new text).
      await this.loadFile(cx, { quiet: !changed || quiet });
    } catch (e) {
      if (version === this.version) {
        this.compareError = String(e?.message ?? e);
        this.compare = null;
        this.compareSig = null;
      }
    } finally {
      if (version === this.version) this.loading = false;
      cx.notify();
    }
  }

  selectedFile() {
    return this.compare?.files.find((f) => f.path === this.selected) ?? null;
  }

  /**
   * The layout the selected file is drawn in. A new (or deleted) file has only one
   * side, so side by side would leave half the pane empty: it gets one column, as on the web.
   */
  layout() {
    const status = this.selectedFile()?.status;
    return status === "added" || status === "deleted" ? "unified" : this.mode;
  }

  async loadFile(cx, { quiet = false } = {}) {
    const f = this.selectedFile();
    const cmp = this.compare;
    if (!f || !cmp) {
      this.file = null;
      return;
    }
    const key = `${cmp.base.sha}:${cmp.head.sha}:${f.oldPath}:${f.path}`;
    if (!quiet && this.file?.key !== key) this.fileLoading = key;
    cx.notify();
    try {
      const data = await this.repo.fileDiff(cmp.base.sha, cmp.head.sha, f.path, f.oldPath);
      if (this.selected !== f.path || this.compare !== cmp) return;
      // Same text as on screen: keep the rows (and their scroll) as they are.
      if (this.file?.key === key && this.file.data.patch === data.patch && this.file.data.newContent === data.newContent && this.file.data.oldContent === data.oldContent) return;
      this.file = { key, path: f.path, data, parsed: parseFilePatch(data.patch), oldLines: splitLines(data.oldContent), newLines: splitLines(data.newContent), syntax: this.syntaxFor(f.path, data) };
      this.fileError = null;
      this.rowsCache = null;
    } catch (e) {
      if (this.selected === f.path) {
        this.fileError = String(e?.message ?? e);
        this.file = null;
      }
    } finally {
      if (this.fileLoading === key) this.fileLoading = null;
      cx.notify();
    }
  }

  loadGraph(cx) {
    cx.spawn(async (cx) => {
      try {
        this.graph = await this.repo.graph(this.graphLimit);
        this.graphRows = null;
      } catch (e) {
        this.graphError = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  loadPulls(cx) {
    cx.spawn(async (cx) => {
      try {
        this.pulls = await this.repo.pulls();
        this.pullsError = null;
      } catch (e) {
        this.pullsError = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  loadPull(cx, number) {
    const version = ++this.version;
    this.pr = number;
    this.pull = null;
    this.pullError = null;
    this.compare = null;
    this.compareSig = null;
    this.save();
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const pull = await this.repo.pull(number);
        if (version !== this.version) return;
        this.pull = pull;
        this.base = pull.base;
        this.head = pull.head;
        this.version++;
        await this.loadCompare(cx);
      } catch (e) {
        if (version === this.version) this.pullError = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  /** Re-read what may have moved: HEAD (then refs and graph too), and a live comparison. */
  refresh(cx) {
    if (this.refreshing || !this.repo) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      try {
        const info = await this.repo.info();
        const moved = info.headSha !== this.info?.headSha;
        const files = info.uncommitted !== this.info?.uncommitted;
        this.info = info;
        if (moved) {
          this.refs = await this.repo.refs();
          if (this.showGraph) this.loadGraph(cx);
        }
        if (this.live() && !this.pr) {
          await this.loadCompare(cx, { quiet: true });
          // Hits follow the text on disk, as the web view's do.
          if (this.searchState.open && this.searchState.settled.trim()) this.runSearch(cx, { quiet: true });
          else if (this.searchState.index) this.searchState.index.stale = true;
        }
      } catch {
        /* the next tick tries again */
      } finally {
        this.refreshing = false;
        cx.notify();
      }
    });
  }

  watch(cx) {
    // Local repositories tell us when something changes; remote ones are polled.
    cx.timer.every(this.on ? 3000 : 10000, (cx) => this.refresh(cx));
    if (this.on) return;
    const root = this.repo.root;
    cx.spawn(async (cx) => {
      try {
        for (;;) {
          await watchFolder(root);
          await cx.sleep(300); // a burst of writes (a checkout, an agent's edit) settles first
          this.refresh(cx);
        }
      } catch {
        /* too many folders watched: the timer still refreshes */
      }
    });
  }

  // ---------------------------------------------------------------- choosing

  choose(cx, base, head, { keepPr = false } = {}) {
    if (!keepPr) {
      this.pr = null;
      this.pull = null;
      this.pullError = null;
    }
    this.base = base;
    this.head = head;
    this.version++;
    this.save();
    cx.spawn(async (cx) => {
      await this.loadCompare(cx);
      // Hits belong to the comparison they came from: search the new one.
      const s = this.searchState;
      s.index = null;
      s.result = null;
      if (s.settled.trim()) this.runSearch(cx);
    });
    cx.notify();
  }

  select(cx, path) {
    if (!path || path === this.selected) return;
    this.selected = path;
    this.tree.cursor = path;
    this.file = null;
    this.fileError = null;
    this.rowsCache = null;
    this.save();
    cx.spawn(async (cx) => this.loadFile(cx));
    cx.notify();
  }

  go(cx, delta) {
    const list = this.ordered ?? [];
    const i = list.findIndex((f) => f.path === this.selected);
    const next = list[Math.min(Math.max(i + delta, 0), list.length - 1)];
    if (next) {
      this.select(cx, next.path);
      this.revealInTree = next.path;
    }
  }

  setExpanded(cx, gap, how) {
    const path = this.file?.path;
    if (!path) return;
    this.expanded.set(path, expand(this.expanded.get(path) ?? new Map(), gap, how));
    this.rowsCache = null;
    cx.notify();
  }

  /**
   * Syntax state for a file's two sides: `{ source, doc }` each, or null without full
   * text (too large, binary) or a known language. A side whose text didn't change keeps
   * its doc, so a refresh re-highlights only what moved.
   */
  syntaxFor(path, data) {
    const lang = languageFor(path);
    if (!lang) return null;
    const prev = this.file?.path === path ? this.file.syntax : null;
    const side = (content, before) => {
      if (content === null || content.length > MAX_SYNTAX_CHARS) return null;
      if (before?.source === content) return before;
      return { source: content, doc: new SyntaxDoc(lang, splitLines(content).map(untab), before?.doc) };
    };
    return { old: side(data.oldContent, prev?.old), new: side(data.newContent, prev?.new) };
  }

  /**
   * Highlight, in the background, the chunks behind the lines the diff shows: one chunk
   * (a few tens of ms) per tick, so the window keeps responding. Rows are drawn plain
   * until their chunk is done. Runs again whenever the rows change (a gap opened).
   */
  startSyntax(cx) {
    const f = this.file;
    const built = this.rowsCache;
    if (!f?.syntax || this.syntaxBusy || !built || built.file !== f || this.syntaxScanned === built) return;
    this.syntaxScanned = built;
    const jobs = [];
    const seen = new Set();
    for (const r of built.unified) {
      if (r.t !== "line") continue;
      // Removed lines come from the base side; added and unchanged ones from the head side.
      const side = r.line.kind === "del" ? "old" : "new";
      const doc = f.syntax[side]?.doc;
      if (!doc) continue;
      const chunk = doc.chunkOf(side === "old" ? r.line.old : r.line.new);
      if (doc.isDone(chunk) || seen.has(`${side}${chunk}`)) continue;
      seen.add(`${side}${chunk}`);
      jobs.push([doc, chunk]);
    }
    if (!jobs.length) return;
    this.syntaxBusy = true;
    cx.spawn(async (cx) => {
      try {
        for (const [doc, chunk] of jobs) {
          if (this.file !== f) break;
          doc.highlight(chunk);
          cx.notify();
          await cx.sleep(1);
        }
      } finally {
        this.syntaxBusy = false;
        this.syntaxScanned = null; // the rows may have changed meanwhile: look again
        cx.notify();
      }
    });
  }

  /** The selected file's rows, rebuilt only when the file, its open gaps or the layout change. */
  rows() {
    const f = this.file;
    if (!f) return null;
    const open = this.expanded.get(f.path) ?? new Map();
    const layout = this.layout();
    const key = `${f.key}|${layout}`;
    if (this.rowsCache?.key === key && this.rowsCache.open === open && this.rowsCache.file === f) return this.rowsCache;
    const unified = unifiedRows(f.parsed, f.oldLines, f.newLines, open);
    const rows = layout === "split" ? splitRows(unified) : unified;
    this.rowsCache = { key, open, file: f, unified, rows, marks: inlineMarks(unified) };
    return this.rowsCache;
  }

  // ---------------------------------------------------------------- search

  toggleSearch(cx, open = !this.searchState.open) {
    this.searchState.open = open;
    if (open) this.searchState.input.focus();
    else this.handle.focus();
    cx.notify();
  }

  onQuery(cx) {
    const s = this.searchState;
    s.query = s.input.value();
    const query = s.query;
    cx.timer.after(200, (cx) => {
      if (s.query !== query) return; // typed on: wait for the newer one
      s.settled = query;
      this.runSearch(cx);
    });
    cx.notify();
  }

  /**
   * Search the comparison for the settled query. `quiet` is a re-run after a refresh:
   * it re-reads the patch (a live comparison's text can change without its file list
   * changing), rebuilds only if the text did, and keeps the highlighted hit.
   */
  runSearch(cx, { quiet = false } = {}) {
    const s = this.searchState;
    const cmp = this.compare;
    if (!s.settled.trim() || !cmp) {
      if (!quiet) s.result = null;
      cx.notify();
      return;
    }
    const key = `${cmp.base.sha}..${cmp.head.sha}`;
    // Shows the query as it is now: typing may have moved on while the patch was read.
    const show = (keepCursor) => {
      const query = s.settled;
      if (!query.trim()) return;
      const before = s.result?.hits[s.cursor];
      s.result = search(s.index.index, query);
      const at = keepCursor && before ? s.result.hits.findIndex((h) => h.path === before.path && h.side === before.side && h.line === before.line) : -1;
      s.cursor = at >= 0 ? at : keepCursor ? Math.min(s.cursor, Math.max(0, s.result.hits.length - 1)) : 0;
    };
    // Typing reuses the index; a refresh marks it stale when search isn't showing.
    if (!quiet && s.index?.key === key && !s.index.stale) {
      show(false);
      cx.notify();
      return;
    }
    // One patch read at a time: a request meanwhile runs once the read is done
    // (a typed query wins over a background re-run).
    if (s.searching) {
      s.rerun = { quiet: quiet && (s.rerun?.quiet ?? true) };
      if (!quiet) s.busy = true;
      cx.notify();
      return;
    }
    s.searching = true;
    if (!quiet) s.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const patch = await this.repo.patch(cmp.base.sha, cmp.head.sha, SEARCH_LINES);
        if (`${this.compare?.base.sha}..${this.compare?.head.sha}` !== key) return; // another comparison was picked: its rerun follows
        const same = s.index?.key === key && s.index.patch === patch.patch;
        if (same) s.index.stale = false;
        else s.index = { key, patch: patch.patch, index: buildIndex(patch.patch, patch.partial) };
        s.error = null;
        if (!(same && quiet)) show(quiet);
      } catch (e) {
        if (!quiet) s.error = String(e?.message ?? e);
      } finally {
        s.searching = false;
        s.busy = false;
        const again = s.rerun;
        s.rerun = null;
        if (again) this.runSearch(cx, again);
        cx.notify();
      }
    });
  }

  openHit(cx, hit) {
    this.searchState.jump = { ...hit, seq: (this.searchState.jump?.seq ?? 0) + 1 };
    if (hit.path === this.selected) {
      this.pendingJump = this.searchState.jump;
      cx.notify();
    } else {
      this.pendingJump = this.searchState.jump;
      this.select(cx, hit.path);
    }
  }

  // ---------------------------------------------------------------- pickers

  openPicker(cx, which) {
    if (this.picker?.which === which) {
      this.picker = null;
      this.handle.focus();
      cx.notify();
      return;
    }
    const input = InputState.new({ placeholder: which === "pr" ? "Filter pull requests" : "Branch, tag, commit or any revision" });
    this.picker = { which, input, query: "", cursorIndex: undefined, scroll: VirtualListScrollHandle.new() };
    input.on("change", (_e, cx) => {
      this.picker.query = input.value();
      this.picker.cursorIndex = undefined; // back to the first match
      cx.notify();
    });
    input.on("submit", (_e, cx) => pickCurrent(this, cx));
    input.focus();
    if (which === "pr" && !this.pulls) this.loadPulls(cx);
    cx.notify();
  }

  closePicker(cx) {
    this.picker?.scroll.release();
    this.picker = null;
    this.handle.focus();
    cx.notify();
  }

  // ---------------------------------------------------------------- layout

  startSplitter(kind, event) {
    this.splitter = { kind, from: kind === "tree" ? event.position.x : event.position.y, start: kind === "tree" ? this.treeWidth : this.graphHeight };
  }

  moveSplitter(event, cx) {
    const s = this.splitter;
    if (!s) return;
    if (s.kind === "tree") this.treeWidth = Math.min(Math.max(s.start + event.position.x - s.from, 180), Math.max(220, this.size.width - 360));
    else this.graphHeight = Math.min(Math.max(s.start + event.position.y - s.from, 90), Math.max(120, this.size.height - 220));
    cx.notify();
  }

  endPointer(cx) {
    if (this.splitter) {
      this.splitter = null;
      this.save();
      cx.notify();
    }
    if (this.graphUI.drag) finishDrag(this, cx, true);
  }

  onKey(e, cx) {
    const k = e.keystroke;
    if (k === "cmd-shift-f" || k === "ctrl-shift-f") {
      this.toggleSearch(cx, true);
      cx.stop_propagation();
      return;
    }
    if (k === "f7" || k === "shift-f7") {
      this.go(cx, k === "f7" ? 1 : -1);
      cx.stop_propagation();
      return;
    }
    if (this.picker && pickerKeys(this, e, cx)) return cx.stop_propagation();
    if (this.graphUI.drag && k === "escape") {
      finishDrag(this, cx, false);
      return cx.stop_propagation();
    }
    // The panel holding the keyboard first: the search box only answers when nothing else has it.
    if (this.graphUI.handle.is_focused() && graphKeys(this, e, cx)) return cx.stop_propagation();
    if (this.tree.handle.is_focused() && treeKeys(this, e, cx)) return cx.stop_propagation();
    if (this.searchState.open && searchKeys(this, e, cx)) return cx.stop_propagation();
  }

  // ---------------------------------------------------------------- render

  render(cx) {
    const t = theme();
    if (this.launcher) return div();
    if (this.toolbar) return toolbarButton(t);
    const root = v_flex()
      .id("git-diff")
      .size_full()
      .relative()
      .bg(t.background)
      .text_color(t.foreground)
      .text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.onKey(e, cx))
      .on_size_change((size, cx) => {
        this.size = size;
        cx.notify();
      })
      .on_mouse_move((e, cx) => this.moveSplitter(e, cx))
      .on_mouse_up("left", (_e, cx) => this.endPointer(cx))
      .when(Boolean(this.splitter), (e) => (this.splitter.kind === "tree" ? e.cursor_col_resize() : e.cursor_row_resize()))
      .child(this.header(t));

    if (this.fatal) return root.child(message(t, this.fatal, true));
    if (!this.repo) return root.child(message(t, "Opening repository…"));

    const body = this.comparison(t);
    this.startSyntax(cx);
    if (!this.showGraph) return root.child(body).when(Boolean(this.picker), (e) => e.child(this.popover(t)));
    return root
      .child(div().h(this.graphHeight).flex_none().min_h(0).child(renderGraph(this, t)))
      .child(splitterBar(t, "graph-split", false, (e) => this.startSplitter("graph", e), this.splitter?.kind === "graph"))
      .child(body)
      .when(Boolean(this.picker), (e) => e.child(this.popover(t)));
  }

  popover(t) {
    return this.picker.which === "pr" ? renderPullPicker(this, t) : renderPicker(this, t);
  }

  header(t) {
    const info = this.info;
    const live = this.live();
    const showPulls = Boolean(this.pulls?.github) || Boolean(this.pullsError);
    return h_flex()
      .id("header")
      .h(44)
      .flex_none()
      .px(10)
      .gap(6)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .bg(t.chrome)
      .child(h_flex().gap(6).items_center().min_w(0).mr(4).tooltip(this.repo?.root ?? this.folder ?? "")
        .child(icon("repo", 15, t.muted))
        .child(div().font_semibold().truncate().child(info?.name ?? this.repo?.name ?? "…"))
        .when(Boolean(info?.currentBranch), (e) => e.child(div().text_size(11).text_color(t.dim).whitespace_nowrap().child(`on ${info.currentBranch}`)))
        .when(Boolean(this.on), (e) => e.child(div().text_size(11).text_color(t.dim).whitespace_nowrap().child(`· ${this.on}`))))
      .when(showPulls, (e) => e
        .child(this.pickerButton(t, "pr", "Pull request", this.pr ? `#${this.pr}${this.pull ? ` ${this.pull.title}` : ""}` : "Pull requests", "pr"))
        .when(Boolean(this.pull), (e) => e.child(button(t, { id: "pr-open", glyph: "external", tip: `Open on GitHub · ${this.pull.baseRef} ← ${this.pull.headRef}`, on: () => openUrl(this.pull.url) })))
        .child(separator(t)))
      .child(this.pickerButton(t, "base", "Base", refLabel(this, this.base, this.compare?.base.sha)))
      .child(button(t, { id: "swap", glyph: "swap", tip: "Swap base and head", on: (_e, cx) => this.choose(cx, this.head, this.base) }))
      .child(this.pickerButton(t, "head", "Head", refLabel(this, this.head, this.compare?.head.sha)))
      .when(live, (e) => e.child(button(t, { id: "reload", glyph: "refresh", tip: "Updates when the repository changes. Click to reload now", on: (_e, cx) => this.refresh(cx) })))
      .when(Boolean(this.loading), (e) => e.child(icon("refresh", 13, t.dim).spin(900)))
      .child(div().flex_1())
      .child(button(t, { id: "search", glyph: "search", tip: "Search changed lines (⌘⇧F / Ctrl+Shift+F)", active: this.searchState.open, on: (_e, cx) => this.toggleSearch(cx) }))
      .child(h_flex().rounded(7).border_1().border_color(t.border).p(1).gap(1)
        .child(button(t, { id: "mode-split", glyph: "split", tip: "Side by side", size: 24, active: this.mode === "split", on: (_e, cx) => this.setPref(cx, "mode", "split") }))
        .child(button(t, { id: "mode-unified", glyph: "unified", tip: "Unified", size: 24, active: this.mode === "unified", on: (_e, cx) => this.setPref(cx, "mode", "unified") })))
      .child(button(t, { id: "graph", glyph: "graph", label: "Graph", tip: this.showGraph ? "Hide the commit graph" : "Show the commit graph", active: this.showGraph, on: (_e, cx) => this.setPref(cx, "showGraph", !this.showGraph) }))
      .child(button(t, { id: "wrap", glyph: "wrap", tip: "Wrap long lines", active: this.wrap, on: (_e, cx) => this.setPref(cx, "wrap", !this.wrap) }));
  }

  setPref(cx, key, value) {
    this[key] = value;
    this.rowsCache = null;
    if (key === "showGraph" && value && !this.graph) this.loadGraph(cx);
    this.save();
    cx.notify();
  }

  pickerButton(t, which, label, value, glyph) {
    const open = this.picker?.which === which;
    return h_flex()
      .id(`pick-${which}`)
      .h(28)
      .px(8)
      .gap(6)
      .min_w(0)
      .max_w(which === "pr" ? 280 : 240)
      .items_center()
      .rounded(6)
      .border_1()
      .border_color(open ? t.accent : t.border)
      .bg(t.background)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.openPicker(cx, which))
      .when(Boolean(glyph), (e) => e.child(icon(glyph, 13, t.muted)))
      .when(!glyph, (e) => e.child(div().text_size(11).text_color(t.dim).child(label)))
      .child(div().text_size(12).truncate().child(value || "Choose…"))
      .child(icon("down", 12, t.dim));
  }

  comparison(t) {
    const wrapIn = (el) => div().flex_1().min_h(0).flex().flex_col().child(el);
    if (this.pr && this.pullError) return wrapIn(message(t, `Couldn't load pull request #${this.pr}: ${this.pullError}`, true));
    if (this.pr && !this.pull) return wrapIn(message(t, `Loading pull request #${this.pr}…`));
    if (this.compareError) return wrapIn(message(t, this.compareError, true));
    if (!this.compare) return wrapIn(message(t, "Comparing…"));
    return h_flex()
      .flex_1()
      .min_h(0)
      .items_start()
      .child(div().w(this.treeWidth).h_full().flex_none().min_h(0).border_r(1).border_color(t.border)
        .child(this.searchState.open ? renderSearch(this, t) : renderTree(this, t)))
      .child(splitterBar(t, "tree-split", true, (e) => this.startSplitter("tree", e), this.splitter?.kind === "tree"))
      .child(div().flex_1().min_w(0).h_full().min_h(0).child(renderDiff(this, t)));
  }
}

// ---------------------------------------------------------------- helpers

/** The Diff button beside the tab bar, styled like its Files / Changes buttons. */
function toolbarButton(t) {
  const space = spaces().find((s) => s.active);
  const tab = space?.tabs.find((x) => x.active);
  const on = Boolean(tab?.name?.startsWith("Diff · "));
  return h_flex()
    .size_full()
    .pr(10)
    .items_center()
    .bg(t.chrome)
    .border_b(1)
    .border_color(t.border)
    .child(h_flex()
      .id("diff-button")
      .h(26)
      .px(8)
      .gap(5)
      .flex_none()
      .items_center()
      .rounded(6)
      .text_size(12)
      .bg(on ? t.selected : t.chrome)
      .text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover))
      .tooltip("Compare revisions of this repository")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()) // a press here shouldn't drag the window
      .on_click((_e, cx) => {
        cx.spawn(async () => {
          try {
            await openDiff();
          } catch (e) {
            failed(e);
          }
        });
      })
      .child(icon("graph", 14))
      .child("Diff"));
}

function message(t, text, error = false) {
  return div().flex_1().flex().items_center().justify_center().p(24).text_color(error ? t.ansi1 : t.muted).child(text);
}

function splitterBar(t, id, vertical, onDown, active) {
  return div()
    .id(id)
    .flex_none()
    .when(vertical, (e) => e.w(5).h_full().ml(-3).cursor_col_resize())
    .when(!vertical, (e) => e.h(5).w_full().mt(-3).cursor_row_resize())
    .when(active, (e) => e.bg(t.accent))
    .hover((s) => s.bg(t.border))
    .on_mouse_down("left", (e, cx) => {
      onDown(e);
      cx.stop_propagation();
    });
}

export function openUrl(url) {
  if (!/^https:\/\//.test(url)) return;
  exec("open", [url]).then((r) => r.code === 0 || exec("xdg-open", [url]));
}

export { isPseudoRev, WORKTREE };
