import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clean, fit } from "./ansi";
import { App } from "./app";
import { layoutFor } from "./state";
import { decodeKeys } from "./term";

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("decodeKeys", () => {
  test("names arrows, function keys and controls, and splits a burst", () => {
    expect(decodeKeys("\x1b[A\x1b[B")).toEqual(["up", "down"]);
    expect(decodeKeys("\x1b[18~\x1b[18;2~")).toEqual(["f7", "shift+f7"]);
    expect(decodeKeys("j\r\t\x7f\x03")).toEqual(["j", "enter", "tab", "backspace", "ctrl+c"]);
    expect(decodeKeys("\x1b")).toEqual(["escape"]);
    expect(decodeKeys("日本")).toEqual(["日", "本"]);
  });
  test("mouse reports become clicks, drags, releases and wheel turns; other buttons are dropped", () => {
    expect(decodeKeys("\x1b[<0;12;5M\x1b[<0;12;5m")).toEqual(["mouse click 12 5", "mouse release 12 5"]);
    expect(decodeKeys("\x1b[<64;3;4M\x1b[<69;3;4M")).toEqual(["mouse wheelup 3 4", "mouse wheeldown 3 4"]);
    expect(decodeKeys("\x1b[<2;1;1M")).toEqual([]);
    expect(decodeKeys("\x1b[<32;20;5M\x1b[<0;20;5m")).toEqual(["mouse drag 20 5", "mouse release 20 5"]);
  });
  test("pasted text arrives as characters, without its line breaks", () => {
    expect(decodeKeys("\x1b[200~a\nb\x1b[201~")).toEqual(["a", " ", "b"]);
  });
});

describe("ansi", () => {
  test("repository text can't send escape sequences to the terminal", () => {
    expect(clean("a\x1b[2Jb\x07\x9b")).toBe("a␛[2Jb␇�");
    expect(plain(fit([{ text: "\x1b]52;c;evil\x07" }], 20))).not.toContain("\x1b");
  });
  test("fit cuts and pads by display columns", () => {
    expect(plain(fit([{ text: "日本語" }], 5))).toBe("日本 ");
    expect(plain(fit([{ text: "abcdef" }], 4, undefined, 2))).toBe("cdef");
    expect(plain(fit([{ text: "ab" }], 4))).toBe("ab  ");
  });
});

