/**
 * The repository as the Herdr mod reads it: the same comparisons, file diffs, refs,
 * graph and pull requests as the server's Git / GitHub services, as plain async code.
 * Processes and files come from the host (Herdr's `exec` / `readTextFile`), so the
 * same code works for a space on another machine.
 *
 * Read-only like the server: every git call goes through the same allow-list, and the
 * one write (`fetchCommits`, for pull requests) creates or moves no ref.
 */
import {
  INDEX,
  isPseudoRev,
  WORKTREE,
  type CommitEntry,
  type CompareResponse,
  type FileChange,
  type FileDiffResponse,
  type GitHubRepo,
  type GraphResponse,
  type PullResolved,
  type PullsResponse,
  type PullSummary,
  type RefEntry,
  type RefsResponse,
  type RepoInfo,
  type ResolvedRef,
} from "@/shared/api";
import {
  diffRange,
  isRepoPath,
  lineCount,
  looksBinary,
  OBJECT_ID,
  parseGitHubRemote,
  parseGraphLog,
  parseNameStatus,
  parseNumstat,
  sideOf,
  untrackedPatch,
  type NumstatEntry,
} from "@/shared/gitText";

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface Host {
  /** Run a program in the repository (any folder inside it before `root` is known). */
  run(command: string, args: ReadonlyArray<string>, options?: { timeout?: number }): Promise<RunResult>;
  /** A file's text by absolute path, or null when missing. Throws when it can't be read (too large). */
  readFile(path: string): Promise<string | null>;
}

export class GitError extends Error {}

const MAX_BLOB_BYTES = 2 * 1024 * 1024;
const RECENT_COMMITS = 300;
const MAX_UNTRACKED = 2000;
export const MAX_GRAPH_COMMITS = 5000;
const MAX_PATHSPEC = 5000;
const MAX_PULLS = 100;
const READ_ONLY = new Set(["rev-parse", "for-each-ref", "log", "diff", "ls-tree", "cat-file", "merge-base", "ls-remote", "ls-files"]);
// `env` sets git's environment: Herdr's exec takes no env option.
const ENV = ["GIT_OPTIONAL_LOCKS=0", "GIT_TERMINAL_PROMPT=0", "LC_ALL=C"];
const GLOBAL = ["--no-pager", "--literal-pathspecs", "-c", "color.ui=never", "-c", "core.quotePath=off", "-c", "core.fsmonitor=false"];
const GH_ENV = ["GH_PROMPT_DISABLED=1", "GH_NO_UPDATE_NOTIFIER=1", "GH_SPINNER_DISABLED=1", "NO_COLOR=1", "GIT_TERMINAL_PROMPT=0"];
const DIFF = ["--no-color", "--no-ext-diff", "--no-textconv", "-M"];
const NO_BLOB = { content: null, tooLarge: false } as const;

interface Blob {
  readonly content: string | null;
  readonly tooLarge: boolean;
}

export interface PatchResponse {
  readonly base: ResolvedRef;
  readonly head: ResolvedRef;
  readonly patch: string;
  readonly partial: boolean;
}

/** Concurrency-limited map, in order. */
async function mapLimit<T, R>(items: ReadonlyArray<T>, limit: number, fn: (item: T) => Promise<R>): Promise<Array<R>> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export type Repo = Awaited<ReturnType<typeof openRepo>>;

