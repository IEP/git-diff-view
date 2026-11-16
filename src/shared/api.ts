/**
 * Wire types shared by the Effect backend and the React frontend.
 * Plain types only: this file is imported by the browser bundle too.
 */

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "typechange" | "unknown";

export interface RepoInfo {
  readonly root: string;
  readonly name: string;
  /** Current branch name, or null when HEAD is detached. */
  readonly currentBranch: string | null;
  readonly headSha: string | null;
}

export interface RefEntry {
  readonly name: string;
  readonly sha: string;
  readonly subject: string;
}

export interface CommitEntry {
  readonly sha: string;
  readonly shortSha: string;
  readonly subject: string;
  readonly author: string;
  readonly date: string;
}

export interface RefsResponse {
  readonly branches: ReadonlyArray<RefEntry>;
  readonly remoteBranches: ReadonlyArray<RefEntry>;
  readonly tags: ReadonlyArray<RefEntry>;
  readonly commits: ReadonlyArray<CommitEntry>;
}

export interface ResolvedRef {
  readonly ref: string;
  readonly sha: string;
}

export interface FileChange {
  readonly status: ChangeStatus;
  /** Path on the head side (for deletions: the deleted path). */
  readonly path: string;
  /** Path on the base side when it differs (renames / copies). */
  readonly oldPath: string | null;
  /** Rename / copy similarity score, 0–100. */
  readonly similarity: number | null;
  readonly additions: number;
  readonly deletions: number;
  readonly binary: boolean;
}

export interface CompareResponse {
  readonly base: ResolvedRef;
  readonly head: ResolvedRef;
  readonly files: ReadonlyArray<FileChange>;
}

export interface FileDiffResponse {
  /** Unified diff text for this single file (`diff --git` header + hunks). */
  readonly patch: string;
  readonly oldContent: string | null;
  readonly newContent: string | null;
  readonly binary: boolean;
  /** Set when either side exceeded the size limit; contents are omitted then. */
  readonly tooLarge: boolean;
}

export interface ApiErrorBody {
  readonly error: string;
  readonly message: string;
}
