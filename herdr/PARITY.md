# Herdr mod vs web viewer

The web viewer (`src/`) is the reference. These notes list where the Herdr mod
(`herdr/`) still behaves differently, and why. "Doable" items are plain JS work
nobody has done yet. "Not practical" items are blocked by the mod runtime (no
DOM, `Intl`, `TextEncoder`, Node or SQLite) or by gpui-kit.

## Matched in this pass

- Added and deleted files (untracked ones too) always use one column, even in
  side-by-side mode (`layout()` in `git-diff/main.js`).
- Changed words inside a modified line get a stronger tint, as in
  `@git-diff-view` (`inlineChanges` / `inlineMarks` / `segments` in
  `src/diffModel.ts`). Lines are compared word by word. Pairs that are more
  than half rewritten, or longer than 1000 characters, keep the plain line tint.
- The empty-diff messages use the web's wording: binary, renamed, copied, mode
  only, no content changes, and "File too large to show." A large file with
  hunks shows the web's "showing changed hunks only" banner.
- The file tree's +/− totals follow the filter.
- The pull request picker has "Stop comparing #N" and also matches the base branch.
- The graph header shows the range size ("N commits + uncommitted") and warns
  when B is an ancestor of A.
- Search:
  - Hits are ordered by path, so untracked files no longer come last.
  - Each file row shows its hit count, and the summary reads "N lines in M files".
  - In a live comparison, search runs again after each refresh. It rebuilds
    only when the patch text changed, and keeps the highlighted hit.
- The search-jump border follows its line when you switch layout or open a gap.
- Syntax highlighting, with the same highlight.js grammars as the web view (37
  common languages, through `lowlight`; `src/syntax.ts`). Colours come from
  the Herdr theme's ANSI palette.

## How syntax highlighting differs

The mod's script engine runs highlight.js at about 6 ms per KB, on the window's
thread, and slows down sharply on large inputs: a 263 KB file did not finish in
one call within about 45 seconds, while 50 KB pieces took about 330 ms each. So
the mod never highlights a file whole:

- Each side is cut at blank lines into chunks of about 4 KB. Only chunks that
  hold lines the diff shows are highlighted, one per tick in the background,
  and rows are drawn plain until their chunk is done.
- Each chunk is highlighted on its own. If a chunk edge falls inside a
  construct that spans a blank line (a template string, a block comment or
  docstring, a fenced code block), the next chunk starts outside it and is
  coloured wrongly up to the construct's end. The web view highlights the
  whole file.
- After an edit to a live file, lines above and below the edited stretch keep
  their colours while their chunks are redone, so saving doesn't flash plain.
- No highlighting without full file text: files over 1 MB, files too large to
  read, and CRLF files the mod shows from the patch alone. Lines over 2,000
  characters stay plain.
- The language comes from the file extension (or `Makefile`). There is no
  content-based detection, so files without a known extension stay plain.

## Not practical in Herdr

| Web behaviour | Why not in the mod |
| --- | --- |
| Search index in in-memory SQLite FTS5 (`src/server/DiffIndex.ts`) | No SQLite in the mod runtime. `src/search.ts` scans lower-cased lines instead, which takes milliseconds at the 200k-line cap. Matching is the same: literal and case-insensitive. |
| URL state (`?base&head&file`, shareable links) | A mod has no address bar. Tab props (`folder`, `on`, `base`/`head` or `pr`) do the same job when opening a tab. |
| Light/dark toggle | The mod follows Herdr's theme by design. |
| Tooltips on tree rows (rename "old → new") | Virtual-list rows can't register handlers, including `tooltip`. The rename could still be shown as inline text (doable). |
| Exact wrapped-line heights | Row heights are estimated from character count at 0.6 em. Wide characters (CJK, emoji) or long unbroken tokens can clip. A virtual list needs sizes before layout. |
| 2 MiB working-tree file limit | The host's `readTextFile` reads at most 1 MiB, and larger untracked files show as "too large". |
| Pausing refresh while hidden | The web pauses polling when its tab is hidden. No visibility signal for mods was found, so the mod watches the folder plus a 10 s timer (3 s on remote machines). |

## Doable, not done yet

- Graph right-click menu: view commit, move A or B here, copy commit ID. Right
  now you can't copy a commit ID from the mod.
- Graph drawing details: the bracket joining A and B, dimmed dots outside the
  range, hollow merge dots, auto-scroll while dragging near an edge, and
  "Load more" disabled while it loads.
- Ref picker: hide "Use …" when the typed text names a ref exactly, and pick a
  commit's short SHA, as the web does.
- Pull request list: count on the button, base ← head, fork prefix, updated date.
- Tree: inline "← old name" on renamed files, file-type icons, Esc to clear the
  filter, and Down to move from the filter into the tree.
- Worktree reads: symlinks show their target's text, and mode is always
  `100644`. `git ls-files -s` could supply the real mode.
