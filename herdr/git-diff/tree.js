// The changed files as an IntelliJ-style tree: folders first, single-child chains
// compacted, a filter box, and keyboard navigation (↑ ↓ ← → Enter Home End).
import { div } from "gpui-kit";
import { v_flex, h_flex, Input, v_virtual_list, Scrollbar } from "gpui-base";
import { allDirPaths, buildTree, visibleRows } from "./core.js";
import { button, icon, statusStyle, fill, safeRows } from "./ui.js";

const ROW_H = 26;

function rowsOf(view) {
  const files = view.compare?.files ?? [];
  const q = view.tree.filter.trim().toLowerCase();
  const key = `${view.compareSig?.length}:${view.compare?.base.sha}:${view.compare?.head.sha}:${q}`;
  const cache = view.treeCache;
  if (cache?.key === key && cache.files === files && cache.collapsedVersion === view.tree.collapsedVersion) return cache;
  const shown = q ? files.filter((f) => f.path.toLowerCase().includes(q) || f.oldPath?.toLowerCase().includes(q)) : files;
  const root = buildTree(shown);
  // A filter opens every folder, so matches are never hidden.
  const rows = visibleRows(root, q ? new Set() : view.tree.collapsed);
  view.treeCache = { key, files, collapsedVersion: view.tree.collapsedVersion, root, rows, count: shown.length };
  return view.treeCache;
}

function toggle(view, cx, path, open) {
  const c = view.tree.collapsed;
  const isOpen = !c.has(path);
  if (open === isOpen) return;
  if (isOpen) c.add(path);
  else c.delete(path);
  view.tree.collapsedVersion = (view.tree.collapsedVersion ?? 0) + 1;
  cx.notify();
}

export function treeKeys(view, e, cx) {
  const { rows } = rowsOf(view);
  if (!rows.length) return false;
  const tree = view.tree;
  let i = rows.findIndex((r) => r.node.path === tree.cursor && (r.node.kind === "file") === tree.cursorIsFile);
  if (i < 0) i = Math.max(0, rows.findIndex((r) => r.node.kind === "file" && r.node.path === view.selected));
  const row = rows[i];
  const moveTo = (j) => {
    const r = rows[Math.min(Math.max(j, 0), rows.length - 1)];
    tree.cursor = r.node.path;
    tree.cursorIsFile = r.node.kind === "file";
    tree.scroll.scroll_to_item(rows.indexOf(r));
    if (r.node.kind === "file") view.select(cx, r.node.path);
    cx.notify();
  };
  switch (e.key) {
    case "down":
      moveTo(i + 1);
      return true;
    case "up":
      moveTo(i - 1);
      return true;
    case "home":
      moveTo(0);
      return true;
    case "end":
      moveTo(rows.length - 1);
      return true;
    case "right":
      if (row?.node.kind === "dir") {
        if (tree.collapsed.has(row.node.path)) toggle(view, cx, row.node.path, true);
        else moveTo(i + 1);
      }
      return true;
    case "left":
      if (row?.node.kind === "dir" && !tree.collapsed.has(row.node.path)) toggle(view, cx, row.node.path, false);
      else if (row?.parentKey) moveTo(rows.findIndex((r) => r.key === row.parentKey));
      return true;
    case "enter":
    case "space":
      if (row?.node.kind === "dir") toggle(view, cx, row.node.path, tree.collapsed.has(row.node.path));
      return true;
    default:
      return false;
  }
}

