import { Database } from "bun:sqlite";
import { Context, Effect, Layer, Schema } from "effect";
import { isPseudoRev, type SearchHit, type SearchResponse } from "@/shared/api";
import { Git, type GitError, type InvalidRef } from "./Git";

/**
 * Full-text search over the changed lines of one comparison.
 *
 * Each comparison gets its own in-memory SQLite database with an FTS5 table that
 * uses the trigram tokenizer, so any substring of 3+ characters is an index lookup
 * (`oobar` finds `fooBar`). Nothing touches the disk, and an index is rebuilt from
 * `git diff` whenever it is missing or the diff changed.
 */

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Changed lines indexed per comparison; the rest of a huge diff is left out (`partial`). */
const MAX_ROWS = 200_000;
/** Characters indexed per comparison, for the same reason (trigram indexes are ~3× the text). */
const MAX_CHARS = 32_000_000;
/** Longer lines (minified code, data) are indexed up to this many characters. */
const MAX_LINE = 2_000;
/** Text sent back per hit: a window around the first match. */
const SNIPPET = 240;
/** Comparisons kept indexed at once (e.g. the one on screen plus a couple just left). */
const CACHED_INDEXES = 3;
export const MAX_HITS = 500;

// ---------------------------------------------------------------------------
// Patch parsing
// ---------------------------------------------------------------------------

