// The selected file's diff: unified or side by side, with line numbers, expandable
// unchanged context between hunks, optional wrapping, and search matches marked.
import { div } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, Scrollbar } from "gpui-base";
import { findLine, findPair, splitMatches, untab } from "./core.js";
import { alpha, button, fill, icon, mono, statusStyle, safeRows } from "./ui.js";

const LINE_H = 20;
const GAP_H = 26;
const NUM_W = 44;
const FONT = 12;
const CHAR_W = FONT * 0.6; // monospace advance, close enough to size wrapped rows

export function renderDiff(view, t) {
  const f = view.selectedFile();
  if (!f) return center(t, view.compare?.files.length ? "Select a file in the tree to see its diff." : "No differences between these revisions.");
  return v_flex()
    .id("diff")
    .size_full()
    .child(fileHeader(view, t, f))
    .child(body(view, t, f));
}

function center(t, text, color) {
  return div().size_full().flex().items_center().justify_center().p(24).text_color(color ?? t.muted).child(text);
}

function fileHeader(view, t, f) {
  const s = statusStyle(t, f.status);
  const list = view.ordered ?? [];
  const i = list.findIndex((x) => x.path === f.path);
  return h_flex()
    .h(38)
    .flex_none()
    .px(10)
    .gap(8)
    .items_center()
    .border_b(1)
    .border_color(t.border)
    .child(div().px(5).rounded(4).border_1().border_color(t.border).text_size(11).font_family(mono()).text_color(s.color).tooltip(s.label).child(s.letter))
    .child(h_flex().min_w(0).gap(6).items_center().font_family(mono()).text_size(12)
      .when(Boolean(f.oldPath), (e) => e.child(div().truncate().text_color(t.dim).child(f.oldPath)).child(div().text_color(t.dim).child("→")))
      .child(div().truncate().font_semibold().child(f.path))
      .child(button(t, { id: "copy-path", glyph: "copy", tip: "Copy path", size: 22, on: (_e, cx) => cx.write_to_clipboard(f.path) })))
    .when(f.similarity !== null && f.status !== "modified", (e) => e.child(div().text_size(11).text_color(t.dim).whitespace_nowrap().child(`${f.similarity}% similar`)))
    .child(div().flex_1())
    .child(div().text_size(11).text_color(t.dim).whitespace_nowrap().child(`${i + 1} / ${list.length}`))
    .child(button(t, { id: "prev-file", glyph: "up", tip: "Previous file (Shift+F7)", size: 24, disabled: i <= 0, on: (_e, cx) => view.go(cx, -1) }))
    .child(button(t, { id: "next-file", glyph: "down", tip: "Next file (F7)", size: 24, disabled: i >= list.length - 1, on: (_e, cx) => view.go(cx, 1) }));
}

