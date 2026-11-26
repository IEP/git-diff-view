// Compile the server + frontend into one standalone executable.
//   bun run build      → dist/git-diff-view
//   bun run install:bin → ~/.bun/bin/git-diff-view (already on PATH wherever Bun is installed)
import tailwind from "bun-plugin-tailwind";
import { homedir } from "node:os";
import { join } from "node:path";

const install = process.argv.includes("--install");
const outfile = install
  ? join(process.env.BUN_INSTALL ?? join(homedir(), ".bun"), "bin", "git-diff-view")
  : "./dist/git-diff-view";

const result = await Bun.build({
  // The terminal viewer highlights in a worker, which must be compiled in too.
  entrypoints: ["./src/index.ts", "./src/tui/syntaxWorker.ts"],
  compile: { outfile },
  plugins: [tailwind],
  minify: true,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`✔ Built ${outfile}`);
