// The Herdr mod's core: diff rows, search, and the repository layer against a real git repo.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INDEX, WORKTREE } from "@/shared/api";
import { utf8Decode, unquotePath } from "@/shared/gitText";
import { naturalCompare } from "@/lib/tree";
import { expand, findLine, findPair, parseFilePatch, splitLines, splitRows, unifiedRows, untab } from "./diffModel";
import { defaultRefs, openRepo, type Host } from "./repo";
import { buildIndex, search, snippet, splitMatches } from "./search";

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);

describe("diff rows", () => {
  // Line 10 changed and line 30 removed, in a 40-line file.
  const old = lines(40);
  const next = [...old.slice(0, 9), "LINE 10", ...old.slice(10, 29), ...old.slice(30)];
  const patch = [
    "diff --git a/f b/f",
    "--- a/f",
    "+++ b/f",
    "@@ -9,3 +9,3 @@",
    " line 9",
    "-line 10",
    "+LINE 10",
    " line 11",
    "@@ -29,3 +29,2 @@",
    " line 29",
    "-line 30",
    " line 31",
    "",
  ].join("\n");
  const parsed = parseFilePatch(patch);

  test("parses hunks by their counts", () => {
    expect(parsed.hunks.map((h) => [h.oldStart, h.oldCount, h.newStart, h.newCount, h.lines.length])).toEqual([
      [9, 3, 9, 3, 4],
      [29, 3, 29, 2, 3],
    ]);
    expect(parsed.hunks[0]!.lines[2]).toEqual({ kind: "add", text: "LINE 10", old: null, new: 10 });
  });

  test("gaps cover the unchanged lines before, between and after hunks", () => {
    const rows = unifiedRows(parsed, old, next, new Map());
    const gaps = rows.filter((r) => r.t === "gap").map((r) => (r.t === "gap" ? [r.gap.oldFrom, r.gap.newFrom, r.gap.count] : []));
    // before: 1–8; between: old 12–28 / new 12–28; after: old 32–40 / new 31–39
    expect(gaps).toEqual([[1, 1, 8], [12, 12, 17], [32, 31, 9]]);
  });

  test("opening a gap shows its lines with both numbers, from either end", () => {
    const first = unifiedRows(parsed, old, next, new Map()).find((r) => r.t === "gap");
    if (first?.t !== "gap") throw new Error("no gap");
    const between = unifiedRows(parsed, old, next, new Map()).filter((r) => r.t === "gap")[1];
    if (between?.t !== "gap") throw new Error("no gap");
    let open = expand(new Map(), between.gap, "down", 2);
    open = expand(open, between.gap, "up", 3);
    const rows = unifiedRows(parsed, old, next, open);
    const i = rows.findIndex((r) => r.t === "gap" && r.gap.key === between.gap.key);
    const around = rows.slice(i - 2, i + 4).map((r) => (r.t === "line" ? `${r.line.old}/${r.line.new} ${r.line.text}` : r.t === "gap" ? `gap ${r.hidden}` : "hunk"));
    expect(around).toEqual(["12/12 line 12", "13/13 line 13", "gap 12", "26/26 line 26", "27/27 line 27", "28/28 line 28"]);
    const all = unifiedRows(parsed, old, next, expand(new Map(), first.gap, "all"));
    expect(all.slice(0, 8).every((r) => r.t === "line" && r.line.kind === "ctx")).toBe(true);
  });

  test("side by side pairs removed lines with the added lines after them", () => {
    const split = splitRows(unifiedRows(parsed, old, next, new Map()));
    const changed = split.filter((r) => r.t === "pair" && (r.left?.kind !== "ctx" || r.right?.kind !== "ctx"));
    expect(changed).toEqual([
      { t: "pair", left: { kind: "del", n: 10, text: "line 10" }, right: { kind: "add", n: 10, text: "LINE 10" } },
      { t: "pair", left: { kind: "del", n: 30, text: "line 30" }, right: null },
    ]);
    expect(findPair(split, "old", 30)).toBe(split.indexOf(changed[1]!));
  });

  test("without contents there are no gaps, only hunks", () => {
    const rows = unifiedRows(parsed, null, null, new Map());
    expect(rows.filter((r) => r.t === "gap")).toHaveLength(0);
    expect(rows.filter((r) => r.t === "hunk")).toHaveLength(2);
    expect(findLine(rows, "new", 10)).toBe(3);
  });

  test("a new file and binary or mode-only patches", () => {
    const added = parseFilePatch("diff --git a/n b/n\nnew file mode 100644\n--- /dev/null\n+++ b/n\n@@ -0,0 +1,2 @@\n+a\n+b\n");
    const rows = unifiedRows(added, null, ["a", "b"], new Map());
    expect(rows.map((r) => r.t)).toEqual(["hunk", "line", "line"]);
    expect(parseFilePatch("diff --git a/x b/x\nBinary files a/x and b/x differ\n").binary).toBe(true);
    expect(parseFilePatch("diff --git a/x b/x\nold mode 100644\nnew mode 100755\n").notes).toEqual(["old mode 100644", "new mode 100755"]);
  });

  test("helpers", () => {
    expect(splitLines("a\r\nb\n")).toEqual(["a", "b"]);
    expect(splitLines(null)).toBeNull();
    expect(untab("a\tb")).toBe("a   b");
    expect(untab("\tx")).toBe("    x");
  });
});

