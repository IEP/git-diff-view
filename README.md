# git-diff-view

A read-only, IntelliJ-style viewer for comparing any two Git revisions: branches, tags, commits, or expressions like `HEAD~3`.

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

It prints the URLs that work: LAN IPs, the Tailscale IP, `<name>.local`, and the MagicDNS name (`machine.tailnet.ts.net`, read from `tailscale status` when the CLI is installed).

**There is no login.** Anyone who can reach the port can read every file in the repository's history. Prefer the Tailscale-IP bind on networks you don't control.

The API still rejects requests whose `Host` isn't one of this machine's own addresses or names, which blocks DNS rebinding. If you reach it through some other name, such as a reverse proxy or custom DNS, allow that name with `--allow-host diff.example.lan` (repeatable) or `ALLOWED_HOSTS=a,b`. `git-diff-view --help` lists all options.

The binary runs in production mode (no HMR) and needs only `git` (plus `gh` for pull requests) on the machine. Rebuild after changing the source.

Then open the printed URL. The URL keeps `?base=…&head=…&file=…`, so you can bookmark or share it.

## Using it

| Action | How |
|---|---|
| Pick revisions | Base / Head pickers: search branches, remotes, tags and commits, or type any revision |
| Pick from the graph | Commit graph panel above the diff: **click** a commit to view it alone, **drag** the **A** / **B** handles in the left gutter to move either end (the list auto-scrolls near its edges, Esc cancels), or **Shift-click** to select a range. Commits whose changes are in the diff are tinted. Right-click or the A / B / Enter keys work too |
| Show / hide the graph | **Graph** button in the header, or the hide button at the right of the graph's bar |
| Navigate tree | ↑ ↓ to move, ← → to collapse/expand, Enter to toggle, Home/End |
| Next / previous file | F7 / Shift+F7, or the arrows in the diff header |
| Filter | Box above the tree (Esc to clear, ↓ to jump into the tree) |
| Layout | Side-by-side or unified, line wrap, light/dark theme |

Comparison is a direct two-point diff (`git diff A B`), like IntelliJ's "Compare with…".

## GitHub pull requests

If the `upstream` or `origin` remote points at github.com, a **Pull requests** picker appears in the header. It lists open PRs through the GitHub CLI, so [`gh`](https://cli.github.com) must be installed and logged in (`gh auth login`); private repositories work too.

Picking a PR compares the **merge-base** of its base and head with its head, which matches GitHub's "Files changed" tab. The URL becomes `?pr=123`, and opening that link fetches the PR's current head again, so it picks up new pushes. Choosing a base or head by hand leaves PR mode.

PR commits that aren't in your clone yet, such as those from forks, are fetched once by commit ID (see below).

## Read-only by design

- Git runs through a single helper with an allow-list: `rev-parse`, `for-each-ref`, `log`, `diff`, `ls-tree`, `cat-file`, `merge-base`, `ls-remote --get-url`.
- **One exception, for pull requests only:** when a PR's commits are missing locally, the app runs `git fetch <remote> <sha>…` with `--no-write-fetch-head --refmap= --no-tags` and auto-gc off. This adds objects to `.git/objects` and nothing else: no ref, `FETCH_HEAD`, index or working-tree change. Commit IDs from GitHub must be 40-character (or 64-character) hex before git sees them.
- Arguments go to git as an array, never through a shell. User refs are rejected if they start with `-`, then resolved with `rev-parse --verify --end-of-options`.
- Runs with `GIT_OPTIONAL_LOCKS=0`, `--no-ext-diff` and `--no-textconv`, so it never touches the index and never runs external tools.
- The API exposes only GET routes.

## Layout

```
src/index.ts             Bun.serve: CLI flags, SPA + /api/* → Effect handler
src/server/HostGuard.ts  Host-header allow-list (loopback, own IPs, .local, MagicDNS)
src/server/Git.ts        Git service (Effect): refs, compare, file diff, -z parsers
src/server/GitHub.ts     GitHub service: remote detection, PR list / resolve via `gh`
src/server/Api.ts        HttpRouter routes, schema-validated query params
src/shared/api.ts        Wire types shared by server and client
src/lib/tree.ts          Changed files → compacted directory tree
src/lib/graph.ts         Commit graph lane layout, A..B range
src/components/          RefPicker, PullPicker, CommitGraph, FileTree, DiffPane
```

Tests: `bun test`
