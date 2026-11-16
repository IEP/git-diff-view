import { useEffect, useMemo, useRef, useState } from "react";
import { CloudIcon, CopyIcon, GitBranchIcon, GitCompareArrowsIcon, Loader2Icon, TagIcon, XIcon } from "lucide-react";
import { relativeDate } from "@/components/RefPicker";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { AsyncState } from "@/lib/api";
import { layoutGraph, type GraphRow, type GraphSegment } from "@/lib/graph";
import { cn } from "@/lib/utils";
import type { GraphCommit, GraphRef, GraphResponse } from "@/shared/api";

const ROW_H = 26;
const LANE_W = 14;
const MAX_LANES_SHOWN = 24;
const DOT_R = 4;

// Mid-tone hues that read on both light and dark backgrounds.
const LANE_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16"];
const laneColor = (i: number) => LANE_COLORS[i % LANE_COLORS.length]!;

interface CommitGraphProps {
  readonly graph: AsyncState<GraphResponse>;
  /** Commits the current comparison resolved to, badged A and B. */
  readonly baseSha: string | null;
  readonly headSha: string | null;
  /** Compare `a` (base) with `b` (head). */
  readonly onCompare: (a: GraphCommit, b: GraphCommit) => void;
  readonly onLoadMore: () => void;
}

