
Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

## Network exposure

- The server binds `127.0.0.1` by default. `--lan` (all interfaces) or `--host <addr>` (e.g. the Tailscale IP) expose it; flags live in `src/index.ts`.
- `/api/*` is guarded by `src/server/HostGuard.ts`: the `Host` header must be loopback, one of this machine's interface IPs, its names, or an `--allow-host` / `$ALLOWED_HOSTS` entry, on the bound port. `namesFor()` decides the names: spoofable ones (`.local`, single-label hostnames) only on a wildcard bind. A specific bind gets only the MagicDNS FQDN, and only if it's a Tailscale IP. This blocks DNS rebinding. Never loosen it to "any Host"; add names explicitly.
- There is no auth: anyone who reaches the port can read the repo, including uncommitted and untracked (non-ignored) files. Keep loopback the default.
- Working-tree reads (`:worktree` pseudo-revision, `src/server/Git.ts`) must stay gated on `git ls-files` listing the exact path, plus `isRepoPath` and the realpath check in `readDisk`. Never read an arbitrary request path from disk.
- `/api/search` (`src/server/DiffIndex.ts`) takes only `base`, `head`, `q`, never a path; its text comes from `Git.patch`. The SQLite index is `:memory:` only: never give it a file path.
- When testing a bind locally, use an unused port. Old `git-diff-view` binaries often sit on 127.0.0.1:3917/3918, and macOS lets a `0.0.0.0` listener share the port, so loopback-resolved names hit the old process.

## Herdr mod (`herdr/`)

- `herdr/git-diff/` is the mod (plain JS on Herdr's gpui-kit), linked into `~/.config/herdr-app/mods/git-diff` by `bun run install:herdr`. `core.js` there is generated from `herdr/src/core.ts` (`bun run build:herdr`) and gitignored, as are the `gpui-kit.d.ts` / `jsconfig.json` Herdr writes into the folder.
- `install:herdr` also clones the shown layout (`layout.clone`, e.g. `main` → `main-diff`) and wraps its `tabs` block with the Diff button (`herdr/layout.ts`), recording what it made in `~/.config/herdr-app/data/git-diff-toolbar.json`; `uninstall:herdr` switches back and deletes only that, refusing if the copy was edited. Never edit Herdr's shipped mods or layouts in place (they're reset on start).
- Herdr's watcher sees the link, not the repo files behind it: after editing, run `bun run build:herdr` (it touches the link) or `touch -h ~/.config/herdr-app/mods/git-diff`, or keep `bun run build:herdr --watch` running. Otherwise the window keeps running the old code while `herdr-app check` passes on the new.
- The mod runtime has no `Intl`, `TextEncoder` / `TextDecoder`, Node or DOM. Anything bundled into `core.js` (`herdr/src`, `src/lib`, `src/shared/gitText.ts`) must stay free of them; `src/shared/gitText.ts` is also used by the server, so keep it pure.
- Virtual-list rows (`v_virtual_list` render callbacks) can't register handlers (`on_click`, `on_mouse_*`, `tooltip`): use the list's `on_item_click(key)`. The commit graph draws its own window of rows for that reason (drag, shift-click).
- Same read-only rules as the server: every git call goes through `READ_ONLY` in `herdr/src/repo.ts`; working-tree reads stay gated on `git ls-files` plus `isRepoPath`.
- Syntax colours go through `SyntaxDoc` (`herdr/src/syntax.ts`), worked ~6 ms per frame from `startSyntax`, on-screen rows first. JS/TS use the resumable lexer (`herdr/src/lexer.ts`, ~0.4 ms/KB in the mod); other languages use lowlight in ~1 KB chunks (~9-13 ms/KB). Never highlight a whole file in one call: the mod's engine (QuickJS-NG) runs on the window's thread and Herdr kills a call after ~0.5 s, silently (no `finally`, hence the heartbeat). highlight.js mentions `document` / `window` only in `highlightAll`, which is never called; keep it that way.
- The web viewer is the reference for behaviour. `herdr/PARITY.md` lists where the mod still differs and why (e.g. no SQLite, so search scans lines); update it when closing or adding a gap.
- Test in the running window: open a test tab with `herdr-app do tab.new --name "Diff (test)" --mod git-diff --props '{"folder":"<repo>"}'`, drive it with `herdr-app do git-diff.<command>`, `herdr-app shot`, then switch back and close the tab.

## Commit flow

When asked to commit / push:

1. Verify first: `bunx tsc --noEmit -p .`, `bun test`, and `bun run build` if `src/` or `build.ts` changed; `bun run build:herdr` and `herdr-app check herdr/git-diff` if `herdr/`, `src/lib` or `src/shared` changed. Don't commit on failures.
2. Update `README.md` (usage, Layout section) and this file when behavior, flags or files change.
3. Stage files by name (no `git add -A`); leave `dist/` and stray files out.
4. Message: imperative subject that says what the user gets (e.g. "Allow opening the viewer from other machines"), blank line, a body wrapped at ~72 cols explaining what changed and why, then the `Co-Authored-By:` trailer.
5. Commit straight to `main`, then `git push origin main` (Gitea) and `git push github main` (GitHub, `IEP/git-diff-view`). No branches or PRs for this repo unless asked.