describe("search", () => {
  const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -3 +3 @@\n-const Foo = 1;\n+const fooBar = 2;\n";
  test("finds a case-insensitive literal in changed lines only", () => {
    const index = buildIndex(patch, false);
    expect(search(index, "FOO").hits).toEqual([
      { path: "a.ts", side: "old", line: 3, text: "const Foo = 1;" },
      { path: "a.ts", side: "new", line: 3, text: "const fooBar = 2;" },
    ]);
    expect(search(index, "a OR b").total).toBe(0);
    expect(search(index, "  ").total).toBe(0);
  });
  test("snippets and match splitting", () => {
    expect(snippet("x".repeat(500) + "needle" + "y".repeat(500), "needle")).toContain("needle");
    expect(splitMatches("aXbxc", "x")).toEqual(["a", "X", "b", "x", "c"]);
  });
});

describe("runtime-free helpers", () => {
  test("utf8Decode matches TextDecoder, including malformed input", () => {
    for (const s of ["plain", "naïve café", "日本語", "emoji 😀", ""]) {
      expect(utf8Decode([...new TextEncoder().encode(s)])).toBe(s);
    }
    const bad = [0x61, 0xc3, 0x28, 0xff, 0xe2, 0x82];
    expect(utf8Decode(bad)).toBe(new TextDecoder().decode(new Uint8Array(bad)));
    expect(unquotePath('"a/caf\\303\\251 \\"x\\".txt"')).toBe('a/café "x".txt');
    expect(unquotePath('"a/😀\\t"')).toBe("a/😀\t");
  });
  test("naturalCompare orders numbers by value, ignoring case", () => {
    expect(["file10", "File2", "file1"].sort(naturalCompare)).toEqual(["file1", "File2", "file10"]);
  });
});

