# Faster syntax highlighting in the Herdr mod

Researched 2026-11-19 against Herdr 0.1.16 and repo HEAD `d9677dd`, using working-tree copies of the inputs.
Benchmarks ran in Bun 1.4.2 on this Mac. The QuickJS proxy is quickjs-ng compiled to WASM and run from Bun.
Anything that can only be settled in the running window is marked **needs in-app check**, with the probe to run.

## Short answer

For `.js`/`.ts` (and later other C-family languages), replace lowlight with a hand-written, line-at-a-time lexer that can resume from saved state.
Keep lowlight for everything else, including `.jsx`/`.tsx` until the lexer handles JSX text (section 3).

- **Speed.** In the QuickJS proxy the lexer turns text into per-line runs 40–49× faster than lowlight; in Bun it is 23–45× faster.
  - Lowlight costs 6.5 ms/KB in the app today. Applying the proxy-to-app ratio to the lexer gives roughly 0.13–0.17 ms/KB in the app (an estimate; needs in-app check).
  - The proxy is an interpreter, so this gain doesn't depend on Herdr's JIT. Whether the JIT speeds the lexer up further is unknown.
- **What that means per file, against today's chunked path:**
  - 34 KB: about 220 ms of work spread over ~37 six-ms ticks today; about 5 ms, one tick, with the lexer.
  - 263 KB: about 1.7 s over ~290 ticks today; about 40 ms over ~7 ticks with the lexer.
- **Chunk edges.** The lexer carries its state from one line to the next, so any line can be a chunk edge and the blank-line chunking (and the colours it breaks) goes away.
- **Bundle size.** The lexer is 4.2 KB minified, against 177 KB for `lowlight` + `common`.
- **The "superlinear" premise was not reproduced.** In the proxy, lowlight is linear from 8 to 256 KB. Why the 263 KB run never finished in the app is still open (section 1, probe in Appendix B).

Two alternatives were ruled out:

- **The host has no faster native path for us.** There is no token or span API, no tree-sitter, no `WebAssembly`, no worker, and `cx.spawn` runs on the UI thread.
- **Offloading through `exec` is not worth it.** It works only where `bun` or `node` is installed, adds 50–90 ms per file (more with node), and gains nothing once the in-process lexer costs ~5 ms per file.

## 1. Which JS engine Herdr embeds

**QuickJS-NG 0.15.1, through Longbridge's `quickjs-jit` (a JIT-enabled fork of rquickjs), with a Cranelift JIT backend compiled in.**

| Evidence | Source |
|---|---|
| App version 0.1.16 | `/Applications/Herdr.app/Contents/Info.plist`: `CFBundleShortVersionString` = `0.1.16` |
| Not JavaScriptCore: the binary links no `JavaScriptCore.framework` (only AppKit, Metal, CoreText …) | `otool -L /Applications/Herdr.app/Contents/MacOS/Herdr` |
| `quickjs-jit 0.12.11`, `quickjs-jit-runtime 0.12.11`, `quickjs-jit-core/-macro/-sys 0.12.11`, `quickjs-jit-stdlib 0.12.7`, `rquickjs 0.12.9` | `Resources/THIRD-PARTY-NOTICES` lines 16068–16069, 16423–16426, 17365–17366 |
| "QuickJS / quickjs-ng (embedded by quickjs-jit-sys) https://github.com/longbridge/quickjs-jit/tree/96593cd…/sys/quickjs" | same file, lines 18585–18586 |
| Cranelift 0.116.1 crates (the JIT code generator) | same file, lines 934–943 |
| `syntect 5.3.0`, `fancy-regex 0.16.2 / 0.19.2`; no tree-sitter crate anywhere (`grep -i tree.sitter` finds nothing) | same file, lines 15779, 16715–16716 |
| The `sys/quickjs` submodule is `https://github.com/quickjs-ng/quickjs.git`, pinned to quickjs-ng `fd0a0210b7be00957751871e7e01b8291268fc29` | `quickjs-jit@96593cd` `.gitmodules` and `README.md` (the JIT matrix text says "the same QuickJS-NG `fd0a0210…` runtime") |
| quickjs-ng at that commit is version 0.15.1 | `quickjs.h@fd0a021` lines 1410–1413 (`QJS_VERSION_MAJOR 0`, `MINOR 15`, `PATCH 1`). The binary has the string `0.15.1` right beside `quickjs.c` and `js_calloc_rt` (`strings -n 6 Herdr`) |
| JIT is compiled in: `a JIT backend is already attached`, `QuickJS rejected the JIT backend`, `invalid JIT interrupt state` | `strings -n 6 Herdr` |
| Mod engine sources: `vendor/gpui-kit/crates/shell/src/engine/quickjs/{mod,scheduler,lifecycle,dock_api}.rs` | `strings -n 6 Herdr` |

Whether the JIT is attached for mod scripts is not visible from outside: **needs in-app check** (probe P1 in Appendix B times a scalar loop against the interpreter baseline measured below it).

### What the engine means for highlight.js-style tokenizers

