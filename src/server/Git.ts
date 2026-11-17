import { Context, Effect, Layer, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { BunServices } from "@effect/platform-bun";
import { lstat, readlink, realpath } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { INDEX, isPseudoRev, WORKTREE } from "@/shared/api";
import {
  diffRange,
  isRepoPath,
  lineCount,
  looksBinary,
  OBJECT_ID,
  parseGraphLog,
  parseNameStatus,
  parseNumstat,
  sideOf,
  untrackedPatch,
  type NumstatEntry,
} from "@/shared/gitText";
import type {
  ChangeStatus,
  CommitEntry,
  CompareResponse,
  FileChange,
  FileDiffResponse,
  GraphCommit,
  GraphRef,
  GraphResponse,
  RefEntry,
  RefsResponse,
  RepoInfo,
  ResolvedRef,
} from "@/shared/api";

export interface PatchResponse {
  readonly base: ResolvedRef;
  readonly head: ResolvedRef;
  readonly patch: string;
  /** Some files were left out to stay under the line limit. */
  readonly partial: boolean;
}

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
/** Untracked files listed in a working-tree comparison, at most. */
const MAX_UNTRACKED = 2000;
export const MAX_GRAPH_COMMITS = 5000;
/** Paths named on one `git diff` command line when a search diff is cut down (argv size). */
const MAX_PATHSPEC = 5000;

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
  "ls-files",
]);


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
    /** Commit graph of every branch, remote branch, tag and HEAD, newest first. */
    graph(limit: number): Effect.Effect<GraphResponse, GitError>;
    resolve(ref: string): Effect.Effect<ResolvedRef, InvalidRef | GitError>;
    compare(base: string, head: string): Effect.Effect<CompareResponse, InvalidRef | GitError>;
    fileDiff(
      base: string,
      head: string,
      path: string,
      oldPath: string | null,
    ): Effect.Effect<FileDiffResponse, InvalidRef | GitError>;
    /**
     * The whole comparison as one zero-context patch (`git diff -U0`), plus all-added
     * (or all-deleted) patches for untracked files when one side is the working tree.
     * Paths always carry `a/` / `b/` prefixes, whatever the user's diff config says.
     * Stops at about `maxLines` changed lines, deciding from `--numstat` before reading
     * any patch text, so a huge comparison is never buffered whole (`partial` is set).
     */
    patch(base: string, head: string, maxLines: number): Effect.Effect<PatchResponse, InvalidRef | GitError>;
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
          const uncommitted = headSha
            ? yield* Effect.all([git("diff", "--name-only", "-z", "HEAD"), untrackedFiles], { concurrency: 2 }).pipe(
                Effect.map(([changed, untracked]) => {
                  const paths = new Set(changed.split("\0").filter(Boolean));
                  for (const p of untracked) paths.add(p);
                  return paths.size;
                }),
                Effect.orElseSucceed(() => 0),
              )
            : 0;
          return {
            root,
            name: basename(root),
            currentBranch: branch === "HEAD" ? null : branch,
            headSha,
            uncommitted,
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

        const graph = Effect.fn("Git.graph")(function* (limit: number) {
          const n = Math.min(Math.max(Math.trunc(limit), 1), MAX_GRAPH_COMMITS);
          const out = yield* git(
            "log",
            // Not --all: that would pull in refs/stash and its synthetic index/worktree commits.
            "--branches",
            "--remotes",
            "--tags",
            "HEAD",
            "--date-order",
            "--decorate=full",
            `-n${n + 1}`, // one extra row tells us whether history continues
            "--format=%H%x00%P%x00%D%x00%s%x00%an%x00%aI%x1e",
            "--",
          ).pipe(Effect.orElseSucceed(() => "")); // empty repository: no HEAD yet
          const commits = parseGraphLog(out);
          const truncated = commits.length > n;
          return { commits: truncated ? commits.slice(0, n) : commits, truncated } satisfies GraphResponse;
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
          if (isPseudoRev(trimmed)) return { ref: trimmed, sha: trimmed } satisfies ResolvedRef;
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

        /** Untracked, non-ignored files (not directories such as nested repositories). */
        const untrackedFiles = git("ls-files", "-z", "--others", "--exclude-standard").pipe(
          Effect.map((out) => out.split("\0").filter((p) => p !== "" && !p.endsWith("/"))),
        );

        const compare = Effect.fn("Git.compare")(function* (baseRef: string, headRef: string) {
          const [base, head] = yield* Effect.all([resolve(baseRef), resolve(headRef)], { concurrency: 2 });
          const range = diffRange(sideOf(base.sha), sideOf(head.sha));
          const [nameStatus, numstat] =
            range === null
              ? ["", ""]
              : yield* Effect.all(
                  [
                    git("diff", ...diffFlags, "--name-status", "-z", ...range),
                    git("diff", ...diffFlags, "--numstat", "-z", ...range),
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

          // `git diff` never reports untracked files: they exist only on the working-tree side.
          if ((base.sha === WORKTREE) !== (head.sha === WORKTREE)) {
            const status = head.sha === WORKTREE ? "added" : "deleted";
            const seen = new Set(files.map((f) => f.path));
            const untracked = (yield* untrackedFiles).filter((p) => !seen.has(p)).slice(0, MAX_UNTRACKED);
            const extra = yield* Effect.forEach(
              untracked,
              (path) =>
                readWorktreeFile(path).pipe(
                  Effect.map((file): FileChange => {
                    const binary = looksBinary(file.content);
                    const lines = binary ? 0 : lineCount(file.content);
                    return {
                      status,
                      path,
                      oldPath: null,
                      similarity: null,
                      additions: status === "added" ? lines : 0,
                      deletions: status === "deleted" ? lines : 0,
                      binary,
                    };
                  }),
                ),
              { concurrency: 8 },
            );
            files.push(...extra);
          }

          files.sort((a, b) => a.path.localeCompare(b.path));
          return { base, head, files } satisfies CompareResponse;
        });

        const patch = Effect.fn("Git.patch")(function* (baseRef: string, headRef: string, maxLines: number) {
          const [base, head] = yield* Effect.all([resolve(baseRef), resolve(headRef)], { concurrency: 2 });
          const range = diffRange(sideOf(base.sha), sideOf(head.sha));
          const stats = parseNumstat(range === null ? "" : yield* git("diff", ...diffFlags, "--numstat", "-z", ...range));

          // Over the limit: diff only the files that fit, named by pathspec (both sides of a rename).
          let budget = maxLines;
          let partial = false;
          let pathspec: Array<string> | null = null;
          const changed = (s: NumstatEntry) => s.additions + s.deletions;
          if ([...stats.values()].reduce((n, s) => n + changed(s), 0) > maxLines) {
            pathspec = [];
            partial = true;
            for (const [path, s] of stats) {
              if (changed(s) === 0 || changed(s) > budget || pathspec.length >= MAX_PATHSPEC) continue;
              budget -= changed(s);
              pathspec.push(path, ...(s.oldPath ? [s.oldPath] : []));
            }
          } else {
            budget -= [...stats.values()].reduce((n, s) => n + changed(s), 0);
          }
          const tracked =
            range === null || pathspec?.length === 0
              ? ""
              : yield* git(
                  "diff", ...diffFlags, "-U0", "--src-prefix=a/", "--dst-prefix=b/", ...range,
                  ...(pathspec ? ["--", ...pathspec] : []),
                );

          let text = tracked;
          if ((base.sha === WORKTREE) !== (head.sha === WORKTREE)) {
            const kind = head.sha === WORKTREE ? "added" : "deleted";
            // A path git already diffs (e.g. after `git rm --cached`) keeps git's version, as in `compare`.
            const untracked = (yield* untrackedFiles).filter((p) => !stats.has(p)).slice(0, MAX_UNTRACKED);
            const files = yield* Effect.forEach(untracked, (path) => Effect.map(readWorktreeFile(path), (file) => ({ path, file })), {
              concurrency: 8,
            });
            for (const { path, file } of files) {
              if (file.tooLarge || looksBinary(file.content)) continue;
              const lines = lineCount(file.content);
              if (lines > budget) {
                partial = true;
                continue;
              }
              budget -= lines;
              text += untrackedPatch(path, file.content, file.mode, kind);
            }
          }
          return { base, head, patch: text, partial } satisfies PatchResponse;
        });

        // -------------------------------------------------------------------
        // single file
        // -------------------------------------------------------------------

        /** Read a blob if it exists at `sha:path`. Returns null when missing or not a regular blob. */
        const readBlob = Effect.fnUntraced(function* (sha: string, path: string) {
          // `ls-tree -l` tells us existence, object type and size in one call.
          const entry = yield* git("ls-tree", "-z", "-l", "--full-tree", sha, "--", path);
          const record = entry.split("\0").find((r) => r.length > 0);
          if (!record) return NO_BLOB;
          const tab = record.indexOf("\t");
          const [, type, objectId, size] = record.slice(0, tab).split(/\s+/);
          if (type !== "blob" || !objectId) return NO_BLOB;
          if (Number(size) > MAX_BLOB_BYTES) return { content: null, tooLarge: true } as const;
          const content = yield* git("cat-file", "blob", objectId);
          return { content, tooLarge: false } as const;
        });

        /** The stage-0 index entry for `path` (none while it has merge conflicts). */
        const readIndexBlob = Effect.fnUntraced(function* (path: string) {
          const out = yield* git("ls-files", "-z", "--stage", "--", path);
          const record = out.split("\0").find((r) => r.endsWith(`\t${path}`) && r.split("\t")[0]!.endsWith(" 0"));
          if (!record) return NO_BLOB;
          const [mode, objectId] = record.split("\t")[0]!.split(" ");
          if (mode === "160000" || !objectId) return NO_BLOB; // submodule
          const size = Number((yield* git("cat-file", "-s", objectId)).trim());
          if (size > MAX_BLOB_BYTES) return { content: null, tooLarge: true } as const;
          return { content: yield* git("cat-file", "blob", objectId), tooLarge: false } as const;
        });

        const rootReal = yield* Effect.promise(() => realpath(root));

        /**
         * Read `path` from the working tree as git would see it. Callers make sure
         * git lists the path; this also refuses anything reached through a
         * symlinked directory, and never follows a symlink itself.
         */
        const readWorktreeFile = (path: string) =>
          Effect.promise(() => readDisk(rootReal, path));

        /** Only paths git tracks or would offer to add: never `.git/*`, ignored files or `..`. */
        const isListed = (path: string, ...which: ReadonlyArray<string>) =>
          git("ls-files", "-z", ...which, "--", path).pipe(Effect.map((out) => out.split("\0").includes(path)));

        const readSide = Effect.fnUntraced(function* (rev: string, path: string) {
          if (rev === INDEX) return yield* readIndexBlob(path);
          if (rev === WORKTREE) {
            if (!(yield* isListed(path, "--cached", "--others", "--exclude-standard"))) return NO_BLOB;
            return yield* readWorktreeFile(path);
          }
          return yield* readBlob(rev, path);
        });

        const fileDiff = Effect.fn("Git.fileDiff")(function* (
          baseRef: string,
          headRef: string,
          path: string,
          oldPath: string | null,
        ) {
          for (const p of [path, oldPath]) {
            if (p !== null && !isRepoPath(p)) return yield* new InvalidRef({ ref: p, message: `Invalid path: "${p}"` });
          }
          const [base, head] = yield* Effect.all([resolve(baseRef), resolve(headRef)], { concurrency: 2 });
          const before = oldPath ?? path;
          const pathspec = before === path ? [path] : [before, path];

          const range = diffRange(sideOf(base.sha), sideOf(head.sha));
          const gitPatch =
            range === null ? "" : yield* git("diff", ...diffFlags, "--full-index", ...range, "--", ...pathspec);

          // An untracked file has no diff from git: build the all-added (or all-deleted) patch here.
          // (After `git rm --cached` git does report it, as deleted; keep that, like the file list.)
          if (
            gitPatch === "" &&
            (base.sha === WORKTREE) !== (head.sha === WORKTREE) &&
            oldPath === null &&
            (yield* isListed(path, "--others", "--exclude-standard"))
          ) {
            const file = yield* readWorktreeFile(path);
            const added = head.sha === WORKTREE;
            const binary = looksBinary(file.content);
            const content = binary || file.tooLarge ? null : file.content;
            return {
              patch: untrackedPatch(path, file.content, file.mode, added ? "added" : "deleted"),
              oldContent: added ? null : content,
              newContent: added ? content : null,
              binary,
              tooLarge: file.tooLarge,
            } satisfies FileDiffResponse;
          }

          const patch = gitPatch;
          const [oldBlob, newBlob] = yield* Effect.all([readSide(base.sha, before), readSide(head.sha, path)], {
            concurrency: 2,
          });

          const binary =
            /^Binary files .* differ$/m.test(patch) ||
            looksBinary(oldBlob.content) ||
            looksBinary(newBlob.content);
          // With autocrlf / eol attributes / clean filters, git diffs the cleaned text while the
          // file on disk differs; the full contents would then disagree with the hunks.
          const filtered = [base.sha, head.sha].includes(WORKTREE) && !patch.includes("\r") &&
            [oldBlob.content, newBlob.content].some((c) => c?.includes("\r\n"));
          const tooLarge = oldBlob.tooLarge || newBlob.tooLarge;
          const shipContent = !binary && !tooLarge && !filtered;

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

        return Git.of({ info, refs, graph, resolve, compare, fileDiff, patch, remoteUrl, hasCommit, mergeBase, fetchCommits });
      }),
    ).pipe(Layer.provide(BunServices.layer));
}

const NO_BLOB = { content: null, tooLarge: false } as const;

export interface DiskFile {
  readonly content: string | null;
  readonly tooLarge: boolean;
  /** Git file mode: 100644, 100755 or 120000 (symlink). */
  readonly mode: string;
}

/**
 * Read `root/path` the way git stores it: a symlink yields its target text and
 * is never followed. Anything whose parent directory resolves outside `root`
 * (a symlinked directory), or that isn't a regular file, reads as missing.
 */
export async function readDisk(root: string, path: string): Promise<DiskFile> {
  const missing: DiskFile = { content: null, tooLarge: false, mode: "100644" };
  if (!isRepoPath(path)) return missing;
  const abs = join(root, path);
  try {
    const parent = await realpath(dirname(abs));
    if (parent !== root && !parent.startsWith(root + sep)) return missing;
    const st = await lstat(abs);
    if (st.isSymbolicLink()) return { content: await readlink(abs), tooLarge: false, mode: "120000" };
    if (!st.isFile()) return missing;
    const mode = st.mode & 0o100 ? "100755" : "100644";
    if (st.size > MAX_BLOB_BYTES) return { content: null, tooLarge: true, mode };
    return { content: await Bun.file(abs).text(), tooLarge: false, mode };
  } catch {
    return missing;
  }
}

// The parsers moved to @/shared/gitText (the Herdr mod uses them too); re-exported for existing importers.
export { diffRange, isRepoPath, OBJECT_ID, parseDecorations, parseGraphLog, parseNameStatus, parseNumstat, sideOf, untrackedPatch } from "@/shared/gitText";
export type { NumstatEntry, Side } from "@/shared/gitText";
