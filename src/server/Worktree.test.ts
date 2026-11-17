import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INDEX, WORKTREE } from "@/shared/api";
import { diffRange, Git, sideOf, untrackedPatch } from "./Git";

describe("diffRange", () => {
  const c = sideOf("a".repeat(40));
  const i = sideOf(INDEX);
  const w = sideOf(WORKTREE);
  test("maps every pair to git diff arguments", () => {
    expect(diffRange(c, sideOf("b".repeat(40)))).toEqual(["a".repeat(40), "b".repeat(40)]);
    expect(diffRange(c, i)).toEqual(["--cached", "a".repeat(40)]);
    expect(diffRange(c, w)).toEqual(["a".repeat(40)]);
    expect(diffRange(i, w)).toEqual([]);
    expect(diffRange(i, c)).toEqual(["-R", "--cached", "a".repeat(40)]);
    expect(diffRange(w, c)).toEqual(["-R", "a".repeat(40)]);
    expect(diffRange(w, i)).toEqual(["-R"]);
    expect(diffRange(w, w)).toBeNull();
    expect(diffRange(i, i)).toBeNull();
  });
});

describe("untrackedPatch", () => {
  test("adds every line and flags a missing final newline", () => {
    expect(untrackedPatch("n.txt", "a\nb", "100644", "added")).toBe(
      "diff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n\\ No newline at end of file\n",
    );
    expect(untrackedPatch("n.txt", "x\n", "100755", "deleted")).toBe(
      "diff --git a/n.txt b/n.txt\ndeleted file mode 100755\n--- a/n.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n",
    );
  });
});

describe("uncommitted changes (real repository)", () => {
  let dir: string;
  let head: string;
  const sh = (...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };
  const run = <A, E>(f: (git: Git["Service"]) => Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.flatMap(Effect.service(Git), f).pipe(Effect.provide(Git.layer(dir))));

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "gdv-wt-"));
    sh("init", "-q", "-b", "main");
    await writeFile(join(dir, "staged.txt"), "one\n");
    await writeFile(join(dir, "unstaged.txt"), "one\n");
    await writeFile(join(dir, ".gitignore"), "secret.env\n");
    sh("add", ".");
    sh("commit", "-q", "-m", "init");
    head = sh("rev-parse", "HEAD");
    await writeFile(join(dir, "staged.txt"), "one\ntwo\n");
    sh("add", "staged.txt");
    await writeFile(join(dir, "unstaged.txt"), "one\nthree\n");
    await writeFile(join(dir, "new.txt"), "fresh\nfile");
    await writeFile(join(dir, "secret.env"), "TOKEN=1\n");
    await mkdir(join(dir, "outside"));
    await symlink("/etc", join(dir, "etc-link"));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  const paths = (r: { files: ReadonlyArray<{ path: string; status: string }> }) => r.files.map((f) => `${f.status} ${f.path}`);

  test("HEAD → working tree shows staged, unstaged and untracked, never ignored", async () => {
    const r = await run((g) => g.compare("HEAD", WORKTREE));
    expect(r.head.sha).toBe(WORKTREE);
    expect(paths(r)).toEqual(["added etc-link", "added new.txt", "modified staged.txt", "modified unstaged.txt"]);
    expect(r.files.find((f) => f.path === "new.txt")).toMatchObject({ additions: 2, deletions: 0 });
  });

  test("HEAD → index shows only staged changes", async () => {
    expect(paths(await run((g) => g.compare(head, INDEX)))).toEqual(["modified staged.txt"]);
  });

  test("index → working tree shows unstaged and untracked", async () => {
    expect(paths(await run((g) => g.compare(INDEX, WORKTREE)))).toEqual([
      "added etc-link",
      "added new.txt",
      "modified unstaged.txt",
    ]);
  });

  test("working tree → HEAD is the reverse", async () => {
    const r = await run((g) => g.compare(WORKTREE, "HEAD"));
    expect(paths(r)).toEqual(["deleted etc-link", "deleted new.txt", "modified staged.txt", "modified unstaged.txt"]);
    expect(r.files.find((f) => f.path === "unstaged.txt")).toMatchObject({ additions: 0, deletions: 1 });
  });

  test("file diff reads each side from the right place", async () => {
    const staged = await run((g) => g.fileDiff(head, INDEX, "staged.txt", null));
    expect([staged.oldContent, staged.newContent]).toEqual(["one\n", "one\ntwo\n"]);
    const unstaged = await run((g) => g.fileDiff(INDEX, WORKTREE, "unstaged.txt", null));
    expect([unstaged.oldContent, unstaged.newContent]).toEqual(["one\n", "one\nthree\n"]);
    expect(unstaged.patch).toContain("+three");
  });

  test("untracked files get a synthesized patch", async () => {
    const d = await run((g) => g.fileDiff("HEAD", WORKTREE, "new.txt", null));
    expect(d.patch).toContain("@@ -0,0 +1,2 @@\n+fresh\n+file");
    expect(d.newContent).toBe("fresh\nfile");
    const link = await run((g) => g.fileDiff("HEAD", WORKTREE, "etc-link", null));
    expect(link.newContent).toBe("/etc"); // the link text, not the directory
  });

  test("refuses paths git doesn't list: .git, ignored files, traversal, through symlinks", async () => {
    for (const path of [".git/config", "secret.env", "etc-link/hosts"]) {
      const d = await run((g) => g.fileDiff("HEAD", WORKTREE, path, null));
      expect(d.newContent).toBeNull();
    }
    for (const path of ["../x", "/etc/hosts", "a/./b", "a//b"]) {
      const err = await run((g) => Effect.flip(g.fileDiff("HEAD", WORKTREE, path, null)));
      expect(err._tag).toBe("InvalidRef");
    }
  });
});

