import { serve } from "bun";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import index from "./index.html";
import { makeApiHandler } from "./server/Api";
import { interfaceAddresses, isShareableAddress, isWildcard, machineNames, makeHostGuard, normalizeHost } from "./server/HostGuard";

const USAGE = `Usage: git-diff-view [repo] [--lan | --host <addr>] [--port <n>] [--allow-host <name>]...

  repo                 Repository to inspect (default: $REPO, then the current directory)
  --lan                Listen on every interface (LAN, Tailscale, ...). Same as --host 0.0.0.0
  --host <addr>        Address to listen on (default: $HOST, then 127.0.0.1)
                       e.g. your Tailscale IP, to be reachable from the tailnet only
  --port <n>           Port (default: $PORT, then 3000)
  --allow-host <name>  Extra Host name to accept, e.g. a custom DNS name (repeatable;
                       also $ALLOWED_HOSTS, comma-separated)`;

const { values: opts, positionals } = (() => {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        lan: { type: "boolean" },
        host: { type: "string" },
        port: { type: "string" },
        "allow-host": { type: "string", multiple: true },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    console.error(`✖ ${(e as Error).message}\n\n${USAGE}`);
    process.exit(1);
  }
})();
if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}

const repoPath = resolve(positionals[0] ?? process.env.REPO ?? process.cwd());

// Fail fast with a clear message instead of on the first request.
const probe = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: repoPath, stderr: "pipe" });
if (probe.exitCode !== 0) {
  console.error(`✖ Not a git repository: ${repoPath}\n\n${USAGE}`);
  process.exit(1);
}

const api = makeApiHandler(repoPath);

// Loopback by default: the API serves full file contents from the repository.
const hostname = opts.lan ? "0.0.0.0" : (opts.host ?? process.env.HOST ?? "127.0.0.1");
const port = Number(opts.port ?? process.env.PORT ?? 3000);
const extraHosts = [...(process.env.ALLOWED_HOSTS?.split(",") ?? []), ...(opts["allow-host"] ?? [])]
  .map((h) => h.trim())
  .filter(Boolean);
const exposed = hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1";

const names = exposed ? machineNames() : [];
const guard = makeHostGuard({ bindHost: hostname, port, extraHosts, names });

const server = serve({
  hostname,
  port,
  routes: {
    "/api/*": (req) =>
      guard.isTrustedRequest(req)
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
if (!exposed) {
  console.log(`🚀 Open ${server.url}   (add --lan to reach it from other machines)`);
} else {
  // Only list URLs that actually reach this socket.
  const bound = normalizeHost(hostname);
  // 0.0.0.0 is IPv4-only; "::" also takes IPv6.
  const reachable = (addr: string) =>
    isWildcard(hostname) ? hostname === "::" || !addr.includes(":") : normalizeHost(addr) === bound;
  const urls = [
    ...interfaceAddresses().filter((a) => isShareableAddress(a) && reachable(a)).map(normalizeHost),
    ...(isWildcard(hostname) ? [...names, ...extraHosts].map(normalizeHost) : []),
  ];
  console.log(`🚀 Listening on ${hostname}:${port}. Open one of:`);
  for (const h of new Set(urls)) if (h) console.log(`   http://${h}:${port}/`);
  console.log(`⚠  Anyone who can reach these addresses can read this repository's files. There is no login.`);
}
