/**
 * git-diff-view in the terminal: the Herdr mod's repository layer and diff model
 * (`herdr/src`) on a local `Host`, drawn with plain ANSI. This file owns the state's
 * changes (loading, live refresh, keys); `view.ts` draws it, `term.ts` talks to the TTY.
 */
import { buildTree, filesInTreeOrder } from "@/lib/tree";
import { OBJECT_ID } from "@/shared/gitText";
import type { SearchHit } from "@/shared/api";
import { defaultRefs, openRepo, type Repo } from "../../herdr/src/repo";
import { expand, findLine, findPair, parseFilePatch, splitLines, untab, type Gap } from "../../herdr/src/diffModel";
import { buildIndex, search } from "../../herdr/src/search";
import { languageFor, MAX_SYNTAX_CHARS, SyntaxDoc } from "../../herdr/src/syntax";
import { bunHost } from "./host";
import { diffRows, filteredTree, type DiffRows, initialState, sideWidth, layoutFor, pickerItems, searchRows, selectedFile, treeRows, type FileView, type Mode, type State, type SyntaxSide } from "./state";
import { openTerminal, parseMouse, type Key, type Terminal } from "./term";
import { frame, headerAction } from "./view";

const REFRESH_MS = 2000;
const SEARCH_LINES = 200_000;
const SEARCH_DELAY_MS = 120;
/** Columns `<` / `>` resize the sidebar by. */
const SIDE_STEP = 4;
/** Rows a wheel notch scrolls. */
const WHEEL_LINES = 3;
/** Time per frame spent colouring the rows on screen; the rest follows on the next tick. */
const SYNTAX_BUDGET_MS = 30;

export interface TuiOptions {
  readonly base?: string;
  readonly head?: string;
  readonly pr?: number | null;
  readonly mode?: Mode;
}

export function runTui(root: string, opts: TuiOptions = {}): Promise<void> {
  return new Promise((done) => {
    const app = new App(root, opts, done);
    app.start();
  });
}

export class App {
  readonly state: State;
  private repo: Repo | null = null;
  private term: Terminal | null = null;
  /** Bumps on every comparison pick: late results of older picks are dropped. */
  private version = 0;
  private compareSig: string | null = null;
  private refreshing = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private renderQueued = false;
  private pendingJump: SearchHit | null = null;

  constructor(
    root: string,
    opts: TuiOptions,
    private readonly done: () => void = () => {},
    /** Tests drive the app without a terminal: pass a fixed size. */
    private readonly size?: { cols: number; rows: number },
  ) {
    this.state = initialState(root, opts);
  }

  // ---------------------------------------------------------------- lifecycle

  start(): void {
    if (!this.size) {
      this.term = openTerminal({ onKeys: (keys) => this.keys(keys), onResize: () => this.render() });
      const bail = () => this.quit();
      process.once("SIGTERM", bail);
      process.once("SIGHUP", bail);
      process.once("uncaughtException", (e) => {
        this.term?.restore();
        console.error(e);
        process.exit(1);
      });
    }
    this.render();
    void this.load();
  }

  async load(): Promise<void> {
    const s = this.state;
    try {
      this.repo = await openRepo(bunHost(s.root));
      const [info, refs] = await Promise.all([this.repo.info(), this.repo.refs()]);
      s.info = info;
      s.refs = refs;
      // Defaults first: if a pull request fails to load, "Stop comparing" lands here.
      const d = defaultRefs(info, refs);
      if (!s.base) s.base = d.base;
      if (!s.head) s.head = d.head;
      if (s.pr !== null) await this.loadPull(s.pr);
      else await this.loadCompare();
      if (!this.size) this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    } catch (e) {
      s.fatal = errorText(e);
    }
    this.render();
  }

  quit(): void {
    if (this.timer) clearInterval(this.timer);
    this.term?.restore();
    this.done();
  }

  /** Draw on the next tick: several changes in a row paint once. */
  render(): void {
    if (this.renderQueued || !this.term) return;
    this.renderQueued = true;
    setImmediate(() => {
      this.renderQueued = false;
      if (!this.term) return;
      this.paint(this.term.cols, this.term.rows);
    });
  }