describe("repository (real git)", () => {
  let dir: string;
  const sh = (...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };
  // The same shape as Herdr's exec / readTextFile.
  const host = (): Host => ({
    run: async (cmd, args) => {
      const r = Bun.spawnSync([cmd, ...args], { cwd: dir });
      return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
    },
    readFile: async (p) => {
      const f = Bun.file(p);
      return (await f.exists()) ? f.text() : null;
    },
  });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "gdv-herdr-"));
    sh("init", "-q", "-b", "main");
    await writeFile(join(dir, "a.txt"), "one\n");
    await writeFile(join(dir, ".gitignore"), "secret.env\n");
    sh("add", ".");
    sh("commit", "-q", "-m", "init");
    sh("checkout", "-q", "-b", "feature");
    await writeFile(join(dir, "a.txt"), "one\ntwo\n");
    sh("commit", "-q", "-am", "two");
    await writeFile(join(dir, "a.txt"), "one\ntwo\nthree\n");
    sh("add", "a.txt");
    await writeFile(join(dir, "new.txt"), "fresh\n");
    await writeFile(join(dir, "secret.env"), "nope\n");
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  test("info, refs and defaults", async () => {
    const repo = await openRepo(host());
    const info = await repo.info();
    expect(info.currentBranch).toBe("feature");
    expect(info.uncommitted).toBe(2); // a.txt staged, new.txt untracked; secret.env ignored
    const refs = await repo.refs();
    expect(refs.branches.map((b) => b.name).sort()).toEqual(["feature", "main"]);
    expect(defaultRefs(info, refs)).toEqual({ base: "main", head: WORKTREE });
  });

  test("compare and file diffs for the working tree and the index", async () => {
    const repo = await openRepo(host());
    const wt = await repo.compare("main", WORKTREE);
    expect(wt.files.map((f) => [f.status, f.path, f.additions])).toEqual([
      ["modified", "a.txt", 2],
      ["added", "new.txt", 1],
    ]);
    const staged = await repo.compare("HEAD", INDEX);
    expect(staged.files.map((f) => f.path)).toEqual(["a.txt"]);
    const fresh = await repo.fileDiff(wt.base.sha, WORKTREE, "new.txt", null);
    expect(fresh.newContent).toBe("fresh\n");
    expect(fresh.patch).toContain("+fresh");
    const a = await repo.fileDiff(wt.base.sha, WORKTREE, "a.txt", null);
    expect(a.oldContent).toBe("one\n");
    expect(a.newContent).toBe("one\ntwo\nthree\n");
    // Never a file git doesn't list, whatever the path says.
    await expect(repo.fileDiff(wt.base.sha, WORKTREE, "../etc/passwd", null)).rejects.toThrow("Invalid path");
    const ignored = await repo.fileDiff(wt.base.sha, WORKTREE, "secret.env", null);
    expect(ignored.newContent).toBeNull();
  });

  test("search over the whole comparison, untracked files included", async () => {
    const repo = await openRepo(host());
    const p = await repo.patch("main", WORKTREE, 1000);
    const r = search(buildIndex(p.patch, p.partial), "fresh");
    expect(r.hits).toEqual([{ path: "new.txt", side: "new", line: 1, text: "fresh" }]);
  });

  test("graph and revision checks", async () => {
    const repo = await openRepo(host());
    const g = await repo.graph(10);
    expect(g.commits.map((c) => c.subject)).toEqual(["two", "init"]);
    expect(g.commits[0]!.refs).toEqual(expect.arrayContaining([{ kind: "branch", name: "feature" }]));
    await expect(repo.resolve("--output=x")).rejects.toThrow("Invalid revision");
    await expect(repo.resolve("nope")).rejects.toThrow("Unknown revision");
  });

  test("a host started in a subfolder still works on repository paths", async () => {
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "sub", "inner.txt"), "inside\n");
    const h = host();
    const sub: Host = {
      ...h,
      run: async (cmd, args) => {
        const r = Bun.spawnSync([cmd, ...args], { cwd: join(dir, "sub") });
        return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
      },
    };
    const repo = await openRepo(sub);
    const wt = await repo.compare("main", WORKTREE);
    expect(wt.files.map((f) => f.path)).toEqual(["a.txt", "new.txt", "sub/inner.txt"]);
    const fresh = await repo.fileDiff(wt.base.sha, WORKTREE, "new.txt", null);
    expect(fresh.newContent).toBe("fresh\n");
    const a = await repo.fileDiff(wt.base.sha, WORKTREE, "a.txt", null);
    expect(a.patch).toContain("+three");
  });

  test("not a repository", async () => {
    const outside = await mkdtemp(join(tmpdir(), "gdv-none-"));
    const h = host();
    await expect(openRepo({ ...h, run: (c, a) => h.run(c, a).then((r) => (a.includes("--show-toplevel") ? { ...r, code: 128 } : r)) })).rejects.toThrow("Not a git repository");
    await rm(outside, { recursive: true, force: true });
  });
});
