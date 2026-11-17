// "Search changes" (⌘⇧F): a literal, case-insensitive substring over the added and
// removed lines of the whole comparison, in place of the file tree. ↑ ↓ / Enter or a
// click jump to the line; Esc clears, then closes.
import { div } from "gpui-kit";
import { v_flex, h_flex, Input, v_virtual_list, Scrollbar } from "gpui-base";
import { MAX_HITS, splitMatches } from "./core.js";
import { alpha, button, icon, mono, fill, safeRows } from "./ui.js";

const ROW_H = 24;

/** Hits grouped under a row per file. */
function items(view) {
  const s = view.searchState;
  const r = s.result;
  if (!r) return [];
  if (s.items?.result === r) return s.items.list;
  const list = [];
  let path = null;
  r.hits.forEach((hit, i) => {
    if (hit.path !== path) {
      path = hit.path;
      list.push({ kind: "file", path });
    }
    list.push({ kind: "hit", hit, i });
  });
  s.items = { result: r, list };
  return list;
}

export function searchKeys(view, e, cx) {
  const s = view.searchState;
  const hits = s.result?.hits ?? [];
  const move = (i) => {
    if (!hits.length) return;
    s.cursor = Math.min(Math.max(i, 0), hits.length - 1);
    const at = items(view).findIndex((it) => it.kind === "hit" && it.i === s.cursor);
    if (at >= 0) s.scroll.scroll_to_item(at);
    view.openHit(cx, hits[s.cursor]);
  };
  switch (e.key) {
    case "down":
      move(s.cursor + 1);
      return true;
    case "up":
      move(s.cursor - 1);
      return true;
    case "escape":
      if (s.query) {
        s.input.set_value("");
        s.query = "";
        s.settled = "";
        s.result = null;
      } else view.toggleSearch(cx, false);
      cx.notify();
      return true;
    default:
      return false;
  }
}

export function renderSearch(view, t) {
  const s = view.searchState;
  const list = items(view);
  const r = s.result;
  let summary = "Type to search the added and removed lines";
  if (s.error) summary = s.error;
  else if (s.busy) summary = "Searching…";
  else if (r) summary = r.total === 0 ? "No matches" : r.total > r.hits.length ? `First ${MAX_HITS} of ${r.total} matches` : `${r.total} match${r.total === 1 ? "" : "es"}`;
  return v_flex()
    .id("search")
    .size_full()
    .child(h_flex().h(36).flex_none().px(8).gap(6).items_center().border_b(1).border_color(t.border)
      .child(div().id("search-box").flex_1().min_w(0).h(26).px(8).flex().items_center().rounded(6).border_1().border_color(t.accent).bg(t.background)
        .child(icon("search", 12, t.dim)).child(Input.new(s.input).flex_1().h_full().ml(6).text_size(12)))
      .child(button(t, { id: "search-close", glyph: "close", tip: "Close search (Esc)", size: 24, on: (_e, cx) => view.toggleSearch(cx, false) })))
    .child(div().px(10).py(5).flex_none().text_size(11).text_color(s.error ? t.ansi1 : t.dim).child(summary))
    .when(Boolean(r?.partial), (e) => e.child(div().px(10).pb(5).text_size(11).text_color(t.ansi3).child("The comparison is too large to search completely; some files are left out.")))
    .child(div().flex_1().min_h(0).relative()
      .child(fill(v_virtual_list("search-hits", list.length, ROW_H, (i) => (list[i].kind === "file" ? `f:${list[i].path}` : `h:${list[i].i}`), safeRows((range) =>
        list.slice(range.start, range.end).map((it) => (it.kind === "file" ? fileRow(t, it.path) : hitRow(view, t, it))))).track_scroll(s.scroll).on_item_click((key, cx) => {
        if (!key.startsWith("h:")) return;
        const i = Number(key.slice(2));
        const hit = s.result?.hits[i];
        if (!hit) return;
        s.cursor = i;
        view.openHit(cx, hit);
      }).size_full()))
      .child(Scrollbar.vertical("search-hits").absolute().inset_0()));
}

function fileRow(t, path) {
  const parts = path.split("/");
  const name = parts.pop();
  return h_flex().h(ROW_H).px(10).gap(4).items_center().text_size(12).bg(t.surface)
    .child(div().font_semibold().whitespace_nowrap().child(name))
    .child(div().truncate().text_color(t.dim).text_size(11).child(parts.join("/")));
}

function hitRow(view, t, it) {
  const s = view.searchState;
  const { hit, i } = it;
  const active = s.cursor === i;
  const color = hit.side === "new" ? t.ansi2 : t.ansi1;
  const parts = splitMatches(hit.text.trim() || " ", s.settled);
  return h_flex()
    .id(`hit-${i}`)
    .h(ROW_H)
    .pl(14)
    .pr(8)
    .gap(8)
    .items_center()
    .font_family(mono())
    .text_size(11)
    .cursor_pointer()
    .when(active, (e) => e.bg(t.selected))
    .hover((st) => st.bg(t.hover))
    .child(div().w(46).flex_none().text_right().text_color(color).child(`${hit.side === "new" ? "+" : "−"}${hit.line}`))
    .child(h_flex().flex_1().min_w(0).overflow_hidden().whitespace_nowrap()
      .children(parts.map((p, k) => (k % 2 ? div().bg(alpha(t.ansi3, "66")).rounded(2).child(p) : div().whitespace_nowrap().child(p)))));
}
