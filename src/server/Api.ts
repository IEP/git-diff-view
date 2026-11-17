import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { ApiErrorBody } from "@/shared/api";
import { DiffSearch } from "./DiffIndex";
import { Git } from "./Git";
import { GitHub } from "./GitHub";

const CompareParams = Schema.Struct({
  base: Schema.String,
  head: Schema.String,
});

const FileParams = Schema.Struct({
  base: Schema.String,
  head: Schema.String,
  path: Schema.String,
  oldPath: Schema.optional(Schema.String),
});

const SearchParams = Schema.Struct({
  base: Schema.String,
  head: Schema.String,
  // Literal text, not a pattern. Tabs are fine (pasted indentation); other control characters
  // and line breaks can't occur within one diff line.
  q: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200), Schema.isPattern(/^[^\x00-\x08\x0a-\x1f\x7f]*$/)),
});

const GraphParams = Schema.Struct({
  limit: Schema.optional(Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,4}$/))),
});

const PullParams = Schema.Struct({
  number: Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,8}$/)),
});

const errorResponse = (status: number, error: string, message: string) =>
  HttpServerResponse.json({ error, message } satisfies ApiErrorBody, { status });

/** Map every typed failure of a handler to a JSON error response. */
const handle = <A, E extends { readonly _tag: string; readonly message: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.flatMap((body) => HttpServerResponse.json(body)),
    Effect.catch((e: E | { readonly _tag: string; readonly message: string }) => {
      const status =
        e._tag === "InvalidRef" || e._tag === "SchemaError"
          ? 400
          : e._tag === "NotGitHub"
            ? 404
            : e._tag === "GitHubError"
              ? 502
              : 500;
      return errorResponse(status, e._tag, e.message);
    }),
    Effect.orDie,
  );

const Routes = Layer.mergeAll(
  HttpRouter.add(
    "GET",
    "/api/repo",
    handle(Effect.gen(function* () {
      const git = yield* Git;
      return yield* git.info;
    })),
  ),
  HttpRouter.add(
    "GET",
    "/api/refs",
    handle(Effect.gen(function* () {
      const git = yield* Git;
      return yield* git.refs;
    })),
  ),
  HttpRouter.add(
    "GET",
    "/api/graph",
    handle(
      Effect.gen(function* () {
        const git = yield* Git;
        const { limit } = yield* HttpServerRequest.schemaSearchParams(GraphParams);
        return yield* git.graph(limit ? Number(limit) : 500);
      }),
    ),
  ),
  HttpRouter.add(
    "GET",
    "/api/compare",
    handle(
      Effect.gen(function* () {
        const git = yield* Git;
        const { base, head } = yield* HttpServerRequest.schemaSearchParams(CompareParams);
        return yield* git.compare(base, head);
      }),
    ),
  ),
  HttpRouter.add(
    "GET",
    "/api/file",
    handle(
      Effect.gen(function* () {
        const git = yield* Git;
        const { base, head, path, oldPath } = yield* HttpServerRequest.schemaSearchParams(FileParams);
        return yield* git.fileDiff(base, head, path, oldPath ?? null);
      }),
    ),
  ),
  HttpRouter.add(
    "GET",
    "/api/search",
    handle(
      Effect.gen(function* () {
        const search = yield* DiffSearch;
        const { base, head, q } = yield* HttpServerRequest.schemaSearchParams(SearchParams);
        return yield* search.search(base, head, q);
      }),
    ),
  ),
  HttpRouter.add(
    "GET",
    "/api/pulls",
    handle(Effect.gen(function* () {
      const github = yield* GitHub;
      return yield* github.pulls;
    })),
  ),
  HttpRouter.add(
    "GET",
    "/api/pull",
    handle(
      Effect.gen(function* () {
        const github = yield* GitHub;
        const { number } = yield* HttpServerRequest.schemaSearchParams(PullParams);
        return yield* github.pull(Number(number));
      }),
    ),
  ),
  // Read-only API: anything else under /api is a 404 (never a fallthrough to the SPA).
  HttpRouter.add("*", "/api/*", errorResponse(404, "NotFound", "No such endpoint").pipe(Effect.orDie)),
);

/**
 * Build the fetch-style handler for the API. Bun.serve mounts it under `/api/*`;
 * the Git layer is built once, so a bad repo path fails at startup.
 */
export const makeApiHandler = (repoPath: string) =>
  HttpRouter.toWebHandler(
    Routes.pipe(
      Layer.provideMerge(GitHub.layer),
      Layer.provideMerge(DiffSearch.layer),
      Layer.provideMerge(Git.layer(repoPath)),
      Layer.provide(HttpServer.layerServices),
    ),
    { disableLogger: true },
  );
