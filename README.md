# git-diff-view

A read-only, IntelliJ-style viewer for comparing any two Git revisions: branches, tags, commits, expressions like `HEAD~3`, or your uncommitted changes (working tree, staged).

- **Backend:** Bun + Effect v4 (`effect/http` router, `effect/process` to run git)
- **Frontend:** React 19 + shadcn/ui + Tailwind v4, diffs rendered by `@git-diff-view/react`

## Run

```bash
bun install
bun dev -- /path/to/repo        # or: REPO=/path/to/repo bun dev   (defaults to cwd)
# PORT=4000 bun dev -- ...      # default port 3000
```

### Standalone binary (no `bun dev`)

```bash
bun run install:bin                    # → ~/.bun/bin/git-diff-view, already on PATH; re-run after changes
cd /path/to/repo && git-diff-view      # or: git-diff-view /path/to/repo
bun run build                          # alternative: just build dist/git-diff-view
```

### From other machines (LAN, Tailscale)

By default the server listens on `127.0.0.1` only. To open it from a phone, tablet or another computer:

```bash
git-diff-view --lan                        # all interfaces; prints every URL that reaches it
git-diff-view --host 100.x.y.z             # your Tailscale IP: reachable from the tailnet only, not the LAN
bun dev -- /path/to/repo --lan             # same flags in dev mode (HOST=0.0.0.0 works too)
```

It prints the URLs that work. With `--lan` those are the LAN IPs, the Tailscale IP, `<name>.local` and the MagicDNS name (`machine.tailnet.ts.net`, read from `tailscale status` when the CLI is installed). With `--host <tailscale-ip>` only the IP and the full MagicDNS name are accepted. Short names and `.local` can be spoofed by anyone on the LAN, so they would let a LAN attacker reach a tailnet-only server.

**There is no login.** Anyone who can reach the port can read every file in the repository's history, and your uncommitted work (tracked and untracked files that aren't gitignored). Prefer the Tailscale-IP bind on networks you don't control.

The API still rejects requests whose `Host` isn't one of this machine's own addresses or names, which blocks DNS rebinding. If you reach it through some other name, such as a reverse proxy or custom DNS, allow that name with `--allow-host diff.example.lan` (repeatable) or `ALLOWED_HOSTS=a,b`. `git-diff-view --help` lists all options.

The binary runs in production mode (no HMR) and needs only `git` (plus `gh` for pull requests) on the machine. Rebuild after changing the source.

Then open the printed URL. It opens on `main` (or `master`, …) → **Working tree**: everything on your branch, committed or not. The URL keeps `?base=…&head=…&file=…`, so you can bookmark or share it.

## Using it

| Action | How |
|---|---|
| Pick revisions | Base / Head pickers: search branches, remotes, tags and commits, or type any revision |
| Uncommitted changes | Pick **Working tree** (files on disk, including untracked) or **Staged (index)** under *Local changes* in either picker. `HEAD → Working tree` is everything not yet committed, `HEAD → Staged` is the next commit, `Staged → Working tree` is what `git add` hasn't picked up. See *Live updates* below |
| Pick from the graph | Commit graph panel above the diff: **click** a commit to view it alone (pinned to that commit), **drag** the **A** / **B** handles in the left gutter to move either end (the list auto-scrolls near its edges, Esc cancels), or **Shift-click** to select a range. Commits whose changes are in the diff are tinted. Right-click or the A / B / Enter keys work too |
| Show / hide the graph | **Graph** button in the header, or the hide button at the right of the graph's bar |
| Navigate tree | ↑ ↓ to move, ← → to collapse/expand, Enter to toggle, Home/End |
| Next / previous file | F7 / Shift+F7, or the arrows in the diff header |
| Filter | Box above the tree (Esc to clear, ↓ to jump into the tree) |
| Search changes | **⌘⇧F** / **Ctrl+Shift+F** or the 🔍 button: find text in the added and removed lines of the whole comparison. ↑ ↓ / Enter or click jump to the line, matches are highlighted in the diff, Esc clears then closes. See *Search* below |
| Layout | Side-by-side or unified, line wrap, light/dark theme |

