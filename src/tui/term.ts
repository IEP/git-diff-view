/**
 * The terminal itself: raw mode, the alternate screen, key decoding, resize, and a
 * line-diffing painter. Everything else in the TUI is pure and never touches the TTY.
 */

export type Key = string;

/** Escape sequences → key names (xterm, VT220 and rxvt variants). */
const SEQUENCES: Record<string, Key> = {
  "\x1b[A": "up", "\x1b[B": "down", "\x1b[C": "right", "\x1b[D": "left",
  "\x1bOA": "up", "\x1bOB": "down", "\x1bOC": "right", "\x1bOD": "left",
  "\x1b[H": "home", "\x1b[F": "end", "\x1bOH": "home", "\x1bOF": "end",
  "\x1b[1~": "home", "\x1b[4~": "end", "\x1b[7~": "home", "\x1b[8~": "end",
  "\x1b[5~": "pageup", "\x1b[6~": "pagedown", "\x1b[3~": "delete", "\x1b[2~": "insert",
  "\x1b[Z": "shift+tab",
  "\x1b[18~": "f7", "\x1b[18;2~": "shift+f7",
  "\x1b[1;2A": "shift+up", "\x1b[1;2B": "shift+down", "\x1b[1;2C": "shift+right", "\x1b[1;2D": "shift+left",
  "\x1b[1;5C": "ctrl+right", "\x1b[1;5D": "ctrl+left", "\x1b[1;3C": "alt+right", "\x1b[1;3D": "alt+left",
};

/** Split raw input into key names. Unknown escape sequences are dropped whole. */
export function decodeKeys(input: string): Array<Key> {
  const keys: Array<Key> = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i]!;
    if (c === "\x1b") {
      // CSI: ESC [ params final; SS3: ESC O x; lone ESC: escape.
      if (input[i + 1] === "[") {
        let j = i + 2;
        while (j < input.length && !/[@-~]/.test(input[j]!)) j++;
        const seq = input.slice(i, j + 1);
        if (seq === "\x1b[200~") {
          // Bracketed paste: the text up to ESC[201~, as typed characters.
          const end = input.indexOf("\x1b[201~", j + 1);
          const text = input.slice(j + 1, end < 0 ? input.length : end);
          for (const ch of text.replace(/[\r\n\t]+/g, " ")) keys.push(ch);
          i = end < 0 ? input.length : end + 6;
          continue;
        }
        const name = SEQUENCES[seq];
        if (name) keys.push(name);
        i = j + 1;
      } else if (input[i + 1] === "O" && i + 2 < input.length) {
        const name = SEQUENCES[input.slice(i, i + 3)];
        if (name) keys.push(name);
        i += 3;
      } else if (i + 1 < input.length && input[i + 1] !== "\x1b") {
        keys.push(`alt+${input[i + 1]}`);
        i += 2;
      } else {
        keys.push("escape");
        i++;
      }
      continue;
    }
    const code = c.charCodeAt(0);
    if (c === "\r" || c === "\n") keys.push("enter");
    else if (c === "\t") keys.push("tab");
    else if (code === 0x7f || code === 0x08) keys.push("backspace");
    else if (code < 0x20) keys.push(`ctrl+${String.fromCharCode(code + 96)}`);
    else {
      const cp = input.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      keys.push(ch);
      i += ch.length;
      continue;
    }
    i++;
  }
  return keys;
}

export interface Terminal {
  readonly cols: number;
  readonly rows: number;
  /** Draw a full frame (one string per row), rewriting only rows that changed. */
  paint(lines: ReadonlyArray<string>): void;
  /** Forget what's on screen: the next paint redraws every row. */
  invalidate(): void;
  restore(): void;
}

export function openTerminal(handlers: { onKeys(keys: Array<Key>): void; onResize(): void }): Terminal {
  const out = process.stdout;
  const input = process.stdin;
  let shown: Array<string> = [];
  let restored = false;

  const restore = () => {
    if (restored) return;
    restored = true;
    out.write("\x1b[?2004l\x1b[?25h\x1b[0m\x1b[?1049l");
    try {
      input.setRawMode(false);
    } catch {
      /* stdin already closed */
    }
    input.pause();
  };

  input.setRawMode(true);
  input.setEncoding("utf8");
  input.resume();
  // Alternate screen, hidden cursor, bracketed paste.
  out.write("\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[2J");

  input.on("data", (data: string) => handlers.onKeys(decodeKeys(data)));
  out.on("resize", () => {
    shown = [];
    out.write("\x1b[2J");
    handlers.onResize();
  });

  return {
    get cols() {
      return out.columns || 80;
    },
    get rows() {
      return out.rows || 24;
    },
    paint(lines) {
      let buf = "";
      for (let r = 0; r < lines.length; r++) {
        if (shown[r] === lines[r]) continue;
        buf += `\x1b[${r + 1};1H${lines[r]}`;
      }
      shown = lines.slice();
      if (buf) out.write(buf);
    },
    invalidate() {
      shown = [];
    },
    restore,
  };
}