function body(view, t, f) {
  if (view.fileError) return center(t, view.fileError, t.ansi1);
  const file = view.file;
  if (!file || file.path !== f.path) return center(t, "Loading…");
  const d = file.data;
  if (d.binary) return center(t, "Binary file · no text diff");
  const built = view.rows();
  const rows = built.rows;
  if (!rows.length) {
    const notes = file.parsed.notes;
    return center(t, notes.length ? notes.join(" · ") : f.status === "renamed" ? "Renamed without changes" : "No text changes");
  }
  const split = view.mode === "split";
  const highlight = view.searchState.open ? view.searchState.settled : "";
  const jump = view.pendingJump;

  // A search hit asked for a line of this file: scroll there once its rows exist.
  if (jump && jump.path === f.path) {
    const at = split ? findPair(rows, jump.side, jump.line) : findLine(rows, jump.side, jump.line);
    if (at >= 0) view.diffScroll.scroll_to_item(at, "center");
    view.jumped = { ...jump, index: at };
    view.pendingJump = null;
  }
  const jumpedIndex = view.jumped?.path === f.path ? view.jumped.index : -1;

  // Text scrolls sideways inside each cell by one shared offset (wheel sideways or
  // Shift+wheel), so line numbers stay put and both halves of a split row move together.
  const paneW = Math.max(200, view.size.width - view.treeWidth - 8);
  const textW = split ? paneW / 2 - NUM_W - 20 : paneW - NUM_W * 2 - 30;
  const textCols = Math.max(10, Math.floor(textW / CHAR_W));
  if (view.diffXFor !== file.key) {
    view.diffXFor = file.key;
    view.diffX = 0;
  }
  let maxLen = 0;
  if (!view.wrap) for (const r of built.unified) if (r.t === "line" && r.line.text.length > maxLen) maxLen = untab(r.line.text).length;
  const maxX = view.wrap ? 0 : Math.max(0, maxLen * CHAR_W - textW + 24);
  view.diffX = Math.min(view.diffX ?? 0, maxX);

  const heightOf = (r) => {
    if (r.t === "gap") return GAP_H;
    if (r.t === "hunk") return LINE_H;
    if (!view.wrap) return LINE_H;
    const len = r.t === "line" ? untab(r.line.text).length : Math.max(untab(r.left?.text ?? "").length, untab(r.right?.text ?? "").length);
    return LINE_H * Math.max(1, Math.ceil(len / textCols));
  };
  const sizes = view.wrap ? rows.map(heightOf) : rows.map((r) => (r.t === "gap" ? GAP_H : LINE_H));
  const draw = (r, i) => {
    const hl = i === jumpedIndex;
    if (r.t === "hunk") return hunkRow(t, r.text);
    if (r.t === "gap") return gapRow(view, t, r);
    return split ? pairRow(view, t, r, highlight, hl, sizes[i]) : lineRow(view, t, r.line, highlight, hl, sizes[i]);
  };

  return div()
    .flex_1()
    .min_h(0)
    .relative()
    .font_family(mono())
    .text_size(FONT)
    .child(div().id("diff-content").size_full().relative()
      .on_mouse_down("left", (e, _cx) => {
        view.diffDownX = e.local_position?.x ?? 0;
      })
      .on_scroll_wheel((e, cx) => {
        const dx = Math.abs(e.delta.x) > Math.abs(e.delta.y) ? e.delta.x : e.modifiers.shift ? e.delta.y : 0;
        if (!dx || maxX === 0) return;
        view.diffX = Math.min(Math.max(0, view.diffX - dx), maxX);
        cx.notify();
      })
      .child(fill(v_virtual_list("diff-rows", rows.length, sizes, (i) => rowKey(rows[i], i), safeRows((range) =>
        rows.slice(range.start, range.end).map((r, k) => draw(r, range.start + k)))).track_scroll(view.diffScroll).on_item_click((key, cx) => {
        if (!key.startsWith("g")) return;
        const r = rows.find((x) => x.t === "gap" && `g${x.gap.key}` === key);
        if (r) view.setExpanded(cx, r.gap, gapZone(r, view.diffDownX ?? 0));
      }).size_full())))
    .when(maxX > 0, (e) => e.child(div().absolute().bottom(2).h(5).rounded(3).bg(t.border)
      .left(NUM_W * (split ? 1 : 2) + ((view.diffX / maxX) * Math.max(0, textW - Math.max(30, (textW * textW) / (textW + maxX)))))
      .w(Math.max(30, (textW * textW) / (textW + maxX)))))
    .child(Scrollbar.vertical("diff-rows").absolute().inset_0());
}

function rowKey(r, i) {
  if (r.t === "gap") return `g${r.gap.key}`;
  if (r.t === "hunk") return `h${i}`;
  if (r.t === "line") return `${r.line.kind}${r.line.old ?? ""}:${r.line.new ?? ""}`;
  return `p${r.left?.kind ?? ""}${r.left?.n ?? ""}:${r.right?.kind ?? ""}${r.right?.n ?? ""}`;
}

function hunkRow(t, text) {
  return div().w_full().h(LINE_H).px(12).flex().items_center().bg(alpha(t.accent, "14")).text_color(t.dim).whitespace_nowrap().child(text);
}

// Gap controls sit at fixed x positions: the list reports only which row was clicked,
// and the press position recorded on the content box says which control it was on.
const GAP_LABEL_W = 190;
const GAP_CONTROL_W = 96;