The top row of the graph is the **working tree** (dashed dot, with the number of uncommitted files), drawn on top of HEAD: drag **B** onto it to include uncommitted work, or click it to see just the uncommitted changes against your branch.

A handle dropped on a branch tip picks the branch by name, not its commit id: the current branch first, then another local branch, `HEAD`, a remote branch or a tag.

### Live updates

A comparison that names something movable (a branch, `HEAD`, the working tree or the index) re-reads itself every 2 seconds while the tab is visible, and right away when you come back to it, so edits and new commits from an editor or an agent show up on their own. The next read starts only after the previous one finished. Unchanged results don't re-render, so scroll position and expanded context stay put. ↻ next to the pickers reloads at once. Comparisons of fixed commit ids (a pull request, a clicked commit) never change and aren't polled.

Comparison is a direct two-point diff (`git diff A B`), like IntelliJ's "Compare with…". In the URL the working tree is `:worktree` and the index `:index` (a ref name can't contain `:`), e.g. `?base=HEAD&head=:worktree`; these map to `git diff [--cached] [-R] <commit>`. Untracked files come from `git ls-files --others --exclude-standard` and show as added.

### Search

The search panel replaces the file tree and looks for a literal, case-insensitive substring (`50%_off`, `"quoted"`, `a OR b` all mean exactly that text) in the changed lines only, not in unchanged context. Untracked files count as added when one side is the working tree.

On the first search of a comparison the server reads it as one `git diff -U0` and indexes every changed line into an **in-memory** SQLite FTS5 table with the trigram tokenizer, so any 3+ character substring is an index lookup (shorter queries scan). Nothing is written to disk. The last 3 comparisons stay indexed. Two commit ids are indexed once; a comparison involving the working tree or the index re-reads the diff on each search and rebuilds only if it changed. Above 200,000 changed lines, files that don't fit are left out of the search; this is decided from `git diff --numstat` before any patch text is read, and the panel says the search is partial. Lines are indexed up to 2,000 characters.

## Inside Herdr

The same viewer runs natively in [Herdr](https://herdr.dev) as a mod, in a tab next to your terminals: no server, no browser. It has the commit graph with A / B handles, the Base / Head pickers (working tree and index included), pull requests, the file tree and filter, unified or side-by-side diffs with expandable context, wrap, F7 navigation, search over the changed lines, and live updates.

```bash
bun run install:herdr        # build, link ~/.config/herdr-app/mods/git-diff here, add the Diff button
bun run uninstall:herdr      # back to your original layout; removes the copy and the link
```

Click **Diff** at the right of the tab bar, after Files and Changes. It opens a tab **Diff · <repo>** for the focused terminal's repository, or switches to it when the space already has one; on another machine's space, git runs on that machine. The tab remembers its comparison. Without the button, `herdr-app do mod.open --name git-diff` does the same.

The button needs a place in the window, and Herdr's own tab bar and menus can't be extended, so the installer copies the layout you're on (`main` → `main-diff`, with Herdr's `layout.clone`), switches to it, and in the copy wraps the tab bar block in a row with the button beside it. Herdr's mods (tab bar, menus, panels) stay untouched and keep updating; only that layout copy no longer follows Herdr's changes to `main`. Uninstall switches back and deletes the copy, unless you edited it.

Commands for keys in `keys.json` (`"mod:git-diff": { "f7": "git-diff.next-file" }`): `git-diff.next-file`, `prev-file`, `search`, `graph`, `split`, `unified`, `wrap`, `reload`, `pick-base`, `pick-head`, `pick-pr`.

