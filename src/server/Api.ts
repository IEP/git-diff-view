import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import type { ApiErrorBody } from "@/shared/api";
import { Git } from "./Git";

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

const errorResponse = (status: number, error: string, message: string) =>
  HttpServerResponse.json({ error, message } satisfies ApiErrorBody, { status });

/** Map every typed failure of a handler to a JSON error response. */
const handle = <A, E extends { readonly _tag: string; readonly message: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.flatMap((body) => HttpServerResponse.json(body)),
    Effect.catch((e: E | { readonly _tag: string; readonly message: string }) => {
      const status = e._tag === "InvalidRef" || e._tag === "SchemaError" ? 400 : 500;
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
  // Read-only API: anything else under /api is a 404 (never a fallthrough to the SPA).
  HttpRouter.add("*", "/api/*", errorResponse(404, "NotFound", "No such endpoint").pipe(Effect.orDie)),
);

/**
 * Build the fetch-style handler for the API. Bun.serve mounts it under `/api/*`;
 * the Git layer is built once, so a bad repo path fails at startup.
 */
export const makeApiHandler = (repoPath: string) =>
  HttpRouter.toWebHandler(
    Routes.pipe(Layer.provideMerge(Git.layer(repoPath)), Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );
