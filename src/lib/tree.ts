import type { FileChange } from "@/shared/api";

export interface DirNode {
  readonly kind: "dir";
  /** Display name. May be a compacted chain like `src/main/java`. */
  readonly name: string;
  /** Full path from the repo root; also the stable key for expand/collapse. */
  readonly path: string;
  readonly children: ReadonlyArray<TreeNode>;
  readonly fileCount: number;
  readonly additions: number;
  readonly deletions: number;
}

export interface FileNode {
  readonly kind: "file";
  readonly name: string;
  readonly path: string;
  readonly change: FileChange;
}

export type TreeNode = DirNode | FileNode;

export interface VisibleRow {
  readonly key: string;
  readonly node: TreeNode;
  readonly depth: number;
  readonly parentKey: string | null;
}

export const rowKey = (node: TreeNode) => `${node.kind === "dir" ? "d" : "f"}:${node.path}`;

interface MutableDir {
  name: string;
  path: string;
  dirs: Map<string, MutableDir>;
  files: Array<FileNode>;
}

/** Natural, case-insensitive order ("file2" before "file10"). */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Build a directory tree from a flat list of changed files.
 *
 * Like IntelliJ's "Changes" view: directories come before files, both sorted
 * naturally, and chains of single-child directories are collapsed into one
 * row (`src/main/java/com/acme`) so deep package paths don't waste space.
 */
export function buildTree(files: ReadonlyArray<FileChange>): DirNode {
  const root: MutableDir = { name: "", path: "", dirs: new Map(), files: [] };

  for (const change of files) {
    const parts = change.path.split("/");
    const fileName = parts.pop()!;
    let dir = root;
    for (const part of parts) {
      let next = dir.dirs.get(part);
      if (!next) {
        next = { name: part, path: dir.path ? `${dir.path}/${part}` : part, dirs: new Map(), files: [] };
        dir.dirs.set(part, next);
      }
      dir = next;
    }
    dir.files.push({ kind: "file", name: fileName, path: change.path, change });
  }

  return freeze(root, true);
}

function freeze(dir: MutableDir, isRoot: boolean): DirNode {
  let current = dir;
  let name = dir.name;

  // Compact: a directory whose only child is another directory merges into it.
  if (!isRoot) {
    while (current.files.length === 0 && current.dirs.size === 1) {
      const only = current.dirs.values().next().value!;
      name = `${name}/${only.name}`;
      current = only;
    }
  }

  const dirs = [...current.dirs.values()]
    .map((d) => freeze(d, false))
    .sort((a, b) => collator.compare(a.name, b.name));
  const files = [...current.files].sort((a, b) => collator.compare(a.name, b.name));

  let fileCount = files.length;
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    additions += f.change.additions;
    deletions += f.change.deletions;
  }
  for (const d of dirs) {
    fileCount += d.fileCount;
    additions += d.additions;
    deletions += d.deletions;
  }

  return { kind: "dir", name, path: current.path, children: [...dirs, ...files], fileCount, additions, deletions };
}

/** Flatten the tree into the rows currently on screen, honouring collapsed directories. */
export function visibleRows(root: DirNode, collapsed: ReadonlySet<string>): Array<VisibleRow> {
  const rows: Array<VisibleRow> = [];
  const walk = (nodes: ReadonlyArray<TreeNode>, depth: number, parentKey: string | null) => {
    for (const node of nodes) {
      const key = rowKey(node);
      rows.push({ key, node, depth, parentKey });
      if (node.kind === "dir" && !collapsed.has(node.path)) walk(node.children, depth + 1, key);
    }
  };
  walk(root.children, 0, null);
  return rows;
}

/** Every directory path in the tree, used for "collapse all". */
export function allDirPaths(root: DirNode): Array<string> {
  const out: Array<string> = [];
  const walk = (node: DirNode) => {
    for (const child of node.children) {
      if (child.kind === "dir") {
        out.push(child.path);
        walk(child);
      }
    }
  };
  walk(root);
  return out;
}

/** Files in on-screen (tree) order, used for next/previous file navigation. */
export function filesInTreeOrder(root: DirNode): Array<FileChange> {
  const out: Array<FileChange> = [];
  const walk = (node: DirNode) => {
    for (const child of node.children) {
      if (child.kind === "dir") walk(child);
      else out.push(child.change);
    }
  };
  walk(root);
  return out;
}
