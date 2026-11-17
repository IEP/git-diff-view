// The commit graph above the diff, like the web app's:
//   click a commit        → that commit alone (pinned), against its first parent
//   shift / cmd-click      → a range from the last clicked commit
//   drag the A / B handle  → move that end of the comparison (Esc cancels)
//   keys: ↑ ↓ PgUp PgDn Home End, Enter (Shift+Enter: range), A / B move an end
// The working tree is a row on top of HEAD, so it can be picked like any commit.
import { div, PathBuilder } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { commitsInRange, isPseudoRev, layoutGraph, PSEUDO_LABEL, WORKTREE } from "./core.js";
import { alpha, button, laneColor, mono, relativeDate } from "./ui.js";

const ROW_H = 26;
const LANE_W = 14;
const MAX_LANES = 24;
const MID = ROW_H / 2;
const x = (col) => col * LANE_W + LANE_W / 2;

/** Laid-out rows, the working tree first; rebuilt when history or the uncommitted count changes. */
export function graphRows(view) {
  const g = view.graph;
  if (!g) return null;
  const parent = view.info?.headSha ?? null;
  const files = view.info?.uncommitted ?? 0;
  const c = view.graphCache;
  if (c && c.graph === g && c.parent === parent && c.files === files) return c;
  const commits = parent
    ? [{ sha: WORKTREE, shortSha: "", parents: [parent], refs: [], subject: files === 0 ? "No uncommitted changes" : `Uncommitted changes · ${files} file${files === 1 ? "" : "s"}`, author: "", date: "" }, ...g.commits]
    : g.commits;
  const rows = layoutGraph(commits);
  view.graphCache = {
    graph: g,
    parent,
    files,
    commits,
    rows,
    lanes: Math.min(Math.max(1, ...rows.map((r) => r.width)), MAX_LANES),
    indexOf: new Map(rows.map((r, i) => [r.commit.sha, i])),
  };
  return view.graphCache;
}

/** A pick on a branch tip becomes the branch's name, so the comparison follows new commits. */
function nameFor(view, sha) {
  const data = graphRows(view);
  const refs = data?.rows[data.indexOf.get(sha) ?? -1]?.commit.refs ?? [];
  const branches = refs.filter((r) => r.kind === "branch").map((r) => r.name);
  const current = view.info?.currentBranch;
  if (current && branches.includes(current)) return current;
  return branches[0] ?? (refs.some((r) => r.kind === "head") ? "HEAD" : undefined) ?? refs.find((r) => r.kind === "remote")?.name ?? refs.find((r) => r.kind === "tag")?.name ?? sha;
}

function compareCommits(view, cx, a, b, pin = false) {
  view.marked = { base: a, head: b };
  view.choose(cx, pin ? a : nameFor(view, a), pin ? b : nameFor(view, b));
}

/** One commit against its first parent, like `git show`. */
function show(view, cx, c) {
  const ui = view.graphUI;
  ui.anchor = c.sha;
  if (isPseudoRev(c.sha)) {
    ui.notice = null;
    return compareCommits(view, cx, c.parents[0], c.sha);
  }
  const parent = c.parents[0];
  if (!parent) {
    ui.notice = `${c.shortSha} is a root commit with no parent. Drag a handle onto it, or shift-click another commit.`;
    return cx.notify();
  }
  ui.notice = null;
  compareCommits(view, cx, parent, c.sha, true);
}

/** Range from the anchor to `c`; whichever sits lower in the list (older) is A. */
function span(view, cx, c) {
  const data = graphRows(view);
  const other = view.graphUI.anchor ?? view.marked.head;
  if (!other || other === c.sha) return show(view, cx, c);
  view.graphUI.notice = null;
  const otherIndex = isPseudoRev(other) ? -1 : (data.indexOf.get(other) ?? Infinity);
  const [base, head] = otherIndex > (data.indexOf.get(c.sha) ?? 0) ? [other, c.sha] : [c.sha, other];
  compareCommits(view, cx, base, head);
}

/** Move one end of the comparison to `c`. */
function moveEnd(view, cx, end, c) {
  const [base, head] = end === "A" ? [c.sha, view.marked.head] : [view.marked.base, c.sha];
  if (!base || !head || base === head) return;
  view.graphUI.notice = null;
  compareCommits(view, cx, base, head);
}