describe("terminal viewer (real repository)", () => {
  let dir: string;
  const sh = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", dir, ...args], { stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString();
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "tui-"));
    sh("init", "-q", "-b", "main");
    await writeFile(join(dir, "app.ts"), Array.from({ length: 60 }, (_, i) => `const v${i} = ${i};`).join("\n") + "\n");
    await writeFile(join(dir, "notes.md"), "one\ntwo\n");
    sh("add", "-A");
    sh("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    await writeFile(join(dir, "app.ts"), Array.from({ length: 60 }, (_, i) => (i === 40 ? "const changed = 40;" : `const v${i} = ${i};`)).join("\n") + "\n");
    await writeFile(join(dir, "new.txt"), "fresh\n");
    await writeFile(join(dir, ".env"), "SECRET=1\n");
    await writeFile(join(dir, ".gitignore"), ".env\n");
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  const open = async (cols = 100, rows = 30) => {
    const app = new App(dir, {}, () => {}, { cols, rows });
    await app.load();
    return app;
  };

  test("opens on main → working tree with untracked files, ignored ones left out", async () => {
    const app = await open();
    const screen = app.frame(100, 30).map(plain);
    expect(screen).toHaveLength(30);
    expect(screen[0]).toContain("main → Working tree");
    const text = screen.join("\n");
    expect(text).toContain("app.ts");
    expect(text).toContain("new.txt");
    expect(text).toContain(".gitignore");
    expect(app.state.compare?.files.map((f) => f.path)).toEqual([".gitignore", "app.ts", "new.txt"]);
    // The untracked file's text is read from disk.
    expect(text).toContain("1 +.env");
    app.select("app.ts");
    await app.loadFile();
    const diff = app.frame(100, 30).map(plain).join("\n");
    expect(diff).toContain("const changed = 40;");
    expect(diff).toMatch(/⋯ \d+ unchanged lines/);
    for (const row of screen) expect(Bun.stringWidth(row)).toBe(100);
  });

  test("keys move through files, toggle the layout and open gaps", async () => {
    const app = await open();
    app.select("app.ts");
    await app.loadFile();
    app.key("tab");
    expect(app.state.focus).toBe("diff");
    app.key("s");
    expect(app.state.mode).toBe("unified");
    let text = app.frame(100, 30).map(plain).join("\n");
    expect(text).toMatch(/41 +-const v40 = 40;/);
    expect(text).toMatch(/41 +\+const changed = 40;/);
    // Open the first gap completely.
    app.key("g");
    app.key("enter");
    text = app.frame(100, 30).map(plain).join("\n");
    expect(text).toContain("const v0 = 0;");
    app.key(".");
    await app.loadFile();
    expect(app.state.selected).not.toBe("app.ts");
  });

  test("search finds changed lines and jumps to them", async () => {
    const app = await open();
    for (const k of ["/", ..."CHANGED", "enter"]) app.key(k);
    await app.runSearch();
    expect(app.state.search.result?.total).toBe(1);
    app.key("enter");
    expect(app.state.focus).toBe("diff");
    const text = app.frame(100, 30).map(plain).join("\n");
    expect(text).toContain("1 line in 1 file");
  });

  test("picking a base from the picker re-compares", async () => {
    const app = await open();
    for (const k of ["b", ..."HEAD", "enter"]) app.key(k);
    expect(app.state.base).toBe("HEAD");
    await app.loadCompare();
    expect(plain(app.frame(100, 30)[0]!)).toContain("HEAD → Working tree");
  });

  test("a live refresh keeps the tree cursor on its row", async () => {
    const app = await open();
    app.key("end");
    const row = () => app.frame(100, 30) && app.state.treeCursor;
    expect(row()).toBe(2); // new.txt, below the open .gitignore
    await writeFile(join(dir, "aaa.txt"), "sorts first\n");
    await app.refresh({ force: true });
    expect(app.state.compare?.files.map((f) => f.path)).toContain("aaa.txt");
    expect(row()).toBe(3); // still new.txt, one row lower
    await rm(join(dir, "aaa.txt"));
  });

  test("clicks open files, gaps and pickers; the wheel scrolls", async () => {
    const app = await open();
    // Tree rows start on screen row 3 (header, pane title): row 4 is app.ts.
    app.key("mouse click 5 4");
    expect(app.state.selected).toBe("app.ts");
    await app.loadFile();
    // The diff's first row (screen row 3) is the gap above the change: a click opens it.
    app.key("mouse click 60 3");
    expect(app.state.focus).toBe("diff");
    expect(app.frame(100, 30).map(plain).join("\n")).toContain("const v0 = 0;");
    app.key("mouse wheeldown 60 10");
    app.frame(100, 30);
    expect(app.state.diffScroll).toBe(3);
    // The header's head label opens its picker; clicking an entry picks it.
    const head = plain(app.frame(100, 30)[0]!).indexOf("Working tree");
    app.key(`mouse click ${head + 2} 1`);
    expect(app.state.picker?.which).toBe("head");
    app.frame(100, 30);
    app.key("mouse click 10 5"); // screen row 5 is the first entry: Working tree
    expect(app.state.picker).toBeNull();
    expect(app.state.head).toBe(":worktree");
  });

  test("the buttons on a ⋯ row show 20 lines from its top or bottom", async () => {
    const app = await open();
    app.select("app.ts");
    await app.loadFile();
    const clickOn = (label: string) => {
      const screen = app.frame(100, 30).map(plain);
      const y = screen.findIndex((r) => r.includes(label));
      app.key(`mouse click ${screen[y]!.indexOf(label) + 2} ${y + 1}`);
      return app.frame(100, 30).map(plain).join("\n");
    };
    // The first gap hides lines 1–37 (const v0 … v36).
    let text = clickOn("↓ 20");
    expect(text).toContain("const v19 = 19;");
    expect(text).not.toContain("const v20 = 20;");
    expect(text).toContain("⋯ 17 unchanged lines");
    // 17 left: only "all" is offered, and it shows the rest.
    expect(text).not.toContain("↓ 20");
    text = clickOn(" all ");
    expect(text).toContain("const v20 = 20;");
    expect(text).not.toContain("⋯ 17");
    // From the bottom on a fresh view: the 20 lines just above the change.
    const other = await open();
    other.select("app.ts");
    await other.loadFile();
    const screen = other.frame(100, 30).map(plain);
    const y = screen.findIndex((r) => r.includes("↑ 20"));
    other.key(`mouse click ${screen[y]!.indexOf("↑ 20") + 2} ${y + 1}`);
    text = other.frame(100, 30).map(plain).join("\n");
    expect(text).toContain("const v17 = 17;");
    expect(text).not.toContain("const v16 = 16;");
  });

  test("the sidebar resizes by dragging its divider or with < > =", async () => {
    const app = await open();
    const side = () => layoutFor(app.state, 100, 30).side;
    const auto = side();
    const divider = () => plain(app.frame(100, 30)[5]!).indexOf("│");
    expect(divider()).toBe(auto);
    // Press on the divider (1-based column side+1), drag, release.
    app.key(`mouse click ${auto + 1} 6`);
    expect(app.state.resizing).toBe(true);
    app.key("mouse drag 41 6");
    app.key("mouse release 41 6");
    expect(app.state.resizing).toBe(false);
    expect(side()).toBe(40);
    expect(divider()).toBe(40);
    // A drag that doesn't start on the divider changes nothing.
    app.key("mouse drag 60 6");
    expect(side()).toBe(40);
    app.key(">");
    expect(side()).toBe(44);
    app.key("<");
    app.key("<");
    expect(side()).toBe(36);
    // Limits: the diff keeps 30 columns, the sidebar at least 16.
    app.key(`mouse click ${divider() + 1} 6`);
    app.key("mouse drag 99 6");
    expect(side()).toBe(69);
    app.key("mouse drag 2 6");
    expect(side()).toBe(16);
    app.key("mouse release 2 6");
    app.key("=");
    expect(side()).toBe(auto);
    for (const row of app.frame(100, 30)) expect(Bun.stringWidth(plain(row))).toBe(100);
  });

  test("syntax colours arrive from the worker after the file draws", async () => {
    const app = await open();
    app.select("app.ts");
    await app.loadFile();
    for (let i = 0; i < 100 && !app.state.file?.syntax; i++) await Bun.sleep(20);
    const runs = app.state.file?.syntax?.new?.runs;
    expect(runs?.[0]?.some((r) => r[2] === "keyword")).toBe(true); // "const"
    // Keyword colour (256-colour 176) is on screen.
    expect(app.frame(100, 30).join("\n")).toContain("38;5;176");
  });

  test("narrow terminals show one pane at a time", async () => {
    const app = await open(50, 20);
    expect(app.frame(50, 20).map(plain).join("\n")).toContain("new.txt");
    app.key("tab");
    const screen = app.frame(50, 20).map(plain);
    expect(screen.join("\n")).not.toContain(" Files");
    for (const row of screen) expect(Bun.stringWidth(row)).toBe(50);
  });
});
