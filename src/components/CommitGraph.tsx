import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  CloudIcon,
  CopyIcon,
  EyeIcon,
  GitBranchIcon,
  GitCompareArrowsIcon,
  InfoIcon,
  Loader2Icon,
  PanelTopCloseIcon,
  TagIcon,
  XIcon,
} from "lucide-react";
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
import { commitsInRange, layoutGraph, type GraphRow, type GraphSegment } from "@/lib/graph";
import { cn } from "@/lib/utils";
import { isPseudoRev, PSEUDO_LABEL, type GraphCommit, type GraphRef, type GraphResponse } from "@/shared/api";

const ROW_H = 26;
const LANE_W = 14;
const MAX_LANES_SHOWN = 24;
const DOT_R = 4;
/** Pointer this close to the list's top / bottom edge auto-scrolls while dragging. */
const EDGE = 32;
const MAX_SCROLL_STEP = 18;

// Mid-tone hues that read on both light and dark backgrounds.
const LANE_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16"];
const laneColor = (i: number) => LANE_COLORS[i % LANE_COLORS.length]!;

const EMPTY = new Set<string>();

type End = "A" | "B";
/** Gutter line in a row: passing through, or leaving a handle upwards / downwards. */
type Line = "through" | "up" | "down" | null;

interface CommitGraphProps {
  readonly graph: AsyncState<GraphResponse>;
  /** Commits the current comparison resolved to, shown as the A and B handles. */
  readonly baseSha: string | null;
  readonly headSha: string | null;
  /** Compare commit `base` (A) with commit `head` (B). */
  readonly onCompare: (base: string, head: string) => void;
  readonly onLoadMore: () => void;
  /** Hide the whole graph panel. */
  readonly onHide: () => void;
}

/**
 * Commit history with lanes. The comparison is a range with two handles in the
 * left gutter:
 *   - click a commit       view it alone (first parent → commit)
 *   - drag the A / B handle move that end of the range
 *   - shift-click          range from the last clicked commit to this one (older = A)
 * Commits whose changes are in the diff (`A..B`) are tinted, live while dragging.
 */