function gapZone(r, x) {
  if (r.hidden <= 20) return "all";
  const k = Math.floor((x - 8 - GAP_LABEL_W) / GAP_CONTROL_W);
  return k === 0 ? "down" : k === 1 ? "up" : "all";
}

function gapRow(view, t, r) {
  const small = r.hidden <= 20;
  const control = (glyph, label) =>
    h_flex().w(GAP_CONTROL_W).flex_none().h(20).px(8).gap(4).items_center().rounded(5).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .when(Boolean(glyph), (e) => e.child(icon(glyph, 12)))
      .child(div().text_size(11).whitespace_nowrap().child(label));
  return h_flex()
    .w_full()
    .h(GAP_H)
    .px(8)
    .items_center()
    .bg(t.surface)
    .border_t(1)
    .border_b(1)
    .border_color(t.border)
    .text_color(t.dim)
    .child(div().w(GAP_LABEL_W).flex_none().text_size(11).whitespace_nowrap().child(`${r.hidden} unchanged line${r.hidden === 1 ? "" : "s"}`))
    .when(!small, (e) => e.child(control("down", "20 more")).child(control("up", "20 more")))
    .child(control(null, small ? "Show" : "Show all"));
}

function lineColors(t, kind) {
  if (kind === "add") return { bg: alpha(t.ansi2, "1c"), num: alpha(t.ansi2, "2e"), sign: "+", signColor: t.ansi2 };
  if (kind === "del") return { bg: alpha(t.ansi1, "1c"), num: alpha(t.ansi1, "2e"), sign: "−", signColor: t.ansi1 };
  return { bg: null, num: null, sign: " ", signColor: t.dim };
}

function text(view, t, raw, highlight) {
  const s = untab(raw) || " ";
  const parts = highlight ? splitMatches(s, highlight) : [s];
  const content = parts.length === 1 ? s : h_flex().when(view.wrap, (e) => e.flex_wrap()).children(parts.map((p, i) => (i % 2 ? div().bg(alpha(t.ansi3, "66")).rounded(2).child(p) : div().whitespace_nowrap().child(p))));
  if (view.wrap) return div().flex_1().min_w(0).whitespace_normal().child(content);
  return div().flex_1().min_w(0).h_full().overflow_hidden().relative()
    .child(div().absolute().top(0).left(-(view.diffX ?? 0)).whitespace_nowrap().child(content));
}

function num(t, n, bg) {
  return div().w(NUM_W).flex_none().h_full().pr(8).text_right().text_color(t.dim).when(Boolean(bg), (e) => e.bg(bg)).child(n == null ? "" : String(n));
}

function lineRow(view, t, line, highlight, hl, h) {
  const c = lineColors(t, line.kind);
  return h_flex()
    .w_full()
    .h(h)
    .flex_none()
    .items_start()
    .when(Boolean(c.bg), (e) => e.bg(c.bg))
    .when(hl, (e) => e.border_1().border_color(t.accent))
    .child(num(t, line.old, c.num))
    .child(num(t, line.new, c.num))
    .child(div().w(16).flex_none().text_color(c.signColor).child(c.sign))
    .child(text(view, t, line.text, highlight));
}

function half(view, t, side, highlight) {
  if (!side) return h_flex().flex_1().min_w(0).h_full().bg(t.canvas).child(div().w(NUM_W).flex_none());
  const c = lineColors(t, side.kind);
  return h_flex()
    .flex_1()
    .min_w(0)
    .h_full()
    .items_start()
    .when(Boolean(c.bg), (e) => e.bg(c.bg))
    .child(num(t, side.n, c.num))
    .child(div().w(14).flex_none().text_color(c.signColor).child(c.sign))
    .child(text(view, t, side.text, highlight));
}

function pairRow(view, t, r, highlight, hl, h) {
  return h_flex()
    .w_full()
    .h(h)
    .flex_none()
    .items_stretch()
    .when(hl, (e) => e.border_1().border_color(t.accent))
    .child(half(view, t, r.left, highlight))
    .child(div().w(1).flex_none().bg(t.border))
    .child(half(view, t, r.right, highlight));
}
