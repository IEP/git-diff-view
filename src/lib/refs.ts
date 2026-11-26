import { WORKTREE, type RefsResponse, type RepoInfo } from "@/shared/api";

/**
 * The comparison a fresh viewer opens on: the working tree (everything on this branch,
 * committed or not) against main / master, else against the current commit's parent.
 * Shared by the web app and the terminal viewer.
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