export function CommitGraph({ graph, baseSha, headSha, onCompare, onLoadMore }: CommitGraphProps) {
  const data = graph.status === "success" ? graph.data : null;
  // Keep showing the previous page while "load more" fetches the next one.
  const [shown, setShown] = useState<GraphResponse | null>(null);
  useEffect(() => {
    if (data) setShown(data);
  }, [data]);

  const rows = useMemo(() => (shown ? layoutGraph(shown.commits) : []), [shown]);
  const lanes = Math.min(Math.max(1, ...rows.map((r) => r.width)), MAX_LANES_SHOWN);

  // Step 1 of the two-step pick: A is held here until B is chosen.
  const [pendingA, setPendingA] = useState<GraphCommit | null>(null);
  const [menuFor, setMenuFor] = useState<GraphCommit | null>(null);
  const [focused, setFocused] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const bySha = useMemo(() => new Map(rows.map((r) => [r.commit.sha, r.commit])), [rows]);
  const currentA = pendingA ?? (baseSha ? (bySha.get(baseSha) ?? null) : null);
  // While picking, only the pending A is badged; otherwise the live comparison.
  const aSha = pendingA?.sha ?? baseSha;
  const bSha = pendingA ? null : headSha;

  const setA = (c: GraphCommit) => setPendingA(c);
  const setB = (c: GraphCommit) => {
    if (!currentA || currentA.sha === c.sha) return;
    setPendingA(null);
    onCompare(currentA, c);
  };

  const focusRow = (i: number) => {
    const next = Math.min(Math.max(i, 0), rows.length - 1);
    setFocused(next);
    listRef.current?.querySelector<HTMLElement>(`[data-index="${next}"]`)?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const row = rows[focused];
    switch (e.key) {
      case "ArrowDown":
        focusRow(focused + 1);
        break;
      case "ArrowUp":
        focusRow(focused - 1);
        break;
      case "PageDown":
        focusRow(focused + 20);
        break;
      case "PageUp":
        focusRow(focused - 20);
        break;
      case "Home":
        focusRow(0);
        break;
      case "End":
        focusRow(rows.length - 1);
        break;
      case "a":
      case "A":
        if (row) setA(row.commit);
        break;
      case "b":
      case "B":
        if (row) setB(row.commit);
        break;
      case "Escape":
        if (!pendingA) return;
        setPendingA(null);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  if (!shown) {
    return graph.status === "error" ? (
      <div className="text-destructive flex flex-1 items-center justify-center p-6 text-sm">{graph.error.message}</div>
    ) : (
      <div className="text-muted-foreground flex flex-1 items-center justify-center gap-2 p-6 text-sm">
        <Loader2Icon className="size-4 animate-spin" /> Loading history…
      </div>
    );
  }

  const target = menuFor;
  const canB = !!target && !!currentA && currentA.sha !== target.sha;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ------------------------------------------------------------ hint bar */}
      <div className="bg-muted/40 flex min-h-9 items-center gap-2 border-b px-3 text-xs">
        <GitCompareArrowsIcon className="text-muted-foreground size-3.5 shrink-0" />
        {pendingA ? (
          <>
            <Badge kind="A" />
            <code>{pendingA.shortSha}</code>
            <span className="text-muted-foreground truncate">{pendingA.subject}</span>
            <span className="shrink-0">→ now right-click the commit to compare it with and choose Set as B.</span>
            <Button variant="ghost" size="sm" className="ml-auto h-6 px-2 text-xs" onClick={() => setPendingA(null)}>
              <XIcon className="size-3.5" /> Cancel <kbd className="text-muted-foreground ml-1">Esc</kbd>
            </Button>
          </>
        ) : (
          <span className="text-muted-foreground">
            Right-click a commit and choose <b className="text-foreground">Set as A</b> (base), then right-click
            another and choose <b className="text-foreground">Set as B</b> (head). Keyboard: focus a row, press{" "}
            <kbd>A</kbd> / <kbd>B</kbd> or the menu key.
          </span>
        )}
      </div>

      {/* ------------------------------------------------------------ rows */}
      <ContextMenu onOpenChange={(open) => !open && setMenuFor(null)}>
        <ContextMenuTrigger asChild>
          <div
            ref={listRef}
            role="listbox"
            aria-label="Commit history"
            className="min-h-0 flex-1 overflow-auto"
            onKeyDown={onKeyDown}
          >
            {rows.map((row, i) => (
              <div
                key={row.commit.sha}
                data-index={i}
                role="option"
                aria-selected={row.commit.sha === aSha || row.commit.sha === bSha}
                tabIndex={i === focused ? 0 : -1}
                onFocus={() => setFocused(i)}
                // Runs before the menu opens (it bubbles up to the trigger), so the menu knows its row.
                onContextMenu={() => {
                  setFocused(i);
                  setMenuFor(row.commit);
                }}
                className={cn(
                  "hover:bg-muted/60 flex cursor-default items-center gap-2 pr-3 text-xs outline-none select-none",
                  "focus-visible:ring-ring focus-visible:ring-1 focus-visible:ring-inset",
                  menuFor?.sha === row.commit.sha && "bg-accent",
                  pendingA?.sha === row.commit.sha && "bg-blue-500/10",
                )}
                style={{ height: ROW_H }}
              >
                <GraphCell row={row} lanes={lanes} marker={row.commit.sha === aSha ? "A" : row.commit.sha === bSha ? "B" : null} />
                {row.commit.sha === aSha && <Badge kind="A" />}
                {row.commit.sha === bSha && <Badge kind="B" />}
                {row.commit.refs.map((r) => (
                  <RefChip key={`${r.kind}:${r.name}`} r={r} />
                ))}
                <span className="min-w-0 flex-1 truncate">{row.commit.subject}</span>
                <span className="text-muted-foreground hidden w-32 shrink-0 truncate md:block">{row.commit.author}</span>
                <span className="text-muted-foreground hidden w-24 shrink-0 truncate text-right sm:block">
                  {relativeDate(row.commit.date)}
                </span>
                <code className="text-muted-foreground w-14 shrink-0 text-right">{row.commit.shortSha}</code>
              </div>
            ))}
            {shown.truncated && (
              <div className="flex justify-center p-3">
                <Button variant="outline" size="sm" onClick={onLoadMore} disabled={graph.status === "loading"}>
                  {graph.status === "loading" && <Loader2Icon className="size-4 animate-spin" />}
                  Load more history
                </Button>
              </div>
            )}
          </div>
        </ContextMenuTrigger>

        <ContextMenuContent className="w-72" onCloseAutoFocus={(e) => e.preventDefault()}>
          {target && (
            <>
              <ContextMenuLabel className="truncate">
                <code>{target.shortSha}</code> · {target.subject}
              </ContextMenuLabel>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => setA(target)} disabled={pendingA?.sha === target.sha}>
                <Badge kind="A" />
                Set as A (base)
                <ContextMenuShortcut>A</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => setB(target)} disabled={!canB}>
                <Badge kind="B" />
                <span className="truncate">
                  Set as B (head)
                  {currentA && currentA.sha !== target.sha && (
                    <span className="text-muted-foreground"> · compare with {currentA.shortSha}</span>
                  )}
                </span>
                <ContextMenuShortcut>B</ContextMenuShortcut>
              </ContextMenuItem>
              {pendingA && (
                <ContextMenuItem onSelect={() => setPendingA(null)}>
                  <XIcon />
                  Clear A
                  <ContextMenuShortcut>Esc</ContextMenuShortcut>
                </ContextMenuItem>
              )}
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => void navigator.clipboard?.writeText(target.sha)}>
                <CopyIcon />
                Copy commit ID
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function Badge({ kind }: { kind: "A" | "B" }) {
  return (
    <span
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-[10px] font-bold text-white",
        kind === "A" ? "bg-blue-600" : "bg-orange-600",
      )}
      aria-label={kind === "A" ? "A (base)" : "B (head)"}
    >
      {kind}
    </span>
  );
}

