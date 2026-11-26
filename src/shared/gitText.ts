/** Pure helpers for reading git's output: no I/O, no Effect. Used by the server's services. */
import { INDEX, WORKTREE } from "@/shared/api";
import type { ChangeStatus, FileChange, GraphCommit, GraphRef } from "@/shared/api";

/** A full object id (SHA-1 or SHA-256). Anything from outside must match before git sees it. */
export const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// ---------------------------------------------------------------------------
// Parsers for `git diff -z` output
// ---------------------------------------------------------------------------

const STATUS_BY_LETTER: Record<string, ChangeStatus> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "typechange",
};

/**
 * `--name-status -z` emits NUL-separated tokens:
 *   `M\0path\0`  or  `R087\0old\0new\0` (renames/copies carry two paths).
 */
export function parseNameStatus(out: string): Array<Omit<FileChange, "additions" | "deletions" | "binary">> {
  const tokens = out.split("\0");
  const result: Array<Omit<FileChange, "additions" | "deletions" | "binary">> = [];
  let i = 0;
  while (i < tokens.length) {
    const code = tokens[i++];
    if (!code) continue;
    const letter = code[0]!;
    const status = STATUS_BY_LETTER[letter] ?? "unknown";
    if (letter === "R" || letter === "C") {
      const oldPath = tokens[i++] ?? "";
      const path = tokens[i++] ?? "";
      const score = Number.parseInt(code.slice(1), 10);
      result.push({ status, path, oldPath, similarity: Number.isNaN(score) ? null : score });
    } else {
      const path = tokens[i++] ?? "";
      result.push({ status, path, oldPath: null, similarity: null });
    }
  }
  return result;
}

/**
 * `--numstat -z` emits `added\tdeleted\tpath\0`, or for renames
 * `added\tdeleted\t\0old\0new\0`. Binary files report `-\t-`.
 * Keyed by the head-side path.
 */
export interface NumstatEntry {
  readonly additions: number;
  readonly deletions: number;
  readonly binary: boolean;
  /** The base-side path of a rename or copy. */
  readonly oldPath: string | null;
}

/** `git diff --numstat -z` keyed by head-side path, in git's order. */
export function parseNumstat(out: string): Map<string, NumstatEntry> {
  const tokens = out.split("\0");
  const result = new Map<string, NumstatEntry>();
  let i = 0;
  while (i < tokens.length) {
    const record = tokens[i++];
    if (!record) continue;
    const [added = "", deleted = "", inlinePath = ""] = record.split("\t");
    let path = inlinePath;
    let oldPath: string | null = null;
    if (path === "") {
      oldPath = tokens[i++] ?? null;
      path = tokens[i++] ?? "";
    }
    const binary = added === "-" && deleted === "-";
    result.set(path, {
      additions: binary ? 0 : Number(added) || 0,
      deletions: binary ? 0 : Number(deleted) || 0,
      binary,
      oldPath,
    });
  }
  return result;
}

/**
 * Parse `git log --decorate=full --format=%H%x00%P%x00%D%x00%s%x00%an%x00%aI%x1e`.
 * Records end with RS (0x1e); a subject can't contain NUL or RS.
 */
export function parseGraphLog(out: string): Array<GraphCommit> {
  const commits: Array<GraphCommit> = [];
  for (const raw of out.split("\x1e")) {
    const record = raw.replace(/^\n/, "");
    if (!record) continue;
    const [sha = "", parents = "", decorations = "", subject = "", author = "", date = ""] = record.split("\0");
    if (!sha) continue;
    commits.push({
      sha,
      shortSha: sha.slice(0, 7),
      parents: parents ? parents.split(" ") : [],
      refs: parseDecorations(decorations),
      subject,
      author,
      date,
    });
  }
  return commits;
}

/** `%D` with `--decorate=full`: "HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1". */
export function parseDecorations(decorations: string): Array<GraphRef> {
  const refs: Array<GraphRef> = [];
  for (const part of decorations.split(", ")) {
    if (!part) continue;
    let name = part;
    if (name.startsWith("HEAD -> ")) {
      refs.push({ kind: "head", name: "HEAD" });
      name = name.slice("HEAD -> ".length);
    } else if (name === "HEAD") {
      refs.push({ kind: "head", name: "HEAD" });
      continue;
    }
    if (name.startsWith("tag: ")) name = name.slice("tag: ".length);
    if (name.startsWith("refs/heads/")) {
      refs.push({ kind: "branch", name: name.slice("refs/heads/".length) });
    } else if (name.startsWith("refs/remotes/")) {
      if (name.endsWith("/HEAD")) continue; // origin/HEAD symref is noise
      refs.push({ kind: "remote", name: name.slice("refs/remotes/".length) });
    } else if (name.startsWith("refs/tags/")) {
      refs.push({ kind: "tag", name: name.slice("refs/tags/".length) });
    }
  }
  return refs;
}

