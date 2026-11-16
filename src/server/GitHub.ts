import { Context, Effect, Layer, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { BunServices } from "@effect/platform-bun";
import type { GitHubRepo, PullResolved, PullsResponse, PullSummary } from "@/shared/api";
import { Git, GitError, OBJECT_ID } from "./Git";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The repository has no `upstream` / `origin` remote on github.com. */
export class NotGitHub extends Schema.TaggedError<NotGitHub>()("NotGitHub", {
  message: Schema.String,
}) {}

/** `gh` is missing, not logged in, or GitHub returned an error. */
export class GitHubError extends Schema.TaggedError<GitHubError>()("GitHubError", {
  message: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// Remote URL parsing
// ---------------------------------------------------------------------------

/** Remotes checked in order: in a fork workflow, PRs live on `upstream`. */
const REMOTE_CANDIDATES = ["upstream", "origin"] as const;

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

// ---------------------------------------------------------------------------
// gh output schemas (GitHub data is untrusted input)
// ---------------------------------------------------------------------------

const GhPullListItem = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  author: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  baseRefName: Schema.String,
  headRefName: Schema.String,
  isDraft: Schema.Boolean,
  isCrossRepository: Schema.Boolean,
  updatedAt: Schema.String,
  url: Schema.String,
});
const decodePullList = Schema.decodeUnknownEffect(Schema.Array(GhPullListItem));

const GhPullView = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
  baseRefName: Schema.String,
  headRefName: Schema.String,
  baseRefOid: Schema.String,
  headRefOid: Schema.String,
});
const decodePullView = Schema.decodeUnknownEffect(GhPullView);

const LIST_FIELDS = "number,title,author,baseRefName,headRefName,isDraft,isCrossRepository,updatedAt,url";
const VIEW_FIELDS = "number,title,url,baseRefName,headRefName,baseRefOid,headRefOid";
const MAX_PULLS = 100;
const GH_TIMEOUT = "30 seconds";

const GH_ENV = {
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  GH_SPINNER_DISABLED: "1",
  NO_COLOR: "1",
  GIT_TERMINAL_PROMPT: "0",
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class GitHub extends Context.Service<
  GitHub,
  {
    readonly pulls: Effect.Effect<PullsResponse, GitHubError | GitError>;
    pull(number: number): Effect.Effect<PullResolved, NotGitHub | GitHubError | GitError>;
  }
>()("git-diff-view/server/GitHub") {
  static readonly layer = Layer.effect(
    GitHub,
    Effect.gen(function* () {
      const git = yield* Git;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      /** Run `gh` with array args, no prompts, and parse its JSON stdout. */
      const gh = Effect.fnUntraced(function* (args: ReadonlyArray<string>) {
        const out = yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(ChildProcess.make("gh", [...args], { env: GH_ENV, extendEnv: true }));
            const [stdout, stderr, exitCode] = yield* Effect.all(
              [
                Stream.mkString(Stream.decodeText(handle.stdout)),
                Stream.mkString(Stream.decodeText(handle.stderr)),
                handle.exitCode,
              ],
              { concurrency: "unbounded" },
            );
            if (Number(exitCode) !== 0) {
              const msg = stderr.trim() || `gh exited with code ${exitCode}`;
              return yield* new GitHubError({
                message: /auth login|not logged/i.test(msg) ? `GitHub CLI is not logged in. Run \`gh auth login\`. (${msg})` : msg,
              });
            }
            return stdout;
          }),
        ).pipe(
          Effect.catchTag("PlatformError", () =>
            Effect.fail(new GitHubError({ message: "GitHub CLI (`gh`) not found. Install it from https://cli.github.com" })),
          ),
          Effect.timeoutOrElse({
            duration: GH_TIMEOUT,
            orElse: () => Effect.fail(new GitHubError({ message: "GitHub CLI timed out" })),
          }),
        );
        return yield* Effect.try({
          try: () => JSON.parse(out) as unknown,
          catch: () => new GitHubError({ message: "Unexpected output from GitHub CLI" }),
        });
      });

      /** First of upstream / origin that points at github.com. Remotes rarely change: read once. */
      const detect = yield* Effect.cached(
        Effect.gen(function* () {
          for (const remote of REMOTE_CANDIDATES) {
            const url = yield* git.remoteUrl(remote).pipe(Effect.orElseSucceed(() => null));
            const parsed = url ? parseGitHubRemote(url) : null;
            if (parsed) return { ...parsed, remote } satisfies GitHubRepo;
          }
          return null;
        }),
      );

      const pulls = Effect.gen(function* () {
        const github = yield* detect;
        if (!github) return { github: null, pulls: [] } satisfies PullsResponse;
        const raw = yield* gh([
          "pr", "list",
          "--repo", `${github.owner}/${github.name}`,
          "--state", "open",
          "--limit", String(MAX_PULLS),
          "--json", LIST_FIELDS,
        ]);
        const items = yield* decodePullList(raw).pipe(
          Effect.mapError(() => new GitHubError({ message: "Unexpected pull request list from GitHub" })),
        );
        const list = items.map(
          (p): PullSummary => ({
            number: p.number,
            title: p.title,
            author: p.author?.login ?? "ghost",
            baseRef: p.baseRefName,
            headRef: p.headRefName,
            isDraft: p.isDraft,
            isCrossRepository: p.isCrossRepository,
            updatedAt: p.updatedAt,
            url: p.url,
          }),
        );
        return { github, pulls: list } satisfies PullsResponse;
      });

      const pull = Effect.fn("GitHub.pull")(function* (number: number) {
        const github = yield* detect;
        if (!github) return yield* new NotGitHub({ message: "This repository has no GitHub remote (upstream or origin)." });

        // Always ask GitHub for the current head: the PR may have been pushed to since the list loaded.
        const raw = yield* gh(["pr", "view", String(number), "--repo", `${github.owner}/${github.name}`, "--json", VIEW_FIELDS]);
        const pr = yield* decodePullView(raw).pipe(
          Effect.mapError(() => new GitHubError({ message: "Unexpected pull request data from GitHub" })),
        );
        if (!OBJECT_ID.test(pr.baseRefOid) || !OBJECT_ID.test(pr.headRefOid)) {
          return yield* new GitHubError({ message: "GitHub returned an invalid commit id" });
        }

        // Fork PRs (and fresh pushes) are usually not local yet: fetch only what is missing.
        const shas = [pr.baseRefOid, pr.headRefOid];
        const present = yield* Effect.all(shas.map(git.hasCommit), { concurrency: 2 });
        const missing = shas.filter((_, i) => !present[i]);
        yield* git.fetchCommits(github.remote, missing);

        const base = yield* git.mergeBase(pr.baseRefOid, pr.headRefOid);
        return {
          number: pr.number,
          title: pr.title,
          url: pr.url,
          baseRef: pr.baseRefName,
          headRef: pr.headRefName,
          base,
          head: pr.headRefOid,
        } satisfies PullResolved;
      });

      return GitHub.of({ pulls, pull });
    }),
  ).pipe(Layer.provide(BunServices.layer));
}