export function finishDrag(view, cx, commit) {
  const ui = view.graphUI;
  const d = ui.drag;
  ui.drag = null;
  const c = graphRows(view)?.rows[d?.index ?? -1]?.commit;
  if (commit && d && c) moveEnd(view, cx, d.end, c);
  cx.notify();
}

function focusRow(view, cx, i) {
  const data = graphRows(view);
  if (!data) return;
  const ui = view.graphUI;
  ui.focused = Math.min(Math.max(i, 0), data.rows.length - 1);
  reveal(view, ui.focused);
  cx.notify();
}

// The graph scrolls itself: rows that know where the pointer is need ordinary elements,
// and a virtual list's rows can register no handlers.
const viewport = (view) => Math.max(ROW_H, view.graphHeight - 30);
const contentHeight = (view) => {
  const data = graphRows(view);
  return data ? (data.rows.length + (view.graph?.truncated ? 1 : 0)) * ROW_H : 0;
};

function scrollTo(view, offset) {
  const ui = view.graphUI;
  ui.offset = Math.min(Math.max(0, offset), Math.max(0, contentHeight(view) - viewport(view)));
}

/** Scroll the least needed for row `i` to show, or put it in the middle. */
function reveal(view, i, center = false) {
  const ui = view.graphUI;
  const top = i * ROW_H;
  const h = viewport(view);
  if (center) scrollTo(view, top - h / 2 + ROW_H / 2);
  else if (top < ui.offset) scrollTo(view, top);
  else if (top + ROW_H > ui.offset + h) scrollTo(view, top + ROW_H - h);
}

/** The row under a pointer at `y` inside the list. */
const rowAt = (view, y) => Math.floor((y + view.graphUI.offset) / ROW_H);

export function graphKeys(view, e, cx) {
  const data = graphRows(view);
  if (!data) return false;
  const ui = view.graphUI;
  const c = data.rows[ui.focused]?.commit;
  switch (e.key) {
    case "down":
      focusRow(view, cx, ui.focused + 1);
      return true;
    case "up":
      focusRow(view, cx, ui.focused - 1);
      return true;
    case "pagedown":
      focusRow(view, cx, ui.focused + 20);
      return true;
    case "pageup":
      focusRow(view, cx, ui.focused - 20);
      return true;
    case "home":
      focusRow(view, cx, 0);
      return true;
    case "end":
      focusRow(view, cx, data.rows.length - 1);
      return true;
    case "enter":
      if (c) (e.modifiers.shift ? span : show)(view, cx, c);
      return true;
    case "a":
      if (c) moveEnd(view, cx, "A", c);
      return true;
    case "b":
      if (c) moveEnd(view, cx, "B", c);
      return true;
    case "escape":
      if (!ui.notice) return false;
      ui.notice = null;
      cx.notify();
      return true;
    default:
      return false;
  }
}

export function renderGraph(view, t) {
  const ui = view.graphUI;
  const data = graphRows(view);
  const bar = h_flex().h(30).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border).bg(t.chrome).text_size(11).text_color(t.dim);
  if (!data) {
    return v_flex().size_full().child(bar.child(div().child(view.graphError ?? "Loading history…")).child(div().flex_1()).child(hide(view, t)));
  }
  const { rows, lanes, indexOf } = data;

  // Bring the current head into view once, when history first arrives.
  if (!ui.scrolled && view.marked.head) {
    const i = indexOf.get(view.marked.head);
    if (i !== undefined) {
      ui.scrolled = true;
      ui.focused = i;
      reveal(view, i, true);
    }
  }

  const drag = ui.drag;
  const aSha = drag?.end === "A" ? (rows[drag.index]?.commit.sha ?? view.marked.base) : view.marked.base;
  const bSha = drag?.end === "B" ? (rows[drag.index]?.commit.sha ?? view.marked.head) : view.marked.head;
  const rangeKey = `${aSha}..${bSha}`;
  if (data.rangeKey !== rangeKey) {
    data.rangeKey = rangeKey;
    data.range = commitsInRange(data.commits, aSha, bSha);
  }
  const shortOf = (sha) => (isPseudoRev(sha) ? PSEUDO_LABEL[sha] : (rows[indexOf.get(sha) ?? -1]?.commit.shortSha ?? sha?.slice(0, 7)));

  const dragged = drag ? rows[drag.index]?.commit : null;
  const status = dragged
    ? h_flex().gap(6).items_center().min_w(0).child(badge(t, drag.end)).child(div().text_color(t.foreground).child("→")).child(div().font_family(mono()).child(dragged.shortSha || PSEUDO_LABEL[dragged.sha] || "")).child(div().truncate().child(dragged.subject))
    : ui.notice
      ? div().truncate().text_color(t.ansi3).child(ui.notice)
      : h_flex().gap(6).items_center().min_w(0)
        .child(div().whitespace_nowrap().child("Click a commit to view it · drag"))
        .child(badge(t, "A")).child(div().child("/")).child(badge(t, "B"))
        .child(div().truncate().child("to move an end · Shift-click for a range"));

  const total = rows.length + (view.graph.truncated ? 1 : 0);
  return v_flex()
    .id("graph")
    .size_full()
    .track_focus(ui.handle)
    .child(bar
      .child(div().font_semibold().text_color(t.muted).child("History"))
      .when(Boolean(aSha && bSha), (e) => e.child(h_flex().gap(4).items_center().font_family(mono())
        .child(badge(t, "A")).child(div().child(shortOf(aSha) ?? "")).child(div().child("→")).child(badge(t, "B")).child(div().child(shortOf(bSha) ?? ""))))
      .child(div().flex_1().min_w(0).child(status))
      .child(hide(view, t)))
    .child(rowsWindow(view, t, data, aSha, bSha));
}

