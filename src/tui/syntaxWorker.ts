/**
 * Syntax highlighting off the main thread: a large file takes a while (about 1 ms per
 * KB), and the screen keeps responding meanwhile. Listed in build.ts's entrypoints so
 * the compiled binary carries it.
 */
import { highlightFile } from "./syntax";

declare const self: Worker;

export interface HighlightRequest {
  readonly id: number;
  readonly lang: string;
  readonly lines: ReadonlyArray<string>;
}

self.onmessage = (e: MessageEvent<HighlightRequest>) => {
  const { id, lang, lines } = e.data;
  let runs: ReturnType<typeof highlightFile> = null;
  try {
    runs = highlightFile(lang, lines);
  } catch {
    /* plain, then */
  }
  self.postMessage({ id, runs });
};
