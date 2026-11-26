/**
 * Styled text for the terminal: spans of text with a style, cut and padded to an exact
 * number of display columns. Repository text is untrusted, so every control character
 * is drawn as a visible symbol before it reaches the terminal (no escape injection).
 */

export interface Style {
  /** 256-colour index. */
  readonly fg?: number;
  readonly bg?: number;
  readonly bold?: boolean;
  readonly dim?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly reverse?: boolean;
}

export interface Span {
  readonly text: string;
  readonly style?: Style;
}

export const RESET = "\x1b[0m";

export function sgr(s: Style | undefined): string {
  if (!s) return "";
  const codes: Array<string | number> = [];
  if (s.bold) codes.push(1);
  if (s.dim) codes.push(2);
  if (s.italic) codes.push(3);
  if (s.underline) codes.push(4);
  if (s.reverse) codes.push(7);
  if (s.fg !== undefined) codes.push(`38;5;${s.fg}`);
  if (s.bg !== undefined) codes.push(`48;5;${s.bg}`);
  return codes.length ? `\x1b[${codes.join(";")}m` : "";
}

/** C0 controls, DEL and C1 controls, which a terminal could act on. */
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;
/** Controls (tab included: the diff expands tabs before this) as visible, inert text. */
export const clean = (text: string) =>
  text.replace(CONTROL, (c) => {
    const code = c.charCodeAt(0);
    return code < 0x20 ? String.fromCharCode(0x2400 + code) : code === 0x7f ? "␡" : "�";
  });

const segmenter = new Intl.Segmenter();
/** Display columns of already-clean text. */
export const width = (text: string) => Bun.stringWidth(text);

/**
 * Lay spans out in exactly `cols` columns, skipping the first `skip` columns (horizontal
 * scroll). The rest of the row is padded with `fill`'s style.
 */
export function fit(spans: ReadonlyArray<Span>, cols: number, fill?: Style, skip = 0): string {
  let out = "";
  let used = 0;
  let toSkip = skip;
  for (const span of spans) {
    if (used >= cols) break;
    let text = clean(span.text);
    if (toSkip > 0) {
      const w = width(text);
      if (w <= toSkip) {
        toSkip -= w;
        continue;
      }
      let cut = "";
      for (const { segment } of segmenter.segment(text)) {
        if (toSkip > 0) {
          const sw = width(segment);
          // A wide character cut in half becomes a space.
          if (sw > toSkip) cut += " ".repeat(sw - toSkip);
          toSkip = Math.max(0, toSkip - sw);
        } else cut += segment;
      }
      text = cut;
    }
    let w = width(text);
    if (used + w > cols) {
      let kept = "";
      let kw = 0;
      for (const { segment } of segmenter.segment(text)) {
        const sw = width(segment);
        if (used + kw + sw > cols) break;
        kept += segment;
        kw += sw;
      }
      text = kept;
      w = kw;
    }
    if (!text) continue;
    out += sgr(span.style) + text + RESET;
    used += w;
  }
  if (used < cols) out += sgr(fill) + " ".repeat(cols - used) + RESET;
  return out;
}

/** `text` cut to `cols` columns with an ellipsis when it doesn't fit. */
export function ellipsize(text: string, cols: number): string {
  const t = clean(text);
  if (width(t) <= cols) return t;
  if (cols <= 1) return cols === 1 ? "…" : "";
  let kept = "";
  let kw = 0;
  for (const { segment } of segmenter.segment(t)) {
    const sw = width(segment);
    if (kw + sw > cols - 1) break;
    kept += segment;
    kw += sw;
  }
  return kept + "…";
}

/** `text` cut from the left, keeping its end (paths: the file name matters most). */
export function ellipsizeStart(text: string, cols: number): string {
  const t = clean(text);
  if (width(t) <= cols) return t;
  if (cols <= 1) return cols === 1 ? "…" : "";
  const parts = [...segmenter.segment(t)].map((s) => s.segment);
  let kept = "";
  let kw = 0;
  for (let i = parts.length - 1; i >= 0; i--) {
    const sw = width(parts[i]!);
    if (kw + sw > cols - 1) break;
    kept = parts[i]! + kept;
    kw += sw;
  }
  return "…" + kept;
}
