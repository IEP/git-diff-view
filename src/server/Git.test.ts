import { describe, expect, test } from "bun:test";
import { buildTree, visibleRows } from "@/lib/tree";
import type { FileChange } from "@/shared/api";
import { parseNameStatus, parseNumstat } from "./Git";

describe("parseNameStatus", () => {
  test("handles plain, renamed and copied entries", () => {
    const out = "M\0src/a.ts\0R087\0docs/old.md\0docs/new.md\0A\0file with space.txt\0D\0gone\0";
    expect(parseNameStatus(out)).toEqual([
      { status: "modified", path: "src/a.ts", oldPath: null, similarity: null },
      { status: "renamed", path: "docs/new.md", oldPath: "docs/old.md", similarity: 87 },
      { status: "added", path: "file with space.txt", oldPath: null, similarity: null },
      { status: "deleted", path: "gone", oldPath: null, similarity: null },
    ]);
  });
});

describe("parseNumstat", () => {
  test("keys renames by new path and flags binaries", () => {
    const out = "3\t1\tsrc/a.ts\0" + "1\t0\t\0docs/old.md\0docs/new.md\0" + "-\t-\tlogo.bin\0";
    const stats = parseNumstat(out);
    expect(stats.get("src/a.ts")).toEqual({ additions: 3, deletions: 1, binary: false, oldPath: null });
    expect(stats.get("docs/new.md")).toEqual({ additions: 1, deletions: 0, binary: false, oldPath: "docs/old.md" });
    expect(stats.get("logo.bin")).toEqual({ additions: 0, deletions: 0, binary: true, oldPath: null });
  });
});

describe("buildTree", () => {
  const change = (path: string): FileChange => ({
    status: "modified",
    path,
    oldPath: null,
    similarity: null,
    additions: 1,
    deletions: 0,
    binary: false,
  });

  test("compacts single-child directory chains and sorts dirs before files", () => {
    const tree = buildTree([
      change("z.txt"),
      change("src/main/java/com/acme/App.java"),
      change("src/main/java/com/acme/web/Ctrl.java"),
      change("src/util.ts"),
    ]);
    const rows = visibleRows(tree, new Set()).map((r) => `${"  ".repeat(r.depth)}${r.node.name}`);
    expect(rows).toEqual([
      "src",
      "  main/java/com/acme",
      "    web",
      "      Ctrl.java",
      "    App.java",
      "  util.ts",
      "z.txt",
    ]);
  });

  test("collapsed directories hide their children", () => {
    const tree = buildTree([change("a/b/c.ts"), change("a/d.ts")]);
    expect(visibleRows(tree, new Set(["a"])).map((r) => r.node.name)).toEqual(["a"]);
  });
});
