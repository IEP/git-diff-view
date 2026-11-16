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

Then open the printed URL. The URL keeps `?base=…&head=…&file=…`, so you can bookmark or share it.

## Using it

| Action | How |
|---|---|
| Pick revisions | Base / Head pickers: search branches, remotes, tags and commits, or type any revision |
| Navigate tree | ↑ ↓ to move, ← → to collapse/expand, Enter to toggle, Home/End |
| Next / previous file | F7 / Shift+F7, or the arrows in the diff header |
| Filter | Box above the tree (Esc to clear, ↓ to jump into the tree) |
| Layout | Side-by-side or unified, line wrap, light/dark theme |

Comparison is a direct two-point diff (`git diff A B`), like IntelliJ's "Compare with…".

## Read-only by design

- Git runs through a single helper with an allow-list: `rev-parse`, `for-each-ref`, `log`, `diff`, `ls-tree`, `cat-file`.
- Arguments go to git as an array, never through a shell. User refs are rejected if they start with `-`, then resolved with `rev-parse --verify --end-of-options`.
- Runs with `GIT_OPTIONAL_LOCKS=0`, `--no-ext-diff` and `--no-textconv`, so it never touches the index and never runs external tools.
- The API exposes only GET routes.

## Layout

```
src/index.ts             Bun.serve: SPA + /api/* → Effect handler
src/server/Git.ts        Git service (Effect): refs, compare, file diff, -z parsers
src/server/Api.ts        HttpRouter routes, schema-validated query params
src/shared/api.ts        Wire types shared by server and client
src/lib/tree.ts          Changed files → compacted directory tree
src/components/          RefPicker, FileTree, DiffPane
```

Tests: `bun test`