function rowsWindow(view, t, data, aSha, bSha) {
  const ui = view.graphUI;
  const { rows, lanes } = data;
  const h = viewport(view);
  const total = contentHeight(view);
  scrollTo(view, ui.offset ?? 0); // the panel or history may have shrunk
  const first = Math.floor(ui.offset / ROW_H);
  const last = Math.min(rows.length + (view.graph.truncated ? 1 : 0), first + Math.ceil(h / ROW_H) + 1);
  const shown = [];
  for (let i = first; i < last; i++) shown.push(i < rows.length ? graphRow(view, t, rows[i], i, lanes, aSha, bSha, data.range) : moreRow(view, t));
  const thumb = total > h ? Math.max(24, (h * h) / total) : 0;
  return div()
    .id("graph-rows")
    .flex_1()
    .min_h(0)
    .relative()
    .overflow_hidden()
    .when(Boolean(ui.drag), (e) => e.cursor_grabbing())
    .on_scroll_wheel((e, cx) => {
      scrollTo(view, ui.offset - e.delta.y);
      cx.notify();
    })
    .on_mouse_move((e, cx) => {
      if (!ui.drag || !e.local_position) return;
      const y = e.local_position.y;
      // Near an edge while dragging: keep scrolling so far-away commits can be reached.
      if (y < ROW_H) scrollTo(view, ui.offset - ROW_H / 2);
      else if (y > h - ROW_H) scrollTo(view, ui.offset + ROW_H / 2);
      const i = Math.min(Math.max(rowAt(view, Math.min(Math.max(y, 0), h - 1)), 0), rows.length - 1);
      if (i !== ui.drag.index || y < ROW_H || y > h - ROW_H) {
        ui.drag.index = i;
        cx.notify();
      }
    })
    .child(v_flex().absolute().left(0).right(0).top(first * ROW_H - ui.offset).children(shown))
    .when(thumb > 0, (e) => e.child(div().absolute().right(2).w(6).rounded(3).bg(t.border)
      .top((ui.offset / Math.max(1, total - h)) * (h - thumb)).h(thumb)));
}

function hide(view, t) {
  return button(t, { id: "graph-hide", glyph: "close", tip: "Hide the commit graph", size: 22, on: (_e, cx) => view.setPref(cx, "showGraph", false) });
}

function moreRow(view, t) {
  return h_flex().id("graph-more").h(ROW_H).px(12).items_center().text_size(12).text_color(t.accent).cursor_pointer().hover((s) => s.bg(t.hover))
    .on_click((_e, cx) => {
      view.graphLimit += 500;
      view.loadGraph(cx);
    })
    .child("Load more history");
}

const BADGE = { A: "#3b82f6", B: "#10b981" };

function badge(t, end) {
  return div().w(16).h(16).flex_none().flex().items_center().justify_center().rounded(4).bg(BADGE[end]).text_color("#ffffff").text_size(10).font_semibold().child(end);
}

