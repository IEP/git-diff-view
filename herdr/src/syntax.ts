/**
 * Syntax colors for the Herdr mod's diff.
 *
 * JS/TS files go through a hand-written lexer (`lexer.ts`), top to bottom, carrying
 * its state from line to line: about 0.4 ms per KB in the mod. Everything else uses
 * lowlight (the highlight.js grammars the web view's `@git-diff-view` uses), which is
 * about 25 times slower there (~6 ms per KB, on the window's thread), and Herdr kills a
 * script call that runs for about half a second. So lowlight never sees a whole file:
 * it is cut at blank lines into chunks of about a KB, and only chunks holding lines the
 * diff shows are highlighted, a few milliseconds' worth per tick, by the caller. A
 * construct spanning a blank line at a chunk edge (a block comment, a docstring) can be
 * colored wrongly there. Measurements: herdr/research/faster-syntax-highlighting.md.
 */
import { createLowlight, common } from "lowlight";
import { cloneState, initState, lexLine, LEXED, type LexState } from "./lexer";

/** What a token is, reduced to the few kinds the mod colors. */
export type SyntaxKind = "keyword" | "string" | "number" | "comment" | "function" | "type" | "attr" | "tag" | "meta";

/** A colored run `[from, to, kind]` on a line's drawn (untabbed) text. */
export type SyntaxRun = readonly [number, number, SyntaxKind];

// ~1.2 KB takes about 8 ms in the mod: short enough that a slice never holds up a
// frame (Herdr interrupts long-running script work, and the job with it).
const CHUNK_CHARS = 1_200;
const CHUNK_MAX = 2_500;
/** Files over this are left plain: highlighting all that is shown would take too long. */
export const MAX_SYNTAX_CHARS = 1_000_000;
/** Lines over this are left plain (minified code, data). */
const MAX_LINE = 2_000;

let lowlight: ReturnType<typeof createLowlight> | null = null;
/** Created on first use: the toolbar button and launcher load this file too. */
const engine = () => (lowlight ??= createLowlight(common));

/** The grammar for a path, by extension (or name, for `Makefile`), or null. */
export function languageFor(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (name === "makefile" || name === "gnumakefile") return "makefile";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1);
  return engine().registered(ext) ? ext : null;
}

// highlight.js scope (the first class, without `hljs-`) → kind. Unlisted scopes draw plain.
const KIND: Record<string, SyntaxKind> = {
  keyword: "keyword", "selector-tag": "keyword", "meta-keyword": "keyword", doctag: "keyword",
  string: "string", regexp: "string", char: "string", "template-tag": "string", symbol: "string",
  number: "number", literal: "number",
  comment: "comment", quote: "comment",
  title: "function", "title.function": "function", "title.function.invoke": "function", section: "function",
  type: "type", "title.class": "type", "title.class.inherited": "type", built_in: "type", class: "type",
  attr: "attr", attribute: "attr", property: "attr", "selector-attr": "attr", "selector-class": "attr", "selector-id": "attr", variable: "attr", "template-variable": "attr",
  name: "tag", tag: "tag", "selector-pseudo": "tag", bullet: "tag",
  meta: "meta", "meta.prompt": "meta", addition: "string", deletion: "keyword", link: "string", code: "string",
};

/** An embedded expression (`${…}` in a template string) draws plain, not as its string. */
const PLAIN = "plain" as const;

function kindOf(className: ReadonlyArray<string> | undefined): SyntaxKind | typeof PLAIN | null {
  if (!className?.length) return null;
  if (className[0] === "hljs-subst") return PLAIN;
  // `["hljs-title", "function_"]` → "title.function"
  const base = className[0]!.replace(/^hljs-/, "");
  const full = [base, ...className.slice(1).map((c) => c.replace(/_+$/, ""))].join(".");
  return KIND[full] ?? KIND[base] ?? null;
}

interface HastNode {
  readonly type: string;
  readonly value?: string;
  readonly properties?: { readonly className?: ReadonlyArray<string> };
  readonly children?: ReadonlyArray<HastNode>;
}

/** Highlight some lines as one piece of text: runs per line, same length as `lines`. */
export function highlightLines(lang: string, lines: ReadonlyArray<string>): Array<Array<SyntaxRun> | null> {
  const out: Array<Array<SyntaxRun> | null> = lines.map(() => []);
  let tree: HastNode;
  try {
    tree = engine().highlight(lang, lines.join("\n")) as HastNode;
  } catch {
    return lines.map(() => null);
  }
  let line = 0;
  let col = 0;
  const push = (text: string, kind: SyntaxKind | null) => {
    const parts = text.split("\n");
    parts.forEach((part, k) => {
      if (k > 0) {
        line++;
        col = 0;
      }
      if (!part) return;
      const runs = out[line];
      if (runs && kind) {
        const last = runs[runs.length - 1];
        if (last && last[1] === col && last[2] === kind) runs[runs.length - 1] = [last[0], col + part.length, kind];
        else runs.push([col, col + part.length, kind]);
      }
      col += part.length;
    });
  };
  const walk = (node: HastNode, kind: SyntaxKind | null) => {
    if (node.type === "text") return push(node.value ?? "", kind);
    const own = node.type === "element" ? kindOf(node.properties?.className) : null;
    const next = own === PLAIN ? null : (own ?? kind);
    for (const child of node.children ?? []) walk(child, next);
  };
  walk(tree, null);
  return out;
}