- **Regexes run in `libregexp`, a backtracking bytecode interpreter in C.** It has no regex JIT (`lre_exec` → `lre_exec_backtrack`, `libregexp.c@fd0a021` lines 2497–2540).
  - The quickjs-jit README's own matrix (0.12.11, measured 2026-09-30) shows `strings-regexp` at 1.02× same-version QuickJS ("tied") and 0.053× Bun.
  - In the same matrix, scalar loops (`scalar-loop`, `numeric`, `quickjs-bitops`) run 26–49× faster than the interpreter.
  - So the JIT does not speed up regex matching, which dominates highlight.js, Prism and Shiki.
  - Whether it speeds up a `charCodeAt` loop is unknown: the README's string workloads that I read are also ties with the interpreter. Closures and `for-of` are deliberately left to the interpreter in 0.12.11 (README: "P2 deferral").
- **Searching from `lastIndex` does not copy the string.** `js_regexp_exec` passes the flat string buffer and `last_index` straight to `lre_exec` (`quickjs.c@fd0a021` lines 48514–48565).
  - Ropes are linearized once and the result is cached on the rope (`js_linearize_string_rope`, lines 5019–5040).
  - Substrings over 1024 bytes are slices, not copies (`JS_STRING_SLICE_LEN_MAX`, line 225).
  - Taken together, the engine source has no per-`exec` O(n) cost that would make highlight.js quadratic.
- **There is a hard limit of 255 capture groups per regex** (`CAPTURE_COUNT_MAX 255`, `libregexp.c` line 58; error "too many captures", line 1310).
  - Shiki's JavaScript engine emits larger regexes for the JS/TS grammars, and fails in the proxy with exactly this error (section 3).
- **Regex execution polls the host's interrupt handler** every 10 000 backtracking steps (`INTERRUPT_COUNTER_INIT 10000`, `lre_poll_timeout`, `libregexp.c` lines 62, 2063–2070). When Herdr decides a slice ran too long, even a single `exec` call is stopped.
- **The resulting "interrupted" error cannot be caught.** `JS_ThrowInterrupted` throws `InternalError: interrupted` and then calls `JS_SetUncatchableError` (`quickjs.c` lines 8215–8219), so a `try/catch` in the mod never sees it. The whole task just stops.

### Superlinear: not reproduced in the proxy, unresolved in the app

Sweep on prefixes of `herdr/git-diff/core.js` in the quickjs-ng proxy, median of 5, with nothing else running (`sweep-quiet.txt`):

| input | 8 KB | 16 KB | 32 KB | 64 KB | 128 KB | 256 KB |
|---|---|---|---|---|---|---|
| lowlight, ms/KB | 22.1 | 18.5 | 18.7 | 20.3 | 17.1 | 13.8 |
| hand lexer (char loop), ms/KB | 0.50 | 0.44 | 0.56 | 0.48 | 0.41 | 0.43 |
| Prism (`refractor.tokenize`), ms/KB | 5.9 | 5.6 | 5.2 | 5.5 | 5.4 | **19.6** |

An earlier run that overlapped other benchmarks showed the same shapes, with refractor's hast path also bending (6.2 → 16.0 ms/KB between 128 and 256 KB).

- **Lowlight is linear or better from 8 KB to 256 KB in the proxy** (quickjs-ng 0.12.1, interpreter only). In Bun it is also flat, at 0.29–0.38 ms/KB.
- **Prism bends about 3.6× between 128 and 256 KB.** I didn't bisect it. Its `greedy` rematching in `matchGrammar` (`refractor/lib/prism-core.js` lines 530–663) is a candidate, not a confirmed cause.
- **The proxy can't rule out a cause specific to the app.** The app runs quickjs-ng 0.15.1 with a JIT; the proxy runs 0.12.1 without one.
- **The interrupt is one candidate explanation, not a proven one.**
  - At the measured 6.5 ms/KB, 263 KB is about 1.7 s in a single call. If Herdr's interrupt fired, the uncatchable error (above) would end the job silently, which looks like "didn't finish".
  - Against that: single calls of 199 ms and 330 ms did complete in the app, while a job running 25–30 ms slices was killed. So the interrupt rule isn't a plain per-call time limit, and I can't say from outside what it is.
- **A question that settles most of it:** during those 45 s, was the Herdr window frozen?
  - Frozen means the script really was computing that long, i.e. real superlinear cost or a pathology in the app's engine.
  - Responsive means the job was stopped early (the interrupt or something else) and the work never ran.
- **Needs in-app check:** probe P2 in Appendix B times lowlight on growing prefixes, one per frame, and logs a `start` line before each call. A `start` with no `done` means the task was killed there; ms/KB rising with size means real superlinear cost.

## 2. Native or off-thread highlighting the host exposes

None that a virtual list's rows can use.

Grep commands run against `~/.config/herdr-app/`:

```sh
grep -n -i -E "tree.?sitter|webassembly|\bwasm\b|worker|highlight_|syntax_|tokeni|spawn\b|background_executor|thread" gpui-kit.d.ts
grep -n -i -E "highlight|tree_sitter|worker|webassembly|wasm|thread|background|spawn|token" herdr.d.ts AGENTS.md
grep -n -E "EditorState|interface Editor|language\??:|syntax\??:|on_token|highlights?\b" gpui-kit.d.ts
```

