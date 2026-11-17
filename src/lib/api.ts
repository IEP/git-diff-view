import { useEffect, useRef, useState } from "react";
import type {
  ApiErrorBody,
  CompareResponse,
  FileDiffResponse,
  GraphResponse,
  PullResolved,
  PullsResponse,
  RefsResponse,
  RepoInfo,
} from "@/shared/api";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function get<T>(path: string, params: Record<string, string | null | undefined>, signal: AbortSignal): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null) qs.set(k, v);
  const res = await fetch(qs.size ? `${path}?${qs}` : path, { signal });
  const body = await res.json();
  if (!res.ok) {
    const err = body as ApiErrorBody;
    throw new ApiError(err.error ?? "Error", err.message ?? res.statusText);
  }
  return body as T;
}

export const api = {
  repo: (signal: AbortSignal) => get<RepoInfo>("/api/repo", {}, signal),
  refs: (signal: AbortSignal) => get<RefsResponse>("/api/refs", {}, signal),
  graph: (limit: number, signal: AbortSignal) => get<GraphResponse>("/api/graph", { limit: String(limit) }, signal),
  compare: (base: string, head: string, signal: AbortSignal) =>
    get<CompareResponse>("/api/compare", { base, head }, signal),
  file: (base: string, head: string, path: string, oldPath: string | null, signal: AbortSignal) =>
    get<FileDiffResponse>("/api/file", { base, head, path, oldPath }, signal),
  pulls: (signal: AbortSignal) => get<PullsResponse>("/api/pulls", {}, signal),
  pull: (number: number, signal: AbortSignal) => get<PullResolved>("/api/pull", { number: String(number) }, signal),
};

export type AsyncState<T> =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "success"; readonly data: T }
  | { readonly status: "error"; readonly error: Error };

/**
 * Minimal fetch hook: re-runs when `deps` change, aborts the stale request,
 * and stays idle while `load` is null.
 */
export function useAsync<T>(
  load: ((signal: AbortSignal) => Promise<T>) | null,
  deps: ReadonlyArray<unknown>,
): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ status: load ? "loading" : "idle" });

  useEffect(() => {
    if (!load) {
      setState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setState({ status: "loading" });
    load(controller.signal).then(
      (data) => !controller.signal.aborted && setState({ status: "success", data }),
      (error: Error) => !controller.signal.aborted && setState({ status: "error", error }),
    );
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}

/**
 * `useAsync` for data that is re-read under the same `key` (polling, reload):
 * - the last result for `key` stays on screen while the next one loads;
 * - a reload that returns equal data keeps the old object, so nothing re-renders;
 * - right after `key` changes, the previous key's result is never shown (`useAsync`
 *   still holds it for one render), so callers see `data: null` and a loader.
 */
export function useHeldAsync<T>(
  key: string,
  load: ((signal: AbortSignal) => Promise<T>) | null,
  deps: ReadonlyArray<unknown>,
): { readonly state: AsyncState<unknown>; readonly data: T | null } {
  const state = useAsync(
    load ? (s) => load(s).then((data) => ({ key, data, json: JSON.stringify(data) })) : null,
    deps,
  );
  const held = useRef<{ key: string; data: T; json: string } | null>(null);
  const seen = useRef<unknown>(null);
  if (state.status === "success" && state.data !== seen.current) {
    seen.current = state.data;
    const h = held.current;
    if (!h || h.key !== state.data.key || h.json !== state.data.json) held.current = state.data;
  }
  const data = state.status !== "error" && held.current?.key === key ? held.current.data : null;
  return { state, data };
}