describe("uncommitted edge cases (real repository)", () => {
  let dir: string;
  const sh = (...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };
  const run = <A, E>(f: (git: Git["Service"]) => Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.flatMap(Effect.service(Git), f).pipe(Effect.provide(Git.layer(dir))));

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "gdv-edge-"));
    sh("init", "-q", "-b", "main");
    await writeFile(join(dir, ".gitattributes"), "*.txt text eol=crlf\n");
    await writeFile(join(dir, "crlf.txt"), "a\r\nb\r\n");
    await writeFile(join(dir, "old-name.md"), "the same body\nacross a rename\nwith enough lines\n");
    await writeFile(join(dir, "dropped.md"), "kept on disk\n");
    sh("add", ".");
    sh("commit", "-q", "-m", "init");
    await writeFile(join(dir, "crlf.txt"), "a\r\nB\r\n");
    sh("mv", "old-name.md", "new-name.md");
    sh("rm", "-q", "--cached", "dropped.md");
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  test("a staged rename is a rename both ways", async () => {
    const fwd = await run((g) => g.compare("HEAD", INDEX));
    expect(fwd.files.find((f) => f.path === "new-name.md")).toMatchObject({ status: "renamed", oldPath: "old-name.md" });
    const back = await run((g) => g.compare(INDEX, "HEAD"));
    expect(back.files.find((f) => f.path === "old-name.md")).toMatchObject({ status: "renamed", oldPath: "new-name.md" });
  });

  test("git rm --cached: deleted in the list and in the diff", async () => {
    const r = await run((g) => g.compare("HEAD", WORKTREE));
    expect(r.files.filter((f) => f.path === "dropped.md").map((f) => f.status)).toEqual(["deleted"]);
    const d = await run((g) => g.fileDiff("HEAD", WORKTREE, "dropped.md", null));
    expect(d.patch).toContain("deleted file mode");
  });

  test("eol-converted files ship hunks only", async () => {
    const d = await run((g) => g.fileDiff("HEAD", WORKTREE, "crlf.txt", null));
    expect(d.patch).toContain("+B");
    expect([d.oldContent, d.newContent, d.tooLarge]).toEqual([null, null, false]);
  });
});