/** Opens the repository containing the host's folder; rejects when it isn't one. */
export async function openRepo(host: Host) {
  // Pathspecs and `ls-files --others` are relative to git's folder: once the root is
  // known, every call runs there (-C), even when the host started in a subfolder.
  let at: Array<string> = [];
  const spawnGit = async (args: ReadonlyArray<string>, timeout?: number) => {
    const r = await host.run("env", [...ENV, "git", ...at, ...GLOBAL, ...args], { timeout });
    if (r.code !== 0) throw new GitError(r.stderr.trim() || `git exited with code ${r.code}`);
    return r.stdout;
  };
  const git = (...args: Array<string>) => {
    if (!READ_ONLY.has(args[0] ?? "")) throw new GitError(`Refusing to run git subcommand "${args[0]}"`);
    return spawnGit(args);
  };
  const quiet = (p: Promise<string>, fallback = "") => p.catch(() => fallback);

  const root = (await git("rev-parse", "--show-toplevel").catch(() => {
    throw new GitError("Not a git repository");
  })).trim();
  at = ["-C", root];
  const name = root.split("/").pop() || root;

  const untrackedFiles = async () =>
    (await git("ls-files", "-z", "--others", "--exclude-standard")).split("\0").filter((p) => p !== "" && !p.endsWith("/"));

  /** A working-tree file. Only paths git lists reach here; `isRepoPath` keeps `..` out regardless. */
  const readWorktree = async (path: string): Promise<Blob> => {
    if (!isRepoPath(path)) return NO_BLOB;
    try {
      const content = await host.readFile(`${root}/${path}`);
      return { content, tooLarge: false };
    } catch {
      return { content: null, tooLarge: true };
    }
  };

  const info = async (): Promise<RepoInfo> => {
    const branch = (await quiet(git("rev-parse", "--abbrev-ref", "HEAD"), "HEAD")).trim();
    const headSha = (await quiet(git("rev-parse", "--verify", "--quiet", "HEAD^{commit}"))).trim() || null;
    let uncommitted = 0;
    if (headSha) {
      try {
        const [changed, untracked] = await Promise.all([git("diff", "--name-only", "-z", "HEAD"), untrackedFiles()]);
        const paths = new Set(changed.split("\0").filter(Boolean));
        for (const p of untracked) paths.add(p);
        uncommitted = paths.size;
      } catch {
        uncommitted = 0;
      }
    }
    return { root, name, currentBranch: branch === "HEAD" ? null : branch, headSha, uncommitted };
  };

  const refs = async (): Promise<RefsResponse> => {
    const [refLines, logOut] = await Promise.all([
      git("for-each-ref", "--sort=-committerdate", "--format=%(refname)%00%(objectname)%00%(*objectname)%00%(subject)", "refs/heads", "refs/remotes", "refs/tags"),
      quiet(git("log", "--all", "--date-order", `-n${RECENT_COMMITS}`, "--format=%H%x00%h%x00%s%x00%an%x00%aI")),
    ]);
    const branches: Array<RefEntry> = [];
    const remoteBranches: Array<RefEntry> = [];
    const tags: Array<RefEntry> = [];
    for (const line of refLines.split("\n")) {
      if (!line) continue;
      const [refname = "", sha = "", peeled = "", subject = ""] = line.split("\0");
      if (refname.startsWith("refs/heads/")) branches.push({ name: refname.slice(11), sha, subject });
      else if (refname.startsWith("refs/remotes/")) {
        if (!refname.endsWith("/HEAD")) remoteBranches.push({ name: refname.slice(13), sha, subject });
      } else if (refname.startsWith("refs/tags/")) tags.push({ name: refname.slice(10), sha: peeled || sha, subject });
    }
    const commits: Array<CommitEntry> = [];
    for (const line of logOut.split("\n")) {
      if (!line) continue;
      const [sha = "", shortSha = "", subject = "", author = "", date = ""] = line.split("\0");
      commits.push({ sha, shortSha, subject, author, date });
    }
    return { branches, remoteBranches, tags, commits };
  };

  const graph = async (limit: number): Promise<GraphResponse> => {
    const n = Math.min(Math.max(Math.trunc(limit), 1), MAX_GRAPH_COMMITS);
    const out = await quiet(
      git("log", "--branches", "--remotes", "--tags", "HEAD", "--date-order", "--decorate=full", `-n${n + 1}`, "--format=%H%x00%P%x00%D%x00%s%x00%an%x00%aI%x1e", "--"),
    );
    const commits = parseGraphLog(out);
    const truncated = commits.length > n;
    return { commits: truncated ? commits.slice(0, n) : commits, truncated };
  };

  const resolve = async (ref: string): Promise<ResolvedRef> => {
    const trimmed = ref.trim();
    if (trimmed === "" || trimmed.length > 256 || trimmed.startsWith("-") || /[\s\x00-\x1f\x7f]/.test(trimmed)) {
      throw new GitError(`Invalid revision: "${ref}"`);
    }
    if (isPseudoRev(trimmed)) return { ref: trimmed, sha: trimmed };
    const sha = (await git("rev-parse", "--verify", "--end-of-options", `${trimmed}^{commit}`).catch(() => {
      throw new GitError(`Unknown revision: "${ref}"`);
    })).trim();
    return { ref: trimmed, sha };
  };

  const compare = async (baseRef: string, headRef: string): Promise<CompareResponse> => {
    const [base, head] = await Promise.all([resolve(baseRef), resolve(headRef)]);
    const range = diffRange(sideOf(base.sha), sideOf(head.sha));
    const [nameStatus, numstat] =
      range === null ? ["", ""] : await Promise.all([git("diff", ...DIFF, "--name-status", "-z", ...range), git("diff", ...DIFF, "--numstat", "-z", ...range)]);
    const stats = parseNumstat(numstat);
    const files = parseNameStatus(nameStatus).map((f): FileChange => {
      const s = stats.get(f.path);
      return { ...f, additions: s?.additions ?? 0, deletions: s?.deletions ?? 0, binary: s?.binary ?? false };
    });
    if ((base.sha === WORKTREE) !== (head.sha === WORKTREE)) {
      const status = head.sha === WORKTREE ? "added" : "deleted";
      const seen = new Set(files.map((f) => f.path));
      const untracked = (await untrackedFiles()).filter((p) => !seen.has(p)).slice(0, MAX_UNTRACKED);
      files.push(
        ...(await mapLimit(untracked, 16, async (path): Promise<FileChange> => {
          const file = await readWorktree(path);
          const binary = looksBinary(file.content);
          const lines = binary ? 0 : lineCount(file.content);
          return { status, path, oldPath: null, similarity: null, additions: status === "added" ? lines : 0, deletions: status === "deleted" ? lines : 0, binary };
        })),
      );
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { base, head, files };
  };

  const patch = async (baseRef: string, headRef: string, maxLines: number): Promise<PatchResponse> => {
    const [base, head] = await Promise.all([resolve(baseRef), resolve(headRef)]);
    const range = diffRange(sideOf(base.sha), sideOf(head.sha));
    const stats = parseNumstat(range === null ? "" : await git("diff", ...DIFF, "--numstat", "-z", ...range));
    let budget = maxLines;
    let partial = false;
    let pathspec: Array<string> | null = null;
    const changed = (s: NumstatEntry) => s.additions + s.deletions;
    const total = [...stats.values()].reduce((n, s) => n + changed(s), 0);
    if (total > maxLines) {
      pathspec = [];
      partial = true;
      for (const [path, s] of stats) {
        if (changed(s) === 0 || changed(s) > budget || pathspec.length >= MAX_PATHSPEC) continue;
        budget -= changed(s);
        pathspec.push(path, ...(s.oldPath ? [s.oldPath] : []));
      }
    } else budget -= total;
    let text =
      range === null || pathspec?.length === 0
        ? ""
        : await git("diff", ...DIFF, "-U0", "--src-prefix=a/", "--dst-prefix=b/", ...range, ...(pathspec ? ["--", ...pathspec] : []));
    if ((base.sha === WORKTREE) !== (head.sha === WORKTREE)) {
      const kind = head.sha === WORKTREE ? "added" : "deleted";
      const untracked = (await untrackedFiles()).filter((p) => !stats.has(p)).slice(0, MAX_UNTRACKED);
      const files = await mapLimit(untracked, 16, async (path) => ({ path, file: await readWorktree(path) }));
      for (const { path, file } of files) {
        if (file.tooLarge || looksBinary(file.content)) continue;
        const lines = lineCount(file.content);
        if (lines > budget) {
          partial = true;
          continue;
        }
        budget -= lines;
        text += untrackedPatch(path, file.content, "100644", kind);
      }
    }
    return { base, head, patch: text, partial };
  };

  const readBlob = async (sha: string, path: string): Promise<Blob> => {
    const entry = await git("ls-tree", "-z", "-l", "--full-tree", sha, "--", path);
    const record = entry.split("\0").find((r) => r.length > 0);
    if (!record) return NO_BLOB;
    const [, type, objectId, size] = record.slice(0, record.indexOf("\t")).split(/\s+/);
    if (type !== "blob" || !objectId) return NO_BLOB;
    if (Number(size) > MAX_BLOB_BYTES) return { content: null, tooLarge: true };
    return { content: await git("cat-file", "blob", objectId), tooLarge: false };
  };

  const readIndexBlob = async (path: string): Promise<Blob> => {
    const out = await git("ls-files", "-z", "--stage", "--", path);
    const record = out.split("\0").find((r) => r.endsWith(`\t${path}`) && r.split("\t")[0]!.endsWith(" 0"));
    if (!record) return NO_BLOB;
    const [mode, objectId] = record.split("\t")[0]!.split(" ");
    if (mode === "160000" || !objectId) return NO_BLOB;
    if (Number((await git("cat-file", "-s", objectId)).trim()) > MAX_BLOB_BYTES) return { content: null, tooLarge: true };
    return { content: await git("cat-file", "blob", objectId), tooLarge: false };
  };

  const isListed = async (path: string, ...which: Array<string>) =>
    (await git("ls-files", "-z", ...which, "--", path)).split("\0").includes(path);

  const readSide = async (rev: string, path: string): Promise<Blob> => {
    if (rev === INDEX) return readIndexBlob(path);
    if (rev === WORKTREE) return (await isListed(path, "--cached", "--others", "--exclude-standard")) ? readWorktree(path) : NO_BLOB;
    return readBlob(rev, path);
  };

  /** Takes resolved ids (`CompareResponse.base.sha`), so a moving branch can't change between list and file. */
  const fileDiff = async (baseSha: string, headSha: string, path: string, oldPath: string | null): Promise<FileDiffResponse> => {
    for (const p of [path, oldPath]) if (p !== null && !isRepoPath(p)) throw new GitError(`Invalid path: "${p}"`);
    for (const s of [baseSha, headSha]) if (!isPseudoRev(s) && !OBJECT_ID.test(s)) throw new GitError(`Not a commit id: "${s}"`);
    const before = oldPath ?? path;
    const pathspec = before === path ? [path] : [before, path];
    const range = diffRange(sideOf(baseSha), sideOf(headSha));
    const gitPatch = range === null ? "" : await git("diff", ...DIFF, "--full-index", ...range, "--", ...pathspec);

    if (gitPatch === "" && (baseSha === WORKTREE) !== (headSha === WORKTREE) && oldPath === null && (await isListed(path, "--others", "--exclude-standard"))) {
      const file = await readWorktree(path);
      const added = headSha === WORKTREE;
      const binary = looksBinary(file.content);
      const content = binary || file.tooLarge ? null : file.content;
      return {
        patch: untrackedPatch(path, file.content, "100644", added ? "added" : "deleted"),
        oldContent: added ? null : content,
        newContent: added ? content : null,
        binary,
        tooLarge: file.tooLarge,
      };
    }
    const [oldBlob, newBlob] = await Promise.all([readSide(baseSha, before), readSide(headSha, path)]);
    const binary = /^Binary files .* differ$/m.test(gitPatch) || looksBinary(oldBlob.content) || looksBinary(newBlob.content);
    const filtered =
      [baseSha, headSha].includes(WORKTREE) && !gitPatch.includes("\r") && [oldBlob.content, newBlob.content].some((c) => c?.includes("\r\n"));
    const tooLarge = oldBlob.tooLarge || newBlob.tooLarge;
    const ship = !binary && !tooLarge && !filtered;
    return { patch: gitPatch, oldContent: ship ? oldBlob.content : null, newContent: ship ? newBlob.content : null, binary, tooLarge };
  };

  // ---------------------------------------------------------------- GitHub

  const remoteUrl = async (remote: string) => {
    const url = (await git("ls-remote", "--get-url", "--end-of-options", remote)).trim();
    return url === "" || url === remote ? null : url;
  };

  let detected: Promise<GitHubRepo | null> | null = null;
  const detect = () =>
    (detected ??= (async () => {
      for (const remote of ["upstream", "origin"]) {
        const url = await remoteUrl(remote).catch(() => null);
        const parsed = url ? parseGitHubRemote(url) : null;
        if (parsed) return { ...parsed, remote };
      }
      return null;
    })());

  const gh = async (args: Array<string>): Promise<unknown> => {
    let r: RunResult;
    try {
      r = await host.run("env", [...GH_ENV, "gh", ...args], { timeout: 30_000 });
    } catch {
      throw new GitError("GitHub CLI (`gh`) timed out or could not start");
    }
    if (r.code === 127) throw new GitError("GitHub CLI (`gh`) not found. Install it from https://cli.github.com");
    if (r.code !== 0) {
      const msg = r.stderr.trim() || `gh exited with code ${r.code}`;
      throw new GitError(/auth login|not logged/i.test(msg) ? `GitHub CLI is not logged in. Run \`gh auth login\`. (${msg})` : msg);
    }
    try {
      return JSON.parse(r.stdout) as unknown;
    } catch {
      throw new GitError("Unexpected output from GitHub CLI");
    }
  };

  const str = (v: unknown) => (typeof v === "string" ? v : null);

  const pulls = async (): Promise<PullsResponse> => {
    const github = await detect();
    if (!github) return { github: null, pulls: [] };
    const raw = await gh(["pr", "list", "--repo", `${github.owner}/${github.name}`, "--state", "open", "--limit", String(MAX_PULLS), "--json",
      "number,title,author,baseRefName,headRefName,isDraft,isCrossRepository,updatedAt,url"]);
    if (!Array.isArray(raw)) throw new GitError("Unexpected pull request list from GitHub");
    const list = raw.flatMap((p: Record<string, unknown>): Array<PullSummary> => {
      const number = p.number;
      const title = str(p.title);
      if (typeof number !== "number" || title === null) return [];
      return [{
        number,
        title,
        author: str((p.author as { login?: unknown } | null)?.login) ?? "ghost",
        baseRef: str(p.baseRefName) ?? "",
        headRef: str(p.headRefName) ?? "",
        isDraft: p.isDraft === true,
        isCrossRepository: p.isCrossRepository === true,
        updatedAt: str(p.updatedAt) ?? "",
        url: str(p.url) ?? "",
      }];
    });
    return { github, pulls: list };
  };

  const hasCommit = (sha: string) => (OBJECT_ID.test(sha) ? git("cat-file", "-e", `${sha}^{commit}`).then(() => true, () => false) : Promise.resolve(false));

  const fetchCommits = async (remote: string, shas: Array<string>) => {
    if (!/^[A-Za-z0-9._-]+$/.test(remote) || remote.startsWith("-") || shas.some((s) => !OBJECT_ID.test(s))) {
      throw new GitError("Refusing to fetch: invalid remote or commit id");
    }
    if (shas.length === 0) return;
    // No destination in the refspecs and an empty refmap: nothing under refs/ is created or updated.
    await spawnGit(["-c", "gc.auto=0", "-c", "maintenance.auto=false", "fetch", "--quiet", "--no-tags", "--no-recurse-submodules",
      "--no-write-fetch-head", "--refmap=", "--end-of-options", remote, ...shas], 90_000);
  };

  const pull = async (number: number): Promise<PullResolved> => {
    const github = await detect();
    if (!github) throw new GitError("This repository has no GitHub remote (upstream or origin).");
    const pr = (await gh(["pr", "view", String(number), "--repo", `${github.owner}/${github.name}`, "--json",
      "number,title,url,baseRefName,headRefName,baseRefOid,headRefOid"])) as Record<string, unknown>;
    const baseOid = str(pr?.baseRefOid) ?? "";
    const headOid = str(pr?.headRefOid) ?? "";
    if (!OBJECT_ID.test(baseOid) || !OBJECT_ID.test(headOid)) throw new GitError("GitHub returned an invalid commit id");
    const present = await Promise.all([baseOid, headOid].map(hasCommit));
    await fetchCommits(github.remote, [baseOid, headOid].filter((_, i) => !present[i]));
    const base = (await git("merge-base", baseOid, headOid)).trim();
    return {
      number,
      title: str(pr.title) ?? "",
      url: str(pr.url) ?? "",
      baseRef: str(pr.baseRefName) ?? "",
      headRef: str(pr.headRefName) ?? "",
      base,
      head: headOid,
    };
  };

  return { root, name, info, refs, graph, resolve, compare, patch, fileDiff, pulls, pull };
}

/**
 * The comparison a fresh viewer opens on: the working tree (everything on this branch,
 * committed or not) against main / master, else against the current commit's parent.
 * Same choice as the web app.
 */
export function defaultRefs(repo: RepoInfo, refs: RefsResponse): { base: string; head: string } {
  const current = repo.currentBranch ?? "HEAD";
  const head = WORKTREE;
  const candidates = ["main", "master", "develop", "trunk"];
  const local = candidates.find((c) => c !== current && refs.branches.some((b) => b.name === c));
  if (local) return { base: local, head };
  const remote = candidates
    .map((c) => `origin/${c}`)
    .find((c) => refs.remoteBranches.some((b) => b.name === c && b.sha !== repo.headSha));
  if (remote) return { base: remote, head };
  return { base: refs.commits.length > 1 ? `${current}~1` : current, head };
}
