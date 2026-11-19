/**
 * A hand-written JS/TS lexer for the Herdr mod's syntax colors: one line at a time,
 * carrying its state (inside a block comment, a template string, whether a `/` starts
 * a regex) from line to line, so a file can be colored from any line on, with no
 * chunk edges. In the mod's engine it runs at about 0.4 ms per KB, some 25-35 times
 * faster than lowlight (herdr/research/faster-syntax-highlighting.md).
 *
 * It colors what lowlight colors for these files, roughly: keywords, strings, template
 * strings, regexes, comments, numbers and literals, calls, capitalized names.
 * No JSX: `.jsx` / `.tsx` stay on lowlight.
 */
import type { SyntaxKind, SyntaxRun } from "./syntax";

/** Lexer state between lines. Treat as opaque; `cloneState` before keeping one. */
export interface LexState {
  /** 0 code, 1 block comment, 2 template string. */
  mode: 0 | 1 | 2;
  /** For each open template string: the brace depth inside its current `${`, 0 in its text. */
  tpl: Array<number>;
  /** A `/` here starts a regex literal, not a division. */
  regexOk: boolean;
}

export const initState = (): LexState => ({ mode: 0, tpl: [], regexOk: true });
export const cloneState = (s: LexState): LexState => ({ mode: s.mode, tpl: s.tpl.slice(), regexOk: s.regexOk });
export const sameState = (a: LexState, b: LexState): boolean =>
  a.mode === b.mode && a.regexOk === b.regexOk && a.tpl.length === b.tpl.length && a.tpl.every((d, i) => d === b.tpl[i]);

/** The extensions (as `languageFor` returns them) this lexer colors. */
export const LEXED = new Set(["js", "mjs", "cjs", "ts", "mts", "cts"]);

const KEYWORDS = new Set(
  ("abstract as async await break case catch class const continue debugger declare default delete do else enum export extends " +
    "finally for from function get if implements import in infer instanceof interface is keyof let namespace new of " +
    "package private protected public readonly return satisfies set static switch throw try type typeof " +
    "unique var void while with yield").split(" "),
);
/** Colored as literals (lowlight's `literal`, drawn as numbers). */
const LITERALS = new Set(["true", "false", "null", "undefined", "NaN", "Infinity"]);
/** Colored as lowlight colors `variable.language`. */
const SELF = new Set(["this", "super"]);
/** After these keywords a `/` starts a regex. */
const REGEX_AFTER = new Set("return typeof instanceof in of new delete void throw case do else yield await".split(" "));

const isIdStart = (c: number) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 36 || c > 127;
const isIdPart = (c: number) => isIdStart(c) || (c >= 48 && c <= 57);
const isDigit = (c: number) => c >= 48 && c <= 57;

function push(runs: Array<[number, number, SyntaxKind]>, from: number, to: number, kind: SyntaxKind) {
  if (to <= from) return;
  const last = runs[runs.length - 1];
  if (last && last[1] === from && last[2] === kind) last[1] = to;
  else runs.push([from, to, kind]);
}