- **No tree-sitter, `WebAssembly`, `wasm` or `Worker`** in any of the three files. The binary has no `WebAssembly` string either (`grep -c WebAssembly herdr-strings.txt` = 0), and neither does `quickjs.c@fd0a021` (0 matches).
  - quickjs-ng's `Worker` exists only in the `qjs:os` module of `quickjs-libc.c` (line 4508). The types don't declare it.
  - Needs in-app check: probe P1 (Appendix B) logs `typeof WebAssembly`, `typeof Worker`, `typeof SharedArrayBuffer`.
- **`cx.spawn` runs on the UI thread.**
  - It is documented as `App::spawn`, "Calls `body(cx)` and adopts the promise it returns" (`gpui-kit.d.ts` lines 377–384). `cx.sleep` "Resolves after `ms` on GPUI's foreground executor" (line 386). `Timer` is "One-shot and repeating callbacks on the foreground executor" (line 389).
  - `TaskOptions` has only `owner` (lines 22054–22057), so there is no thread option.
  - AGENTS.md: "Anything slow goes through `exec` or `fetch`" (line 985).
- **The only host calls documented as off-thread are I/O.**
  - `readTextFile` "Runs off the UI thread" (`herdr.d.ts` line 27).
  - `exec` runs a program; it takes no stdin, caps output at 8 MiB and defaults to a 30 s timeout (`herdr.d.ts` lines 4–14).
  - `localStorage` writes go to a background thread (`gpui-kit.d.ts` line 20633).
- **`EditorState` / `Editor` expose no spans.**
  - `EditorState.new({ language, value, readonly, syntax, … })`. Its instance methods are `value`, `set_value`, `selected_range`, `set_selected_range`, `replace`, `on`, `focus`, `release` (`gpui-kit.d.ts` lines 21489–21525). None of them returns tokens or highlight ranges.
  - The `syntax` option only maps semantic kinds (keyword, string, comment, …) to colours.
  - `TextareaState.tokens()` returns `InlineTokenSpan` chips (`{ range, token: { id, text, label } }`, line 20710), not syntax.
- **The native highlighter appears to be syntect, not tree-sitter.**
  - syntect 5.3.0 is linked (notices line 15779; strings include `syntect-5.3.0/src/parsing/parser.rs`).
  - The binary embeds Sublime-style scopes: `source.js`, `source.rust`, `source.python`, `source.go`, … but **no `source.ts`**.
    - `grep -o -E "^source\.[a-z0-9.+_-]+$" herdr-strings.txt` lists the scopes.
    - An unanchored `grep -c -a "source\.ts\b"` on the binary itself gives 0.
    - The word `TypeScript` appears in the binary only inside an SVG icon's `<title>`.
  - So the built-in editor probably can't highlight TypeScript as TypeScript (needs in-app check), and in any case none of it is reachable from script.
- `TextView.markdown(id, md)` renders Markdown (`gpui-kit.d.ts` line 20746). Whether it highlights fenced code natively needs an in-app check. It would still be one opaque element, useless for our rows.

## 3. Faster JS tokenizers that fit the constraints

All candidates were timed end to end, from text to per-line `[from, to, kind]` runs (the shape `herdr/src/syntax.ts` produces). Each was warmed up and the median taken: 15 reps in Bun (3 for 256 KB), 5 in the proxy.

Inputs, all working-tree copies:

- `herdr/git-diff/main.js` (33.6 KB, JS)
- `src/server/Git.ts` (27.8 KB, TS)
- prefixes of the generated `herdr/git-diff/core.js`

Candidates:

- `lowlightCurrent`: `highlightLines` imported from `herdr/src/syntax.ts`.
- `lowlightChunked`: the same, over `planChunks`.
- `hljsDirect`: `highlight.js/lib/core` with only `javascript` and `typescript`, plus a custom `__emitter` that writes runs directly with no hast.
- `refractorRuns`: refractor 5 hast.
- `prismTokens`: Prism's `tokenize` through refractor, no hast.
- `shikiJs`: `@shikijs/core` 4.6 with `createJavaScriptRegexEngine()`. A theme whose colours encode the kinds is used with `codeToTokensBase`.
- `sugarHigh`: sugar-high 2.7, a char lexer with language presets.
- `handChar` / `handRe`: a hand-written JS/TS lexer, as a `charCodeAt` loop and as a sticky regex.

### Results

The QuickJS proxy is `@jitl/quickjs-ng-wasmfile-release-sync` 0.32.0, which is quickjs-ng 0.12.1, interpreter only, run as WASM.

- **Calibration.** The proxy runs lowlight at 15.8–16.6 ms/KB. The app measured 6.5 ms/KB, so the app is about 2.5× faster than the proxy. Relative speeds should carry over; absolute ones don't.
- **Same direction in both engines.** The rankings mostly agree. In QuickJS, though, the regex-free char lexer pulls further ahead (40–49× there, against 23–45× in Bun), as section 1 predicts.

