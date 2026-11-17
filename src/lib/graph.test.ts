import { describe, expect, test } from "bun:test";
import type { GraphCommit } from "@/shared/api";
import { commitsInRange, layoutGraph } from "./graph";

const c = (sha: string, ...parents: Array<string>): GraphCommit => ({
  sha,
  shortSha: sha,
  parents,
  refs: [],
  subject: sha,
  author: "",
  date: "",
});

//   m        merge of f2 into b
//   |\
//   b f2
//   | f1
//   |/
//   a
//   root
const history = [c("m", "b", "f2"), c("f2", "f1"), c("b", "a"), c("f1", "a"), c("a", "root"), c("root")];

describe("commitsInRange", () => {
  test("a single commit against its parent", () => {
    expect([...commitsInRange(history, "a", "b")]).toEqual(["b"]);
  });

  test("follows every parent of a merge, excluding the base's ancestors", () => {
    expect(new Set(commitsInRange(history, "a", "m"))).toEqual(new Set(["m", "b", "f2", "f1"]));
  });

  test("an unrelated base excludes only what it can reach", () => {
    expect(new Set(commitsInRange(history, "b", "f2"))).toEqual(new Set(["f2", "f1"]));
  });

  test("base outside the loaded window excludes nothing", () => {
    expect(new Set(commitsInRange(history, "zzz", "f1"))).toEqual(new Set(["f1", "a", "root"]));
  });

  test("missing head gives an empty range", () => {
    expect(commitsInRange(history, "a", null).size).toBe(0);
  });
});

describe("layoutGraph", () => {
  test("a merge's second parent opens a new lane that rejoins at the fork point", () => {
    const rows = layoutGraph(history);
    expect(rows.map((r) => r.column)).toEqual([0, 1, 0, 1, 0, 0]);
  });
});
