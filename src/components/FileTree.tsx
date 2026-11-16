import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRightIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileJsonIcon,
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { allDirPaths, buildTree, rowKey, visibleRows, type TreeNode } from "@/lib/tree";
import { cn } from "@/lib/utils";
import type { ChangeStatus, FileChange } from "@/shared/api";

// IntelliJ-style status colours: green = added, blue = modified, etc.
export const STATUS_STYLE: Record<ChangeStatus, { letter: string; label: string; text: string }> = {
  added: { letter: "A", label: "Added", text: "text-green-700 dark:text-green-400" },
  modified: { letter: "M", label: "Modified", text: "text-blue-700 dark:text-blue-400" },
  deleted: { letter: "D", label: "Deleted", text: "text-red-700 dark:text-red-400" },
  renamed: { letter: "R", label: "Renamed", text: "text-violet-700 dark:text-violet-400" },
  copied: { letter: "C", label: "Copied", text: "text-teal-700 dark:text-teal-400" },
  typechange: { letter: "T", label: "Type changed", text: "text-amber-700 dark:text-amber-400" },
  unknown: { letter: "?", label: "Changed", text: "text-muted-foreground" },
};

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|java|kt|kts|scala|go|rs|py|rb|php|c|h|cc|cpp|hpp|cs|swift|m|sh|bash|zsh|css|scss|less|html|vue|svelte|sql|xml|gradle)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|ico|bmp|avif)$/i;
const JSON_EXT = /\.(json|jsonc|ya?ml|toml)$/i;
const TEXT_EXT = /\.(md|mdx|txt|rst|adoc)$/i;

function FileTypeIcon({ name, className }: { name: string; className?: string }) {
  const Icon = CODE_EXT.test(name)
    ? FileCodeIcon
    : IMAGE_EXT.test(name)
      ? FileImageIcon
      : JSON_EXT.test(name)
        ? FileJsonIcon
        : TEXT_EXT.test(name)
          ? FileTextIcon
          : FileIcon;
  return <Icon className={className} />;
}

interface FileTreeProps {
  readonly files: ReadonlyArray<FileChange>;
  readonly selectedPath: string | null;
  readonly onSelect: (file: FileChange) => void;
}