| candidate | Bun main.js | Bun Git.ts | proxy main.js | proxy Git.ts | min. bundle (gzip) |
|---|---|---|---|---|---|
| lowlight (`common`), current | 12.2 ms (1×) | 8.7 ms (1×) | 558 ms (1×) | 440 ms (1×) | 177 KB (53 KB) |
| highlight.js core, JS+TS, direct emitter | 1.2× | 1.1× | 1.1× | 1.2× | 37 KB (12 KB) |
| refractor (Prism → hast) | 1.5× | 1.6× | 2.9× | 3.2× | 38 KB (13 KB) |
| Prism `tokenize`, no hast | 2.8× | 2.6× | 4.2× | 4.9× | 15 KB (6 KB), prism core + clike + js + ts |
| Shiki core + JS regex engine | 0.17× | 0.23× | **fails**: `SyntaxError: too many captures` | fails | 523 KB (85 KB) |
| Shiki, `forgiving: true` | — | — | 0.18× (2308 ms) | 0.15× (2890 ms) | 523 KB |
| sugar-high 2.7 | 2.8× | 4.4× | 5.5× | 6.8× | 10 KB for JS+TS; 30 KB for all 30 presets |
| hand lexer, sticky regex | 11.9× | 17.2× | 17× | 24× | 4.2 KB (1.6 KB) |
| **hand lexer, char loop** | **23×** | **45×** | **40×** | **49×** | **4.2 KB (1.6 KB)** |

Bundle sizes come from `bun build <entry> --minify --format=iife --target=browser`, with one entry per candidate that imports only its own modules.

### Correctness against lowlight

These numbers are from `cs.ts` and `disagree.ts` in the scratch bench.

- **Comment and string spans.** Every candidate marks exactly the same characters as comment or string as lowlight does, on both `main.js` and `Git.ts`: a 0.00 % mismatch over non-space characters.
- **Other kinds differ by naming, not by lexing.** For the hand lexer (timed version) on `main.js`:
  - lowlight colours property names `attr` (15.6 % of characters; the hand lexer leaves them plain).
  - lowlight colours `this` as `attr` (6.1 %; the hand lexer calls it a keyword).
  - lowlight colours `null`/`true` as `number` (1.9 %; the hand lexer calls them keywords).
  - These are one-line table fixes, plus "identifier after `.` → attr".
- **JSX/TSX is a real gap.** On `src/App.tsx` and `src/components/CommitGraph.tsx` (`cs2.ts`, comparing against lowlight `tsx`, which `common` aliases to the TypeScript grammar):

  | file | hand lexer | sugar-high | Prism |
  |---|---|---|---|
  | `App.tsx` (580 lines) | 6.9 % of chars on 67 lines | 7.9 % on 76 lines | 6.6 % on 66 lines |
  | `CommitGraph.tsx` (694 lines) | 9.9 % on 81 lines | 10.9 % on 97 lines | 9.7 % on 81 lines |

  The mismatches are in comment/string spans.
  - For example, an apostrophe in JSX text (`Couldn't load pull request …`) starts a string in the hand lexer that runs to the end of the line.
  - `{/* … */}` comments inside JSX and attribute values (`base={base}`) are lexed differently.
  - Until the lexer has a JSX mode, route `.jsx`/`.tsx` to lowlight.
- **Known limits of the hand lexer as benchmarked:**
  - Regex literals are found by a heuristic: the previous token is an operator, `(`, or a keyword such as `return`.
  - It has no JSX mode.
  - It emits no `attr` runs.
  - It covers only JS/TS keywords.
  - The fixes in the recommendation (attr for `.name`, kind table) add a little work per identifier. Re-time after adding them.
- **The current chunking is fine on these files.** `planChunks` + lowlight gives exactly the same colours as whole-file lowlight on all three inputs: 0 of 900, 0 of 649 and 0 of 11 187 lines differ (`chunkcmp.ts`). The breakage only shows when a block comment or template string contains a blank line at a chunk edge.

### Resumable state (read from source)

- **highlight.js 11.12: no public continuation.**
  - `_highlight(languageName, code, ignoreIllegals, continuation)` takes one and returns `_top` (`highlight.js/lib/core.js` lines 1741, 2120, 2169).
  - The public `highlight()` calls `_highlight(context.language, context.code, ignoreIllegals)` without it (line 1723), and `_highlight` isn't exported (export list, lines 2548–2557).
  - Resuming would need the private function and would also lose the emitter's open scopes.
- **lowlight 3.3:** calls `high.highlight` and reads `result._emitter.root` (`lowlight/lib/index.js` lines 94–109). No continuation.
- **Prism / refractor:** `tokenize(text, grammar)` takes the whole text (`refractor/lib/prism-core.js` line 362). No state.
- **Shiki:** this one does resume. `codeToTokensBase(code, { grammarState })` plus `getLastGrammarState(tokens)` (`@shikijs/types` `.d.mts`: `grammarState?: GrammarState`, "allowing to continue tokenizing from a intermediate grammar state"; `@shikijs/primitive/dist/index.mjs` line 596). It is the slowest option, though, and it doesn't load in QuickJS.
- **sugar-high:** `tokenize(code, options)` over the whole string (`sugar-high/lib/core.js` line 49). No state.
- **Hand lexer:** resumable by design. It lexes one line at a time and mutates a small state `{ mode: code | block comment | template, tpl: [brace depths], regexOk }` that is easy to clone.

