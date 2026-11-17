import { serve } from "bun";
import { resolve } from "node:path";
import index from "./index.html";
import { makeApiHandler } from "./server/Api";

// Repository to inspect: first CLI arg, then $REPO, then the current directory.
//   bun dev -- ~/code/my-repo
const repoPath = resolve(process.argv[2] ?? process.env.REPO ?? process.cwd());

// Fail fast with a clear message instead of on the first request.
const probe = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: repoPath, stderr: "pipe" });
if (probe.exitCode !== 0) {
  console.error(`✖ Not a git repository: ${repoPath}`);
  console.error(`  Usage: git-diff-view <path-to-repo>   (or: bun dev -- <path-to-repo>)`);
  process.exit(1);
}

const api = makeApiHandler(repoPath);

const hostname = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);

// DNS-rebinding guard: a hostile page can point its own domain at 127.0.0.1,
// making its requests same-origin in the browser. The Host header still names
// that domain, so only accept the names we actually serve under.
const allowedHosts = new Set(
  ["127.0.0.1", "localhost", "[::1]", hostname].map((h) => `${h}:${port}`),
);

const isTrustedRequest = (req: Request) =>
  allowedHosts.has(req.headers.get("host") ?? "") &&
  req.headers.get("sec-fetch-site") !== "cross-site";

const server = serve({
  // Loopback only: the API serves full file contents from the repository.
  hostname,
  port,
  routes: {
    "/api/*": (req) =>
      isTrustedRequest(req)
        ? api.handler(req)
        : Response.json({ error: "Forbidden", message: "Untrusted Host or cross-site request" }, { status: 403 }),
    "/*": index,
  },
  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});

console.log(`🔍 Diffing ${probe.stdout.toString().trim()}`);
console.log(`🚀 Open ${server.url}`);
