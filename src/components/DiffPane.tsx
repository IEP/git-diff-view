import { DiffModeEnum, DiffView } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view-pure.css";
import { ArrowRightIcon, ChevronDownIcon, ChevronUpIcon, CopyIcon, FileWarningIcon, Loader2Icon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, useHeldAsync } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { FileChange, FileDiffResponse } from "@/shared/api";
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
}

export function DiffPane({ baseSha, headSha, file, mode, wrap, theme, position, onPrev, onNext, reload = 0 }: DiffPaneProps) {
  // A reload of the same file keeps the old diff up until the new one arrives.
  const { state, data: shown } = useHeldAsync(
    `${baseSha}:${headSha}:${file?.oldPath}:${file?.path}`,
    file ? (signal) => api.file(baseSha, headSha, file.path, file.oldPath, signal) : null,
    [baseSha, headSha, file?.path, file?.oldPath, reload],
  );

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

      <div className="min-h-0 flex-1 overflow-auto">
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
