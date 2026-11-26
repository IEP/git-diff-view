import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layoutGraph } from "@/lib/graph";
import type { GraphCommit } from "@/shared/api";
import { App } from "./app";
import { graphCells } from "./graph";

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const commit = (sha: string, ...parents: Array<string>): GraphCommit => ({ sha, shortSha: sha, parents, refs: [], subject: sha, author: "t", date: "2026-01-01T00:00:00Z" });
/** Each row's graph cells as one string, trailing blanks dropped. */
const draw = (commits: Array<GraphCommit>) => layoutGraph(commits).map((r) => graphCells(r).map((c) => c.text).join("").trimEnd());

describe("graphCells", () => {
  test("a straight line is one dot per row", () => {
    expect(draw([commit("c", "b"), commit("b", "a"), commit("a")])).toEqual(["●", "●", "●"]);
  });

  test("a branch splits off and merges back", () => {
    // m merges f into main; f and b both sit on a. f reserved a's lane first, so b joins it (┤).
    expect(draw([commit("m", "b", "f"), commit("f", "a"), commit("b", "a"), commit("a")])).toEqual([
      "●─╮",
      "│ ●",
      "●─┤",
      "  ●",
    ]);
  });

  test("an octopus fans out, and an edge passes under a lane without joining it", () => {
    // c's edge back to lane 0 crosses b's lane: drawn as a plain │, not ┼.
    expect(draw([commit("o", "a", "b", "c"), commit("c", "a"), commit("b", "a"), commit("a")])).toEqual([
      "●─┬─╮",
      "├─│─●",
      "├─●",
      "●",
    ]);
  });

  test("a parent outside the window keeps its lane open", () => {
    expect(draw([commit("b", "a", "z"), commit("a")])).toEqual(["●─╮", "● │"]);
    expect(draw([commit("o", "a", "b", "c"), commit("c", "a"), commit("b", "x"), commit("a")])).toEqual(["●─┬─╮", "├─│─●", "│ ●", "● │"]);
  });
});

describe("commit graph screen (real repository)", () => {
  let dir: string;
  const sh = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "tui-graph-"));
    sh("init", "-q", "-b", "main");
    for (const [name, text] of [["a.txt", "one\n"], ["b.txt", "two\n"]] as const) {
      await writeFile(join(dir, name), text);
      sh("add", name);
      sh("commit", "-qm", `add ${name}`);
    }
    sh("checkout", "-qb", "topic", "HEAD~1");
    await writeFile(join(dir, "c.txt"), "three\n");
    sh("add", "c.txt");
    sh("commit", "-qm", "add c.txt");
    sh("checkout", "-q", "main");
    sh("merge", "-q", "--no-ff", "topic", "-m", "merge topic\x1b[31m");
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  const open = async () => {
    const app = new App(dir, {}, () => {}, { cols: 100, rows: 20 });
    await app.load();
    app.key("c");
    await app.loadGraph();
    return app;
  };

  test("c lists the history with its graph, starting on the head", async () => {
    const app = await open();
    const screen = app.frame(100, 20).map(plain);
    const text = screen.join("\n");
    expect(text).toContain("4 commits");
    expect(text).toMatch(/▌B ●─╮ +\w+ HEAD main merge topic␛\[31m/); // escape drawn inert
    expect(text).toMatch(/┃ ├─● +\w+ topic add c\.txt/); // in main~1..HEAD, joining add a.txt's lane
    for (const row of screen) expect(Bun.stringWidth(row)).toBe(100);
  });

  test("enter diffs a commit against its parent; b and h move one end", async () => {
    const app = await open();
    app.key("down"); // the newer of the two side commits
    const picked = app.state.graph!.commits![1]!;
    app.key("enter");
    expect(app.state.graph).toBeNull();
    expect([app.state.base, app.state.head]).toEqual([picked.parents[0]!, picked.sha]);

    const app2 = await open();
    app2.key("end"); // the first commit
    app2.key("b");
    const first = sh("rev-list", "--max-parents=0", "HEAD");
    expect(app2.state.base).toBe(first);
    expect(app2.state.graph).not.toBeNull(); // stays open to pick the other end
    app2.key("enter");
    expect(plain(app2.frame(100, 20).at(-1)!)).toContain("is the first commit");
  });

  test("clicks pick a commit and a second click opens it; esc closes", async () => {
    const app = await open();
    app.key("mouse click 10 5"); // body row 3 → list row 2
    expect(app.state.graph!.cursor).toBe(2);
    app.key("mouse click 10 5");
    expect(app.state.graph).toBeNull();
    app.key("c");
    app.key("escape");
    expect(app.state.graph).toBeNull();
  });
});
