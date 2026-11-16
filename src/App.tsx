import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeftRightIcon,
  Columns2Icon,
  FolderGit2Icon,
  Loader2Icon,
  MoonIcon,
  RowsIcon,
  SunIcon,
  WrapTextIcon,
} from "lucide-react";
import { DiffPane } from "@/components/DiffPane";
import { FileTree } from "@/components/FileTree";
import { RefPicker } from "@/components/RefPicker";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Separator } from "@/components/ui/separator";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { api, useAsync } from "@/lib/api";
import { buildTree, filesInTreeOrder } from "@/lib/tree";
import type { RefsResponse, RepoInfo } from "@/shared/api";
import "./index.css";

// ---------------------------------------------------------------------------
// Small persisted / URL-backed state helpers
// ---------------------------------------------------------------------------

function readUrl() {
  const p = new URLSearchParams(window.location.search);
  return { base: p.get("base") ?? "", head: p.get("head") ?? "", file: p.get("file") };
}

function writeUrl(state: { base: string; head: string; file: string | null }) {
  const p = new URLSearchParams();
  if (state.base) p.set("base", state.base);
  if (state.head) p.set("head", state.head);
  if (state.file) p.set("file", state.file);
  const next = `${window.location.pathname}${p.size ? `?${p}` : ""}`;
  if (next !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(null, "", next);
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

/** Pick sensible defaults: compare the current branch against main/master, else against its parent commit. */
function defaultRefs(repo: RepoInfo, refs: RefsResponse): { base: string; head: string } {
  const head = repo.currentBranch ?? "HEAD";
  const candidates = ["main", "master", "develop", "trunk"];
  const local = candidates.find((c) => c !== head && refs.branches.some((b) => b.name === c));
  if (local) return { base: local, head };
  const remote = candidates
    .map((c) => `origin/${c}`)
    .find((c) => refs.remoteBranches.some((b) => b.name === c) && refs.remoteBranches.find((b) => b.name === c)?.sha !== repo.headSha);
  if (remote) return { base: remote, head };
  return { base: refs.commits.length > 1 ? `${head}~1` : head, head };
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function App() {
  const initial = useMemo(readUrl, []);
  const [base, setBase] = useState(initial.base);
  const [head, setHead] = useState(initial.head);
  const [selected, setSelected] = useState<string | null>(initial.file);

  const [mode, setMode] = usePref<"split" | "unified">("gdv.mode", "split");
  const [wrap, setWrap] = usePref<"on" | "off">("gdv.wrap", "off");
  const [theme, setTheme] = usePref<"light" | "dark">(
    "gdv.theme",
    window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  const repo = useAsync((s) => api.repo(s), []);
  const refs = useAsync((s) => api.refs(s), []);
  const repoData = repo.status === "success" ? repo.data : null;
  const refsData = refs.status === "success" ? refs.data : null;

  // Fill in defaults once we know the repo, unless the URL already chose.
  useEffect(() => {
    if (!repoData || !refsData || (base && head)) return;
    const d = defaultRefs(repoData, refsData);
    if (!base) setBase(d.base);
    if (!head) setHead(d.head);
  }, [repoData, refsData]); // eslint-disable-line react-hooks/exhaustive-deps

  const compare = useAsync(base && head ? (s) => api.compare(base, head, s) : null, [base, head]);
  const compareData = compare.status === "success" ? compare.data : null;

  // Files in the order they appear in the tree, for next / previous navigation.
  const ordered = useMemo(() => (compareData ? filesInTreeOrder(buildTree(compareData.files)) : []), [compareData]);
  const selectedIndex = ordered.findIndex((f) => f.path === selected);
  const selectedFile = selectedIndex >= 0 ? ordered[selectedIndex]! : null;

  // After a new comparison loads, keep the selection if the file is still there, else pick the first file.
  useEffect(() => {
    if (!compareData) return;
    if (!selected || !compareData.files.some((f) => f.path === selected)) setSelected(ordered[0]?.path ?? null);
  }, [compareData]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => writeUrl({ base, head, file: selected }), [base, head, selected]);

  const go = useCallback(
    (delta: number) => {
      const next = ordered[Math.min(Math.max(selectedIndex + delta, 0), ordered.length - 1)];
      if (next) setSelected(next.path);
    },
    [ordered, selectedIndex],
  );

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

          <div className="flex items-center gap-1.5">
            <RefPicker
              label="Base"
              value={base}
              refs={refsData}
              resolvedSha={compareData?.base.sha}
              onChange={setBase}
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label="Swap base and head"
                  onClick={() => {
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
              onChange={setHead}
            />
            {compare.status === "loading" && <Loader2Icon className="text-muted-foreground size-4 animate-spin" />}
          </div>

          <div className="ml-auto flex items-center gap-1">
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
        ) : compare.status === "error" ? (
          <Message tone="error">{compare.error.message}</Message>
        ) : !compareData ? (
          <Message>
            <Loader2Icon className="size-4 animate-spin" /> Comparing…
          </Message>
        ) : (
          <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
            <ResizablePanel defaultSize="28" minSize="15" maxSize="60">
              <FileTree
                key={`${compareData.base.sha}..${compareData.head.sha}`}
                files={compareData.files}
                selectedPath={selected}
                onSelect={(f) => setSelected(f.path)}
              />
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
              />
            </ResizablePanel>
          </ResizablePanelGroup>
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
