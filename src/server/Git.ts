import { Context, Effect, Layer, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { BunServices } from "@effect/platform-bun";
import { basename } from "node:path";
import type {
  ChangeStatus,
  CommitEntry,
  CompareResponse,
  FileChange,
  FileDiffResponse,
  RefEntry,
  RefsResponse,
  RepoInfo,
  ResolvedRef,
} from "@/shared/api";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class GitError extends Schema.TaggedError<GitError>()("GitError", {
  message: Schema.String,
  args: Schema.Array(Schema.String),
}) {}

export class InvalidRef extends Schema.TaggedError<InvalidRef>()("InvalidRef", {
  ref: Schema.String,
  message: Schema.String,
}) {}

export class NotARepository extends Schema.TaggedError<NotARepository>()("NotARepository", {
  path: Schema.String,
  message: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Files larger than this are not shipped to the browser in full. */
const MAX_BLOB_BYTES = 2 * 1024 * 1024;
const RECENT_COMMITS = 300;

/**
 * Every git invocation goes through this allow-list. The app is read-only by
 * construction: there is no code path that can run a mutating subcommand.
 * (`ls-remote` is only ever called with `--get-url`, which reads config.)
 *
 * The single exception is `fetchCommits`, which has its own fixed argument
 * list: it adds objects for pull-request commits and never touches any ref,
 * FETCH_HEAD, the index or the working tree.
 */
const READ_ONLY_SUBCOMMANDS = new Set([
  "rev-parse",
  "for-each-ref",
  "log",
  "diff",
  "ls-tree",
  "cat-file",
  "merge-base",
  "ls-remote",
]);

/** A full object id (SHA-1 or SHA-256). Anything from outside must match before git sees it. */
export const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const FETCH_TIMEOUT = "90 seconds";

/** Global flags prepended to every call: no pager, no colour, no external diff tools, no locks. */
const GLOBAL_ARGS = [
  "--no-pager",
  "--literal-pathspecs",
  "-c",
  "color.ui=never",
  "-c",
  "core.quotePath=off",
];

const GIT_ENV = {
  // Don't take optional locks (e.g. refreshing the index) - we never write.
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class Git extends Context.Service<
  Git,
  {
    readonly info: Effect.Effect<RepoInfo, GitError>;
    readonly refs: Effect.Effect<RefsResponse, GitError>;
    resolve(ref: string): Effect.Effect<ResolvedRef, InvalidRef | GitError>;
    compare(base: string, head: string): Effect.Effect<CompareResponse, InvalidRef | GitError>;
    fileDiff(
      base: string,
      head: string,
      path: string,
      oldPath: string | null,
    ): Effect.Effect<FileDiffResponse, InvalidRef | GitError>;
    /** The URL configured for `remote` (after insteadOf rewriting), or null if there is no such remote. */
    remoteUrl(remote: string): Effect.Effect<string | null, GitError>;
    hasCommit(sha: string): Effect.Effect<boolean>;
    mergeBase(a: string, b: string): Effect.Effect<string, GitError>;
    /** Download commits by id from `remote` without creating or moving any ref. */
    fetchCommits(remote: string, shas: ReadonlyArray<string>): Effect.Effect<void, GitError>;
  }
>()("git-diff-view/server/Git") {
  /** Build the service for the repository containing `repoPath`. */
  static readonly layer = (repoPath: string) =>
    Layer.effect(
      Git,
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

        /** Spawn git without the allow-list check. Only `runIn` and `fetchCommits` call this. */
        const spawnGit = Effect.fnUntraced(function* (cwd: string, args: ReadonlyArray<string>) {
          const fullArgs = [...GLOBAL_ARGS, ...args];
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* spawner.spawn(
                ChildProcess.make("git", fullArgs, { cwd, env: GIT_ENV, extendEnv: true }),
              );
              const [stdout, stderr, exitCode] = yield* Effect.all(
                [
                  Stream.mkString(Stream.decodeText(handle.stdout)),
                  Stream.mkString(Stream.decodeText(handle.stderr)),
                  handle.exitCode,
                ],
                { concurrency: "unbounded" },
              );
              if (Number(exitCode) !== 0) {
                return yield* new GitError({
                  message: stderr.trim() || `git exited with code ${exitCode}`,
                  args: [...args],
                });
              }
              return stdout;
            }),
          ).pipe(
            Effect.catchTag("PlatformError", (cause) =>
              Effect.fail(new GitError({ message: `Failed to run git: ${cause.message}`, args: [...args] })),
            ),
          );
        });

        const runIn = Effect.fnUntraced(function* (cwd: string, args: ReadonlyArray<string>) {
          const sub = args[0];
          if (sub === undefined || !READ_ONLY_SUBCOMMANDS.has(sub)) {
            return yield* new GitError({ message: `Refusing to run git subcommand "${sub}"`, args: [...args] });
          }
          return yield* spawnGit(cwd, args);
        });

        // Resolve the repository root once, at startup.
        const root = (yield* runIn(repoPath, ["rev-parse", "--show-toplevel"]).pipe(
          Effect.mapError(
            (e) => new NotARepository({ path: repoPath, message: `Not a git repository: ${repoPath} (${e.message})` }),
          ),
        )).trim();

        const git = (...args: ReadonlyArray<string>) => runIn(root, args);

        // -------------------------------------------------------------------
        // info / refs
        // -------------------------------------------------------------------

        const info = Effect.gen(function* () {
          const branch = yield* git("rev-parse", "--abbrev-ref", "HEAD").pipe(
            Effect.map((s) => s.trim()),
            Effect.orElseSucceed(() => "HEAD"),
          );
          const headSha = yield* git("rev-parse", "--verify", "--quiet", "HEAD^{commit}").pipe(
            Effect.map((s) => s.trim() || null),
            Effect.orElseSucceed(() => null),
          );
          return {
            root,
            name: basename(root),
            currentBranch: branch === "HEAD" ? null : branch,
            headSha,
          } satisfies RepoInfo;
        });

        const refs = Effect.gen(function* () {
          const [refLines, logOut] = yield* Effect.all(
            [
              git(
                "for-each-ref",
                "--sort=-committerdate",
                "--format=%(refname)%00%(objectname)%00%(*objectname)%00%(subject)",
                "refs/heads",
                "refs/remotes",
                "refs/tags",
              ),
              // An empty repository has no commits: treat that as an empty log.
              git("log", "--all", "--date-order", `-n${RECENT_COMMITS}`, "--format=%H%x00%h%x00%s%x00%an%x00%aI").pipe(
                Effect.orElseSucceed(() => ""),
              ),
            ],
            { concurrency: 2 },
          );

          const branches: Array<RefEntry> = [];
          const remoteBranches: Array<RefEntry> = [];
          const tags: Array<RefEntry> = [];
          for (const line of refLines.split("\n")) {
            if (!line) continue;
            const [refname = "", sha = "", peeled = "", subject = ""] = line.split("\0");
            if (refname.startsWith("refs/heads/")) {
              branches.push({ name: refname.slice("refs/heads/".length), sha, subject });
            } else if (refname.startsWith("refs/remotes/")) {
              if (refname.endsWith("/HEAD")) continue; // origin/HEAD symref is noise
              remoteBranches.push({ name: refname.slice("refs/remotes/".length), sha, subject });
            } else if (refname.startsWith("refs/tags/")) {
              // Annotated tags point at a tag object; `*objectname` is the commit.
              tags.push({ name: refname.slice("refs/tags/".length), sha: peeled || sha, subject });
            }
          }

          const commits: Array<CommitEntry> = [];
          for (const line of logOut.split("\n")) {
            if (!line) continue;
            const [sha = "", shortSha = "", subject = "", author = "", date = ""] = line.split("\0");
            commits.push({ sha, shortSha, subject, author, date });
          }

          return { branches, remoteBranches, tags, commits } satisfies RefsResponse;
        });

        // -------------------------------------------------------------------
        // ref resolution
        // -------------------------------------------------------------------

        const resolve = Effect.fn("Git.resolve")(function* (ref: string) {
          const trimmed = ref.trim();
          // A leading "-" would be parsed as an option; control chars / whitespace
          // never appear in valid revisions. Reject before git sees it.
          if (trimmed === "" || trimmed.length > 256 || trimmed.startsWith("-") || /[\s\x00-\x1f\x7f]/.test(trimmed)) {
            return yield* new InvalidRef({ ref, message: `Invalid revision: "${ref}"` });
          }
          const sha = yield* git("rev-parse", "--verify", "--end-of-options", `${trimmed}^{commit}`).pipe(
            Effect.map((s) => s.trim()),
            Effect.mapError(() => new InvalidRef({ ref, message: `Unknown revision: "${ref}"` })),
          );
          return { ref: trimmed, sha } satisfies ResolvedRef;
        });

        // -------------------------------------------------------------------
        // compare
        // -------------------------------------------------------------------

        const diffFlags = ["--no-color", "--no-ext-diff", "--no-textconv", "-M"] as const;

        const compare = Effect.fn("Git.compare")(function* (baseRef: string, headRef: string) {
          const [base, head] = yield* Effect.all([resolve(baseRef), resolve(headRef)], { concurrency: 2 });
          const [nameStatus, numstat] = yield* Effect.all(
            [
              git("diff", ...diffFlags, "--name-status", "-z", base.sha, head.sha),
              git("diff", ...diffFlags, "--numstat", "-z", base.sha, head.sha),
            ],
            { concurrency: 2 },
          );
          const stats = parseNumstat(numstat);
          const files = parseNameStatus(nameStatus).map((f): FileChange => {
            const s = stats.get(f.path);
            return {
              ...f,
              additions: s?.additions ?? 0,
              deletions: s?.deletions ?? 0,
              binary: s?.binary ?? false,
            };
          });
          files.sort((a, b) => a.path.localeCompare(b.path));
          return { base, head, files } satisfies CompareResponse;
        });

        // -------------------------------------------------------------------
        // single file
        // -------------------------------------------------------------------

        /** Read a blob if it exists at `sha:path`. Returns null when missing or not a regular blob. */
        const readBlob = Effect.fnUntraced(function* (sha: string, path: string) {
          // `ls-tree -l` tells us existence, object type and size in one call.
          const entry = yield* git("ls-tree", "-z", "-l", "--full-tree", sha, "--", path);
          const record = entry.split("\0").find((r) => r.length > 0);
          if (!record) return { content: null, tooLarge: false } as const;
          const tab = record.indexOf("\t");
          const [, type, objectId, size] = record.slice(0, tab).split(/\s+/);
          if (type !== "blob" || !objectId) return { content: null, tooLarge: false } as const;
          if (Number(size) > MAX_BLOB_BYTES) return { content: null, tooLarge: true } as const;
          const content = yield* git("cat-file", "blob", objectId);
          return { content, tooLarge: false } as const;
        });

        const fileDiff = Effect.fn("Git.fileDiff")(function* (
          baseRef: string,
          headRef: string,
          path: string,
          oldPath: string | null,
        ) {
          const [base, head] = yield* Effect.all([resolve(baseRef), resolve(headRef)], { concurrency: 2 });
          const before = oldPath ?? path;
          const pathspec = before === path ? [path] : [before, path];

          const [patch, oldBlob, newBlob] = yield* Effect.all(
            [
              git("diff", ...diffFlags, "--full-index", base.sha, head.sha, "--", ...pathspec),
              readBlob(base.sha, before),
              readBlob(head.sha, path),
            ],
            { concurrency: 3 },
          );

          const binary =
            /^Binary files .* differ$/m.test(patch) ||
            looksBinary(oldBlob.content) ||
            looksBinary(newBlob.content);
          const tooLarge = oldBlob.tooLarge || newBlob.tooLarge;
          const shipContent = !binary && !tooLarge;

          return {
            patch,
            oldContent: shipContent ? oldBlob.content : null,
            newContent: shipContent ? newBlob.content : null,
            binary,
            tooLarge,
          } satisfies FileDiffResponse;
        });

        // -------------------------------------------------------------------
        // remotes / pull-request support
        // -------------------------------------------------------------------

        const remoteUrl = Effect.fn("Git.remoteUrl")(function* (remote: string) {
          // `--get-url` echoes its argument back when no such remote exists.
          const url = (yield* git("ls-remote", "--get-url", "--end-of-options", remote)).trim();
          return url === "" || url === remote ? null : url;
        });

        const hasCommit = (sha: string) =>
          OBJECT_ID.test(sha)
            ? git("cat-file", "-e", `${sha}^{commit}`).pipe(
                Effect.as(true),
                Effect.orElseSucceed(() => false),
              )
            : Effect.succeed(false);

        const mergeBase = Effect.fn("Git.mergeBase")(function* (a: string, b: string) {
          if (!OBJECT_ID.test(a) || !OBJECT_ID.test(b)) {
            return yield* new GitError({ message: "merge-base expects full commit ids", args: [a, b] });
          }
          return (yield* git("merge-base", a, b)).trim();
        });

        const fetchCommits = Effect.fn("Git.fetchCommits")(function* (remote: string, shas: ReadonlyArray<string>) {
          if (!/^[A-Za-z0-9._-]+$/.test(remote) || remote.startsWith("-") || shas.some((s) => !OBJECT_ID.test(s))) {
            return yield* new GitError({ message: "Refusing to fetch: invalid remote or commit id", args: [remote, ...shas] });
          }
          if (shas.length === 0) return;
          const args = [
            "-c", "gc.auto=0",
            "-c", "maintenance.auto=false",
            "fetch",
            "--quiet",
            "--no-tags",
            "--no-recurse-submodules",
            "--no-write-fetch-head",
            // No destination in the refspecs and an empty refmap: nothing under refs/ is created or updated.
            "--refmap=",
            "--end-of-options",
            remote,
            ...shas,
          ];
          yield* spawnGit(root, args).pipe(
            Effect.timeoutOrElse({
              duration: FETCH_TIMEOUT,
              orElse: () => Effect.fail(new GitError({ message: `git fetch from "${remote}" timed out`, args })),
            }),
          );
        });

        return Git.of({ info, refs, resolve, compare, fileDiff, remoteUrl, hasCommit, mergeBase, fetchCommits });
      }),
    ).pipe(Layer.provide(BunServices.layer));
}

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
export function parseNumstat(out: string): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const tokens = out.split("\0");
  const result = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  let i = 0;
  while (i < tokens.length) {
    const record = tokens[i++];
    if (!record) continue;
    const [added = "", deleted = "", inlinePath = ""] = record.split("\t");
    let path = inlinePath;
    if (path === "") {
      i++; // skip old path
      path = tokens[i++] ?? "";
    }
    const binary = added === "-" && deleted === "-";
    result.set(path, {
      additions: binary ? 0 : Number(added) || 0,
      deletions: binary ? 0 : Number(deleted) || 0,
      binary,
    });
  }
  return result;
}

/** Same heuristic git uses: a NUL byte in the first 8000 bytes means binary. */
function looksBinary(content: string | null): boolean {
  return content !== null && content.slice(0, 8000).includes("\0");
}