  /** The frame at a size, after keeping the cursors on screen and colouring visible rows. */
  frame(cols: number, rows: number): Array<string> {
    this.keepVisible(cols, rows);
    this.colour(cols, rows, Infinity);
    return frame(this.state, cols, rows);
  }

  private paint(cols: number, rows: number): void {
    this.keepVisible(cols, rows);
    const more = this.colour(cols, rows, SYNTAX_BUDGET_MS);
    this.term!.paint(frame(this.state, cols, rows));
    if (more) setTimeout(() => this.render(), 0);
  }

  // ---------------------------------------------------------------- loading

  /** Branch names, HEAD and the working tree move; two commit ids never do. */
  private live(): boolean {
    const s = this.state;
    return Boolean(s.base && s.head) && ![s.base, s.head].every((r) => OBJECT_ID.test(r));
  }

  async loadCompare({ quiet = false } = {}): Promise<void> {
    const s = this.state;
    const repo = this.repo;
    const version = this.version;
    const base = s.base;
    const head = s.head;
    if (!repo || !base || !head) return;
    if (!quiet) s.loading = true;
    this.render();
    try {
      const next = await repo.compare(base, head);
      if (version !== this.version) return;
      const sig = JSON.stringify(next);
      const changed = sig !== this.compareSig;
      this.compareSig = sig;
      s.compareError = null;
      if (changed) {
        // The tree cursor stays on its row while files come and go.
        const atKey = treeRows(s)[s.treeCursor]?.key;
        s.compare = next;
        if (!s.selected || !next.files.some((f) => f.path === s.selected)) {
          s.selected = filesInTreeOrder(buildTree(next.files))[0]?.path ?? null;
          s.diffCursor = s.diffScroll = s.hscroll = 0;
        }
        const again = atKey ? treeRows(s).findIndex((r) => r.key === atKey) : -1;
        if (again >= 0) s.treeCursor = again;
        else this.syncTreeCursor();
      }
      // The selected file may change without the list changing (same counts, new text).
      await this.loadFile({ quiet: !changed || quiet });
    } catch (e) {
      if (version === this.version) {
        s.compareError = errorText(e);
        s.compare = null;
        this.compareSig = null;
      }
    } finally {
      if (version === this.version) s.loading = false;
      this.render();
    }
  }

  async loadFile({ quiet = false } = {}): Promise<void> {
    const s = this.state;
    const f = selectedFile(s);
    const cmp = s.compare;
    if (!f || !cmp || !this.repo) {
      s.file = null;
      return;
    }
    const key = `${cmp.base.sha}:${cmp.head.sha}:${f.oldPath}:${f.path}`;
    if (!quiet && s.file?.key !== key) s.fileLoading = true;
    this.render();
    try {
      const data = await this.repo.fileDiff(cmp.base.sha, cmp.head.sha, f.path, f.oldPath);
      if (s.selected !== f.path || s.compare !== cmp) return;
      // Same text as on screen: keep the rows (and the cursor) as they are.
      const old = s.file;
      if (!(old?.key === key && old.data.patch === data.patch && old.data.newContent === data.newContent && old.data.oldContent === data.oldContent)) {
        s.file = { key, path: f.path, data, parsed: parseFilePatch(data.patch), oldLines: splitLines(data.oldContent), newLines: splitLines(data.newContent), syntax: this.syntaxFor(f.path, data) };
        s.fileError = null;
      }
      this.applyJump();
    } catch (e) {
      if (s.selected === f.path) {
        s.fileError = errorText(e);
        s.file = null;
      }
    } finally {
      s.fileLoading = false;
      this.render();
    }
  }

  /**
   * Syntax state for a file's two sides, or null without a known language. A side whose
   * text didn't change keeps its doc, so a refresh re-colours only what moved.
   */
  private syntaxFor(path: string, data: { oldContent: string | null; newContent: string | null }): FileView["syntax"] {
    const lang = languageFor(path);
    if (!lang) return null;
    const prev = this.state.file?.path === path ? this.state.file.syntax : null;
    const side = (content: string | null, before: SyntaxSide | null | undefined): SyntaxSide | null => {
      if (content === null || content.length > MAX_SYNTAX_CHARS) return null;
      if (before?.source === content) return before;
      return { source: content, doc: new SyntaxDoc(lang, splitLines(content)!.map(untab), before?.doc) };
    };
    return { old: side(data.oldContent, prev?.old), new: side(data.newContent, prev?.new) };
  }