const REF_STYLE: Record<GraphRef["kind"], { icon: typeof GitBranchIcon | null; className: string }> = {
  head: { icon: null, className: "border-foreground/30 font-semibold" },
  branch: { icon: GitBranchIcon, className: "border-green-600/40 text-green-700 dark:text-green-400" },
  remote: { icon: CloudIcon, className: "border-violet-600/40 text-violet-700 dark:text-violet-400" },
  tag: { icon: TagIcon, className: "border-amber-600/40 text-amber-700 dark:text-amber-400" },
};

function RefChip({ r }: { r: GraphRef }) {
  const { icon: Icon, className } = REF_STYLE[r.kind];
  return (
    <span
      className={cn("inline-flex max-w-48 shrink-0 items-center gap-1 rounded border px-1 text-[10px] leading-4", className)}
      title={r.name}
    >
      {Icon && <Icon className="size-3 shrink-0" />}
      <span className="truncate">{r.name}</span>
    </span>
  );
}

const x = (col: number) => col * LANE_W + LANE_W / 2;
const MID = ROW_H / 2;

function segmentPath(s: GraphSegment): string {
  const [x1, x2] = [x(s.from), x(s.to)];
  switch (s.kind) {
    case "through":
      return `M${x1} 0V${ROW_H}`;
    case "in":
      return x1 === x2 ? `M${x1} 0V${MID}` : `M${x1} 0C${x1} ${MID * 0.6} ${x2} ${MID * 0.4} ${x2} ${MID}`;
    case "out":
      return x1 === x2
        ? `M${x1} ${MID}V${ROW_H}`
        : `M${x1} ${MID}C${x1} ${MID * 1.6} ${x2} ${MID * 1.4} ${x2} ${ROW_H}`;
  }
}

function GraphCell({ row, lanes, marker }: { row: GraphRow; lanes: number; marker: "A" | "B" | null }) {
  const width = lanes * LANE_W;
  const cx = x(row.column);
  const isMerge = row.commit.parents.length > 1;
  const color = laneColor(row.color);
  return (
    <svg width={width} height={ROW_H} className="shrink-0 overflow-hidden" aria-hidden>
      {row.segments.map((s, i) => (
        <path key={i} d={segmentPath(s)} stroke={laneColor(s.color)} strokeWidth={2} fill="none" />
      ))}
      {marker && (
        <circle cx={cx} cy={MID} r={DOT_R + 3} fill="none" stroke={marker === "A" ? "#2563eb" : "#ea580c"} strokeWidth={2} />
      )}
      <circle
        cx={cx}
        cy={MID}
        r={DOT_R}
        fill={isMerge ? "var(--background)" : color}
        stroke={color}
        strokeWidth={2}
      />
    </svg>
  );
}
