import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeftRightIcon,
  Columns2Icon,
  ExternalLinkIcon,
  FolderGit2Icon,
  GitGraphIcon,
  Loader2Icon,
  MoonIcon,
  RefreshCwIcon,
  RowsIcon,
  SearchIcon,
  SunIcon,
  WrapTextIcon,
} from "lucide-react";
import { CommitGraph } from "@/components/CommitGraph";
import { DiffPane } from "@/components/DiffPane";
import { DiffSearch } from "@/components/DiffSearch";
import { FileTree } from "@/components/FileTree";
import { PullPicker } from "@/components/PullPicker";
import { RefPicker } from "@/components/RefPicker";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Separator } from "@/components/ui/separator";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { api, useAsync, useHeldAsync } from "@/lib/api";
import { buildTree, filesInTreeOrder } from "@/lib/tree";
import {
  WORKTREE,
  type CompareResponse,
  type GraphResponse,
  type RefsResponse,
  type RepoInfo,
  type SearchHit,
} from "@/shared/api";
import "./index.css";

// ---------------------------------------------------------------------------
// Small persisted / URL-backed state helpers
// ---------------------------------------------------------------------------

function readUrl() {
  const p = new URLSearchParams(window.location.search);
  const pr = p.get("pr");
  return {
    base: p.get("base") ?? "",
    head: p.get("head") ?? "",
    file: p.get("file"),
    pr: pr && /^[1-9][0-9]{0,8}$/.test(pr) ? Number(pr) : null,
  };
}

function writeUrl(state: { base: string; head: string; file: string | null; pr: number | null }) {
  const p = new URLSearchParams();
  // A PR link re-resolves on load, so it picks up new pushes; base/head SHAs would pin a stale snapshot.
  if (state.pr) {
    p.set("pr", String(state.pr));
  } else {
    if (state.base) p.set("base", state.base);
    if (state.head) p.set("head", state.head);
  }
  if (state.file) p.set("file", state.file);
  const next = `${window.location.pathname}${p.size ? `?${p}` : ""}`;
  if (next !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(null, "", next);
}

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

function usePref<T extends string>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      return (localStorage.getItem(key) as T | null) ?? initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(key, v);
      } catch {
        /* storage unavailable: preference just won't persist */
      }
    },
    [key],
  );
  return [value, set];
}

/**
 * Pick sensible defaults: the working tree (everything on this branch, committed or
 * not) against main/master, else against the current commit's parent.
 */