  async loadPull(number: number): Promise<void> {
    const s = this.state;
    const version = ++this.version;
    s.pr = number;
    s.pull = null;
    s.pullError = null;
    s.compare = null;
    s.compareError = null;
    this.compareSig = null;
    this.forget();
    s.loading = true;
    this.render();
    try {
      const pull = await this.repo!.pull(number);
      if (version !== this.version) return;
      s.pull = pull;
      s.base = pull.base;
      s.head = pull.head;
      this.version++;
      await this.loadCompare();
      if (s.search.query.trim()) await this.runSearch();
    } catch (e) {
      if (version === this.version) {
        s.pullError = errorText(e);
        s.compareError = `Pull request #${number}: ${s.pullError}`;
        s.loading = false;
      }
    }
    this.render();
  }

  async loadPulls(): Promise<void> {
    const s = this.state;
    if (!this.repo) return;
    try {
      s.pulls = await this.repo.pulls();
      s.pullsError = null;
    } catch (e) {
      s.pullsError = errorText(e);
    }
    this.render();
  }

  /** Re-read what may have moved: HEAD (then the refs too), and a live comparison. */
  async refresh({ force = false } = {}): Promise<void> {
    const s = this.state;
    if (this.refreshing || !this.repo) return;
    this.refreshing = true;
    try {
      const info = await this.repo.info();
      const moved = info.headSha !== s.info?.headSha;
      s.info = info;
      if (moved || force) s.refs = await this.repo.refs();
      if ((this.live() && s.pr === null) || force) {
        await this.loadCompare({ quiet: true });
        // Hits follow the text on disk, as the web view's do.
        if (s.search.open && s.search.query.trim()) await this.runSearch({ quiet: true });
        else s.search.index = null;
      }
    } catch {
      /* the next tick tries again */
    } finally {
      this.refreshing = false;
      this.render();
    }
  }

  // ---------------------------------------------------------------- choosing

  /** A new comparison: gaps and search hits belonged to the old one. */
  private forget(): void {
    const s = this.state;
    s.expanded = new Map();
    s.search.index = null;
    s.search.indexedPatch = null;
    s.search.result = null;
    s.search.jump = null;
    this.pendingJump = null;
  }

  choose(base: string, head: string): void {
    const s = this.state;
    s.pr = null;
    s.pull = null;
    s.pullError = null;
    s.base = base;
    s.head = head;
    this.forget();
    this.version++;
    void this.loadCompare().then(() => {
      if (s.search.query.trim()) void this.runSearch();
    });
  }

  select(path: string): void {
    const s = this.state;
    if (s.selected === path) return;
    s.selected = path;
    s.diffCursor = s.diffScroll = s.hscroll = 0;
    this.syncTreeCursor();
    void this.loadFile();
  }

  /** Next or previous file in tree order (the filter applies). */
  go(delta: number): void {
    const s = this.state;
    const tree = filteredTree(s);
    const files = tree ? filesInTreeOrder(tree) : [];
    if (!files.length) return;
    const at = files.findIndex((f) => f.path === s.selected);
    const next = files[Math.min(files.length - 1, Math.max(0, at < 0 ? 0 : at + delta))];
    if (next) this.select(next.path);
  }

  private syncTreeCursor(): void {
    const s = this.state;
    const i = treeRows(s).findIndex((r) => r.key === `f:${s.selected}`);
    if (i >= 0) s.treeCursor = i;
  }

  // ---------------------------------------------------------------- search