export function CommitGraph({ graph, baseSha, headSha, onCompare, onLoadMore, onHide }: CommitGraphProps) {
  const data = graph.status === "success" ? graph.data : null;
  // Keep showing the previous page while "load more" fetches the next one.
  const [shown, setShown] = useState<GraphResponse | null>(null);
  useEffect(() => {
    if (data) setShown(data);
  }, [data]);

  const rows = useMemo(() => (shown ? layoutGraph(shown.commits) : []), [shown]);
  const lanes = Math.min(Math.max(1, ...rows.map((r) => r.width)), MAX_LANES_SHOWN);
  const indexOf = useMemo(() => new Map(rows.map((r, i) => [r.commit.sha, i])), [rows]);

  // The last plainly clicked commit; shift-click spans from it.
  const [anchor, setAnchor] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<GraphCommit | null>(null);
  const [focused, setFocused] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // ---------------------------------------------------------------- dragging
  const [drag, setDrag] = useState<{ end: End; index: number } | null>(null);
  const dragRef = useRef<{ end: End; pointerId: number; clientY: number; raf: number } | null>(null);

  // While dragging, the moved end follows the pointer; everything previews from these.
  const aSha = drag?.end === "A" ? (rows[drag.index]?.commit.sha ?? baseSha) : baseSha;
  const bSha = drag?.end === "B" ? (rows[drag.index]?.commit.sha ?? headSha) : headSha;
  const aIndex = aSha ? indexOf.get(aSha) : undefined;
  const bIndex = bSha ? indexOf.get(bSha) : undefined;

  const range = useMemo(() => (shown ? commitsInRange(shown.commits, aSha, bSha) : EMPTY), [shown, aSha, bSha]);
  // Both ends loaded, yet nothing is in A..B: B is behind A.
  const backwards = !!aSha && !!bSha && aSha !== bSha && aIndex !== undefined && bIndex !== undefined && range.size === 0;
  // The gutter bracket joins the two handles (by position; the tint is what's actually in the diff).
  const [bracketTop, bracketBottom] =
    aIndex !== undefined && bIndex !== undefined ? [Math.min(aIndex, bIndex), Math.max(aIndex, bIndex)] : [-1, -1];

  const indexAt = (clientY: number) => {
    const el = listRef.current!;
    const i = Math.floor((clientY - el.getBoundingClientRect().top + el.scrollTop) / ROW_H);
    return Math.min(Math.max(i, 0), rows.length - 1);
  };

  const stopDrag = (commit: boolean) => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    cancelAnimationFrame(d.raf);
    if (listRef.current?.hasPointerCapture(d.pointerId)) listRef.current.releasePointerCapture(d.pointerId);
    setDrag(null);
    if (!commit) return;
    const target = rows[indexAt(d.clientY)]?.commit.sha;
    const [base, head] = d.end === "A" ? [target, headSha] : [baseSha, target];
    if (!base || !head || base === head || (base === baseSha && head === headSha)) return;
    setNotice(null);
    onCompare(base, head);
  };

  // Capture on the list, not the handle: the handle re-renders into another row as it moves.
  const startDrag = (end: End, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const list = listRef.current!;
    try {
      list.setPointerCapture(e.pointerId);
    } catch {
      // Pointer already gone (e.g. cancelled by the OS): the drag still works while it stays over the list.
    }
    const d = { end, pointerId: e.pointerId, clientY: e.clientY, raf: 0 };
    dragRef.current = d;
    setDrag({ end, index: indexAt(e.clientY) });
    // Auto-scroll near the edges, and keep the hovered row in sync while the content moves.
    const tick = () => {
      if (dragRef.current !== d) return;
      const r = list.getBoundingClientRect();
      const depth = d.clientY < r.top + EDGE ? d.clientY - (r.top + EDGE) : d.clientY > r.bottom - EDGE ? d.clientY - (r.bottom - EDGE) : 0;
      if (depth) list.scrollTop += Math.max(-MAX_SCROLL_STEP, Math.min(MAX_SCROLL_STEP, depth / 2));
      const index = indexAt(d.clientY);
      setDrag((prev) => (prev && prev.index !== index ? { ...prev, index } : prev));
      d.raf = requestAnimationFrame(tick);
    };
    d.raf = requestAnimationFrame(tick);
  };

  useEffect(() => {
    if (!drag) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      stopDrag(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }); // re-bound each render so stopDrag sees current props

  // ---------------------------------------------------------------- picking
  // Bring the current head into view once, when history first arrives.
  const scrolled = useRef(false);
  useEffect(() => {
    if (scrolled.current || !headSha) return;
    const i = indexOf.get(headSha);
    if (i === undefined) return;
    scrolled.current = true;
    setFocused(i);
    listRef.current?.querySelector(`[data-index="${i}"]`)?.scrollIntoView({ block: "center" });
  }, [indexOf, headSha]);

  const shortOf = (sha: string) =>
    isPseudoRev(sha) ? PSEUDO_LABEL[sha] : (rows[indexOf.get(sha) ?? -1]?.commit.shortSha ?? sha.slice(0, 7));

  /** One commit against its first parent, like `git show`. */
  const show = (c: GraphCommit) => {
    setAnchor(c.sha);
    const parent = c.parents[0];
    if (!parent) {
      setNotice(`${c.shortSha} is a root commit with no parent. Drag a handle onto it, or shift-click another commit.`);
      return;
    }
    setNotice(null);
    onCompare(parent, c.sha);
  };

  /** Range from the anchor to `c`; whichever sits lower in the list (older) is A. */
  const span = (c: GraphCommit) => {
    const other = anchor ?? headSha;
    if (!other || other === c.sha) return show(c);
    setNotice(null);
    // Uncommitted state is newer than any commit, so it always stays the head.
    const otherIndex = isPseudoRev(other) ? -1 : (indexOf.get(other) ?? Infinity);
    const [base, head] = otherIndex > (indexOf.get(c.sha) ?? 0) ? [other, c.sha] : [c.sha, other];
    onCompare(base, head);
  };

  /** Move one end of the range to `c` (keyboard and menu counterpart of dragging). */
  const moveEnd = (end: End, c: GraphCommit) => {
    const [base, head] = end === "A" ? [c.sha, headSha] : [baseSha, c.sha];
    if (!base || !head || base === head) return;
    setNotice(null);
    onCompare(base, head);
  };

  const focusRow = (i: number) => {
    const next = Math.min(Math.max(i, 0), rows.length - 1);
    setFocused(next);
    listRef.current?.querySelector<HTMLElement>(`[data-index="${next}"]`)?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (drag) return;
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
      case "Enter":
        if (row) (e.shiftKey ? span : show)(row.commit);
        break;
      case "a":
      case "A":
        if (row) moveEnd("A", row.commit);
        break;
      case "b":
      case "B":
        if (row) moveEnd("B", row.commit);
        break;
      case "Escape":
        if (!notice) return;
        setNotice(null);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  // Rows are memoized; route their events through a ref so the callbacks stay stable.
  const handlers = useRef({ onRowClick: (_i: number, _e: React.MouseEvent) => {}, onRowMenu: (_i: number) => {}, startDrag });
  handlers.current = {
    onRowClick: (i, e) => {
      const c = rows[i]?.commit;
      if (!c) return;
      setFocused(i);
      (e.shiftKey || e.metaKey || e.ctrlKey ? span : show)(c);
    },
    onRowMenu: (i) => {
      setFocused(i);
      setMenuFor(rows[i]?.commit ?? null);
    },
    startDrag,
  };
  const rowEvents = useMemo<RowEvents>(
    () => ({
      onClick: (i, e) => handlers.current.onRowClick(i, e),
      onMenu: (i) => handlers.current.onRowMenu(i),
      onFocus: (i) => setFocused(i),
      onGrab: (end, e) => handlers.current.startDrag(end, e),
    }),
    [],
  );

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
  const dragged = drag ? rows[drag.index]?.commit : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ------------------------------------------------------------ hint bar */}
      <div className="bg-muted/40 flex min-h-9 items-center gap-2 border-b px-3 text-xs">
        <GitCompareArrowsIcon className="text-muted-foreground size-3.5 shrink-0" />
        {drag && dragged ? (
          <>
            <span className="shrink-0">Move</span>
            <Badge kind={drag.end} />
            <span className="shrink-0">to</span>
            <code className="shrink-0">{dragged.shortSha}</code>
            <span className="text-muted-foreground truncate">{dragged.subject}</span>
            <span className="text-muted-foreground ml-auto shrink-0">
              release to compare · <kbd>Esc</kbd> to cancel
            </span>
          </>
        ) : notice ? (
          <>
            <InfoIcon className="size-3.5 shrink-0 text-amber-600" />
            <span className="truncate">{notice}</span>
            <Button variant="ghost" size="sm" className="ml-auto h-6 shrink-0 px-2 text-xs" onClick={() => setNotice(null)}>
              <XIcon className="size-3.5" /> Dismiss
            </Button>
          </>
        ) : (
          <>
            <span className="text-muted-foreground truncate">
              <b className="text-foreground">Click</b> a commit to view it · <b className="text-foreground">drag</b>{" "}
              <Badge kind="A" inline /> <Badge kind="B" inline /> to change the range ·{" "}
              <b className="text-foreground">Shift-click</b> to select a range
            </span>
            {backwards ? (
              <span className="ml-auto flex shrink-0 items-center gap-1 text-amber-700 dark:text-amber-400">
                <InfoIcon className="size-3.5" /> B is an ancestor of A: the diff runs backwards (⇄ swaps)
              </span>
            ) : (
              range.size > 0 &&
              aSha &&
              bSha && (
                <span className="ml-auto flex shrink-0 items-center gap-1">
                  <Badge kind="A" />
                  <code>{shortOf(aSha)}</code>…
                  <Badge kind="B" />
                  <code>{shortOf(bSha)}</code>
                  <span className="text-muted-foreground">
                    · {range.size}
                    {aIndex === undefined && shown.truncated ? "+" : ""} commit{range.size === 1 ? "" : "s"}
                  </span>
                </span>
              )
            )}
          </>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground -mr-2 size-6 shrink-0"
          onClick={onHide}
          aria-label="Hide commit graph"
          title="Hide commit graph (bring it back with Graph in the header)"
        >
          <PanelTopCloseIcon className="size-3.5" />
        </Button>
      </div>

      {/* ------------------------------------------------------------ rows */}
      <ContextMenu onOpenChange={(open) => !open && setMenuFor(null)}>
        <ContextMenuTrigger asChild disabled={!!drag}>
          <div
            ref={listRef}
            role="listbox"
            aria-label="Commit history"
            className={cn("min-h-0 flex-1 overflow-auto", drag && "cursor-grabbing select-none")}
            onKeyDown={onKeyDown}
            onPointerMove={(e) => {
              if (dragRef.current) dragRef.current.clientY = e.clientY;
            }}
            onPointerUp={(e) => {
              // Drop where the pointer was released, even if no move event preceded it.
              if (dragRef.current) dragRef.current.clientY = e.clientY;
              stopDrag(true);
            }}
            onPointerCancel={() => stopDrag(false)}
          >
            {rows.map((row, i) => (
              <Row
                key={row.commit.sha}
                row={row}
                index={i}
                lanes={lanes}
                focused={i === focused}
                end={i === aIndex ? "A" : i === bIndex ? "B" : null}
                line={
                  bracketTop === bracketBottom
                    ? null
                    : i === bracketTop
                      ? "down"
                      : i === bracketBottom
                        ? "up"
                        : i > bracketTop && i < bracketBottom
                          ? "through"
                          : null
                }
                inRange={range.has(row.commit.sha)}
                dim={range.size > 0 && !range.has(row.commit.sha) && i !== aIndex}
                grabbed={!!drag && i === drag.index}
                menuOpen={menuFor?.sha === row.commit.sha}
                events={rowEvents}
              />
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
              <ContextMenuItem onSelect={() => show(target)} disabled={target.parents.length === 0}>
                <EyeIcon />
                View this commit
                <ContextMenuShortcut>↵</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => moveEnd("A", target)} disabled={!headSha || target.sha === headSha || target.sha === baseSha}>
                <Badge kind="A" />
                Move A (base) here
                <ContextMenuShortcut>A</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => moveEnd("B", target)} disabled={!baseSha || target.sha === baseSha || target.sha === headSha}>
                <Badge kind="B" />
                Move B (head) here
                <ContextMenuShortcut>B</ContextMenuShortcut>
              </ContextMenuItem>
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

interface RowEvents {
  onClick(index: number, e: React.MouseEvent): void;
  onMenu(index: number): void;
  onFocus(index: number): void;
  onGrab(end: End, e: React.PointerEvent): void;
}

interface RowProps {
  readonly row: GraphRow;
  readonly index: number;
  readonly lanes: number;
  readonly focused: boolean;
  /** This row holds the A or B handle. */
  readonly end: End | null;
  /** Gutter line joining the two handles through this row. */
  readonly line: Line;
  readonly inRange: boolean;
  readonly dim: boolean;
  /** The pointer is over this row while dragging a handle. */
  readonly grabbed: boolean;
  readonly menuOpen: boolean;
  readonly events: RowEvents;
}

/** Memoized: a drag re-renders only the rows whose flags change, not the whole history. */
const Row = memo(function Row({ row, index, lanes, focused, end, line, inRange, dim, grabbed, menuOpen, events }: RowProps) {
  const c = row.commit;
  return (
    <div
      data-index={index}
      role="option"
      aria-selected={!!end || inRange}
      tabIndex={focused ? 0 : -1}
      title={c.parents.length === 0 ? "Root commit" : undefined}
      onFocus={(e) => e.target === e.currentTarget && events.onFocus(index)}
      onClick={(e) => events.onClick(index, e)}
      // Runs before the menu opens (it bubbles up to the trigger), so the menu knows its row.
      onContextMenu={() => events.onMenu(index)}
      className={cn(
        "hover:bg-muted/60 flex cursor-pointer items-center gap-2 pr-3 text-xs outline-none select-none",
        "focus-visible:ring-ring focus-visible:ring-1 focus-visible:ring-inset",
        inRange && "bg-orange-500/8 hover:bg-orange-500/15",
        grabbed && "bg-accent",
        menuOpen && "bg-accent",
      )}
      style={{ height: ROW_H }}
    >
      <Gutter end={end} line={line} onGrab={events.onGrab} />
      <GraphCell row={row} lanes={lanes} marker={end} dim={dim} />
      {c.refs.map((r) => (
        <RefChip key={`${r.kind}:${r.name}`} r={r} />
      ))}
      <span className="min-w-0 flex-1 truncate">{c.subject}</span>
      <span className="text-muted-foreground hidden w-32 shrink-0 truncate md:block">{c.author}</span>
      <span className="text-muted-foreground hidden w-24 shrink-0 truncate text-right sm:block">{relativeDate(c.date)}</span>
      <code className="text-muted-foreground w-14 shrink-0 text-right">{c.shortSha}</code>
    </div>
  );
});

/** Left gutter: the draggable A / B handle, or the line joining them. */
function Gutter({ end, line, onGrab }: { end: End | null; line: Line; onGrab: RowEvents["onGrab"] }) {
  return (
    // The whole gutter cell grabs, not just the badge: a forgiving target for a small handle.
    <span
      className={cn("relative flex h-full w-6 shrink-0 items-center justify-center", end && "cursor-grab touch-none")}
      onPointerDown={end ? (e) => onGrab(end, e) : undefined}
      onClick={end ? (e) => e.stopPropagation() : undefined}
    >
      {line && (
        <span
          className={cn(
            "bg-muted-foreground/40 absolute left-1/2 w-0.5 -translate-x-1/2",
            line === "through" ? "inset-y-0" : line === "up" ? "top-0 h-1/2" : "bottom-0 h-1/2",
          )}
          aria-hidden
        />
      )}
      {end && (
        <span
          role="button"
          aria-label={end === "A" ? "Drag to move A (base)" : "Drag to move B (head)"}
          title={end === "A" ? "A (base): drag to another commit" : "B (head): drag to another commit"}
          className={cn(
            "relative flex h-[18px] w-5 items-center justify-center rounded text-[11px] font-bold text-white shadow-sm",
            "ring-background ring-2 transition-transform hover:scale-110 active:cursor-grabbing",
            end === "A" ? "bg-blue-600" : "bg-orange-600",
          )}
        >
          {end}
        </span>
      )}
    </span>
  );
}

function Badge({ kind, inline }: { kind: End; inline?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-[10px] font-bold text-white",
        inline && "align-text-bottom",
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

function GraphCell({
  row,
  lanes,
  marker,
  dim,
}: {
  row: GraphRow;
  lanes: number;
  marker: "A" | "B" | null;
  /** Fade the dot: this commit is outside the compared range. */
  dim: boolean;
}) {
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
        opacity={dim ? 0.35 : 1}
        fill={isMerge ? "var(--background)" : color}
        stroke={color}
        strokeWidth={2}
      />
    </svg>
  );
}