/** Color one line; updates `st` to the state after it. */
export function lexLine(line: string, st: LexState): Array<SyntaxRun> {
  const runs: Array<[number, number, SyntaxKind]> = [];
  const n = line.length;
  let i = 0;
  // The previous significant character was a `.`: a name after it is a property, not a keyword.
  let afterDot = false;
  while (i < n) {
    if (st.mode === 1) {
      const end = line.indexOf("*/", i);
      const stop = end < 0 ? n : end + 2;
      push(runs, i, stop, "comment");
      i = stop;
      if (end >= 0) st.mode = 0;
      continue;
    }
    if (st.mode === 2) {
      const from = i;
      while (i < n) {
        const c = line.charCodeAt(i);
        if (c === 92) i += 2;
        else if (c === 96) {
          i++;
          st.mode = 0;
          st.tpl.pop();
          st.regexOk = false;
          break;
        } else if (c === 36 && line.charCodeAt(i + 1) === 123) {
          st.mode = 0;
          st.tpl[st.tpl.length - 1] = 1;
          break;
        } else i++;
      }
      push(runs, from, Math.min(i, n), "string");
      if (st.mode === 0 && st.tpl.length && st.tpl[st.tpl.length - 1] === 1 && line.charCodeAt(i) === 36) {
        i += 2; // `${`: the expression inside draws as code
        st.regexOk = true;
      }
      afterDot = false;
      continue;
    }
    const c = line.charCodeAt(i);
    if (c === 32 || c === 9) {
      i++;
      continue;
    }
    if (c === 47) {
      const d = line.charCodeAt(i + 1);
      if (d === 47) {
        push(runs, i, n, "comment");
        i = n;
        continue;
      }
      if (d === 42) {
        st.mode = 1;
        push(runs, i, i + 2, "comment");
        i += 2;
        continue;
      }
      if (st.regexOk) {
        let j = i + 1;
        let cls = false;
        for (; j < n; j++) {
          const e = line.charCodeAt(j);
          if (e === 92) j++;
          else if (e === 91) cls = true;
          else if (e === 93) cls = false;
          else if (e === 47 && !cls) break;
        }
        if (j < n) {
          j++;
          while (j < n && isIdPart(line.charCodeAt(j))) j++; // flags
          push(runs, i, j, "string");
          i = j;
          st.regexOk = false;
          afterDot = false;
          continue;
        }
      }
      i++;
      st.regexOk = true;
      afterDot = false;
      continue;
    }
    if (c === 34 || c === 39) {
      let j = i + 1;
      for (; j < n; j++) {
        const e = line.charCodeAt(j);
        if (e === 92) j++;
        else if (e === c) {
          j++;
          break;
        }
      }
      push(runs, i, Math.min(j, n), "string");
      i = j;
      st.regexOk = false;
      afterDot = false;
      continue;
    }
    if (c === 96) {
      st.mode = 2;
      st.tpl.push(0);
      push(runs, i, i + 1, "string");
      i++;
      continue;
    }
    if (isDigit(c) || (c === 46 && isDigit(line.charCodeAt(i + 1)))) {
      let j = i + 1;
      while (j < n) {
        const e = line.charCodeAt(j);
        if (isIdPart(e) || e === 46) j++;
        else break;
      }
      push(runs, i, j, "number");
      i = j;
      st.regexOk = false;
      afterDot = false;
      continue;
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdPart(line.charCodeAt(j))) j++;
      const word = line.slice(i, j);
      let k = j;
      while (k < n && line.charCodeAt(k) === 32) k++;
      const call = line.charCodeAt(k) === 40;
      if (!afterDot && KEYWORDS.has(word)) {
        push(runs, i, j, "keyword");
        st.regexOk = REGEX_AFTER.has(word);
      } else {
        if (!afterDot && LITERALS.has(word)) push(runs, i, j, "number");
        else if (!afterDot && SELF.has(word)) push(runs, i, j, "attr");
        else if (call) push(runs, i, j, "function");
        else if (c >= 65 && c <= 90) push(runs, i, j, "type");
        st.regexOk = false;
      }
      i = j;
      afterDot = false;
      continue;
    }
    // Punctuation; braces track template `${ … }` nesting.
    if (st.tpl.length && st.tpl[st.tpl.length - 1]! > 0) {
      if (c === 123) st.tpl[st.tpl.length - 1]!++;
      else if (c === 125 && --st.tpl[st.tpl.length - 1]! === 0) {
        st.mode = 2;
        i++;
        continue;
      }
    }
    afterDot = c === 46 || (c === 63 && line.charCodeAt(i + 1) === 46); // `.` or `?.`
    if (c === 63 && afterDot) i++;
    st.regexOk = !(c === 41 || c === 93 || c === 125);
    i++;
  }
  return runs;
}
