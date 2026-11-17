// Bundle the mod's TypeScript core (git, diff model, search, tree, graph) next to its UI.
//   bun run build:herdr            → herdr/git-diff/core.js
//   bun run build:herdr --watch    → rebuild on change (Herdr hot-reloads the mod)
//   bun run install:herdr          → build, then link ~/.config/herdr-app/mods/git-diff here
//
// Herdr's watcher sees the link in its mods folder, not the files behind it, so every
// build touches the link: that is what makes the running window reload the mod.
import { lstat, lutimes, readlink, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { watch } from "node:fs";

const here = import.meta.dir;
const modDir = join(here, "git-diff");
const home = process.env.HERDR_APP_HOME ?? join(homedir(), ".config", "herdr-app");
const link = join(home, "mods", "git-diff");

/** Reload the mod in a running Herdr (when it's installed as a link here). */
async function touchLink() {
  const st = await lstat(link).catch(() => null);
  if (!st?.isSymbolicLink() || resolve(join(home, "mods"), await readlink(link)) !== modDir) return;
  const now = new Date();
  await lutimes(link, now, now);
}

async function build() {
  const result = await Bun.build({
    entrypoints: [join(here, "src/core.ts")],
    outdir: modDir,
    naming: "core.js",
    format: "esm",
    target: "browser",
    // Herdr's runtime has none of these; fail the build rather than the mod.
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    return false;
  }
  console.log(`✔ Built ${join(modDir, "core.js")}`);
  await touchLink();
  return true;
}

if (!(await build())) process.exit(1);

if (process.argv.includes("--install")) {
  const existing = await lstat(link).catch(() => null);
  if (!existing) {
    await symlink(modDir, link);
    console.log(`✔ Linked ${link} → ${modDir}`);
  } else if (existing.isSymbolicLink() && resolve(join(home, "mods"), await readlink(link)) === modDir) {
    console.log(`✔ ${link} already links here`);
  } else {
    console.error(`✖ ${link} exists and isn't a link to ${modDir}; move it away first.`);
    process.exit(1);
  }
}

if (process.argv.includes("--watch")) {
  console.log("Watching herdr/src, src/lib, src/shared (rebuild) and herdr/git-diff (reload)…");
  let timer: ReturnType<typeof setTimeout> | undefined;
  for (const dir of ["herdr/src", "src/lib", "src/shared"]) {
    watch(join(here, "..", dir), { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(build, 100);
    });
  }
  // The UI is plain JS in the mod folder: no build, just tell Herdr. Skip what we or Herdr write.
  watch(modDir, { recursive: true }, (_event, file) => {
    if (!file || /^(core\.js|gpui-kit\.d\.ts|jsconfig\.json)$/.test(String(file))) return;
    clearTimeout(timer);
    timer = setTimeout(touchLink, 100);
  });
}
