
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

## Terminal viewer (`src/tui/`)

- `git-diff-view --tui` (flags in `src/index.ts`) runs the viewer in the terminal instead of starting the server. It calls the server's `Git`, `GitHub` and `DiffSearch` services in-process through `src/tui/git.ts` (an Effect `ManagedRuntime`), so the read-only allow-list, the working-tree gating and the SQLite search index are the server's. Fix git behaviour in `src/server/`, never in a TUI copy.
- Syntax colours (`src/tui/syntax.ts`) highlight a whole file in one lowlight call (~1 ms/KB in Bun), after the file first draws plain; files over `MAX_SYNTAX_CHARS` stay plain.
- `view.ts` and `state.ts` stay pure (no TTY, no git) so `src/tui/tui.test.ts` can check whole frames. Every string reaches the screen through `fit()` in `ansi.ts`, which turns control characters into visible symbols. Never write repository text to stdout any other way.
- Test it in a real terminal with an unused Rex tab: `rex window new tui --focus=false --keep-open -c <repo> -- bun <this repo>/src/index.ts --tui`, then `rex send` / `rex send-key` and `rex capture`.

## Commit flow

When asked to commit / push:

1. Verify first: `bunx tsc --noEmit -p .`, `bun test`, and `bun run build` if `src/` or `build.ts` changed. Don't commit on failures.
2. Update `README.md` (usage, Layout section) and this file when behavior, flags or files change.
3. Stage files by name (no `git add -A`); leave `dist/` and stray files out.
4. Message: imperative subject that says what the user gets (e.g. "Allow opening the viewer from other machines"), blank line, a body wrapped at ~72 cols explaining what changed and why, then the `Co-Authored-By:` trailer.
5. Commit straight to `main`, then `git push origin main` (Gitea) and `git push github main` (GitHub, `IEP/git-diff-view`). No branches or PRs for this repo unless asked.
