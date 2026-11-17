import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INDEX, WORKTREE } from "@/shared/api";
import { DiffIndex, DiffSearch, parsePatch, unquotePath } from "./DiffIndex";
import { Git } from "./Git";

describe("parsePatch", () => {
  test("numbers removed lines on the base side and added lines on the head side", () => {
    const patch = [
      "diff --git a/f.txt b/f.txt",
      "index 1..2 100644",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -2 +2,2 @@ ctx",
      "-old",
      "+new one",
      "+new two",
      "@@ -10,0 +12 @@",
      "+tail",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    expect(parsePatch(patch)).toEqual([
      { path: "f.txt", side: "old", line: 2, text: "old" },
      { path: "f.txt", side: "new", line: 2, text: "new one" },
      { path: "f.txt", side: "new", line: 3, text: "new two" },
      { path: "f.txt", side: "new", line: 12, text: "tail" },
    ]);
  });

  test("a removed '-- x' line is content, not a header", () => {
    const patch = "diff --git a/s b/s\n--- a/s\n+++ b/s\n@@ -2 +1,0 @@\n--- x\n";
    expect(parsePatch(patch)).toEqual([{ path: "s", side: "old", line: 2, text: "-- x" }]);
  });

  test("paths: spaces (trailing tab), quoting, renames and deletions", () => {
    const patch = [
      "diff --git a/sp ace.txt b/sp ace.txt",
      "--- a/sp ace.txt\t",
      "+++ b/sp ace.txt\t",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      'diff --git "a/q\\"uo.txt" "b/q\\"uo.txt"',
      '--- "a/q\\"uo.txt"',
      '+++ "b/q\\"uo.txt"',
      "@@ -0,0 +1 @@",
      "+q",
      "diff --git a/old.txt b/new.txt",
      "rename from old.txt",
      "rename to new.txt",
      "--- a/old.txt",
      "+++ b/new.txt",
      "@@ -4,0 +5 @@",
      "+r5",
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100644",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "",
    ].join("\n");
    expect(parsePatch(patch).map((r) => `${r.side}:${r.path}:${r.line}`)).toEqual([
      "old:sp ace.txt:1",
      "new:sp ace.txt:1",
      'new:q"uo.txt:1',
      "new:new.txt:5",
      "old:gone.txt:1",
    ]);
  });

  test("unquotePath decodes C escapes and octal UTF-8 bytes", () => {
    expect(unquotePath('"a/tab\\there"')).toBe("a/tab\there");
    expect(unquotePath('"a/caf\\303\\251"')).toBe("a/café");
    expect(unquotePath("a/plain")).toBe("a/plain");
  });
});

describe("DiffIndex", () => {
  const index = DiffIndex.build([
    { path: "a.ts", side: "new", line: 1, text: "const fooBar = 50%_off;" },
    { path: "a.ts", side: "old", line: 3, text: 'say("hi")' },
    { path: "b.ts", side: "new", line: 7, text: "Hello World" },
    { path: "b.ts", side: "new", line: 8, text: "   " },
  ]);
  afterAll(() => index.close());
  const find = (q: string) => index.search(q).hits.map((h) => `${h.path}:${h.line}`);

  test("substring, case-insensitive", () => {
    expect(find("oobar")).toEqual(["a.ts:1"]);
    expect(find("WORLD")).toEqual(["b.ts:7"]);
  });
  test("query text is literal: quotes, LIKE wildcards and FTS operators", () => {
    expect(find('("hi")')).toEqual(["a.ts:3"]);
    expect(find("%_o")).toEqual(["a.ts:1"]);
    expect(find("50%")).toEqual(["a.ts:1"]);
    expect(find("_x")).toEqual([]);
    expect(find("foo OR hello")).toEqual([]);
    expect(find("a*")).toEqual([]);
  });
  test("queries shorter than a trigram still work", () => {
    expect(find("lo")).toEqual(["b.ts:7"]);
    expect(find("%")).toEqual(["a.ts:1"]);
  });
  test("counts every match but returns at most the limit", () => {
    expect(index.search("o", 1)).toMatchObject({ total: 2, hits: [{ path: "a.ts" }] });
  });
  test("tabs in lines and queries", () => {
    const tabs = DiffIndex.build([{ path: "Makefile", side: "new", line: 2, text: "\t$(CC) -o app" }]);
    expect(tabs.search("\t$(CC)").hits).toHaveLength(1);
    tabs.close();
  });
  test("stops at the row and character limits and says so", () => {
    const rows = ["one", "two", "three"].map((text, i) => ({ path: "f", side: "new" as const, line: i + 1, text }));
    expect(DiffIndex.build(rows).partial).toBe(false);
    const byRows = DiffIndex.build(rows, { maxRows: 2 });
    expect([byRows.partial, byRows.search("t").total]).toEqual([true, 1]);
    const byChars = DiffIndex.build(rows, { maxChars: 7 });
    expect([byChars.partial, byChars.search("o").total]).toEqual([true, 2]);
    byRows.close();
    byChars.close();
  });
  test("cuts long lines to a window around the match", () => {
    const long = DiffIndex.build([{ path: "m.js", side: "new", line: 1, text: "x".repeat(1000) + "needle" + "y".repeat(1000) }]);
    const [hit] = long.search("needle").hits;
    expect(hit!.text).toContain("needle");
    expect(hit!.text.length).toBeLessThan(260);
    long.close();
  });
});

describe("DiffSearch (real repository)", () => {
  let dir: string;
  let first: string;
  let second: string;
  // One runtime for the whole suite, so the index cache carries over between searches.
  let runtime: ManagedRuntime.ManagedRuntime<DiffSearch | Git, unknown>;
  const sh = (...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], {
      cwd: dir,
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };
  const search = (base: string, head: string, q: string) =>
    runtime.runPromise(Effect.flatMap(Effect.service(DiffSearch), (s) => s.search(base, head, q)));
  const hits = async (base: string, head: string, q: string) =>
    (await search(base, head, q)).hits.map((h) => `${h.side}:${h.path}:${h.line}:${h.text}`);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "gdv-search-"));
    sh("init", "-q", "-b", "main");
    // A user's diff config must not change the paths we parse.
    sh("config", "diff.mnemonicPrefix", "true");
    await writeFile(join(dir, "app.ts"), "const alpha = 1;\nconst beta = 2;\n");
    await writeFile(join(dir, "old name.txt"), "one\ntwo\nthree\nfour\n");
    await writeFile(join(dir, ".gitignore"), "secret.env\n");
    sh("add", ".");
    sh("commit", "-q", "-m", "init");
    first = sh("rev-parse", "HEAD");
    await writeFile(join(dir, "app.ts"), "const alpha = 1;\nconst gamma = 3;\n");
    sh("mv", "old name.txt", "new name.txt");
    await writeFile(join(dir, "new name.txt"), "one\ntwo\nthree\nfour\nfive needle\n");
    sh("add", "-A");
    sh("commit", "-q", "-m", "second");
    second = sh("rev-parse", "HEAD");
    // Uncommitted: a staged edit, an unstaged edit and an untracked file.
    await writeFile(join(dir, "app.ts"), "const alpha = 1;\nconst gamma = 3;\nconst staged = true;\n");
    sh("add", "app.ts");
    await writeFile(join(dir, "app.ts"), "const alpha = 1;\nconst gamma = 3;\nconst staged = true;\nconst unstaged = true;\n");
    await writeFile(join(dir, "fresh.txt"), "brand new needle\n");
    await writeFile(join(dir, "secret.env"), "needle=hidden\n");
    runtime = ManagedRuntime.make(DiffSearch.layer.pipe(Layer.provideMerge(Git.layer(dir))));
  });
  afterAll(async () => {
    await runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  test("between two commits: both sides, renamed path with a space", async () => {
    expect(await hits(first, second, "eta")).toEqual(["old:app.ts:2:const beta = 2;"]);
    expect(await hits(first, second, "needle")).toEqual(["new:new name.txt:5:five needle"]);
  });

  test("a reversed range swaps the sides", async () => {
    expect(await hits(second, first, "gamma")).toEqual(["old:app.ts:2:const gamma = 3;"]);
  });

  test("working tree: unstaged and untracked lines, never ignored files", async () => {
    expect(await hits("HEAD", WORKTREE, "needle")).toEqual(["new:fresh.txt:1:brand new needle"]);
    expect(await hits("HEAD", WORKTREE, "staged")).toEqual(["new:app.ts:3:const staged = true;", "new:app.ts:4:const unstaged = true;"]);
    expect(await hits(INDEX, WORKTREE, "staged")).toEqual(["new:app.ts:4:const unstaged = true;"]);
    expect(await hits(WORKTREE, "HEAD", "needle")).toEqual(["old:fresh.txt:1:brand new needle"]);
  });

  test("picks up working-tree edits between searches (cached index is rebuilt)", async () => {
    expect(await hits("HEAD", WORKTREE, "later")).toEqual([]);
    expect(await hits("HEAD", WORKTREE, "later")).toEqual([]); // served from the cache
    await writeFile(join(dir, "fresh.txt"), "brand new needle\nadded later\n");
    expect(await hits("HEAD", WORKTREE, "later")).toEqual(["new:fresh.txt:2:added later"]);
  });

  test("Git.patch stops at the line limit using numstat, before reading the patch", async () => {
    const patchOf = (max: number) =>
      runtime.runPromise(Effect.flatMap(Effect.service(Git), (g) => g.patch(first, second, max)));
    const full = await patchOf(1000);
    expect(full.partial).toBe(false);
    expect(parsePatch(full.patch).map((r) => r.path)).toEqual(["app.ts", "app.ts", "new name.txt"]);
    // app.ts (2 lines) no longer fits; the rename (1 line) still does, both of its paths named.
    const cut = await patchOf(1);
    expect(cut.partial).toBe(true);
    expect(parsePatch(cut.patch)).toEqual([{ path: "new name.txt", side: "new", line: 5, text: "five needle" }]);
    // Untracked files count too.
    const wt = await runtime.runPromise(Effect.flatMap(Effect.service(Git), (g) => g.patch("HEAD", WORKTREE, 2)));
    expect(wt.partial).toBe(true);
  });

  test("bad revisions fail like compare does", async () => {
    await expect(search("-x", "HEAD", "a")).rejects.toThrow();
  });
});