/** Line ranges `[from, to)` (0-based) to highlight as one piece each, cut at blank lines. */
export function planChunks(lines: ReadonlyArray<string>): Array<readonly [number, number]> {
  const chunks: Array<readonly [number, number]> = [];
  let start = 0;
  let size = 0;
  let lastBlank = -1;
  for (let i = 0; i < lines.length; i++) {
    size += lines[i]!.length + 1;
    if (!lines[i]!.trim()) lastBlank = i;
    if (size >= CHUNK_CHARS && lastBlank > start) {
      chunks.push([start, lastBlank + 1]);
      start = lastBlank + 1;
      size = lines.slice(start, i + 1).reduce((n, l) => n + l.length + 1, 0);
      lastBlank = -1;
    } else if (size >= CHUNK_MAX) {
      chunks.push([start, i + 1]);
      start = i + 1;
      size = 0;
      lastBlank = -1;
    }
  }
  if (start < lines.length) chunks.push([start, lines.length]);
  return chunks;
}

/** Lexer state is saved every this many lines, so an edit re-lexes from just above it. */
const CHECKPOINT = 64;

/**
 * One side of a file's syntax colors, worked out a slice at a time by the caller:
 * - JS/TS (`LEXED`): the hand-written lexer, top to bottom, carrying its state from
 *   line to line, so there are no chunk edges;
 * - everything else: lowlight, a blank-line-cut chunk at a time.
 * `runs(n)` is the 1-based line's runs once worked out, else undefined (draw it plain).
 */
export class SyntaxDoc {
  readonly chunks: ReadonlyArray<readonly [number, number]>;
  /** Colored by the lexer rather than lowlight. */
  readonly lexed: boolean;
  private readonly done: Array<boolean>;
  private readonly lineRuns: Array<ReadonlyArray<SyntaxRun> | null | undefined>;
  /** Lexer: the next line (0-based) to lex, the state before it, and saved states. */
  private next = 0;
  private state: LexState = initState();
  private readonly checkpoints = new Map<number, LexState>([[0, initState()]]);

  constructor(
    readonly lang: string,
    /** The side's lines, untabbed, as the diff draws them. */
    readonly lines: ReadonlyArray<string>,
    /**
     * The same side before an edit: lines above and below the edited stretch keep its
     * runs, so a live file doesn't flash plain on every save. They are still worked out
     * again (the lexer resumes from the checkpoint above the edit), but the old colors
     * show until then.
     */
    before?: SyntaxDoc | null,
  ) {
    this.lexed = LEXED.has(lang);
    this.chunks = this.lexed ? [] : planChunks(lines);
    this.done = this.chunks.map(() => false);
    this.lineRuns = new Array(lines.length);
    if (before && before.lang === lang) {
      const old = before.lines;
      let head = 0;
      while (head < old.length && head < lines.length && old[head] === lines[head]) head++;
      let tail = 0;
      while (tail < old.length - head && tail < lines.length - head && old[old.length - 1 - tail] === lines[lines.length - 1 - tail]) tail++;
      for (let i = 0; i < head; i++) this.lineRuns[i] = before.lineRuns[i];
      for (let k = 1; k <= tail; k++) this.lineRuns[lines.length - k] = before.lineRuns[old.length - k];
      if (this.lexed) {
        // Lines above the edit lex the same: resume from the last checkpoint at or above it.
        const from = Math.floor(Math.min(head, before.next) / CHECKPOINT) * CHECKPOINT;
        for (const [at, st] of before.checkpoints) if (at <= from) this.checkpoints.set(at, cloneState(st));
        this.next = from;
        this.state = cloneState(this.checkpoints.get(from) ?? initState());
      }
    }
  }

  runs(line: number): ReadonlyArray<SyntaxRun> | null | undefined {
    return this.lineRuns[line - 1];
  }

  /** Whether a 1-based line's colors are still to be worked out. */
  needs(line: number): boolean {
    if (line < 1 || line > this.lines.length) return false;
    return this.lexed ? line - 1 >= this.next : !this.isDone(this.chunkOf(line));
  }

  /**
   * Work towards a 1-based line's colors until `deadline` (a `Date.now()` time): the
   * lexer goes on down the file (at least one line), lowlight does that line's chunk.
   */
  work(line: number, deadline: number): void {
    if (!this.lexed) return this.highlight(this.chunkOf(line));
    const lines = this.lines;
    do {
      const i = this.next;
      if (i % CHECKPOINT === 0) this.checkpoints.set(i, cloneState(this.state));
      this.lineRuns[i] = lexLine(lines[i]!, this.state);
      this.next = i + 1;
    } while (this.next < lines.length && (this.next % 16 !== 0 || Date.now() < deadline));
  }

  /** The chunk holding a 1-based line. */
  chunkOf(line: number): number {
    let lo = 0;
    let hi = this.chunks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.chunks[mid]![0] <= line - 1) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  isDone(chunk: number): boolean {
    return this.done[chunk] ?? true;
  }

  /** Highlight one lowlight chunk (about 8 ms in the mod). */
  highlight(chunk: number): void {
    if (this.isDone(chunk)) return;
    this.done[chunk] = true;
    const [from, to] = this.chunks[chunk]!;
    const slice = this.lines.slice(from, to);
    // Very long lines go plain and don't take part (they'd dominate the time).
    const runs = highlightLines(this.lang, slice.map((l) => (l.length > MAX_LINE ? "" : l)));
    runs.forEach((r, k) => (this.lineRuns[from + k] = slice[k]!.length > MAX_LINE ? null : r));
  }
}
