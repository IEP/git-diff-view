// Small shared pieces: icons, buttons, colors, formatting.
import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { settings } from "herdr";

export const ICON = (name) => `mods/git-diff/icons/${name}.svg`;

export function icon(name, size = 14, color) {
  const el = svg(ICON(name)).size(size).flex_none();
  return color ? el.text_color(color) : el;
}

export const mono = () => settings().font_family ?? "JetBrains Mono";

/** An icon (and optional label) button. `active` draws it pressed; `disabled` dims it and ignores clicks. */
export function button(t, { id, glyph, label, tip, on, active = false, disabled = false, size = 28 }) {
  let el = h_flex()
    .id(id)
    .h(size)
    .when(!label, (e) => e.w(size).justify_center())
    .when(Boolean(label), (e) => e.px(8).gap(6))
    .flex_none()
    .items_center()
    .rounded(6)
    .text_size(12)
    .text_color(disabled ? t.dim : active ? t.foreground : t.muted)
    .when(active, (e) => e.bg(t.selected))
    .when(!disabled, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)))
    .when(Boolean(glyph), (e) => e.child(icon(glyph, 14)))
    .when(Boolean(label), (e) => e.child(div().whitespace_nowrap().child(label)));
  if (tip) el = el.tooltip(tip);
  if (on && !disabled) el = el.on_click((e, cx) => on(e, cx));
  return el;
}

/** A labelled toggle in an outlined group, like the web header's. */
export function outlined(t, el) {
  return el.border_1().border_color(t.border);
}

export function separator(t) {
  return div().w(1).h(18).mx(4).bg(t.border).flex_none();
}

// Change status → letter, label and color.
export function statusStyle(t, status) {
  switch (status) {
    case "added":
      return { letter: "A", label: "Added", color: t.ansi2 };
    case "deleted":
      return { letter: "D", label: "Deleted", color: t.ansi1 };
    case "renamed":
      return { letter: "R", label: "Renamed", color: t.ansi5 };
    case "copied":
      return { letter: "C", label: "Copied", color: t.ansi5 };
    case "typechange":
      return { letter: "T", label: "Type changed", color: t.ansi3 };
    case "modified":
      return { letter: "M", label: "Modified", color: t.ansi4 };
    default:
      return { letter: "?", label: "Unknown", color: t.muted };
  }
}

// Commit graph lane colors (the web app's palette).
const LANES = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16"];
export const laneColor = (i) => LANES[i % LANES.length];

/** `2026-11-17T09:00:00+07:00` → "3h ago", "Nov 2", "Nov 2, 2024". */
export function relativeDate(iso) {
  const d = new Date(iso);
  const ms = Date.now() - d.getTime();
  if (Number.isNaN(ms)) return "";
  const min = Math.round(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  if (days < 7) return `${days}d ago`;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const same = d.getFullYear() === new Date().getFullYear();
  return `${months[d.getMonth()]} ${d.getDate()}${same ? "" : `, ${d.getFullYear()}`}`;
}

/** Alpha suffix for a `#rrggbb` theme color. */
export const alpha = (color, hex) => (typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color) ? color + hex : color);

export const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Text with case-insensitive matches of `query` highlighted. */
export function marked(t, parts, highlight) {
  if (parts.length === 1) return parts[0];
  return h_flex().children(parts.map((p, i) => (i % 2 ? div().bg(highlight).rounded(2).child(p) : div().child(p))));
}

/** A box with a definite size for a virtual list: a flex-only height can lay one out at zero. */
export const fill = (el) => div().absolute().inset_0().child(el);

/** A virtual list's row callback that shows its exception instead of drawing nothing. */
export const safeRows = (fn) => (range, cx) => {
  try {
    return fn(range, cx);
  } catch (e) {
    console.log(`[git-diff] row render failed: ${e?.stack ?? e}`);
    return [div().h(20).text_color("#ef4444").child(String(e?.message ?? e))];
  }
};