/** Same heuristic git uses: a NUL byte in the first 8000 bytes means binary. */
export function looksBinary(content: string | null): boolean {
  return content !== null && content.slice(0, 8000).includes("\0");
}

export function lineCount(content: string | null): number {
  if (!content) return 0;
  const n = content.split("\n").length;
  return content.endsWith("\n") ? n - 1 : n;
}

// ---------------------------------------------------------------------------
// Uncommitted state
// ---------------------------------------------------------------------------

/** One end of a comparison: a commit, the index, or the working tree. */
export type Side = { readonly kind: "commit"; readonly sha: string } | { readonly kind: "index" } | { readonly kind: "worktree" };

export const sideOf = (rev: string): Side =>
  rev === WORKTREE ? { kind: "worktree" } : rev === INDEX ? { kind: "index" } : { kind: "commit", sha: rev };

const LEVEL = { commit: 0, index: 1, worktree: 2 } as const;

/**
 * The revision arguments for `git diff` that compare `base` → `head`, or null
 * when both are the same uncommitted state (nothing to compare). git can only
 * diff "older" → "newer" (commit → index → working tree), so a swapped pair
 * uses `-R`.
 */
export function diffRange(base: Side, head: Side): ReadonlyArray<string> | null {
  if (base.kind === "commit" && head.kind === "commit") return [base.sha, head.sha];
  if (base.kind === head.kind) return null;
  const reversed = LEVEL[base.kind] > LEVEL[head.kind];
  const [lo, hi] = reversed ? [head, base] : [base, head];
  const flags = reversed ? ["-R"] : [];
  if (lo.kind === "commit") return hi.kind === "index" ? [...flags, "--cached", lo.sha] : [...flags, lo.sha];
  return flags; // index → working tree: plain `git diff`
}

/** A normalized path relative to the repository root, as git prints it: no `..`, `.`, empty or absolute parts. */
export const isRepoPath = (path: string): boolean =>
  path !== "" &&
  path.length <= 4096 &&
  !path.startsWith("/") &&
  !/[\x00]/.test(path) &&
  path.split("/").every((s) => s !== "" && s !== "." && s !== "..");

/** A unified diff adding (or deleting) a whole file, as `git diff` would print it for a new file. */
export function untrackedPatch(path: string, content: string | null, mode: string, kind: "added" | "deleted"): string {
  const added = kind === "added";
  let patch = `diff --git a/${path} b/${path}\n${added ? "new" : "deleted"} file mode ${mode}\n`;
  if (content === null || content === "") return patch;
  if (looksBinary(content)) {
    return patch + (added ? `Binary files /dev/null and b/${path} differ\n` : `Binary files a/${path} and /dev/null differ\n`);
  }
  const lines = content.split("\n");
  const endsWithNewline = content.endsWith("\n");
  if (endsWithNewline) lines.pop();
  const span = lines.length === 1 ? "1" : `1,${lines.length}`;
  patch += added ? `--- /dev/null\n+++ b/${path}\n@@ -0,0 +${span} @@\n` : `--- a/${path}\n+++ /dev/null\n@@ -${span} +0,0 @@\n`;
  const sign = added ? "+" : "-";
  patch += lines.map((l) => sign + l).join("\n") + "\n";
  if (!endsWithNewline) patch += "\\ No newline at end of file\n";
  return patch;
}

// ---------------------------------------------------------------------------
// Whole-patch parsing (search)
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
      const cp = body.codePointAt(i)!;
      if (cp > 0xffff) i++; // the low surrogate is part of this code point
      // A lone surrogate encodes as U+FFFD.
      bytes.push(...utf8.encode(String.fromCodePoint(cp)));
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
  // Each malformed sequence (from octal escapes) becomes U+FFFD.
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

const utf8 = new TextEncoder();

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
// GitHub remotes
// ---------------------------------------------------------------------------

const SEGMENT = /^[A-Za-z0-9_.-]+$/;

/**
 * Extract owner/name from a github.com remote URL. Accepts
 *   git@github.com:owner/repo(.git)
 *   https://[user[:token]@]github.com/owner/repo(.git)(/)
 *   ssh://git@github.com[:22]/owner/repo(.git)
 *   git://github.com/owner/repo
 * Returns null for anything else, including GitHub Enterprise hosts.
 */
export function parseGitHubRemote(url: string): { owner: string; name: string } | null {
  let path: string;
  const scp = /^[\w.-]+@github\.com:(.+)$/i.exec(url);
  if (scp) {
    path = scp[1]!;
  } else {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (!["https:", "http:", "ssh:", "git:", "git+ssh:"].includes(parsed.protocol)) return null;
    if (parsed.hostname.toLowerCase() !== "github.com") return null;
    path = decodeURIComponent(parsed.pathname);
  }
  const parts = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts as [string, string];
  if (!SEGMENT.test(owner) || !SEGMENT.test(name) || name === "." || name === "..") return null;
  return { owner, name };
}

