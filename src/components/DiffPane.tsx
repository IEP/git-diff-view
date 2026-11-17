import { DiffModeEnum, DiffView } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view-pure.css";
import { useEffect, useRef } from "react";
import { ArrowRightIcon, ChevronDownIcon, ChevronUpIcon, CopyIcon, FileWarningIcon, Loader2Icon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, useHeldAsync } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { FileChange, FileDiffResponse, SearchHit } from "@/shared/api";
import { STATUS_STYLE } from "./FileTree";

interface DiffPaneProps {
  readonly baseSha: string;
  readonly headSha: string;
  readonly file: FileChange | null;
  readonly mode: "split" | "unified";
  readonly wrap: boolean;
  readonly theme: "light" | "dark";
  readonly position: { readonly index: number; readonly total: number };
  readonly onPrev: () => void;
  readonly onNext: () => void;
  /** Bumped to re-read the diff (a branch or the working tree changes under the same name). */
  readonly reload?: number;
  /** Scroll to this line once its file is shown; a new object jumps again. */
  readonly jump?: SearchHit | null;
  /** Text to highlight wherever it appears in the diff (the active search). */
  readonly highlight?: string;
}

export function DiffPane({
  baseSha,
  headSha,
  file,
  mode,
  wrap,
  theme,
  position,
  onPrev,
  onNext,
  reload = 0,
  jump = null,
  highlight = "",
}: DiffPaneProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  // A reload of the same file keeps the old diff up until the new one arrives.
  const { state, data: shown } = useHeldAsync(
    `${baseSha}:${headSha}:${file?.oldPath}:${file?.path}`,
    file ? (signal) => api.file(baseSha, headSha, file.path, file.oldPath, signal) : null,
    [baseSha, headSha, file?.path, file?.oldPath, reload],
  );

  useJumpToLine(bodyRef, jump, file?.path === jump?.path && !!shown);
  useHighlight(bodyRef, highlight, !!file);

  if (!file) {
    return <Centered>Select a file in the tree to see its diff.</Centered>;
  }

  const style = STATUS_STYLE[file.status];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-10 items-center gap-2 border-b px-3 py-1.5">
        <Badge variant="outline" className={cn("font-mono", style.text)} title={style.label}>
          {style.letter}
        </Badge>
        <div className="flex min-w-0 items-center gap-1.5 font-mono text-xs">
          {file.oldPath && (
            <>
              <span className="text-muted-foreground truncate">{file.oldPath}</span>
              <ArrowRightIcon className="text-muted-foreground size-3.5 shrink-0" />
            </>
          )}
          <span className="truncate font-medium">{file.path}</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 shrink-0"
                aria-label="Copy path"
                onClick={() => navigator.clipboard?.writeText(file.path)}
              >
                <CopyIcon className="size-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Copy path</TooltipContent>
          </Tooltip>
        </div>
        {file.similarity !== null && file.status !== "modified" && (
          <span className="text-muted-foreground shrink-0 text-xs">{file.similarity}% similar</span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <span className="text-muted-foreground mr-1 text-xs tabular-nums">
            {position.index + 1} / {position.total}
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7" onClick={onPrev} aria-label="Previous file" disabled={position.index <= 0}>
                <ChevronUpIcon className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Previous file (Shift+F7)</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={onNext}
                aria-label="Next file"
                disabled={position.index >= position.total - 1}
              >
                <ChevronDownIcon className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Next file (F7)</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div ref={bodyRef} className="min-h-0 flex-1 overflow-auto">
        {state.status !== "error" && !shown && (
          <Centered>
            <Loader2Icon className="size-4 animate-spin" /> Loading diff…
          </Centered>
        )}
        {state.status === "error" && <Centered tone="error">{state.error.message}</Centered>}
        {shown && (
          <DiffBody key={`${baseSha}:${headSha}:${file.path}`} file={file} diff={shown} mode={mode} wrap={wrap} theme={theme} />
        )}
      </div>
    </div>
  );
}

function DiffBody({
  file,
  diff,
  mode,
  wrap,
  theme,
}: {
  file: FileChange;
  diff: FileDiffResponse;
  mode: "split" | "unified";
  wrap: boolean;
  theme: "light" | "dark";
}) {
  if (diff.binary) {
    return (
      <Centered>
        <FileWarningIcon className="size-4" /> Binary file changed. No text diff to show.
      </Centered>
    );
  }

  const hasHunks = diff.patch.includes("\n@@ ");
  if (!hasHunks && diff.tooLarge) {
    return (
      <Centered>
        <FileWarningIcon className="size-4" /> File too large to show.
      </Centered>
    );
  }
  if (!hasHunks) {
    const reason =
      file.status === "renamed"
        ? "File renamed without content changes."
        : file.status === "copied"
          ? "File copied without content changes."
          : diff.patch.includes("old mode")
            ? "Only the file mode changed."
            : "No content changes.";
    return <Centered>{reason}</Centered>;
  }

  // Ship full contents when we have them: that enables "expand context" and
  // accurate syntax highlighting. For very large files we fall back to hunks only.
  // No content on either side (too large, or the server withheld it): render the hunks alone.
  const withContent = !diff.tooLarge && (diff.oldContent !== null || diff.newContent !== null);
  // A new (or deleted) file has only one side, so split view would leave half
  // the pane empty. Show it as a single full-width column instead.
  const oneSided = file.status === "added" || file.status === "deleted";
  const viewMode = oneSided || mode === "unified" ? DiffModeEnum.Unified : DiffModeEnum.Split;
  return (
    <>
      {diff.tooLarge && (
        <div className="text-muted-foreground border-b bg-amber-500/10 px-3 py-1.5 text-xs">
          Large file: showing changed hunks only, without full-file context.
        </div>
      )}
      <DiffView
        className="text-xs"
        data={{
          oldFile: { fileName: file.oldPath ?? file.path, content: withContent ? (diff.oldContent ?? "") : undefined },
          newFile: { fileName: file.path, content: withContent ? (diff.newContent ?? "") : undefined },
          hunks: [diff.patch],
        }}
        diffViewMode={viewMode}
        diffViewTheme={theme}
        diffViewWrap={wrap}
        diffViewHighlight
        diffViewFontSize={12}
      />
    </>
  );
}

/**
 * Scroll `jump`'s line into view once its file's diff is on screen. The diff view
 * renders (and syntax-highlights) after mounting, so this retries for a moment.
 * Split view tags each side's line numbers; unified view tags old and new numbers.
 */
function useJumpToLine(container: React.RefObject<HTMLDivElement | null>, jump: SearchHit | null, ready: boolean) {
  const done = useRef<SearchHit | null>(null);
  useEffect(() => {
    if (!jump || !ready || done.current === jump) return;
    const selector = `[data-side="${jump.side}"] [data-line-num="${jump.line}"], [data-line-${jump.side}-num="${jump.line}"]`;
    let frame = 0;
    let tries = 0;
    const attempt = () => {
      const row = container.current?.querySelector(selector)?.closest("tr");
      if (row) {
        done.current = jump;
        row.scrollIntoView({ block: "center" });
        row.classList.remove("diff-search-target");
        void row.offsetWidth; // restart the flash animation
        row.classList.add("diff-search-target");
      } else if (++tries < 60) {
        frame = requestAnimationFrame(attempt);
      }
    };
    attempt();
    return () => cancelAnimationFrame(frame);
  }, [container, jump, ready]);
}

const HIGHLIGHT = "diff-search";
const MAX_HIGHLIGHTS = 5000;

/**
 * Mark every occurrence of `query` in the diff's code cells with the CSS Custom
 * Highlight API, which paints ranges without touching the diff view's DOM. It
 * re-runs when the view re-renders (syntax highlighting, expanded context).
 */
function useHighlight(container: React.RefObject<HTMLDivElement | null>, query: string, mounted: boolean) {
  useEffect(() => {
    const root = container.current;
    const registry = typeof CSS !== "undefined" ? CSS.highlights : undefined;
    if (!root || !registry || typeof Highlight === "undefined") return;
    if (!query) {
      registry.delete(HIGHLIGHT);
      return;
    }
    const q = query.toLowerCase();
    const paint = () => {
      const ranges: Array<Range> = [];
      // Unified view: .diff-line-content; split view: .diff-line-old-content / .diff-line-new-content.
      for (const cell of root.querySelectorAll(".diff-line-content, .diff-line-old-content, .diff-line-new-content")) {
        const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
        // Matches can span syntax tokens, so search the cell's text and map offsets back to nodes.
        const nodes: Array<{ node: Text; start: number }> = [];
        let text = "";
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          nodes.push({ node: n as Text, start: text.length });
          text += n.nodeValue ?? "";
        }
        const lower = text.toLowerCase();
        const locate = (offset: number) => {
          let i = nodes.length - 1;
          while (i > 0 && nodes[i]!.start > offset) i--;
          return { node: nodes[i]!.node, offset: offset - nodes[i]!.start };
        };
        for (let at = lower.indexOf(q); at !== -1; at = lower.indexOf(q, at + q.length)) {
          const a = locate(at);
          const b = locate(at + q.length - 1);
          const range = new Range();
          range.setStart(a.node, a.offset);
          range.setEnd(b.node, b.offset + 1);
          ranges.push(range);
          if (ranges.length >= MAX_HIGHLIGHTS) break;
        }
        if (ranges.length >= MAX_HIGHLIGHTS) break;
      }
      registry.set(HIGHLIGHT, new Highlight(...ranges));
    };
    let frame = requestAnimationFrame(paint);
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(paint);
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      registry.delete(HIGHLIGHT);
    };
  }, [container, query, mounted]);
}

function Centered({ children, tone }: { children: React.ReactNode; tone?: "error" }) {
  return (
    <div
      className={cn(
        "flex h-full min-h-40 items-center justify-center gap-2 p-6 text-center text-sm",
        tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}
