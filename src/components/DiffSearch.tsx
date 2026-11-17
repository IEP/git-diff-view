import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2Icon, SearchIcon, XIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api, useHeldAsync } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { SearchHit } from "@/shared/api";

interface DiffSearchProps {
  readonly base: string;
  readonly head: string;
  readonly query: string;
  readonly onQueryChange: (q: string) => void;
  /** The query after typing settles: what is searched and highlighted. */
  readonly settled: string;
  readonly onOpen: (hit: SearchHit) => void;
  readonly onClose: () => void;
  /** The comparison names something that moves (a branch, the working tree): search again now and then. */
  readonly live: boolean;
}

const POLL_MS = 2000;

/** "Find in changes": a full-text search over the changed lines of the current comparison. */
export function DiffSearch({ base, head, query, onQueryChange, settled, onOpen, onClose, live }: DiffSearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [tick, setTick] = useState(0);

  const { state, data } = useHeldAsync(
    `${base}..${head}:${settled}`,
    settled ? (s) => api.search(base, head, settled, s) : null,
    [base, head, settled, tick],
  );

  // Re-search a moving comparison only after the last search finished (a rebuild after a big
  // change may take longer than one interval), and only while the tab is visible.
  useEffect(() => {
    if (!live || !settled || state.status === "loading") return;
    const t = setTimeout(() => {
      if (document.visibilityState === "visible") setTick((n) => n + 1);
    }, POLL_MS);
    return () => clearTimeout(t);
  }, [live, settled, state]);

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => setActive(0), [settled, base, head]);

  // Group consecutive hits by file, keeping the server's order (file by file, top to bottom).
  const groups = useMemo(() => {
    const out: Array<{ path: string; hits: Array<{ hit: SearchHit; n: number }> }> = [];
    data?.hits.forEach((hit, n) => {
      const last = out.at(-1);
      if (last?.path === hit.path) last.hits.push({ hit, n });
      else out.push({ path: hit.path, hits: [{ hit, n }] });
    });
    return out;
  }, [data]);
  const hits = data?.hits ?? [];

  useEffect(() => {
    listRef.current?.querySelector(`[data-hit="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const open = (n: number) => {
    const hit = hits[n];
    if (!hit) return;
    setActive(n);
    onOpen(hit);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        open(Math.min(active + 1, hits.length - 1));
        break;
      case "ArrowUp":
        open(Math.max(active - 1, 0));
        break;
      case "Enter":
        open(active);
        break;
      case "Escape":
        if (query) onQueryChange("");
        else onClose();
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const loading = state.status === "loading";
  const error = state.status === "error" ? state.error : null;

  return (
    <div className="flex h-full min-h-0 flex-col" onKeyDown={onKeyDown}>
      <div className="flex items-center gap-1 border-b px-2 py-1.5">
        <div className="relative flex-1">
          <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search changed lines"
            aria-label="Search changed lines"
            maxLength={200}
            className="h-7 pr-7 pl-7 text-xs"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close search"
            title="Close search (Esc)"
            className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
          >
            <XIcon className="size-3.5" />
          </button>
        </div>
      </div>

      <div className="text-muted-foreground flex min-h-[25px] items-center gap-2 border-b px-3 py-1 text-xs">
        {loading && !data ? (
          <>
            <Loader2Icon className="size-3 animate-spin" /> Searching…
          </>
        ) : error ? (
          <span className="text-destructive">{error.message}</span>
        ) : data && settled ? (
          <span>
            {data.total === 0
              ? "No matches"
              : data.hits.length < data.total
                ? `${data.total} lines · first ${data.hits.length} shown`
                : `${data.total} ${data.total === 1 ? "line" : "lines"} in ${groups.length} ${groups.length === 1 ? "file" : "files"}`}
            {data.partial && " · diff too large, not fully searched"}
          </span>
        ) : (
          <span>Added and removed lines in this comparison</span>
        )}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div ref={listRef} role="listbox" aria-label="Search results" className="py-1 font-mono text-xs select-none">
          {groups.map((g) => (
            <div key={g.path} role="group" aria-label={g.path}>
              <div className="text-muted-foreground flex h-[22px] items-center gap-1 px-2 font-sans" title={g.path}>
                <span className="text-foreground truncate font-medium">{g.path.split("/").at(-1)}</span>
                <span className="min-w-0 truncate text-[11px]">{g.path.includes("/") && g.path.slice(0, g.path.lastIndexOf("/"))}</span>
                <span className="ml-auto shrink-0 pl-2 text-[10px] tabular-nums">{g.hits.length}</span>
              </div>
              {g.hits.map(({ hit, n }) => (
                <div
                  key={n}
                  data-hit={n}
                  role="option"
                  aria-selected={n === active}
                  onClick={() => open(n)}
                  className={cn(
                    "flex h-[22px] cursor-default items-center gap-2 pr-2 pl-4",
                    "hover:bg-accent/60",
                    n === active && "bg-accent",
                  )}
                >
                  <span
                    className={cn(
                      "w-12 shrink-0 text-right tabular-nums",
                      hit.side === "new" ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400",
                    )}
                    title={hit.side === "new" ? `Added, line ${hit.line}` : `Removed, line ${hit.line} of the base`}
                  >
                    {hit.side === "new" ? "+" : "−"}
                    {hit.line}
                  </span>
                  <span className="truncate whitespace-pre">
                    <Marked text={hit.text.trimStart()} query={settled} />
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

/** `text` with every case-insensitive occurrence of `query` marked. */
function Marked({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const parts: Array<React.ReactNode> = [];
  let from = 0;
  for (let at = lower.indexOf(q); at !== -1 && q; at = lower.indexOf(q, from)) {
    parts.push(text.slice(from, at), <mark key={at} className="rounded-sm bg-yellow-400/45 text-inherit">{text.slice(at, at + q.length)}</mark>);
    from = at + q.length;
  }
  parts.push(text.slice(from));
  return <>{parts}</>;
}