export function renderTree(view, t) {
  const tree = view.tree;
  const data = rowsOf(view);
  const { rows } = data;
  const total = view.compare.files.length;
  const add = view.compare.files.reduce((n, f) => n + f.additions, 0);
  const del = view.compare.files.reduce((n, f) => n + f.deletions, 0);

  // F7 / a search hit picked a file: open its folders and bring it into view.
  if (view.revealInTree) {
    const path = view.revealInTree;
    view.revealInTree = null;
    let opened = false;
    for (const d of [...tree.collapsed]) if (path.startsWith(d + "/")) {
      tree.collapsed.delete(d);
      opened = true;
    }
    if (opened) tree.collapsedVersion = (tree.collapsedVersion ?? 0) + 1;
    const i = rowsOf(view).rows.findIndex((r) => r.node.kind === "file" && r.node.path === path);
    if (i >= 0) tree.scroll.scroll_to_item(i, "center");
  }

  const fresh = rowsOf(view).rows;
  return v_flex()
    .id("tree")
    .size_full()
    .track_focus(tree.handle)
    .child(h_flex().h(36).flex_none().px(8).gap(6).items_center().border_b(1).border_color(t.border)
      .child(div().id("tree-filter").flex_1().min_w(0).h(26).px(8).flex().items_center().rounded(6).border_1().border_color(t.border).bg(t.background)
        .child(icon("search", 12, t.dim)).child(Input.new(tree.filterInput).flex_1().h_full().ml(6).text_size(12)))
      .child(button(t, { id: "tree-collapse", glyph: "collapse", tip: "Collapse all", size: 24, on: (_e, cx) => {
        for (const p of allDirPaths(data.root)) tree.collapsed.add(p);
        tree.collapsedVersion = (tree.collapsedVersion ?? 0) + 1;
        cx.notify();
      } }))
      .child(button(t, { id: "tree-expand", glyph: "expand", tip: "Expand all", size: 24, on: (_e, cx) => {
        tree.collapsed.clear();
        tree.collapsedVersion = (tree.collapsedVersion ?? 0) + 1;
        cx.notify();
      } })))
    .child(h_flex().h(26).flex_none().px(10).gap(8).items_center().text_size(11).text_color(t.dim)
      .child(div().child(tree.filter ? `${data.count} of ${total} files` : `${total} file${total === 1 ? "" : "s"} changed`))
      .child(div().flex_1())
      .child(div().text_color(t.ansi2).child(`+${add}`))
      .child(div().text_color(t.ansi1).child(`−${del}`)))
    .child(div().flex_1().min_h(0).relative()
      .when(fresh.length === 0, (e) => e.child(div().p(12).text_color(t.dim).text_size(12).child(total ? "No files match the filter" : "No differences")))
      .child(fill(v_virtual_list("tree-list", fresh.length, ROW_H, (i) => fresh[i].key, safeRows((range) =>
        fresh.slice(range.start, range.end).map((r) => treeRow(view, t, r)))).track_scroll(tree.scroll).on_item_click((key, cx) => {
        // Rows can't hold handlers; the list reports which row's key was clicked.
        const r = fresh.find((x) => x.key === key);
        if (!r) return;
        tree.cursor = r.node.path;
        tree.cursorIsFile = r.node.kind === "file";
        tree.handle.focus();
        if (r.node.kind === "dir") toggle(view, cx, r.node.path, tree.collapsed.has(r.node.path));
        else view.select(cx, r.node.path);
      }).size_full()))
      .child(Scrollbar.vertical("tree-list").absolute().inset_0()));
}

function treeRow(view, t, r) {
  const n = r.node;
  const tree = view.tree;
  const isCursor = tree.cursor === n.path && (n.kind === "file") === Boolean(tree.cursorIsFile) && tree.handle.is_focused();
  const base = h_flex()
    .id(`tr-${r.key}`)
    .h(ROW_H)
    .pl(8 + r.depth * 14)
    .pr(10)
    .gap(6)
    .items_center()
    .text_size(12)
    .cursor_pointer()
    .hover((s) => s.bg(t.hover))
    .when(isCursor, (e) => e.border_1().border_color(t.accent));
  if (n.kind === "dir") {
    const open = !tree.collapsed.has(n.path) || Boolean(tree.filter.trim());
    return base
      .child(icon(open ? "down" : "right", 12, t.dim))
      .child(icon("folder", 13, t.muted))
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(n.name))
      .child(div().text_size(11).text_color(t.dim).child(String(n.fileCount)));
  }
  const c = n.change;
  const s = statusStyle(t, c.status);
  const selected = view.selected === n.path;
  return base
    .when(selected, (e) => e.bg(t.selected))
    .child(div().w(12).flex_none())
    .child(div().w(12).flex_none().text_size(11).font_semibold().text_color(s.color).child(s.letter))
    .child(div().flex_1().min_w(0).truncate().when(c.status === "deleted", (e) => e.text_color(t.dim).line_through()).child(n.name))
    .when(c.binary, (e) => e.child(div().text_size(10).text_color(t.dim).child("bin")))
    .when(c.additions > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${c.additions}`)))
    .when(c.deletions > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${c.deletions}`)));
}
