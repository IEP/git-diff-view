/**
 * "Search changes" for the Herdr mod: a literal, case-insensitive substring over the
 * changed lines of the whole comparison. The server indexes these lines in SQLite
 * FTS5; the mod has no SQLite, so it keeps the parsed lines (lower-cased once) and
 * scans them, which takes milliseconds even at the 200,000-line limit.
 */
import type { SearchHit } from "@/shared/api";
import { parsePatch } from "@/shared/gitText";

export const MAX_ROWS = 200_000;
export const MAX_HITS = 500;
const MAX_LINE = 2_000;
const SNIPPET = 240;

export interface SearchIndex {
  readonly rows: ReadonlyArray<SearchHit>;
  readonly lower: ReadonlyArray<string>;
  /** Changed lines were left out (over the limit). */
  readonly partial: boolean;
}

export function buildIndex(patch: string, partial: boolean): SearchIndex {
  const parsed = parsePatch(patch);
  const rows = parsed.slice(0, MAX_ROWS).map((r) => ({ ...r, text: r.text.slice(0, MAX_LINE) }));
  return { rows, lower: rows.map((r) => r.text.toLowerCase()), partial: partial || parsed.length > MAX_ROWS };
}

export interface SearchResult {
  readonly hits: ReadonlyArray<SearchHit>;
  readonly total: number;
  readonly partial: boolean;
}

export function search(index: SearchIndex, query: string): SearchResult {
  const q = query.toLowerCase();
  if (!q.trim()) return { hits: [], total: 0, partial: index.partial };
  const hits: Array<SearchHit> = [];
  let total = 0;
  for (let i = 0; i < index.rows.length; i++) {
    if (!index.lower[i]!.includes(q)) continue;
    total++;
    if (hits.length < MAX_HITS) {
      const r = index.rows[i]!;
      hits.push({ ...r, text: snippet(r.text, query) });
    }
  }
  return { hits, total, partial: index.partial };
}

/** The line, cut to a window around the first match when it is long. */
export function snippet(text: string, query: string): string {
  if (text.length <= SNIPPET) return text;
  const at = Math.max(text.toLowerCase().indexOf(query.toLowerCase()), 0);
  const start = Math.max(0, Math.min(at - SNIPPET / 3, text.length - SNIPPET));
  return (start > 0 ? "…" : "") + text.slice(start, start + SNIPPET) + (start + SNIPPET < text.length ? "…" : "");
}

/** Split text around case-insensitive matches, for highlighting: [plain, match, plain, match, …]. */
export function splitMatches(text: string, query: string): Array<string> {
  if (!query) return [text];
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const parts: Array<string> = [];
  let from = 0;
  for (let at = lower.indexOf(q); at >= 0; at = lower.indexOf(q, at + q.length)) {
    parts.push(text.slice(from, at), text.slice(at, at + q.length));
    from = at + q.length;
  }
  parts.push(text.slice(from));
  return parts;
}