  private scheduleSearch(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => void this.runSearch(), SEARCH_DELAY_MS);
  }

  async runSearch({ quiet = false } = {}): Promise<void> {
    const s = this.state;
    const ss = s.search;
    const cmp = s.compare;
    const query = ss.query;
    if (!query.trim()) {
      ss.result = null;
      ss.cursor = ss.scroll = 0;
      this.render();
      return;
    }
    if (!cmp || !this.repo) return;
    if (!quiet) ss.busy = true;
    this.render();
    try {
      // A live comparison re-reads its patch, and re-indexes only when it changed.
      if (!ss.index || this.live()) {
        const p = await this.repo.patch(cmp.base.sha, cmp.head.sha, SEARCH_LINES);
        if (s.compare !== cmp) return;
        if (p.patch !== ss.indexedPatch || !ss.index) {
          ss.index = buildIndex(p.patch, p.partial);
          ss.indexedPatch = p.patch;
        }
      }
      if (ss.query !== query) return;
      const kept = ss.result?.hits[ss.cursor];
      ss.result = search(ss.index, query);
      ss.error = null;
      const again = kept ? ss.result.hits.findIndex((h) => h.path === kept.path && h.side === kept.side && h.line === kept.line) : -1;
      ss.cursor = again >= 0 ? again : 0;
      if (again < 0) ss.scroll = 0;
    } catch (e) {
      ss.error = errorText(e);
    } finally {
      ss.busy = false;
      this.render();
    }
  }

  openHit(hit: SearchHit): void {
    const s = this.state;
    s.search.jump = hit;
    this.pendingJump = hit;
    s.focus = "diff";
    if (s.selected !== hit.path) this.select(hit.path);
    else this.applyJump();
  }

  /** Put the diff cursor on the hit just opened, once its file's rows exist. */
  private applyJump(): void {
    const s = this.state;
    const hit = this.pendingJump;
    if (!hit || s.file?.path !== hit.path) return;
    const built = diffRows(s);
    if (!built) return;
    this.pendingJump = null;
    const i = built.layout === "split" ? findPair(built.rows, hit.side, hit.line) : findLine(built.rows, hit.side, hit.line);
    if (i < 0) return;
    s.diffCursor = i;
    s.diffScroll = Math.max(0, i - 5);
    // Long line: pan so the match shows, a little after the left edge.
    const col = untab(hitText(built, i, hit)).toLowerCase().indexOf(s.search.query.trim().toLowerCase());
    const cols = this.term?.cols ?? this.size?.cols ?? 80;
    const L = layoutFor(s, cols, 24);
    const textW = (built.layout === "split" ? L.diffWidth / 2 : L.diffWidth) - 14;
    s.hscroll = col > textW - s.search.query.length ? Math.max(0, col - 8) : 0;
  }

  /** Next or previous search hit, across files. */
  private stepHit(delta: number): void {
    const ss = this.state.search;
    const hits = ss.result?.hits;
    if (!hits?.length) {
      this.state.message = ss.query ? "No search hits." : "Press / to search the changed lines.";
      return;
    }
    ss.cursor = (ss.cursor + delta + hits.length) % hits.length;
    this.openHit(hits[ss.cursor]!);
  }

  // ---------------------------------------------------------------- view upkeep

  /** Keep each list's cursor inside its pane, and in range. */
  private keepVisible(cols: number, rows: number): void {
    const s = this.state;
    const L = layoutFor(s, cols, rows);
    const fitTo = (cursor: number, scroll: number, count: number, h: number) => {
      const c = Math.max(0, Math.min(cursor, count - 1));
      let sc = Math.min(scroll, Math.max(0, count - h));
      if (c < sc) sc = c;
      if (c >= sc + h) sc = c - h + 1;
      return [Math.max(0, c), Math.max(0, sc)] as const;
    };
    [s.treeCursor, s.treeScroll] = fitTo(s.treeCursor, s.treeScroll, treeRows(s).length, L.body - 1);
    const built = diffRows(s);
    [s.diffCursor, s.diffScroll] = fitTo(s.diffCursor, s.diffScroll, built?.rows.length ?? 0, L.diffBody);
    const ss = s.search;
    const srows = searchRows(ss.result);
    const at = srows.findIndex((r) => r.t === "hit" && r.i === ss.cursor);
    if (at >= 0) {
      // The file header above the first hit of a file shows along with it.
      const [, sc] = fitTo(at, ss.scroll, srows.length, L.body - 2);
      ss.scroll = sc === at && srows[at - 1]?.t === "file" ? at - 1 : sc;
    } else ss.scroll = 0;
    if (s.picker) {
      const n = pickerItems(s, s.picker).length;
      [s.picker.cursor, s.picker.scroll] = fitTo(s.picker.cursor, s.picker.scroll, n, L.body - 3);
    }
  }

  /** Work out syntax colours for the rows on screen; true when some are still to do. */
  private colour(cols: number, rows: number, budgetMs: number): boolean {
    const s = this.state;
    const docs = s.file?.syntax;
    const built = diffRows(s);
    if (!docs || !built) return false;
    const h = layoutFor(s, cols, rows).diffBody;
    const deadline = Date.now() + budgetMs;
    for (let i = s.diffScroll; i < s.diffScroll + h && i < built.rows.length; i++) {
      const row = built.rows[i]!;
      const want: Array<["old" | "new", number]> = [];
      if (row.t === "line") want.push(row.line.kind === "del" ? ["old", row.line.old!] : ["new", row.line.new!]);
      else if (row.t === "pair") {
        if (row.left) want.push(["old", row.left.n]);
        if (row.right) want.push(["new", row.right.n]);
      }
      for (const [side, n] of want) {
        const doc = side === "old" ? docs.old?.doc : docs.new?.doc;
        while (doc?.needs(n)) {
          if (Date.now() > deadline) return true;
          doc.work(n, Math.min(deadline, Date.now() + 10));
        }
      }
    }
    return false;
  }

  // ---------------------------------------------------------------- keys

  keys(keys: ReadonlyArray<Key>): void {
    for (const k of keys) this.key(k);
    this.render();
  }

  key(k: Key): void {
    const s = this.state;
    s.message = null;
    if (k === "ctrl+c") return this.quit();
    const m = parseMouse(k);
    if (m) return this.mouse(m.event, m.x - 1, m.y - 1);
    if (s.fatal) {
      if (k === "q" || k === "escape") this.quit();
      return;
    }
    if (s.help) {
      if (k === "escape" || k === "?" || k === "q" || k === "enter") s.help = false;
      return;
    }
    if (s.picker) return this.pickerKey(k);
    if (s.filtering) return this.filterKey(k);
    if (s.search.editing) return this.searchKey(k);

    switch (k) {
      case "q":
        return this.quit();
      case "?":
        s.help = true;
        return;
      case "tab":
      case "shift+tab":
        s.focus = s.focus === "tree" ? "diff" : "tree";
        return;
      case "b":
      case "h":
        s.picker = { which: k === "b" ? "base" : "head", query: "", cursor: 0, scroll: 0 };
        return;
      case "p":
        s.picker = { which: "pr", query: "", cursor: 0, scroll: 0 };
        if (s.pulls === null || s.pullsError) void this.loadPulls();
        return;
      case "x":
        if (s.base && s.head) this.choose(s.head, s.base);
        return;
      case "s": {
        // The cursor stays on the same line of the file.
        const before = diffRows(s);
        const at = before ? rowLine(before, s.diffCursor) : null;
        const offset = s.diffCursor - s.diffScroll;
        s.mode = s.mode === "split" ? "unified" : "split";
        const after = diffRows(s);
        const i = at && after ? findRow(after, at) : -1;
        s.diffCursor = Math.max(0, i);
        s.diffScroll = Math.max(0, i - offset);
        return;
      }
      case "<":
      case ">":
      case "=": {
        const cols = this.term?.cols ?? this.size?.cols ?? 80;
        const now = layoutFor(s, cols, 24).side;
        if (now === 0 || now === cols) return; // narrow terminal: one pane at a time
        s.sideWidth = k === "=" ? null : sideWidth(now + (k === ">" ? SIDE_STEP : -SIDE_STEP), cols);
        return;
      }
      case "r":
        s.message = "Reloading…";
        void this.refresh({ force: true });
        return;
      case "/":
        s.search.open = true;
        s.search.editing = true;
        s.focus = "tree";
        return;
      case "f":
        if (s.search.open) s.search.open = false;
        s.filtering = true;
        s.focus = "tree";
        return;
      case "n":
        return this.stepHit(1);
      case "N":
        return this.stepHit(-1);
      case ".":
      case "f7":
        return this.go(1);
      case ",":
      case "shift+f7":
        return this.go(-1);
      case "escape":
        if (s.search.open) {
          s.search.open = false;
          s.search.jump = null;
        } else if (s.filter) {
          s.filter = "";
          this.syncTreeCursor();
        }
        return;
    }
    if (s.focus === "tree") return s.search.open ? this.hitsKey(k) : this.treeKey(k);
    return this.diffKey(k);
  }

  /** A click or wheel turn at a 0-based cell: acts on whatever is drawn there. */
  private mouse(event: string, x: number, y: number): void {
    const s = this.state;
    const cols = this.term?.cols ?? this.size?.cols ?? 80;
    const rows = this.term?.rows ?? this.size?.rows ?? 24;
    const L = layoutFor(s, cols, rows);
    const wheel = event === "wheelup" ? -WHEEL_LINES : event === "wheeldown" ? WHEEL_LINES : 0;
    const click = event === "click";
    // A click elsewhere finishes typing in the filter or search line, as Enter would.
    if (click && s.filtering) this.filterKey("enter");
    if (click && s.search.editing) this.searchKey("enter");
    // Dragging the divider resizes the sidebar; drags and releases elsewhere do nothing.
    if (event === "drag") {
      if (s.resizing) s.sideWidth = sideWidth(x, cols);
      return;
    }
    if (event === "release") {
      s.resizing = false;
      return;
    }
    if (s.fatal) return;
    if (click && !s.help && !s.picker && y > 0 && L.side > 0 && L.diffWidth > 0 && x === L.side) {
      s.resizing = true;
      return;
    }
    if (s.help) {
      if (click) s.help = false;
      return;
    }
    const bodyRow = y - 1;
    if (s.picker) {
      const p = s.picker;
      const n = pickerItems(s, p).length;
      if (wheel) {
        p.cursor = clampMove(p.cursor, wheel, n);
        p.scroll = Math.max(0, Math.min(Math.max(0, n - (L.body - 3)), p.scroll + wheel));
      } else if (click && y === 0) s.picker = null;
      else if (click && bodyRow >= 3 && bodyRow < L.body) {
        const i = p.scroll + bodyRow - 3;
        if (i < n) {
          p.cursor = i;
          this.pickerKey("enter");
        }
      }
      return;
    }
    if (y === 0) {
      if (!click) return;
      const action = headerAction(s, cols, x);
      if (action === "mode") this.key("s");
      else if (action === "base") this.key("b");
      else if (action === "head") this.key("h");
      else if (action === "pr") this.key("p");
      return;
    }
    if (bodyRow < 0 || bodyRow >= L.body) return;

    if (L.side > 0 && x < L.side) {
      if (s.search.open) {
        const ss = s.search;
        const srows = searchRows(ss.result);
        if (wheel) {
          ss.scroll = Math.max(0, Math.min(Math.max(0, srows.length - (L.body - 2)), ss.scroll + wheel));
          // Keep the cursor among the rows on screen, or keepVisible scrolls back to it.
          const shown = srows.slice(ss.scroll, ss.scroll + L.body - 2).filter((r) => r.t === "hit").map((r) => (r as { i: number }).i);
          if (shown.length && !shown.includes(ss.cursor)) ss.cursor = wheel > 0 ? shown[0]! : shown[shown.length - 1]!;
          return;
        }
        s.focus = "tree";
        const row = srows[ss.scroll + bodyRow - 2];
        if (click && row?.t === "hit") {
          ss.cursor = row.i;
          this.openHit(ss.result!.hits[row.i]!);
          s.focus = "tree";
        }
        return;
      }
      const trows = treeRows(s);
      if (wheel) {
        const h = L.body - 1;
        s.treeScroll = Math.max(0, Math.min(Math.max(0, trows.length - h), s.treeScroll + wheel));
        s.treeCursor = Math.max(s.treeScroll, Math.min(s.treeScroll + h - 1, s.treeCursor));
        return;
      }
      s.focus = "tree";
      const i = s.treeScroll + bodyRow - 1;
      const row = trows[i];
      if (!click || bodyRow === 0 || !row) return;
      s.treeCursor = i;
      if (row.node.kind === "file") this.select(row.node.path);
      else this.treeKey("enter");
      return;
    }

    if (x >= L.diffLeft && L.diffWidth > 0) {
      const built = diffRows(s);
      if (!built) {
        if (click) s.focus = "diff";
        return;
      }
      if (wheel) {
        const h = L.diffBody;
        s.diffScroll = Math.max(0, Math.min(Math.max(0, built.rows.length - h), s.diffScroll + wheel));
        s.diffCursor = Math.max(s.diffScroll, Math.min(s.diffScroll + h - 1, s.diffCursor));
        return;
      }
      if (!click) return;
      s.focus = "diff";
      const i = s.diffScroll + bodyRow - 1;
      const row = built.rows[i];
      if (bodyRow === 0 || !row) return;
      s.diffCursor = i;
      if (row.t === "gap") this.expandGap(row.gap, "all");
    }
  }

  private moveBy(k: Key, page: number): number | null {
    if (k === "up" || k === "k") return -1;
    if (k === "down" || k === "j") return 1;
    if (k === "pageup") return -page;
    if (k === "pagedown" || k === " ") return page;
    if (k === "home" || k === "g") return -Infinity;
    if (k === "end" || k === "G") return Infinity;
    return null;
  }

  private page(): number {
    const rows = this.term?.rows ?? this.size?.rows ?? 24;
    return Math.max(1, rows - 4);
  }

  private treeKey(k: Key): void {
    const s = this.state;
    const rows = treeRows(s);
    const d = this.moveBy(k, this.page());
    if (d !== null) {
      s.treeCursor = clampMove(s.treeCursor, d, rows.length);
      return;
    }
    const row = rows[s.treeCursor];
    if (!row) return;
    const node = row.node;
    if (k === "enter" || k === "l" || k === "right" || k === "left") {
      if (node.kind === "file") {
        if (k === "left") {
          const parent = rows.findIndex((r) => r.key === row.parentKey);
          if (parent >= 0) s.treeCursor = parent;
          return;
        }
        this.select(node.path);
        if (k === "enter" || k === "l") s.focus = "diff";
        return;
      }
      if (s.filter.trim()) return;
      const open = !s.collapsed.has(node.path);
      if (k === "left" && !open) {
        const parent = rows.findIndex((r) => r.key === row.parentKey);
        if (parent >= 0) s.treeCursor = parent;
      } else if (k === "left" || (k === "enter" && open)) s.collapsed.add(node.path);
      else s.collapsed.delete(node.path);
    }
  }

  private hitsKey(k: Key): void {
    const ss = this.state.search;
    const hits = ss.result?.hits ?? [];
    const d = this.moveBy(k, this.page());
    if (d !== null) {
      ss.cursor = clampMove(ss.cursor, d, hits.length);
      return;
    }
    if (k === "enter" && hits[ss.cursor]) this.openHit(hits[ss.cursor]!);
  }

  private diffKey(k: Key): void {
    const s = this.state;
    const built = diffRows(s);
    if (!built) return;
    const d = this.moveBy(k, this.page());
    if (d !== null) {
      s.diffCursor = clampMove(s.diffCursor, d, built.rows.length);
      return;
    }
    const row = built.rows[s.diffCursor];
    switch (k) {
      case "left":
        s.hscroll = Math.max(0, s.hscroll - 8);
        return;
      case "right":
        s.hscroll += 8;
        return;
      case "0":
        s.hscroll = 0;
        return;
      case "]":
      case "[": {
        const changed = (i: number) => {
          const r = built.rows[i];
          return r?.t === "line" ? r.line.kind !== "ctx" : r?.t === "pair" ? r.left?.kind !== "ctx" || r.right?.kind !== "ctx" : false;
        };
        const start = (i: number) => changed(i) && !changed(i - 1);
        const step = k === "]" ? 1 : -1;
        for (let i = s.diffCursor + step; i >= 0 && i < built.rows.length; i += step) {
          if (start(i)) {
            s.diffCursor = i;
            return;
          }
        }
        s.message = k === "]" ? "Last change in this file (. for the next file)." : "First change in this file.";
        return;
      }
      case "enter":
      case "J":
      case "K":
        if (row?.t === "gap") this.expandGap(row.gap, k === "enter" ? "all" : k === "J" ? "down" : "up");
        return;
    }
  }

  private expandGap(gap: Gap, how: "up" | "down" | "all"): void {
    const s = this.state;
    const path = s.selected;
    if (!path) return;
    s.expanded = new Map(s.expanded).set(path, expand(s.expanded.get(path) ?? new Map(), gap, how));
  }

  private pickerKey(k: Key): void {
    const s = this.state;
    const p = s.picker!;
    const items = pickerItems(s, p);
    const d = this.moveBy(k === "j" || k === "k" || k === "g" || k === "G" || k === " " ? "" : k, this.page());
    if (d !== null) {
      p.cursor = clampMove(p.cursor, d, items.length);
      return;
    }
    if (k === "escape") s.picker = null;
    else if (k === "enter") {
      const it = items[p.cursor];
      if (!it) return;
      s.picker = null;
      if (p.which === "pr") {
        if (it.value === "stop") this.choose(s.base, s.head);
        else void this.loadPull(Number(it.value));
      } else if (p.which === "base") this.choose(it.value, s.head);
      else this.choose(s.base, it.value);
    } else if (edit(p, "query", k)) {
      p.cursor = 0;
      p.scroll = 0;
    }
  }

  private filterKey(k: Key): void {
    const s = this.state;
    if (k === "enter" || k === "down") s.filtering = false;
    else if (k === "escape") {
      s.filter = "";
      s.filtering = false;
    } else if (edit(s, "filter", k)) {
      s.treeCursor = 0;
      s.treeScroll = 0;
    }
    if (!s.filtering) this.syncTreeCursor();
  }

  private searchKey(k: Key): void {
    const ss = this.state.search;
    if (k === "enter" || k === "down") {
      ss.editing = false;
      if (this.searchTimer) clearTimeout(this.searchTimer);
      void this.runSearch();
    } else if (k === "escape") {
      ss.editing = false;
      ss.open = false;
      ss.jump = null;
    } else if (edit(ss, "query", k)) this.scheduleSearch();
  }
}

