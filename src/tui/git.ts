/**
 * The repository as the terminal viewer reads it: the server's own Git, GitHub and
 * DiffSearch services (same allow-listed git calls, working-tree checks, pull request
 * fetches and SQLite search index), run as promises.
 */
import { Effect, Layer, ManagedRuntime } from "effect";
import { DiffSearch } from "@/server/DiffIndex";
import { Git } from "@/server/Git";
import { GitHub } from "@/server/GitHub";

export type Repo = ReturnType<typeof openRepo>;

export function openRepo(root: string) {
  const runtime = ManagedRuntime.make(Layer.mergeAll(GitHub.layer, DiffSearch.layer).pipe(Layer.provideMerge(Git.layer(root))));
  const run = <A, E>(effect: Effect.Effect<A, E, Git | GitHub | DiffSearch>): Promise<A> =>
    // Reject with the typed failure itself (its message is what the screen shows).
    runtime.runPromise(effect.pipe(Effect.mapError((e) => (e instanceof Error ? e : new Error(String((e as { message?: string })?.message ?? e))))));
  return {
    info: () => run(Effect.gen(function* () { return yield* (yield* Git).info; })),
    refs: () => run(Effect.gen(function* () { return yield* (yield* Git).refs; })),
    compare: (base: string, head: string) => run(Effect.gen(function* () { return yield* (yield* Git).compare(base, head); })),
    fileDiff: (base: string, head: string, path: string, oldPath: string | null) =>
      run(Effect.gen(function* () { return yield* (yield* Git).fileDiff(base, head, path, oldPath); })),
    graph: (limit: number) => run(Effect.gen(function* () { return yield* (yield* Git).graph(limit); })),
    search: (base: string, head: string, query: string) => run(Effect.gen(function* () { return yield* (yield* DiffSearch).search(base, head, query); })),
    pulls: () => run(Effect.gen(function* () { return yield* (yield* GitHub).pulls; })),
    pull: (number: number) => run(Effect.gen(function* () { return yield* (yield* GitHub).pull(number); })),
    dispose: () => runtime.dispose(),
  };
}