function defaultRefs(repo: RepoInfo, refs: RefsResponse): { base: string; head: string } {
  const current = repo.currentBranch ?? "HEAD";
  const head = WORKTREE;
  const candidates = ["main", "master", "develop", "trunk"];
  const local = candidates.find((c) => c !== current && refs.branches.some((b) => b.name === c));
  if (local) return { base: local, head };
  const remote = candidates
    .map((c) => `origin/${c}`)
    .find((c) => refs.remoteBranches.some((b) => b.name === c) && refs.remoteBranches.find((b) => b.name === c)?.sha !== repo.headSha);
  if (remote) return { base: remote, head };
  return { base: refs.commits.length > 1 ? `${current}~1` : current, head };
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const GRAPH_PAGE = 500;
const POLL_MS = 2000;
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function App() {
  const initial = useMemo(readUrl, []);
  const [base, setBase] = useState(initial.base);
  const [head, setHead] = useState(initial.head);
  const [selected, setSelected] = useState<string | null>(initial.file);
  const [pr, setPr] = useState<number | null>(initial.pr);

  // Picking revisions by hand leaves pull-request mode.
  const chooseBase = useCallback((ref: string) => {
    setPr(null);
    setBase(ref);
  }, []);
  const chooseHead = useCallback((ref: string) => {
    setPr(null);
    setHead(ref);
  }, []);

  const [mode, setMode] = usePref<"split" | "unified">("gdv.mode", "split");
  const [wrap, setWrap] = usePref<"on" | "off">("gdv.wrap", "off");
  const [showGraph, setShowGraph] = usePref<"on" | "off">("gdv.graph", "on");
  const [theme, setTheme] = usePref<"light" | "dark">(
    "gdv.theme",
    window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  // Branch names, HEAD and the working tree move while the page is open (an editor or an
  // agent at work), so such comparisons re-read themselves; fixed commit ids never change.
  const live = !!base && !!head && ![base, head].every((r) => COMMIT_ID.test(r));
  const [tick, setTick] = useState(0);

  const repoQ = useHeldAsync("repo", (s) => api.repo(s), [tick]);
  const repoData = repoQ.data;
  const repo = repoQ.state;
  // New commits: refresh the pickers and the graph too.
  const headSha = repoData?.headSha ?? null;
  const refsQ = useHeldAsync("refs", (s) => api.refs(s), [headSha]);
  const refsData = refsQ.data;
  const refs = refsQ.state;

  // GitHub pull requests: the list is only shown when a remote points at github.com.
  const pulls = useAsync((s) => api.pulls(s), []);
  const showPulls = (pulls.status === "success" && pulls.data.github !== null) || pulls.status === "error";
  const pull = useAsync(pr ? (s) => api.pull(pr, s) : null, [pr]);
  const pullData = pull.status === "success" && pull.data.number === pr ? pull.data : null;

  // A resolved PR drives base (its merge-base) and head.
  useEffect(() => {
    if (!pullData) return;
    setBase(pullData.base);
    setHead(pullData.head);
  }, [pullData]);

  // Fill in defaults once we know the repo, unless the URL already chose.
  useEffect(() => {
    if (pr || !repoData || !refsData || (base && head)) return;
    const d = defaultRefs(repoData, refsData);
    if (!base) setBase(d.base);
    if (!head) setHead(d.head);
    // `pr` is a dependency so leaving PR mode (e.g. after a failed load) fills any still-empty side.
  }, [repoData, refsData, pr]); // eslint-disable-line react-hooks/exhaustive-deps

  // While re-reading the same pair, the last result stays on screen instead of a spinner.
  const { state: compare, data: compareData } = useHeldAsync<CompareResponse>(
    `${base}..${head}`,
    base && head ? (s) => api.compare(base, head, s) : null,
    [base, head, tick],
  );

  // Poll: the next read is scheduled once the last one finished, so a slow repo is never cancelled
  // mid-read. Only while the tab is visible; coming back to it reads at once.
  useEffect(() => {
    if (!live || compare.status === "loading") return;
    const t = setTimeout(() => {
      if (document.visibilityState === "visible") setTick((n) => n + 1);
    }, POLL_MS);
    return () => clearTimeout(t);
  }, [live, compare]);
  useEffect(() => {
    if (!live) return;
    const onVisible = () => document.visibilityState === "visible" && setTick((n) => n + 1);
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [live]);

  // Commit graph. "Load more" raises the limit; the graph keeps the old page on screen meanwhile.
  const [graphLimit, setGraphLimit] = useState(GRAPH_PAGE);
  const graph = useAsync(showGraph === "on" ? (s) => api.graph(graphLimit, s) : null, [graphLimit, showGraph, headSha]);
  // A / B markers. Held across compare reloads (and set optimistically on a pick) so they don't blink.
  const [marked, setMarked] = useState<{ base: string | null; head: string | null }>({ base: null, head: null });
  useEffect(() => {
    if (compareData) setMarked({ base: compareData.base.sha, head: compareData.head.sha });
  }, [compareData]);
  // The last loaded graph, kept while it reloads after new commits.
  const [graphData, setGraphData] = useState<GraphResponse | null>(null);
  useEffect(() => {
    if (graph.status === "success") setGraphData(graph.data);
  }, [graph]);

  /**
   * A graph pick on a branch tip becomes the branch name, so the comparison follows new
   * commits instead of pinning that one: current branch, another local branch, HEAD,
   * a remote branch, a tag, and only then the commit id.
   */
  const nameFor = useCallback(
    (sha: string) => {
      const refs = graphData?.commits.find((c) => c.sha === sha)?.refs ?? [];
      const branches = refs.filter((r) => r.kind === "branch").map((r) => r.name);
      const current = repoData?.currentBranch;
      if (current && branches.includes(current)) return current;
      return (
        branches[0] ??
        (refs.some((r) => r.kind === "head") ? "HEAD" : undefined) ??
        refs.find((r) => r.kind === "remote")?.name ??
        refs.find((r) => r.kind === "tag")?.name ??
        sha
      );
    },
    [graphData, repoData?.currentBranch],
  );

  const compareCommits = useCallback(
    (a: string, b: string, pin?: boolean) => {
      setMarked({ base: a, head: b });
      chooseBase(pin ? a : nameFor(a));
      chooseHead(pin ? b : nameFor(b));
    },
    [chooseBase, chooseHead, nameFor],
  );

  // Files in the order they appear in the tree, for next / previous navigation.
  const ordered = useMemo(() => (compareData ? filesInTreeOrder(buildTree(compareData.files)) : []), [compareData]);
  const selectedIndex = ordered.findIndex((f) => f.path === selected);
  const selectedFile = selectedIndex >= 0 ? ordered[selectedIndex]! : null;

  // After a new comparison loads, keep the selection if the file is still there, else pick the first file.
  useEffect(() => {
    if (!compareData) return;
    if (!selected || !compareData.files.some((f) => f.path === selected)) setSelected(ordered[0]?.path ?? null);
  }, [compareData]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => writeUrl({ base, head, file: selected, pr }), [base, head, selected, pr]);

  const go = useCallback(
    (delta: number) => {
      const next = ordered[Math.min(Math.max(selectedIndex + delta, 0), ordered.length - 1)];
      if (next) setSelected(next.path);
    },
    [ordered, selectedIndex],
  );

  // "Find in changes": full-text search over the changed lines, in place of the file tree.
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const settledQuery = useDebounced(query, 200);
  const [jump, setJump] = useState<SearchHit | null>(null);
  const openHit = useCallback((hit: SearchHit) => {
    setSelected(hit.path);
    setJump({ ...hit }); // a fresh object, so picking the same hit again scrolls again
  }, []);

  // IntelliJ's Find in Path shortcut: ⌘⇧F / Ctrl+Shift+F opens the search (or focuses it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.key.toLowerCase() !== "f") return;
      e.preventDefault();
      setSearchOpen(true);
      document.querySelector<HTMLInputElement>('input[aria-label="Search changed lines"]')?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // IntelliJ's F7 / Shift+F7 for next / previous change.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "F7") return;
      e.preventDefault();
      go(e.shiftKey ? -1 : 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  const fatal = repo.status === "error" ? repo.error : refs.status === "error" ? refs.error : null;

  const comparison =
    pr && pull.status === "error" ? (
    <Message tone="error">
      Couldn't load pull request #{pr}: {pull.error.message}
    </Message>
  ) : pr && !pullData ? (
    <Message>
      <Loader2Icon className="size-4 animate-spin" /> Loading pull request #{pr}…
    </Message>
  ) : compare.status === "error" ? (
    <Message tone="error">{compare.error.message}</Message>
  ) : !compareData ? (
    <Message>
      <Loader2Icon className="size-4 animate-spin" /> Comparing…
    </Message>
  ) : (
    <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
      <ResizablePanel defaultSize="28" minSize="15" maxSize="60">
        {searchOpen && (
          <DiffSearch
            base={base}
            head={head}
            query={query}
            onQueryChange={setQuery}
            settled={settledQuery}
            onOpen={openHit}
            onClose={() => setSearchOpen(false)}
            live={live}
          />
        )}
        {/* Hidden, not unmounted, while searching: its filter and folded folders survive. */}
        <div className={searchOpen ? "hidden" : "h-full"}>
          <FileTree
            key={`${compareData.base.sha}..${compareData.head.sha}`}
            files={compareData.files}
            selectedPath={selected}
            onSelect={(f) => setSelected(f.path)}
          />
        </div>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize="72" minSize="30">
        <DiffPane
          baseSha={compareData.base.sha}
          headSha={compareData.head.sha}
          file={selectedFile}
          mode={mode}
          wrap={wrap === "on"}
          theme={theme}
          position={{ index: selectedIndex, total: ordered.length }}
          onPrev={() => go(-1)}
          onNext={() => go(1)}
          reload={tick}
          jump={jump}
          highlight={searchOpen ? settledQuery : ""}
        />
      </ResizablePanel>
    </ResizablePanelGroup>
  );

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-screen flex-col">
        {/* ---------------------------------------------------------------- header */}
        <header className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
          <div className="mr-2 flex min-w-0 items-center gap-2" title={repoData?.root}>
            <FolderGit2Icon className="size-4 shrink-0" />
            <span className="truncate font-semibold">{repoData?.name ?? "…"}</span>
            {repoData?.currentBranch && <span className="text-muted-foreground truncate text-xs">on {repoData.currentBranch}</span>}
          </div>

          {showPulls && (
            <div className="flex items-center gap-1">
              <PullPicker pulls={pulls} value={pr} onChange={setPr} />
              {pullData && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" className="size-8" asChild>
                      <a href={pullData.url} target="_blank" rel="noreferrer" aria-label={`Open #${pullData.number} on GitHub`}>
                        <ExternalLinkIcon className="size-4" />
                      </a>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    Open on GitHub · {pullData.baseRef} ← {pullData.headRef}
                  </TooltipContent>
                </Tooltip>
              )}
              <Separator orientation="vertical" className="mx-1 h-5!" />
            </div>
          )}

          <div className="flex items-center gap-1.5">
            <RefPicker
              label="Base"
              value={base}
              refs={refsData}
              resolvedSha={compareData?.base.sha}
              onChange={chooseBase}
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label="Swap base and head"
                  onClick={() => {
                    setPr(null);
                    setBase(head);
                    setHead(base);
                  }}
                >
                  <ArrowLeftRightIcon className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Swap base and head</TooltipContent>
            </Tooltip>
            <RefPicker
              label="Head"
              value={head}
              refs={refsData}
              resolvedSha={compareData?.head.sha}
              onChange={chooseHead}
            />
            {live && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    aria-label="Reload now"
                    onClick={() => setTick((n) => n + 1)}
                  >
                    <RefreshCwIcon className={compare.status === "loading" && !compareData ? "size-4 animate-spin" : "size-4"} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Updates every few seconds while this tab is open. Click to reload now</TooltipContent>
              </Tooltip>
            )}
            {compare.status === "loading" && !compareData && !live && <Loader2Icon className="text-muted-foreground size-4 animate-spin" />}
          </div>

          <div className="ml-auto flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Toggle
                    size="sm"
                    variant="outline"
                    pressed={searchOpen}
                    onPressedChange={setSearchOpen}
                    aria-label="Toggle search"
                  >
                    <SearchIcon className="size-4" />
                  </Toggle>
                </span>
              </TooltipTrigger>
              <TooltipContent>Search changed lines (⌘⇧F / Ctrl+Shift+F)</TooltipContent>
            </Tooltip>
            <ToggleGroup
              type="single"
              size="sm"
              variant="outline"
              value={mode}
              onValueChange={(v) => v && setMode(v as "split" | "unified")}
              aria-label="Diff layout"
            >
              <ToggleGroupItem value="split" aria-label="Side by side">
                <Columns2Icon className="size-4" />
              </ToggleGroupItem>
              <ToggleGroupItem value="unified" aria-label="Unified">
                <RowsIcon className="size-4" />
              </ToggleGroupItem>
            </ToggleGroup>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Toggle
                    size="sm"
                    variant="outline"
                    pressed={showGraph === "on"}
                    onPressedChange={(p) => setShowGraph(p ? "on" : "off")}
                    aria-label="Show commit graph"
                  >
                    <GitGraphIcon className="size-4" />
                    Graph
                  </Toggle>
                </span>
              </TooltipTrigger>
              <TooltipContent>{showGraph === "on" ? "Hide" : "Show"} the commit graph</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Toggle
                    size="sm"
                    variant="outline"
                    pressed={wrap === "on"}
                    onPressedChange={(p) => setWrap(p ? "on" : "off")}
                    aria-label="Wrap long lines"
                  >
                    <WrapTextIcon className="size-4" />
                  </Toggle>
                </span>
              </TooltipTrigger>
              <TooltipContent>Wrap long lines</TooltipContent>
            </Tooltip>
            <Separator orientation="vertical" className="mx-1 h-5!" />
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label="Toggle theme"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? <SunIcon className="size-4" /> : <MoonIcon className="size-4" />}
            </Button>
          </div>
        </header>

        {/* ---------------------------------------------------------------- body */}
        {fatal ? (
          <Message tone="error">{fatal.message}</Message>
        ) : showGraph === "on" ? (
          // The graph sits outside the compare states so a pick doesn't unmount it (scroll, focus, pending A survive).
          <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
            <ResizablePanel id="graph" defaultSize="35" minSize="12" maxSize="80" className="flex flex-col">
              <CommitGraph
                graph={graph}
                baseSha={marked.base}
                headSha={marked.head}
                onCompare={compareCommits}
                onLoadMore={() => setGraphLimit((n) => n + GRAPH_PAGE)}
                onHide={() => setShowGraph("off")}
                worktree={repoData?.headSha ? { parent: repoData.headSha, files: repoData.uncommitted } : null}
              />
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel id="compare" defaultSize="65" minSize="20" className="flex flex-col">
              {comparison}
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : (
          comparison
        )}
      </div>
    </TooltipProvider>
  );
}

function Message({ children, tone }: { children: React.ReactNode; tone?: "error" }) {
  return (
    <div
      className={
        "flex flex-1 items-center justify-center gap-2 p-6 text-sm " +
        (tone === "error" ? "text-destructive" : "text-muted-foreground")
      }
    >
      {children}
    </div>
  );
}

export default App;
