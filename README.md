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
src/lib/tree.ts          Changed files → compacted directory tree
src/lib/graph.ts         Commit graph lane layout, A..B range
src/components/          RefPicker, PullPicker, CommitGraph, FileTree, DiffSearch, DiffPane
```

Tests: `bun test`