Not benchmarked: `@speed-highlight/core` 2.1. Its `tokenize` is async and keeps one regex per rule (`dist/index.js`), so it is in the same regex-bound family as Prism.

## 4. Offloading through `exec`

It is possible, but it shouldn't be the main path.

- **The subprocess has to read the text itself.** `exec(command, args, { cwd, on, timeout })` has no stdin (`herdr.d.ts` line 14), and the mod is read-only, so it can't write a temp file. The subprocess must fetch the text, e.g. `sh -c 'git -C <root> show <rev>:<path> | bun hl.js js'`.
  - Working-tree reads must keep the `git ls-files` + `isRepoPath` gate (CLAUDE.md), so the mod would validate the path before passing it as an argument.
- **git has no highlighter.** `git help -a` (198 lines) lists nothing for highlighting or syntax. Its only language-aware pieces are the `diff.<driver>.xfuncname` / `wordRegex` patterns, used for hunk headers and word diffs.
- **`bat`, `pygmentize`, `highlight` and `chroma` aren't installed even on this machine.** `which bat pygmentize …` printed "bat not found", "pygmentize not found", "highlight not found", "chroma not found". Present here: `git` 2.54.0, `bun` 1.4.2, `node` v26.13.1, `deno`, `python3`.
- **Latency on this Mac** (median of 20 spawns via `python3 subprocess`):
  - `bun -e 0`: 12.6 ms.
  - `node -e 0`: 175.9 ms.
  - `git --version`: 15.7 ms.
  - End to end, `git show HEAD:herdr/git-diff/main.js | bun dist/hl.js js <engine>` (median of 10) took 51.5 ms with the hand lexer and 87.7 ms with lowlight.
  - The hand lexer's JSON output for 34 KB of source was 35 KB, far under the 8 MiB cap. The mod still pays to `JSON.parse` it, though in C.