Differences from the web app, from what Herdr's mod runtime allows:
- Syntax highlighting: JS and TS use the mod's own fast lexer; other languages use the web view's grammars in small background chunks (the mod's script engine is slow at them), so a comment or string spanning a blank line can be miscoloured at a chunk edge there. Files over 1 MB stay plain.
- Search scans the changed lines in memory (no SQLite there); same literal, case-insensitive matching and 200,000-line limit.
- Long lines scroll sideways with the trackpad or Shift+wheel, both sides of a split row together.
- Local repositories refresh when files change (Herdr's folder watch, plus every 10 s); other machines every 3 s.
- "Open on GitHub" for a pull request is the one thing that opens a browser.

The full list, with what's left to match and why some of it can't be, is in [`herdr/PARITY.md`](herdr/PARITY.md).

Pull requests and spaces on other machines use the same code paths as the rest, but haven't been tried inside Herdr yet.

The mod is plain JavaScript in `herdr/git-diff/`; its git, diff, search, tree and graph code is TypeScript in `herdr/src/` plus the shared `src/lib/` and `src/shared/gitText.ts`, bundled into `core.js`. While working on it, `bun run build:herdr --watch` rebuilds and makes Herdr reload the mod on every save.

## In the terminal

The same viewer also runs in your terminal, with no server and no browser. It's handy over SSH or in a tmux pane:

```bash
git-diff-view --tui                                  # main → working tree, in the current repository
git-diff-view ~/code/app --tui --base v1.2 --head HEAD
git-diff-view --tui --pr 123                         # a GitHub pull request (needs gh)
git-diff-view --tui --unified                        # start in one column instead of side by side
bun src/index.ts --tui                               # from a checkout, without building
```

It has the file tree and filter, side-by-side or unified diffs with syntax colours and changed-word highlights, gaps you can open, the Base / Head pickers (working tree and index included), pull requests, search over the changed lines, and the same live updates (every 2 s for anything movable). Press `?` for every key. The main ones:

| Key | Does |
|---|---|
| `tab` | switch between the file list and the diff |
| `↑ ↓` / `j k`, `PgUp PgDn`, `g G` | move |
| `enter` | open a file, fold a folder, or show the lines hidden in a `⋯` row (`J` / `K`, or its `↓ 20` / `↑ 20` buttons, show 20 more) |
| `,` / `.` or `Shift+F7` / `F7` | previous / next file |
| `[ ]` | previous / next change in the file |
| `← →` | scroll long lines sideways in the diff (`0` resets) |
| `b` / `h`, `x` | pick the base / head revision, swap them |
| `p` | pick a pull request |
| `/`, `n N` | search the changed lines, next / previous hit |
| `f` | filter files by path |
| `s`, `r`, `q` | side by side ↔ unified, reload, quit |
| `<` / `>`, `=` | narrower / wider sidebar, back to the automatic width (or drag the `│` divider) |
| mouse | click a file, a `⋯` row (or its `↓ 20` / `↑ 20` buttons), a search hit or a picker entry; click the base / head (or the PR) in the top bar to change it, the layout name to switch it; drag the divider to resize the sidebar; the wheel scrolls the pane under the pointer |

While it runs, the terminal sends mouse clicks to the viewer, so selecting text needs the terminal's override (usually Shift-drag, Option-drag in iTerm2 and Terminal.app).

It reuses the Herdr mod's git layer and diff model (`herdr/src`) on a local process runner, and reads working-tree files through the server's guarded `readDisk`, so the same read-only rules apply. Text from the repository has its control characters drawn as visible symbols (`␛`), so a file can't send escape sequences to your terminal. The commit graph isn't in the terminal version yet. Colours use the 256-colour palette and are tuned for dark themes.

## GitHub pull requests

If the `upstream` or `origin` remote points at github.com, a **Pull requests** picker appears in the header. It lists open PRs through the GitHub CLI, so [`gh`](https://cli.github.com) must be installed and logged in (`gh auth login`); private repositories work too.

Picking a PR compares the **merge-base** of its base and head with its head, which matches GitHub's "Files changed" tab. The URL becomes `?pr=123`, and opening that link fetches the PR's current head again, so it picks up new pushes. Choosing a base or head by hand leaves PR mode.

PR commits that aren't in your clone yet, such as those from forks, are fetched once by commit ID (see below).

## Read-only by design

- Git runs through a single helper with an allow-list: `rev-parse`, `for-each-ref`, `log`, `diff`, `ls-tree`, `cat-file`, `merge-base`, `ls-remote --get-url`, `ls-files`.
- **One exception, for pull requests only:** when a PR's commits are missing locally, the app runs `git fetch <remote> <sha>…` with `--no-write-fetch-head --refmap= --no-tags` and auto-gc off. This adds objects to `.git/objects` and nothing else: no ref, `FETCH_HEAD`, index or working-tree change. Commit IDs from GitHub must be 40-character (or 64-character) hex before git sees them.
- Arguments go to git as an array, never through a shell. User refs are rejected if they start with `-`, then resolved with `rev-parse --verify --end-of-options`.
- Runs with `GIT_OPTIONAL_LOCKS=0`, `--no-ext-diff` and `--no-textconv`, so it never writes the index and never runs diff tools. (Working-tree comparisons do run any clean filters the repository configures, such as git-lfs, exactly as `git diff` would.)
- Working-tree files are read from disk only when `git ls-files` lists that exact path (tracked, or untracked and not ignored), so `.git/*` and ignored files such as `.env` are never served. Paths with `..`, `.`, empty or absolute parts are rejected; a symlink yields its target text and is never followed; nothing is read through a symlinked directory.
- The API exposes only GET routes.

## Layout

```
src/index.ts             Bun.serve: CLI flags, SPA + /api/* → Effect handler
src/server/HostGuard.ts  Host-header allow-list (loopback, own IPs, .local, MagicDNS)
src/server/Git.ts        Git service (Effect): refs, compare, file diff, whole patch (commits, index, working tree), -z parsers
src/server/DiffIndex.ts  Diff search: -U0 patch parser, in-memory SQLite FTS5 (trigram) index, LRU cache, DiffSearch service
src/server/GitHub.ts     GitHub service: remote detection, PR list / resolve via `gh`
src/server/Api.ts        HttpRouter routes, schema-validated query params
src/shared/api.ts        Wire types shared by server and client
src/shared/gitText.ts    Pure git-output parsers (name-status, numstat, log, -U0 patch, remotes), shared with the Herdr mod
src/lib/tree.ts          Changed files → compacted directory tree
src/lib/graph.ts         Commit graph lane layout, A..B range
src/components/          RefPicker, PullPicker, CommitGraph, FileTree, DiffSearch, DiffPane
src/tui/app.ts           Terminal viewer (--tui): loading, live refresh, keys; runs herdr/src's repo layer
src/tui/state.ts         Its state and derived rows (tree, diff, pickers, search), pure
src/tui/view.ts          Draws the state as one ANSI string per row, pure (tested without a terminal)
src/tui/term.ts          Raw mode, alternate screen, key decoding, line-diffing painter
src/tui/ansi.ts          Styled spans fitted to display columns; control characters made inert
src/tui/host.ts          Local Host for herdr/src/repo.ts: Bun.spawn plus the server's readDisk
herdr/build.ts           Bundles herdr/src → herdr/git-diff/core.js; --install links the mod and adds the button, --uninstall undoes it, --watch reloads it
herdr/layout.ts          Wraps a layout's tab bar block with the Diff button (for the installer's layout copy)
herdr/src/repo.ts        The mod's git layer: Git + GitHub services as plain async over Herdr's exec / readTextFile
herdr/src/diffModel.ts   One file's diff as rows: hunks, expandable gaps, unified / side-by-side pairs, changed words
herdr/src/search.ts      Search over a -U0 patch's changed lines, in memory
herdr/src/syntax.ts      Syntax colours: the JS/TS lexer, or lowlight a chunk at a time
herdr/src/lexer.ts       Resumable line-at-a-time JS/TS lexer for the mod
herdr/PARITY.md          Where the Herdr mod still differs from the web app, and why
herdr/research/          Research notes for the mod (e.g. faster syntax highlighting)
herdr/git-diff/          The Herdr mod (gpui-kit JS): main.js (state, toolbar button, launcher), graph, tree, diff, search, picker, ui
```

Tests: `bun test`

## License

[MIT](LICENSE)
