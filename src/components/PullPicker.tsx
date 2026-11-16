import { useState } from "react";
import { CheckIcon, ChevronsUpDownIcon, GitPullRequestDraftIcon, GitPullRequestIcon, Loader2Icon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { AsyncState } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { PullsResponse } from "@/shared/api";
import { relativeDate } from "./RefPicker";

interface PullPickerProps {
  readonly pulls: AsyncState<PullsResponse>;
  /** The PR currently being compared, if any. */
  readonly value: number | null;
  readonly onChange: (pr: number | null) => void;
}

/** Choose an open GitHub pull request; the app then compares its merge-base with its head. */
export function PullPicker({ pulls, value, onChange }: PullPickerProps) {
  const [open, setOpen] = useState(false);
  const data = pulls.status === "success" ? pulls.data : null;
  const current = data?.pulls.find((p) => p.number === value);
  const Icon = current?.isDraft ? GitPullRequestDraftIcon : GitPullRequestIcon;

  const pick = (pr: number | null) => {
    onChange(pr);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant={value ? "secondary" : "outline"}
          role="combobox"
          aria-expanded={open}
          aria-label="GitHub pull request"
          className="h-8 max-w-[min(22rem,45vw)] justify-between gap-2 px-2.5 text-xs font-normal"
        >
          <span className="flex min-w-0 items-center gap-2">
            <Icon className="size-3.5 shrink-0 opacity-70" />
            {value ? (
              <span className="truncate">
                <span className="font-medium">#{value}</span>
                {current && <span className="text-muted-foreground"> {current.title}</span>}
              </span>
            ) : (
              <span>Pull requests{data ? ` (${data.pulls.length})` : ""}</span>
            )}
          </span>
          {pulls.status === "loading" ? (
            <Loader2Icon className="size-3.5 shrink-0 animate-spin opacity-50" />
          ) : (
            <ChevronsUpDownIcon className="size-3.5 shrink-0 opacity-50" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[30rem] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search open pull requests by title, number, author or branch…" />
          <CommandList className="max-h-[24rem]">
            {pulls.status === "error" ? (
              <div className="text-destructive p-4 text-sm">{pulls.error.message}</div>
            ) : pulls.status === "loading" ? (
              <div className="text-muted-foreground flex items-center gap-2 p-4 text-sm">
                <Loader2Icon className="size-4 animate-spin" /> Loading pull requests…
              </div>
            ) : (
              <CommandEmpty>No open pull requests.</CommandEmpty>
            )}
            {value !== null && (
              <CommandGroup>
                <CommandItem value={`stop comparing clear exit #${value}`} onSelect={() => pick(null)}>
                  <XIcon />
                  Stop comparing #{value}
                </CommandItem>
              </CommandGroup>
            )}
            {data && data.pulls.length > 0 && (
              <CommandGroup heading={`${data.github?.owner}/${data.github?.name} · open`}>
                {data.pulls.map((p) => {
                  const ItemIcon = p.isDraft ? GitPullRequestDraftIcon : GitPullRequestIcon;
                  return (
                    <CommandItem
                      key={p.number}
                      value={`#${p.number} ${p.title} ${p.author} ${p.headRef} ${p.baseRef}`}
                      onSelect={() => pick(p.number)}
                      className="items-start"
                    >
                      <ItemIcon className={cn("mt-0.5", p.isDraft ? "opacity-50" : "text-green-600 dark:text-green-500")} />
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate">
                          <span className="text-muted-foreground">#{p.number}</span> {p.title}
                        </span>
                        <span className="text-muted-foreground truncate text-xs">
                          {p.author} · <code>{p.baseRef}</code> ← <code>{p.isCrossRepository ? `fork:${p.headRef}` : p.headRef}</code>{" "}
                          · {relativeDate(p.updatedAt)}
                          {p.isDraft && " · draft"}
                        </span>
                      </div>
                      <CheckIcon className={cn("mt-0.5 shrink-0", value === p.number ? "opacity-100" : "opacity-0")} />
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