/** The lanes for one row: through lines, arrivals from children, edges to parents, and the dot. */
function lanesCell(t, row, lanes, isWorktree) {
  const cell = div().w(lanes * LANE_W).h(ROW_H).flex_none().relative();
  const parts = [];
  for (const s of row.segments) {
    if (s.from >= lanes && s.to >= lanes) continue;
    const from = Math.min(s.from, lanes - 1);
    const to = Math.min(s.to, lanes - 1);
    let p = PathBuilder.stroke(1.6);
    if (s.kind === "through") p = p.move_to(x(from), 0).line_to(x(from), ROW_H);
    else if (s.kind === "in") p = from === to ? p.move_to(x(from), 0).line_to(x(to), MID) : p.move_to(x(from), 0).curve_to(x(to), MID, x(from), MID);
    else p = from === to ? p.move_to(x(from), MID).line_to(x(to), ROW_H) : p.move_to(x(from), MID).curve_to(x(to), ROW_H, x(to), MID);
    if (isWorktree) p = p.dash_array([3, 3]);
    parts.push(window.paint_path(p.build(), laneColor(s.color)).absolute().top(0).left(0).size_full());
  }
  const color = laneColor(row.color);
  const dot = div().absolute().left(x(Math.min(row.column, lanes - 1)) - 4.5).top(MID - 4.5).w(9).h(9).rounded_full();
  parts.push(isWorktree ? dot.border_1().border_dashed().border_color(color).bg(t.background) : dot.bg(color).border_1().border_color(t.background));
  return cell.children(parts);
}

function refBadge(t, r) {
  const color = r.kind === "head" ? t.accent : r.kind === "branch" ? t.ansi2 : r.kind === "remote" ? t.ansi4 : t.ansi3;
  return div().px(5).h(16).flex_none().flex().items_center().rounded(4).border_1().border_color(alpha(color, "66")).bg(alpha(color, "1a")).text_color(color).text_size(10).whitespace_nowrap().child(r.name);
}

function graphRow(view, t, row, i, lanes, aSha, bSha, range) {
  const ui = view.graphUI;
  const c = row.commit;
  const isWorktree = c.sha === WORKTREE;
  const isA = c.sha === aSha;
  const isB = c.sha === bSha;
  const inRange = range.has(c.sha);
  const grabbed = ui.drag?.index === i;
  const focusedRow = ui.focused === i && ui.handle.is_focused();
  const handle = (end) =>
    div().id(`h-${end}-${c.sha}`).cursor_grab().on_mouse_down("left", (_e, cx) => {
      ui.drag = { end, index: i };
      ui.handle.focus();
      cx.stop_propagation();
      cx.notify();
    }).child(badge(t, end));
  return h_flex()
    .id(`gr-${c.sha}`)
    .h(ROW_H)
    .w_full()
    .pr(10)
    .gap(8)
    .items_center()
    .text_size(12)
    .cursor_pointer()
    .when(inRange, (e) => e.bg(alpha(t.accent, "14")))
    .when(isA || isB, (e) => e.bg(alpha(t.accent, "26")))
    .when(grabbed, (e) => e.bg(alpha(t.accent, "40")))
    .when(focusedRow, (e) => e.border_1().border_color(t.accent))
    .hover((s) => s.bg(t.hover))
    .on_click((e, cx) => {
      if (ui.drag) return;
      ui.focused = i;
      ui.handle.focus();
      (e.modifiers.shift || e.modifiers.platform || e.modifiers.control ? span : show)(view, cx, c);
    })
    .child(h_flex().w(40).flex_none().pl(4).gap(2).items_center()
      .when(isA, (e) => e.child(handle("A")))
      .when(isB, (e) => e.child(handle("B"))))
    .child(lanesCell(t, row, lanes, isWorktree))
    .child(h_flex().flex_1().min_w(0).gap(4).items_center()
      .children(c.refs.map((r) => refBadge(t, r)))
      .child(div().flex_1().min_w(0).truncate().when(isWorktree, (e) => e.italic().text_color(t.muted)).child(c.subject)))
    .child(div().w(120).flex_none().truncate().text_size(11).text_color(t.dim).child(c.author))
    .child(div().w(72).flex_none().text_size(11).text_color(t.dim).child(c.date ? relativeDate(c.date) : ""))
    .child(div().w(60).flex_none().font_family(mono()).text_size(11).text_color(t.dim).child(c.shortSha));
}