- **Remote machines (`on`) are harder.**
  - A script file next to the mod doesn't exist on the remote, so the code must go inline (`bun -e` / `node -e`).
  - macOS `getconf ARG_MAX` is 1 048 576.
  - On Linux, "the limit per string is 32 pages (the kernel constant MAX_ARG_STRLEN)" (execve(2), https://man7.org/linux/man-pages/man2/execve.2.html). With 4 KiB pages that is 128 KiB.
  - The 177 KB lowlight bundle wouldn't fit as one argument; the 4 KB lexer would.
  - The remote also needs `bun` or `node`, which a server may not have.
- **The verdict is not to depend on it.** Once the lexer is in process, a JS/TS file costs about one frame (estimate), less than the subprocess's spawn latency. The fallback chain, if one is ever wanted for exotic languages:
  1. In-process lexer for languages it covers.
  2. In-process lowlight in slices, as today.
  3. Optionally, `exec("bun", ["-e", <inline lowlight-free script>])` when `bun --version` succeeds on that machine, cached per machine.
  4. Otherwise plain text.

## Comparison of options

"In app (est.)" applies the 2.5× proxy-to-app factor to the proxy number; it **needs an in-app check**.

| option | vs lowlight (Bun / proxy) | in app (est.) | bundle (min.) | resumable | off UI thread | availability |
|---|---|---|---|---|---|---|
| lowlight `common` (today) | 1× / 1× | 6.5 ms/KB (measured) | 177 KB | no (blank-line chunks) | no | everywhere |
| highlight.js, hand-picked langs | 1.1–1.2× / 1.1–1.2× | ~6 ms/KB | 37 KB (JS+TS) | private `_highlight` only | no | everywhere |
| refractor | 1.5× / 3× | ~2 ms/KB | 38 KB | no | no | everywhere |
| Prism `tokenize` | 2.7× / 4–5× (bends at 256 KB) | ~1.5 ms/KB | 15 KB | no | no | everywhere |
| Shiki + JS regex engine | 0.2× / fails (0.15–0.18× forgiving) | slower than today | 523 KB | yes (`grammarState`) | no | fails: 255-capture limit |
| sugar-high 2.7 | 2.8–4.4× / 5.5–6.8× | ~1 ms/KB | 10–30 KB | no | no | everywhere, 30 languages |
| **hand lexer, char loop** | **23–45× / 40–49×** | **~0.13–0.17 ms/KB** | **4 KB** | **yes, per line** | no (doesn't need it) | everywhere; only the languages we write; no JSX yet |
| `exec` + bun/node script | lowlight speed, plus 13–176 ms spawn | 50–90 ms per file | none in mod | n/a (whole file) | yes | only where bun/node exist; inline code ≤128 KiB on Linux |
| `exec` + bat/pygmentize | — | — | — | — | yes | not installed here; rare on servers |
| native `Editor` / syntect | — | — | — | — | yes (native) | no span API; no `source.ts` |

## Recommendation and next steps

Write a table-driven, resumable line lexer; use it for JS/TS (then other C-family languages); keep lowlight behind it as the fallback.

1. **`herdr/src/lexer.ts` (new), pure and bundled into `core.js`.**
   - Signature: `lexLine(line, state, spec) → SyntaxRun[]`. `spec` holds the keyword sets, line/block comment tokens, quote characters, template/raw string rules and the regex-literal rule.
   - Start from the `charCodeAt` variant benchmarked here (Appendix A): plain loops, no closures in the hot path. Its speed-up was measured in an interpreter, so it doesn't rely on the JIT.
   - Map kinds to match today's colours: `this` → `attr`; `true`/`false`/`null`/`undefined` → `number`; identifier after `.` → `attr`; capitalised identifier → `type`; identifier before `(` → `function`.
   - No `Intl` / `TextEncoder`, per CLAUDE.md.
2. **`SyntaxDoc` in `herdr/src/syntax.ts`.** When the file's extension has a lexer spec, skip `planChunks` and lex sequentially.
   - Dispatch on the extension, not on the grammar name: `languageFor` returns `tsx`/`jsx` too. `.jsx`/`.tsx` stay on lowlight until the lexer has a JSX mode.
   - Keep `lineRuns` plus `stateAt[k]`, a cloned state every 64 lines.
   - Add `advance(untilLine, budgetMs)`: it lexes from the first undone line onward and stops at the budget.
   - `runs(n)` stays as is; `chunkOf` and `isDone` become "is line n lexed".
   - For edits (`before`):
     - reuse runs above the first changed line;
     - re-lex from there until the state after a line equals the old state at the matching old line;
     - then reuse the old tail, shifted.
   - Other languages keep the current lowlight chunk path unchanged.
3. **`startSyntax` in `herdr/git-diff/main.js`.** For lexer docs, the job is "advance to the furthest line any visible or unified row needs", inside the same ≤6 ms slice, then `cx.notify()` and `cx.sleep(16)`.
   - Visible-first ordering no longer matters: the whole of a 263 KB file is about 7 slices at the estimated rate.
   - Keep the `beat` staleness guard. A slice killed by the uncatchable interrupt still leaves a stale beat.
4. **Bundle.** Once the lexer covers the common languages, consider replacing `lowlight` + `common` with `highlight.js/lib/core` and a hand-picked list (37 KB for JS+TS against 177 KB for `common`). That makes `core.js` smaller and quicker to load. Keep `languageFor` driven by whichever is registered.
5. **Tests (`herdr/src/core.test.ts`).**
   - Lexing whole equals lexing resumed at every line.
   - Comment and string spans equal lowlight's on the fixtures (`main.js`, `Git.ts`, a template string and a block comment that contain blank lines).
   - A timing guard: ≥10× faster than `highlightLines` in Bun.
6. **In-app checks before committing.** Run the probe mod in Appendix B when you choose to; nothing was opened or linked for this note. It answers:
   - P1: engine facts, and whether the JIT is on;
   - P2: superlinear cost vs the interrupt;
   - P3: the real lexer ms/KB that replaces the 0.13–0.17 estimate, and the largest single call that survives.

## Reproducing

Scratch directory: `/private/tmp/claude-501/-Users-deega-Documents-playground-git-diff-view/73fd5574-ee5b-4d82-9d55-41115a1c1ffd/scratchpad/` (temporary; a reboot clears it).

```sh
# engine
otool -L /Applications/Herdr.app/Contents/MacOS/Herdr
grep -n -i -E "quickjs|tree-sitter|syntect|regress|boa|wasm" /Applications/Herdr.app/Contents/Resources/THIRD-PARTY-NOTICES
strings -n 6 /Applications/Herdr.app/Contents/MacOS/Herdr > herdr-strings.txt
grep -i -E "quickjs|JIT backend|syntect|WebAssembly" herdr-strings.txt
curl -sfL https://raw.githubusercontent.com/longbridge/quickjs-jit/96593cd7a54440ac060a391b8baea7e9a3cf1393/.gitmodules
curl -sfL https://raw.githubusercontent.com/quickjs-ng/quickjs/fd0a0210b7be00957751871e7e01b8291268fc29/quickjs.h | grep QJS_VERSION
# (and libregexp.c, quickjs.c, quickjs-libc.c at the same commit)

# benchmarks (bench/ in the scratch dir)
bun add lowlight@3.3.0 highlight.js@11 refractor prismjs shiki @shikijs/core @shikijs/engine-javascript \
  @shikijs/langs @shikijs/themes sugar-high @speed-highlight/core quickjs-emscripten-core \
  @jitl/quickjs-ng-wasmfile-release-sync
bun bench-bun.ts                       # Bun, all candidates, 4 inputs
bun build-qjs.ts                       # IIFE bundle; maps decode-named-character-reference to its non-DOM build
bun bench-qjs.ts lowlightCurrent,lowlightChunked,hljsDirect,refractorRuns,prismTokens,sugarHigh,handChar,handRe main,git 5
bun bench-qjs.ts lowlightCurrent,prismTokens,handChar core8,core16,core32,core64,core128,core256 5   # quiet sweep
bun jitbase.ts                         # scalar-loop baseline for probe P1
bun bench-qjs.ts shikiJs,shikiForgiving main,git 3
bun cs.ts; bun cs2.ts inputs/App.tsx inputs/CommitGraph.tsx; bun disagree.ts inputs/main.js handChar; bun chunkcmp.ts
```

## Appendix A: the benchmarked lexer (`lexer.js`)

This is the char-loop variant timed above as `handChar`, in plain JS. `bun eqcheck.ts` checked that its output is identical to the TS version on all three inputs.

```js
// Hand-written single-pass JS/TS lexer (charCodeAt loop), one line at a time, resumable.
// Runs are [from, to, kind] with kinds from herdr/src/syntax.ts.

/** State carried between lines: mode 0 code, 1 block comment, 2 template string;
 *  tpl: for each open template, the brace depth inside its current `${`;
 *  regexOk: a `/` here starts a regex literal. */
export const initState = () => ({ mode: 0, tpl: [], regexOk: true });

const KEYWORDS = new Set(
  ("abstract as async await break case catch class const continue debugger declare default delete do else enum export extends " +
    "false finally for from function get if implements import in infer instanceof interface is keyof let namespace new null of " +
    "package private protected public readonly return satisfies set static super switch this throw true try type typeof undefined " +
    "unique var void while with yield").split(" "),
);
// After these keywords a `/` starts a regex.
const REGEX_AFTER = new Set("return typeof instanceof in of new delete void throw case do else yield await".split(" "));

const isIdStart = (c) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 36 || c > 127;
const isIdPart = (c) => isIdStart(c) || (c >= 48 && c <= 57);
const isDigit = (c) => c >= 48 && c <= 57;

function push(runs, from, to, kind) {
  if (to <= from) return;
  const last = runs[runs.length - 1];
  if (last && last[1] === from && last[2] === kind) last[1] = to;
  else runs.push([from, to, kind]);
}

/** Char-loop variant. Mutates `st`; returns this line's runs. */
export function lexLine(line, st) {
  const runs = [];
  const n = line.length;
  let i = 0;
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
        else if (c === 96) { i++; st.mode = 0; st.tpl.pop(); st.regexOk = false; break; }
        else if (c === 36 && line.charCodeAt(i + 1) === 123) { st.mode = 0; st.tpl[st.tpl.length - 1] = 1; break; }
        else i++;
      }
      push(runs, from, Math.min(i, n), "string");
      if (st.mode === 0 && st.tpl.length && st.tpl[st.tpl.length - 1] === 1 && line.charCodeAt(i) === 36) { i += 2; st.regexOk = true; }
      continue;
    }
    const c = line.charCodeAt(i);
    if (c === 32 || c === 9) { i++; continue; }
    if (c === 47) {
      const d = line.charCodeAt(i + 1);
      if (d === 47) { push(runs, i, n, "comment"); i = n; continue; }
      if (d === 42) { st.mode = 1; push(runs, i, i + 2, "comment"); i += 2; continue; }
      if (st.regexOk) {
        let j = i + 1, cls = false;
        for (; j < n; j++) {
          const e = line.charCodeAt(j);
          if (e === 92) j++;
          else if (e === 91) cls = true;
          else if (e === 93) cls = false;
          else if (e === 47 && !cls) break;
        }
        if (j < n) {
          j++;
          while (j < n && isIdPart(line.charCodeAt(j))) j++;
          push(runs, i, j, "string");
          i = j;
          st.regexOk = false;
          continue;
        }
      }
      i++; st.regexOk = true; continue;
    }
    if (c === 34 || c === 39) {
      let j = i + 1;
      for (; j < n; j++) {
        const e = line.charCodeAt(j);
        if (e === 92) j++;
        else if (e === c) { j++; break; }
      }
      push(runs, i, Math.min(j, n), "string");
      i = j; st.regexOk = false; continue;
    }
    if (c === 96) { st.mode = 2; st.tpl.push(0); push(runs, i, i + 1, "string"); i++; continue; }
    if (isDigit(c) || (c === 46 && isDigit(line.charCodeAt(i + 1)))) {
      let j = i + 1;
      while (j < n) {
        const e = line.charCodeAt(j);
        if (isIdPart(e) || e === 46) j++;
        else break;
      }
      push(runs, i, j, "number"); i = j; st.regexOk = false; continue;
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdPart(line.charCodeAt(j))) j++;
      const word = line.slice(i, j);
      if (KEYWORDS.has(word)) { push(runs, i, j, "keyword"); st.regexOk = REGEX_AFTER.has(word); }
      else {
        let k = j;
        while (k < n && line.charCodeAt(k) === 32) k++;
        if (line.charCodeAt(k) === 40) push(runs, i, j, "function");
        else if (c >= 65 && c <= 90) push(runs, i, j, "type");
        st.regexOk = false;
      }
      i = j; continue;
    }
    // Punctuation; braces track template `${ … }` nesting.
    if (st.tpl.length && st.tpl[st.tpl.length - 1] > 0) {
      if (c === 123) st.tpl[st.tpl.length - 1]++;
      else if (c === 125 && --st.tpl[st.tpl.length - 1] === 0) { st.mode = 2; i++; continue; }
    }
    st.regexOk = !(c === 41 || c === 93 || c === 125);
    i++;
  }
  return runs;
}

export function lexLines(lines, st = initState()) {
  return lines.map((l) => lexLine(l, st));
}
```

## Appendix B: in-app probe mod (P1, P2, P3)

Run it only when you choose to. It needs its own folder, not a link into the git-diff mod:

1. Create `~/.config/herdr-app/mods/syntax-probe/` holding `main.js` (below), `lexer.js` (Appendix A), a copy of `herdr/git-diff/core.js` (after `bun run build:herdr`), and `mod.json` containing `{ "place": "none", "title": "Syntax probe" }`.
2. Run `herdr-app check ~/.config/herdr-app/mods/syntax-probe`.
3. Open it with `herdr-app do tab.new --name "Syntax probe" --mod syntax-probe` and read the lines (or `herdr-app shot`).
4. Close the tab and delete the folder.

Reading the output:

- **P1 (engine facts).**
  - `300 captures: too many captures` confirms the libregexp limit.
  - For the loop timings, the proxy interpreter takes ~65 ms per 1e6 iterations (`bun jitbase.ts`: 140, 64, 66 … ms), so about 20 ms for `loop(3e5)`. The app interpreter, about 2.5× faster, should take ~8 ms.
  - Calls that drop to 0–1 ms after the first few mean the JIT tiered the function.
- **P2 (superlinear vs interrupt).** A `start` with no `done` means the task was killed at that size. `done` times whose ms/KB rises with size mean real superlinear cost.
- **P3 (lexer speed).** The `lexer done` times give the real ms/KB, and the largest single call that survives.

```js
// Syntax probe: engine facts (P1), lowlight size sweep (P2), lexer speed (P3).
// Needs ./lexer.js (Appendix A) and ./core.js (a copy of herdr/git-diff/core.js after `bun run build:herdr`).
import { View, div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { checking, readTextFile } from "herdr";
import { SyntaxDoc } from "./core.js";
import { lexLines } from "./lexer.js";

const REPO = "/Users/deega/Documents/playground/git-diff-view";

// Top-level, closure-free, so a JIT can tier it. Proxy baseline (quickjs-ng 0.12.1 WASM
// interpreter): ~65 ms per 1e6 iterations; Bun: ~1 ms. 3e5 iterations stay well inside a frame.
function loop(n) {
  let s = 0;
  for (let i = 0; i < n; i++) s += i & 7;
  return s;
}

export default class SyntaxProbe extends View {
  init(_props, cx) {
    this.out = [];
    if (checking()) return;
    cx.spawn(async (cx) => {
      const log = async (line) => { this.out.push(line); cx.notify(); await cx.sleep(16); };
      const g = globalThis;
      // P1: engine facts
      await log(`WebAssembly=${typeof g.WebAssembly} Worker=${typeof g.Worker} SharedArrayBuffer=${typeof g.SharedArrayBuffer}`);
      try { new RegExp("(a)".repeat(300)); await log("300 captures: ok"); } catch (e) { await log(`300 captures: ${e.message}`); }
      const loopMs = [];
      for (let k = 0; k < 20; k++) { const t = Date.now(); loop(3e5); loopMs.push(Date.now() - t); await cx.sleep(16); }
      await log(`loop(3e5) ms, call 1..20: ${loopMs.join(",")}`);
      // P2 + P3: growing prefixes, one call per frame; a "start" with no "done" = the task was killed there.
      const text = await readTextFile(`${REPO}/herdr/git-diff/core.js`);
      if (!text) return log("core.js not found");
      for (const kb of [16, 32, 64, 128, 256]) {
        const lines = text.slice(0, text.lastIndexOf("\n", kb * 1024)).split("\n");
        await log(`lexer start ${kb} KB`);
        let t = Date.now();
        lexLines(lines);
        await log(`lexer done ${kb} KB: ${Date.now() - t} ms`);
        await log(`lowlight start ${kb} KB`);
        const doc = new SyntaxDoc("js", lines);
        doc.chunks = [[0, lines.length]]; // one call over the whole prefix
        doc.done = [false];
        t = Date.now();
        doc.highlight(0);
        await log(`lowlight done ${kb} KB: ${Date.now() - t} ms`);
      }
      await log("finished");
    });
  }

  render() {
    return v_flex().size_full().p(8).gap(2).text_size(12)
      .children(this.out.map((line, i) => div().id(`l${i}`).child(line)));
  }
}
```

## Appendix C: QuickJS proxy harness (essentials)

The bundle is built with `Bun.build` (`build-qjs.ts`):

- `format: "iife"`, `target: "browser"`;
- a plugin that resolves `decode-named-character-reference` to its non-DOM `index.js`, because the browser build calls `document.createElement`.

The runner (`bench-qjs.ts`) does this for each input and candidate:

- `newQuickJSWASMModuleFromVariant(@jitl/quickjs-ng-wasmfile-release-sync)`;
- a fresh runtime (`setMemoryLimit(1 GiB)`, `setMaxStackSize(0)`, a 240 s interrupt deadline);
- `evalCode(bundle)`, then `evalCode("globalThis.__text = " + JSON.stringify(text))`;
- `evalCode("__run(name, lang, __text, reps)")`, where `__run` splits the text into lines and times the candidate with `Date.now()` inside QuickJS. It returns the median and every rep.