type LineRef = { readonly side: "old" | "new"; readonly n: number };

/** The file line a diff row shows (the head side when it shows both). */
function rowLine(built: DiffRows, i: number): LineRef | null {
  const r = built.rows[i];
  if (!r) return null;
  if (r.t === "line") return r.line.kind === "del" ? { side: "old", n: r.line.old! } : { side: "new", n: r.line.new! };
  if (r.t === "pair") return r.right ? { side: "new", n: r.right.n } : r.left ? { side: "old", n: r.left.n } : null;
  return null;
}

function findRow(built: DiffRows, at: LineRef): number {
  for (let i = 0; i < built.rows.length; i++) {
    const r = built.rows[i]!;
    if (r.t === "line" && (at.side === "old" ? r.line.kind === "del" && r.line.old === at.n : r.line.kind !== "del" && r.line.new === at.n)) return i;
    if (r.t === "pair" && (at.side === "old" ? r.left?.n === at.n : r.right?.n === at.n)) return i;
  }
  return -1;
}

/** A hit's line text as its diff row holds it. */
function hitText(built: DiffRows, i: number, hit: SearchHit): string {
  const r = built.rows[i];
  if (r?.t === "line") return r.line.text;
  if (r?.t === "pair") return (hit.side === "old" ? r.left?.text : r.right?.text) ?? "";
  return "";
}

/** Typing into a text field: characters, backspace, ctrl+u (clear), ctrl+w (word). True when it changed. */
function edit<K extends string>(target: Record<K, string>, field: K, k: Key): boolean {
  const before = target[field];
  if (k === "backspace") target[field] = before.slice(0, -1) as never;
  else if (k === "ctrl+u") target[field] = "" as never;
  else if (k === "ctrl+w") target[field] = before.replace(/\S*\s*$/, "") as never;
  else if ([...k].length === 1 && k >= " ") target[field] = (before + k) as never;
  return target[field] !== before;
}

const clampMove = (at: number, d: number, count: number) => Math.max(0, Math.min(count - 1, d === Infinity ? count - 1 : d === -Infinity ? 0 : at + d));

const errorText = (e: unknown) => String((e as Error)?.message ?? e);
