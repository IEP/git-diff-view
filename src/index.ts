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
  console.error(`  Usage: bun dev -- <path-to-repo>   (or REPO=<path> bun dev)`);
  process.exit(1);
}

const api = makeApiHandler(repoPath);

const server = serve({
  // Loopback only: the API serves full file contents from the repository.
  hostname: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3000),
  routes: {
    "/api/*": (req) => api.handler(req),
    "/*": index,
  },
  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});

console.log(`🔍 Diffing ${probe.stdout.toString().trim()}`);
console.log(`🚀 Open ${server.url}`);
