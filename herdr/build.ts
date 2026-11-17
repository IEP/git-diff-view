// Bundle the mod's TypeScript core (git, diff model, search, tree, graph) next to its UI.
//   bun run build:herdr            → herdr/git-diff/core.js
//   bun run build:herdr --watch    → rebuild on change (Herdr hot-reloads the mod)
//   bun run install:herdr          → build, link ~/.config/herdr-app/mods/git-diff here, and add
//                                    the Diff button beside the tab bar (in a personal layout copy)
//   bun run uninstall:herdr        → back to the original layout; remove the copy and the link
//
// Herdr's watcher sees the link in its mods folder, not the files behind it, so every
// build touches the link: that is what makes the running window reload the mod.
import { createHash } from "node:crypto";
import { lstat, lutimes, mkdir, readlink, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { watch } from "node:fs";
import { withDiffButton } from "./layout";

const here = import.meta.dir;
const modDir = join(here, "git-diff");
const home = process.env.HERDR_APP_HOME ?? join(homedir(), ".config", "herdr-app");
const link = join(home, "mods", "git-diff");
/** What install made, so uninstall removes exactly that and nothing someone edited since. */
const recordFile = join(home, "data", "git-diff-toolbar.json");
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

interface ToolbarRecord {
  readonly source: string;
  readonly layout: string;
  readonly hash: string;
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const layoutPath = (name: string) => {
  if (!NAME.test(name)) throw new Error(`Unsupported layout name: ${JSON.stringify(name)}`);
  return join(home, "layouts", `${name}.json`);
};
const readText = async (path: string) => {
  const f = Bun.file(path);
  return (await f.exists()) ? f.text() : null;
};

/** `herdr-app <args>` against this home; throws with its message on failure. */
function herdr(...args: Array<string>): string {
  const r = Bun.spawnSync(["herdr-app", ...args], { env: { ...process.env, HERDR_APP_HOME: home } });
  if (r.exitCode !== 0) throw new Error(`herdr-app ${args.slice(0, 2).join(" ")}: ${(r.stderr.toString() || r.stdout.toString()).trim()}`);
  return r.stdout.toString();
}
const shownLayout = () => (JSON.parse(herdr("status")) as { layout: string }).layout;

async function readRecord(): Promise<ToolbarRecord | null> {
  const text = await readText(recordFile);
  if (text === null) return null;
  const r = JSON.parse(text) as ToolbarRecord;
  if (!NAME.test(r.source) || !NAME.test(r.layout) || !/^[0-9a-f]{64}$/.test(r.hash)) throw new Error(`Invalid ${recordFile}`);
  return r;
}

async function writeAtomic(path: string, text: string) {
  await writeFile(`${path}.tmp`, text);
  await rename(`${path}.tmp`, path);
}

/**
 * Copy the shown layout with Herdr's own layout.clone (which switches to the copy), then
 * wrap its tab bar with the Diff button. Reinstalling leaves an existing copy alone.
 */
async function installToolbar() {
  const record = await readRecord();
  if (record && (await readText(layoutPath(record.layout))) !== null) {
    console.log(`✔ Diff button already in layout "${record.layout}"`);
    return;
  }
  const source = shownLayout();
  const original = await readText(layoutPath(source));
  if (original === null) throw new Error(`Layout file not found: ${layoutPath(source)}`);
  withDiffButton(JSON.parse(original)); // refuse before cloning anything
  let target = "";
  for (let n = 1; n <= 100 && !target; n++) {
    const name = `${source}-diff${n === 1 ? "" : `-${n}`}`;
    const taken = (await readText(layoutPath(name))) !== null || (await readText(join(home, "layouts", ".state", `${name}.json`))) !== null;
    if (!taken) target = name;
  }
  if (!target) throw new Error("No free layout name for the copy");
  herdr("do", "layout.clone", JSON.stringify({ name: source, as: target }));
  try {
    const cloned = await readText(layoutPath(target));
    if (cloned === null) throw new Error(`Herdr did not create ${layoutPath(target)}`);
    const text = `${JSON.stringify(withDiffButton(JSON.parse(cloned)), null, 2)}\n`;
    await writeAtomic(layoutPath(target), text);
    await mkdir(join(home, "data"), { recursive: true });
    await writeAtomic(recordFile, `${JSON.stringify({ source, layout: target, hash: sha(text) }, null, 2)}\n`);
  } catch (e) {
    // Don't leave a half-made layout on screen; keep the copy to look at.
    try { herdr("do", "layout.switch", JSON.stringify({ name: source })); } catch { /* keep the first error */ }
    throw e;
  }
  console.log(`✔ Added the Diff button beside the tab bar in layout "${target}" (a copy of "${source}"; Herdr's mods are unchanged)`);
}

async function uninstall() {
  const record = await readRecord();
  if (record) {
    const file = layoutPath(record.layout);
    const text = await readText(file);
    if (text !== null && sha(text) !== record.hash) {
      throw new Error(`Layout "${record.layout}" was edited since install; nothing removed. Move ${file} and ${recordFile} aside to uninstall.`);
    }
    if (shownLayout() === record.layout) herdr("do", "layout.switch", JSON.stringify({ name: record.source }));
    if (text !== null) await unlink(file);
    // Herdr's click state (sizes, shown panels) for the copy: it goes with the copy.
    await unlink(join(home, "layouts", ".state", `${record.layout}.json`)).catch(() => {});
    await unlink(recordFile);
    console.log(`✔ Back to layout "${record.source}"; removed "${record.layout}"`);
  }
  const st = await lstat(link).catch(() => null);
  if (st?.isSymbolicLink() && resolve(join(home, "mods"), await readlink(link)) === modDir) {
    await unlink(link);
    console.log(`✔ Removed ${link}`);
  }
}

if (process.argv.includes("--uninstall")) {
  try {
    await uninstall();
  } catch (e) {
    console.error(`✖ ${(e as Error).message}`);
    process.exit(1);
  }
  process.exit(0);
}

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
  try {
    await installToolbar();
  } catch (e) {
    console.error(`✖ Diff button not added: ${(e as Error).message}`);
    console.error("  The mod is installed; open it with: herdr-app do mod.open --name git-diff");
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
