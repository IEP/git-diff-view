/**
 * Syntax colours for the terminal diff: the highlight.js grammars the web view uses
 * (through lowlight), reduced to a few kinds of token. A file is highlighted whole, in
 * one pass, so comments and strings spanning lines are coloured right. That takes about
 * 1 ms per KB, so the viewer runs it in a worker (`syntaxWorker.ts`).
 */
import { common, createLowlight } from "lowlight";

/** What a token is, reduced to the few kinds the terminal colours. */
export type SyntaxKind = "keyword" | "string" | "number" | "comment" | "function" | "type" | "attr" | "tag" | "meta";

/** A coloured run `[from, to, kind]` on a line's drawn (untabbed) text. */
export type SyntaxRun = readonly [number, number, SyntaxKind];

/** The server reads files up to 2 MiB; nothing larger reaches the viewer anyway. */
export const MAX_SYNTAX_CHARS = 2 * 1024 * 1024;
/** Lines over this are left plain (minified code, data). */
const MAX_LINE = 2_000;

const lowlight = createLowlight(common);

/** The grammar for a path, by extension (or name, for `Makefile`), or null. */
export function languageFor(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (name === "makefile" || name === "gnumakefile") return "makefile";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1);
  return lowlight.registered(ext) ? ext : null;
}

// highlight.js scope (the first class, without `hljs-`) → kind. Unlisted scopes draw plain.
const KIND: Record<string, SyntaxKind> = {
  keyword: "keyword", "selector-tag": "keyword", "meta-keyword": "keyword", doctag: "keyword",
  string: "string", regexp: "string", char: "string", "template-tag": "string", symbol: "string",
  number: "number", literal: "number",
  comment: "comment", quote: "comment",
  title: "function", "title.function": "function", "title.function.invoke": "function", section: "function",
  type: "type", "title.class": "type", "title.class.inherited": "type", built_in: "type", class: "type",
  attr: "attr", attribute: "attr", property: "attr", "selector-attr": "attr", "selector-class": "attr", "selector-id": "attr", variable: "attr", "template-variable": "attr",
  name: "tag", tag: "tag", "selector-pseudo": "tag", bullet: "tag",
  meta: "meta", "meta.prompt": "meta", addition: "string", deletion: "keyword", link: "string", code: "string",
};

/** An embedded expression (`${…}` in a template string) draws plain, not as its string. */
const PLAIN = "plain" as const;

function kindOf(className: ReadonlyArray<string> | undefined): SyntaxKind | typeof PLAIN | null {
  if (!className?.length) return null;
  if (className[0] === "hljs-subst") return PLAIN;
  // `["hljs-title", "function_"]` → "title.function"
  const base = className[0]!.replace(/^hljs-/, "");
  const full = [base, ...className.slice(1).map((c) => c.replace(/_+$/, ""))].join(".");
  return KIND[full] ?? KIND[base] ?? null;
}

interface HastNode {
  readonly type: string;
  readonly value?: string;
  readonly properties?: { readonly className?: ReadonlyArray<string> };
  readonly children?: ReadonlyArray<HastNode>;
}

/** Highlight some lines as one piece of text: runs per line, same length as `lines`. */
export function highlightLines(lang: string, lines: ReadonlyArray<string>): Array<Array<SyntaxRun> | null> {
  const out: Array<Array<SyntaxRun> | null> = lines.map(() => []);
  let tree: HastNode;
  try {
    tree = lowlight.highlight(lang, lines.join("\n")) as HastNode;
  } catch {
    return lines.map(() => null);
  }
  let line = 0;
  let col = 0;
  const push = (text: string, kind: SyntaxKind | null) => {
    const parts = text.split("\n");
    parts.forEach((part, k) => {
      if (k > 0) {
        line++;
        col = 0;
      }
      if (!part) return;
      const runs = out[line];
      if (runs && kind) {
        const last = runs[runs.length - 1];
        if (last && last[1] === col && last[2] === kind) runs[runs.length - 1] = [last[0], col + part.length, kind];
        else runs.push([col, col + part.length, kind]);
      }
      col += part.length;
    });
  };
  const walk = (node: HastNode, kind: SyntaxKind | null) => {
    if (node.type === "text") return push(node.value ?? "", kind);
    const own = node.type === "element" ? kindOf(node.properties?.className) : null;
    const next = own === PLAIN ? null : (own ?? kind);
    for (const child of node.children ?? []) walk(child, next);
  };
  walk(tree, null);
  return out;
}

/** A whole file's runs, line by line (very long lines plain), or null when it's too large. */
export function highlightFile(lang: string, lines: ReadonlyArray<string>): Array<ReadonlyArray<SyntaxRun> | null> | null {
  if (lines.reduce((n, l) => n + l.length + 1, 0) > MAX_SYNTAX_CHARS) return null;
  const runs = highlightLines(lang, lines.map((l) => (l.length > MAX_LINE ? "" : l)));
  return runs.map((r, i) => (lines[i]!.length > MAX_LINE ? null : r));
}