export function FileTree({ files, selectedPath, onSelect }: FileTreeProps) {
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return files;
    return files.filter((f) => f.path.toLowerCase().includes(q) || f.oldPath?.toLowerCase().includes(q));
  }, [files, filter]);

  const tree = useMemo(() => buildTree(filtered), [filtered]);
  // While filtering, show every match regardless of what was collapsed.
  const rows = useMemo(() => visibleRows(tree, filter ? new Set() : collapsed), [tree, collapsed, filter]);

  const selectedKey = selectedPath ? `f:${selectedPath}` : null;
  const activeKey = focusedKey ?? selectedKey ?? rows[0]?.key ?? null;
  const activeIndex = rows.findIndex((r) => r.key === activeKey);

  // Keep the active row visible when it changes (keyboard nav, next/prev file).
  useEffect(() => {
    if (!activeKey) return;
    treeRef.current?.querySelector(`[data-key="${CSS.escape(activeKey)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeKey]);

  // When the selection changes from outside (next/prev buttons), follow it.
  useEffect(() => {
    if (selectedKey) setFocusedKey(selectedKey);
  }, [selectedKey]);

  const toggle = (path: string, open?: boolean) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      const isOpen = !next.has(path);
      if (open ?? !isOpen) next.delete(path);
      else next.add(path);
      return next;
    });

  const activate = (node: TreeNode) => {
    setFocusedKey(rowKey(node));
    if (node.kind === "file") onSelect(node.change);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const row = rows[activeIndex];
    if (!row) return;
    const node = row.node;
    const isOpenDir = node.kind === "dir" && (filter !== "" || !collapsed.has(node.path));
    switch (e.key) {
      case "ArrowDown": {
        const next = rows[Math.min(activeIndex + 1, rows.length - 1)];
        if (next) activate(next.node);
        break;
      }
      case "ArrowUp": {
        const prev = rows[Math.max(activeIndex - 1, 0)];
        if (prev) activate(prev.node);
        break;
      }
      case "Home":
        if (rows[0]) activate(rows[0].node);
        break;
      case "End":
        if (rows.at(-1)) activate(rows.at(-1)!.node);
        break;
      case "ArrowRight":
        if (node.kind === "dir") {
          if (!isOpenDir) toggle(node.path, true);
          else if (rows[activeIndex + 1]) activate(rows[activeIndex + 1]!.node);
        }
        break;
      case "ArrowLeft":
        if (isOpenDir && node.kind === "dir") toggle(node.path, false);
        else if (row.parentKey) {
          const parent = rows.find((r) => r.key === row.parentKey);
          if (parent) activate(parent.node);
        }
        break;
      case "Enter":
      case " ":
        if (node.kind === "dir") toggle(node.path);
        else onSelect(node.change);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const totals = useMemo(
    () => filtered.reduce((acc, f) => ({ add: acc.add + f.additions, del: acc.del + f.deletions }), { add: 0, del: 0 }),
    [filtered],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b px-2 py-1.5">
        <div className="relative flex-1">
          <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setFilter("");
              if (e.key === "ArrowDown") {
                e.preventDefault();
                treeRef.current?.focus();
              }
            }}
            placeholder="Filter files"
            aria-label="Filter changed files"
            className="h-7 pr-7 pl-7 text-xs"
          />
          {filter && (
            <button
              type="button"
              onClick={() => setFilter("")}
              aria-label="Clear filter"
              className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
            >
              <XIcon className="size-3.5" />
            </button>
          )}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="size-7" aria-label="Expand all" onClick={() => setCollapsed(new Set())}>
              <ChevronsUpDownIcon className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Expand all</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="Collapse all"
              onClick={() => setCollapsed(new Set(allDirPaths(tree)))}
            >
              <ChevronsDownUpIcon className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Collapse all</TooltipContent>
        </Tooltip>
      </div>

      <div className="text-muted-foreground flex items-center justify-between border-b px-3 py-1 text-xs">
        <span>
          {filtered.length === files.length ? `${files.length} changed files` : `${filtered.length} of ${files.length} files`}
        </span>
        <span className="font-mono tabular-nums">
          <span className="text-green-700 dark:text-green-400">+{totals.add}</span>{" "}
          <span className="text-red-700 dark:text-red-400">−{totals.del}</span>
        </span>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div
          ref={treeRef}
          role="tree"
          aria-label="Changed files"
          tabIndex={0}
          onKeyDown={onKeyDown}
          aria-activedescendant={activeKey ? `row-${activeKey}` : undefined}
          className="py-1 text-xs outline-none select-none"
        >
          {rows.length === 0 && (
            <p className="text-muted-foreground px-3 py-6 text-center text-xs">
              {files.length === 0 ? "No differences between these revisions." : "No files match the filter."}
            </p>
          )}
          {rows.map(({ key, node, depth }) => {
            const isActive = key === activeKey;
            const isSelected = key === selectedKey;
            const indent = { paddingLeft: `${depth * 14 + 6}px` };

            if (node.kind === "dir") {
              const open = filter !== "" || !collapsed.has(node.path);
              return (
                <div
                  key={key}
                  id={`row-${key}`}
                  data-key={key}
                  role="treeitem"
                  aria-expanded={open}
                  aria-level={depth + 1}
                  onClick={() => {
                    setFocusedKey(key);
                    toggle(node.path);
                  }}
                  style={indent}
                  className={cn(
                    "flex h-[22px] cursor-default items-center gap-1 pr-2",
                    "hover:bg-accent/60",
                    isActive && "bg-accent",
                  )}
                >
                  <ChevronRightIcon
                    className={cn("text-muted-foreground size-3.5 shrink-0 transition-transform", open && "rotate-90")}
                  />
                  {open ? (
                    <FolderOpenIcon className="size-4 shrink-0 text-amber-600/80 dark:text-amber-400/80" />
                  ) : (
                    <FolderIcon className="size-4 shrink-0 text-amber-600/80 dark:text-amber-400/80" />
                  )}
                  <span className="truncate">{node.name}</span>
                  <span className="text-muted-foreground ml-1 shrink-0 text-[11px]">
                    {node.fileCount} {node.fileCount === 1 ? "file" : "files"}
                  </span>
                </div>
              );
            }

            const { change } = node;
            const style = STATUS_STYLE[change.status];
            return (
              <div
                key={key}
                id={`row-${key}`}
                data-key={key}
                role="treeitem"
                aria-selected={isSelected}
                aria-level={depth + 1}
                onClick={() => activate(node)}
                title={change.oldPath ? `${change.oldPath} → ${change.path}` : change.path}
                style={indent}
                className={cn(
                  "group flex h-[22px] cursor-default items-center gap-1 pr-2",
                  "hover:bg-accent/60",
                  isActive && "bg-accent",
                  isSelected && "bg-primary/10 dark:bg-primary/15",
                )}
              >
                <span className="size-3.5 shrink-0" />
                <FileTypeIcon name={node.name} className={cn("size-4 shrink-0", style.text)} />
                <span className={cn("truncate", style.text, change.status === "deleted" && "line-through decoration-1")}>
                  {node.name}
                </span>
                {change.oldPath && (
                  <span className="text-muted-foreground min-w-0 truncate text-[11px]">
                    ← {change.oldPath.split("/").at(-1) === node.name ? change.oldPath : change.oldPath.split("/").at(-1)}
                  </span>
                )}
                <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 font-mono text-[10px] tabular-nums">
                  {change.binary ? (
                    <span className="text-muted-foreground">bin</span>
                  ) : (
                    <>
                      {change.additions > 0 && <span className="text-green-700 dark:text-green-400">+{change.additions}</span>}
                      {change.deletions > 0 && <span className="text-red-700 dark:text-red-400">−{change.deletions}</span>}
                    </>
                  )}
                  <span className={cn("w-3 text-center font-semibold", style.text)} title={style.label}>
                    {style.letter}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
