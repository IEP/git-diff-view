import { useState } from "react";
import { CheckIcon, ChevronsUpDownIcon, CloudIcon, GitBranchIcon, GitCommitHorizontalIcon, TagIcon, TextCursorInputIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { RefsResponse } from "@/shared/api";

interface RefPickerProps {
  readonly label: string;
  readonly value: string;
  readonly refs: RefsResponse | null;
  /** Short SHA the current value resolved to, shown next to the name. */
  readonly resolvedSha?: string | undefined;
  readonly onChange: (ref: string) => void;
}

const MAX_COMMITS_SHOWN = 100;

function iconFor(value: string, refs: RefsResponse | null) {
  if (!refs) return GitBranchIcon;
  if (refs.branches.some((b) => b.name === value)) return GitBranchIcon;
  if (refs.remoteBranches.some((b) => b.name === value)) return CloudIcon;
  if (refs.tags.some((t) => t.name === value)) return TagIcon;
  return GitCommitHorizontalIcon;
}

export function relativeDate(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, secs] of units) {
    if (Math.abs(diff) >= secs) return fmt.format(-Math.round(diff / secs), unit);
  }
  return "just now";
}

export function RefPicker({ label, value, refs, resolvedSha, onChange }: RefPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const Icon = iconFor(value, refs);

  const pick = (ref: string) => {
    onChange(ref);
    setOpen(false);
    setSearch("");
  };

  const typed = search.trim();
  const isKnown =
    !!refs &&
    (refs.branches.some((b) => b.name === typed) ||
      refs.remoteBranches.some((b) => b.name === typed) ||
      refs.tags.some((t) => t.name === typed));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={`${label} revision`}
          className="h-8 w-[min(18rem,40vw)] justify-between gap-2 px-2.5 text-xs font-normal"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="text-muted-foreground text-[10px] uppercase tracking-wide">{label}</span>
            <Icon className="size-3.5 shrink-0 opacity-70" />
            <span className="truncate font-medium">{value || "Select…"}</span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {resolvedSha && <code className="text-muted-foreground text-[10px]">{resolvedSha.slice(0, 7)}</code>}
            <ChevronsUpDownIcon className="size-3.5 opacity-50" />
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[26rem] p-0" align="start">
        <Command>
          <CommandInput
            placeholder="Branch, tag, commit, or any revision (HEAD~3)…"
            value={search}
            onValueChange={setSearch}
          />
          <CommandList className="max-h-[22rem]">
            {(!typed || isKnown) && <CommandEmpty>No matching refs.</CommandEmpty>}
            {typed && !isKnown && (
              <CommandGroup heading="Revision" forceMount>
                <CommandItem value={`__typed__ ${typed}`} forceMount onSelect={() => pick(typed)}>
                  <TextCursorInputIcon />
                  Use <code className="font-mono">{typed}</code>
                </CommandItem>
              </CommandGroup>
            )}
            {refs && refs.branches.length > 0 && (
              <CommandGroup heading="Local branches">
                {refs.branches.map((b) => (
                  <CommandItem key={b.name} value={`branch ${b.name}`} onSelect={() => pick(b.name)}>
                    <GitBranchIcon />
                    <span className="truncate">{b.name}</span>
                    <span className="text-muted-foreground ml-auto truncate pl-2 text-xs">{b.subject}</span>
                    <CheckIcon className={cn("shrink-0", value === b.name ? "opacity-100" : "opacity-0")} />
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {refs && refs.remoteBranches.length > 0 && (
              <CommandGroup heading="Remote branches">
                {refs.remoteBranches.map((b) => (
                  <CommandItem key={b.name} value={`remote ${b.name}`} onSelect={() => pick(b.name)}>
                    <CloudIcon />
                    <span className="truncate">{b.name}</span>
                    <CheckIcon className={cn("ml-auto shrink-0", value === b.name ? "opacity-100" : "opacity-0")} />
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {refs && refs.tags.length > 0 && (
              <CommandGroup heading="Tags">
                {refs.tags.map((t) => (
                  <CommandItem key={t.name} value={`tag ${t.name}`} onSelect={() => pick(t.name)}>
                    <TagIcon />
                    <span className="truncate">{t.name}</span>
                    <CheckIcon className={cn("ml-auto shrink-0", value === t.name ? "opacity-100" : "opacity-0")} />
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {refs && refs.commits.length > 0 && (
              <CommandGroup heading="Recent commits">
                {refs.commits.slice(0, MAX_COMMITS_SHOWN).map((c) => (
                  <CommandItem
                    key={c.sha}
                    value={`commit ${c.sha} ${c.subject} ${c.author}`}
                    onSelect={() => pick(c.shortSha)}
                    className="items-start"
                  >
                    <GitCommitHorizontalIcon className="mt-0.5" />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{c.subject}</span>
                      <span className="text-muted-foreground text-xs">
                        <code>{c.shortSha}</code> · {c.author} · {relativeDate(c.date)}
                      </span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