export interface PatchRow {
  readonly path: string;
  readonly side: "old" | "new";
  readonly line: number;
  readonly text: string;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/** Undo git's C-style quoting of a path (`"a/x\"y"`), octal escapes included. */
export function unquotePath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) return raw;
  const bytes: number[] = [];
  const body = raw.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== "\\") {
      bytes.push(...new TextEncoder().encode(c));
      continue;
    }
    const next = body[++i] ?? "";
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(i, i + 3), 8));
      i += 2;
    } else {
      bytes.push(ESCAPES[next] ?? next.charCodeAt(0));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** The path from a `--- a/x` / `+++ b/x` header line, or null for `/dev/null`. */
function headerPath(rest: string, prefix: "a/" | "b/"): string | null {
  // git appends a TAB when an unquoted name contains a space; a real TAB would be quoted.
  const raw = rest.startsWith('"') ? unquotePath(rest) : rest.replace(/\t$/, "");
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : null;
}

/**
 * Split a `git diff -U0` patch into its changed lines. Hunk bodies are consumed by
 * the counts in their `@@` header, never by prefix: a removed line `-- x` prints
 * as `--- x`, which would otherwise look like the next file's header.
 */
export function parsePatch(patch: string): Array<PatchRow> {
  const rows: Array<PatchRow> = [];
  const lines = patch.split("\n");
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i++]!;
    if (line.startsWith("diff --git ")) {
      oldPath = newPath = null;
    } else if (line.startsWith("--- ")) {
      oldPath = headerPath(line.slice(4), "a/");
    } else if (line.startsWith("+++ ")) {
      newPath = headerPath(line.slice(4), "b/");
    } else {
      const m = HUNK.exec(line);
      if (!m) continue;
      // `FileChange.path` is the head side, or the deleted path for deletions.
      const path = newPath ?? oldPath;
      let oldLine = Number(m[1]);
      let newLine = Number(m[3]);
      let oldLeft = m[2] === undefined ? 1 : Number(m[2]);
      let newLeft = m[4] === undefined ? 1 : Number(m[4]);
      while ((oldLeft > 0 || newLeft > 0) && i < lines.length) {
        const body = lines[i++]!;
        const text = body.slice(1);
        if (body.startsWith("\\")) continue; // "\ No newline at end of file"
        if (body.startsWith("-")) {
          if (path !== null) rows.push({ path, side: "old", line: oldLine, text });
          oldLine++;
          oldLeft--;
        } else if (body.startsWith("+")) {
          if (path !== null) rows.push({ path, side: "new", line: newLine, text });
          newLine++;
          newLeft--;
        } else {
          // Context (only with -U > 0): advances both sides, not a change.
          oldLine++;
          newLine++;
          oldLeft--;
          newLeft--;
        }
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

export class DiffIndex {
  private constructor(
    private readonly db: Database,
    readonly partial: boolean,
  ) {}

  static build(
    rows: ReadonlyArray<PatchRow>,
    { maxRows = MAX_ROWS, maxChars = MAX_CHARS }: { maxRows?: number; maxChars?: number } = {},
  ): DiffIndex {
    const db = new Database(":memory:");
    try {
      // path / side / line are stored, not tokenized: a path match would hit every line of the file.
      db.run(
        "CREATE VIRTUAL TABLE lines USING fts5(text, path UNINDEXED, side UNINDEXED, line UNINDEXED, tokenize = 'trigram')",
      );
      const insert = db.prepare("INSERT INTO lines (text, path, side, line) VALUES (?, ?, ?, ?)");
      let partial = false;
      db.transaction(() => {
        let chars = 0;
        for (const [n, row] of rows.entries()) {
          const text = row.text.length > MAX_LINE ? row.text.slice(0, MAX_LINE) : row.text;
          chars += text.length;
          if (n >= maxRows || chars > maxChars) {
            partial = true;
            break;
          }
          if (text.trim() !== "") insert.run(text, row.path, row.side, row.line);
        }
      })();
      insert.finalize();
      return new DiffIndex(db, partial);
    } catch (e) {
      db.close();
      throw e;
    }
  }

  /** Lines containing `query`, case-insensitively, file by file (by path) and in patch order within a file. */
  search(query: string, limit = MAX_HITS): { hits: Array<SearchHit>; total: number } {
    if (query === "") return { hits: [], total: 0 };
    // Trigrams need 3 characters. Inside a quoted FTS5 phrase every character is literal
    // (`%`, `_`, `*`, `-` …); only `"` itself is doubled. Shorter queries scan the table.
    const [where, param] =
      [...query].length >= 3
        ? ["lines MATCH ?", `"${query.replaceAll('"', '""')}"`]
        : ["instr(lower(text), lower(?)) > 0", query];
    const { total } = this.db.query<{ total: number }, [string]>(`SELECT count(*) AS total FROM lines WHERE ${where}`).get(param)!;
    const rows = this.db
      .query<{ path: string; side: "old" | "new"; line: number; text: string }, [string, number]>(
        `SELECT path, side, line, text FROM lines WHERE ${where} ORDER BY path, rowid LIMIT ?`,
      )
      .all(param, limit);
    return { hits: rows.map((r) => ({ ...r, text: snippet(r.text, query) })), total };
  }

  close(): void {
    this.db.close();
  }
}

/** The line, cut to a window around the first match when it is long. */
function snippet(text: string, query: string): string {
  if (text.length <= SNIPPET) return text;
  const at = Math.max(text.toLowerCase().indexOf(query.toLowerCase()), 0);
  const start = Math.max(0, Math.min(at - SNIPPET / 3, text.length - SNIPPET));
  return (start > 0 ? "…" : "") + text.slice(start, start + SNIPPET) + (start + SNIPPET < text.length ? "…" : "");
}

interface CacheEntry {
  readonly index: DiffIndex;
  /** Hash of the patch it was built from (moving comparisons are rebuilt when it changes). */
  readonly hash: string;
  /** Git left files out to stay under the line limit. */
  readonly partial: boolean;
}

/**
 * Least-recently-used indexes, one per comparison pair. Replacing or evicting an
 * entry closes its database, freeing the memory.
 */
class IndexCache {
  private readonly entries = new Map<string, CacheEntry>();
  constructor(private readonly capacity: number) {}

  get(key: string): CacheEntry | undefined {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry;
  }

  set(key: string, entry: CacheEntry): CacheEntry {
    const replaced = this.entries.get(key);
    this.entries.delete(key);
    this.entries.set(key, entry);
    if (replaced && replaced.index !== entry.index) replaced.index.close();
    for (const [k, old] of this.entries) {
      if (this.entries.size <= this.capacity) break;
      this.entries.delete(k);
      old.index.close();
    }
    return entry;
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** SQLite could not build the index (e.g. a build without FTS5). */
export class SearchError extends Schema.TaggedError<SearchError>()("SearchError", {
  message: Schema.String,
}) {}

export class DiffSearch extends Context.Service<
  DiffSearch,
  {
    search(base: string, head: string, query: string): Effect.Effect<SearchResponse, SearchError | InvalidRef | GitError>;
  }
>()("git-diff-view/server/DiffSearch") {
  static readonly layer = Layer.effect(
    DiffSearch,
    Effect.gen(function* () {
      const git = yield* Git;
      const cache = new IndexCache(CACHED_INDEXES);

      const search = Effect.fn("DiffSearch.search")(function* (baseRef: string, headRef: string, query: string) {
        const [base, head] = yield* Effect.all([git.resolve(baseRef), git.resolve(headRef)], { concurrency: 2 });
        // Two commit ids never change, so their index is reused as is. The working tree and
        // the index move, so their diff is re-read and the index rebuilt only if it changed.
        const key = `${base.sha}..${head.sha}`;
        const fixed = !isPseudoRev(base.sha) && !isPseudoRev(head.sha);
        let entry = cache.get(key);
        if (!entry || !fixed) {
          const p = yield* git.patch(base.sha, head.sha, MAX_ROWS);
          const hash = Bun.hash(p.patch).toString(36);
          // Look again: another search may have replaced (and closed) the entry while git ran.
          // From here on everything is synchronous, so no request can interleave.
          entry = cache.get(key);
          if (entry?.hash !== hash) {
            const index = yield* Effect.try({
              try: () => DiffIndex.build(parsePatch(p.patch)),
              catch: (e) => new SearchError({ message: `Couldn't build the search index: ${String(e)}` }),
            });
            entry = cache.set(key, { index, hash, partial: p.partial });
          }
        }
        const { hits, total } = entry.index.search(query);
        return { base, head, hits, total, partial: entry.partial || entry.index.partial } satisfies SearchResponse;
      });

      return DiffSearch.of({ search });
    }),
  );
}
