/**
 * The Herdr mod's repository layer (`herdr/src/repo.ts`) runs on any `Host`: here it is
 * a local process runner and the server's own guarded disk reader, so the terminal UI
 * gets the same read-only git calls, allow-list and working-tree checks as the mod.
 */
import { realpath } from "node:fs/promises";
import { relative } from "node:path";
import type { Host } from "../../herdr/src/repo";
import { readDisk } from "@/server/Git";

export function bunHost(root: string): Host {
  // Paths reach readDisk relative to the real root, so its symlinked-directory check holds.
  const rootReal = realpath(root);
  return {
    async run(command, args, options) {
      const proc = Bun.spawn([command, ...args], {
        cwd: root,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: options?.timeout ?? 60_000,
      });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { code, stdout, stderr };
    },
    async readFile(path) {
      // The repo layer joins git's toplevel, which may be the real path of `root` or not.
      const real = await rootReal;
      const under = [root, real].find((r) => path.startsWith(`${r}/`));
      if (!under) return null;
      const file = await readDisk(real, relative(under, path));
      // The Host contract: null when missing, throw when too large to read.
      if (file.tooLarge) throw new Error("File too large");
      return file.content;
    },
  };
}
