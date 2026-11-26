import { describe, expect, test } from "bun:test";
import { unquotePath } from "@/shared/gitText";
import { expand, findLine, findPair, inlineChanges, inlineMarks, parseFilePatch, segments, splitLines, splitRows, unifiedRows, untab } from "./diffModel";
import { highlightFile, highlightLines, languageFor, MAX_SYNTAX_CHARS, type SyntaxKind } from "./syntax";

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

describe("changed words", () => {
  test("marks only the words that differ", () => {
    const c = inlineChanges("const x = foo(a, b);", "const x = bar(a, b, c);")!;
    expect(c.del.map(([f, t]) => "const x = foo(a, b);".slice(f, t))).toEqual(["foo"]);
    expect(c.add.map(([f, t]) => "const x = bar(a, b, c);".slice(f, t))).toEqual(["bar", ", c"]);
  });

  test("leaves rewritten, identical and oversized lines alone", () => {
    expect(inlineChanges("alpha beta gamma", "one two three")).toBeNull();
    expect(inlineChanges("same", "same")).toBeNull();
    expect(inlineChanges("x".repeat(2000), "y".repeat(2000))).toBeNull();
  });

  test("pairs removed and added lines the way split view does, on untabbed text", () => {
    const patch = ["@@ -1,2 +1,2 @@", "-\tlet a = 1;", "-keep", "+\tlet a = 2;", "+other"].join("\n");
    const marks = inlineMarks(unifiedRows(parseFilePatch(patch), null, null, new Map()));
    expect(marks.get("del1")).toEqual([[12, 13]]);
    expect(marks.get("add1")).toEqual([[12, 13]]);
    expect(marks.has("del2")).toBe(false); // "keep" → "other" is a rewrite
  });

  test("segments merge changed words with search matches", () => {
    const seg = (text: string, changed: boolean, hit: boolean, kind: SyntaxKind | null = null) => ({ text, changed, hit, kind });
    expect(segments("foo bar baz", [[4, 7]], "a")).toEqual([
      seg("foo ", false, false),
      seg("b", true, false),
      seg("a", true, true),
      seg("r", true, false),
      seg(" b", false, false),
      seg("a", false, true),
      seg("z", false, false),
    ]);
    expect(segments("plain", undefined, "")).toEqual([seg("plain", false, false)]);
    // Syntax runs cut too, and are dropped when they don't fit the text.
    expect(segments("let x = 1", [[4, 5]], "", [[0, 3, "keyword"], [8, 9, "number"]])).toEqual([
      seg("let", false, false, "keyword"),
      seg(" ", false, false),
      seg("x", true, false),
      seg(" = ", false, false),
      seg("1", false, false, "number"),
    ]);
    expect(segments("ab", undefined, "", [[0, 5, "string"]])).toEqual([seg("ab", false, false)]);
  });
});

describe("syntax colors", () => {
  test("picks a grammar by extension or name", () => {
    expect(languageFor("src/App.tsx")).toBe("tsx");
    expect(languageFor("a/b/Makefile")).toBe("makefile");
    expect(languageFor("README")).toBeNull();
    expect(languageFor(".gitignore")).toBeNull();
    expect(languageFor("x.unknownext")).toBeNull();
  });

  test("gives runs per line, including across lines", () => {
    const lines = ["const a = 1; /* one", "two */ let s = `x", "y`;"];
    const runs = highlightLines("ts", lines);
    expect(runs).toHaveLength(3);
    const text = (i: number, kind: string) => runs[i]!.filter((r) => r[2] === kind).map(([f, t]) => lines[i]!.slice(f, t));
    expect(text(0, "keyword")).toEqual(["const"]);
    expect(text(0, "number")).toEqual(["1"]);
    expect(text(0, "comment")).toEqual(["/* one"]);
    expect(text(1, "comment")).toEqual(["two */"]);
    expect(text(1, "string")).toEqual(["`x"]);
    expect(text(2, "string")).toEqual(["y`"]);
  });

  test("a whole file at once: a comment spanning a blank line stays a comment", () => {
    const lines = ["/* start", "", "still comment */", "const x = 1;"];
    const runs = highlightFile("ts", lines)!;
    expect(runs[2]!.some((r) => r[2] === "comment")).toBe(true);
    expect(runs[3]!.some((r) => r[2] === "keyword")).toBe(true);
    // Too large: plain, not slow.
    expect(highlightFile("ts", ["x".repeat(MAX_SYNTAX_CHARS + 1)])).toBeNull();
  });
});

test("quoted git paths decode octal UTF-8 and C escapes", () => {
  expect(unquotePath('"a/caf\\303\\251 \\"x\\".txt"')).toBe('a/café "x".txt');
  expect(unquotePath('"a/😀\\t"')).toBe("a/😀\t");
  // A malformed byte sequence becomes U+FFFD, as TextDecoder does.
  expect(unquotePath('"a/\\303("')).toBe("a/\ufffd(");
});
