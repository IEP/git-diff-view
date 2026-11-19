// Base / Head pickers (branches, remote branches, tags, recent commits, the working
// tree and the index, or any revision typed in) and the pull request picker.
// Drawn as a popover inside the mod's block; ↑ ↓ Enter pick, Esc closes.
import { div } from "gpui-kit";
import { v_flex, h_flex, Input, v_virtual_list, Scrollbar } from "gpui-base";
import { INDEX, isPseudoRev, PSEUDO_LABEL, WORKTREE } from "./core.js";
import { icon, mono, relativeDate, fill, safeRows } from "./ui.js";

const ROW_H = 28;
const HEAD_H = 24;
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** What a picker button shows for a revision: its label, with the resolved short id for names. */
export function refLabel(view, ref, sha) {
  if (!ref) return "";
  if (isPseudoRev(ref)) return PSEUDO_LABEL[ref];
  if (COMMIT_ID.test(ref)) {
    const c = view.refs?.commits.find((x) => x.sha === ref);
    return c ? `${c.shortSha} ${c.subject}` : ref.slice(0, 7);
  }
  return sha && !isPseudoRev(sha) && sha.slice(0, 7) !== ref ? `${ref} · ${sha.slice(0, 7)}` : ref;
}

function refItems(view) {
  const p = view.picker;
  const q = p.query.trim().toLowerCase();
  const refs = view.refs ?? { branches: [], remoteBranches: [], tags: [], commits: [] };
  const match = (...s) => !q || s.some((x) => x?.toLowerCase().includes(q));
  const out = [];
  const section = (title, entries) => {
    if (!entries.length) return;
    out.push({ kind: "head", title });
    out.push(...entries);
  };
  if (q) out.push({ kind: "ref", ref: p.query.trim(), title: `Use “${p.query.trim()}”`, detail: "any revision: HEAD~3, a1b2c3d, v1.0^…" });
  section("Local changes", [WORKTREE, INDEX].filter((r) => match(PSEUDO_LABEL[r], "uncommitted", "staged", "index", "working")).map((r) => ({ kind: "ref", ref: r, title: PSEUDO_LABEL[r], detail: r === WORKTREE ? "files on disk, including untracked" : "what the next commit would contain" })));
  section("Branches", refs.branches.filter((b) => match(b.name, b.subject)).map((b) => ({ kind: "ref", ref: b.name, title: b.name, detail: b.subject, sha: b.sha })));
  section("Remote branches", refs.remoteBranches.filter((b) => match(b.name, b.subject)).map((b) => ({ kind: "ref", ref: b.name, title: b.name, detail: b.subject, sha: b.sha })));
  section("Tags", refs.tags.filter((b) => match(b.name, b.subject)).map((b) => ({ kind: "ref", ref: b.name, title: b.name, detail: b.subject, sha: b.sha })));
  section("Recent commits", refs.commits.filter((c) => match(c.sha, c.subject, c.author)).slice(0, 300).map((c) => ({ kind: "ref", ref: c.sha, title: c.subject, detail: `${c.author} · ${relativeDate(c.date)}`, sha: c.sha, short: c.shortSha })));
  return out;
}

function pullItems(view) {
  const q = view.picker.query.trim().toLowerCase();
  // While a pull request is shown, the first item leaves it (base and head stay as they are).
  const stop = view.pr && (!q || `stop comparing clear exit #${view.pr}`.includes(q)) ? [{ kind: "stop", title: `Stop comparing #${view.pr}` }] : [];
  return stop.concat((view.pulls?.pulls ?? [])
    .filter((p) => !q || `#${p.number} ${p.title} ${p.author} ${p.headRef} ${p.baseRef}`.toLowerCase().includes(q))
    .map((p) => ({ kind: "pr", pr: p })));
}

function list(view) {
  return view.picker.which === "pr" ? pullItems(view) : refItems(view);
}

function pick(view, cx, item) {
  const which = view.picker.which;
  view.closePicker(cx);
  if (item.kind === "pr") return view.loadPull(cx, item.pr.number);
  if (item.kind === "stop") return view.choose(cx, view.base, view.head);
  if (which === "base") view.choose(cx, item.ref, view.head);
  else view.choose(cx, view.base, item.ref);
}

/** Enter in the picker's box (its "submit"): the highlighted item, else the first. */
export function pickCurrent(view, cx) {
  const items = list(view);
  const it = items[view.picker.cursorIndex ?? items.findIndex((x) => x.kind !== "head")];
  if (it && it.kind !== "head") pick(view, cx, it);
}

export function pickerKeys(view, e, cx) {
  const p = view.picker;
  const items = list(view);
  const selectable = items.map((it, i) => (it.kind === "head" ? -1 : i)).filter((i) => i >= 0);
  const at = selectable.indexOf(p.cursorIndex ?? selectable[0]);
  const move = (k) => {
    if (!selectable.length) return;
    p.cursorIndex = selectable[Math.min(Math.max(k, 0), selectable.length - 1)];
    p.scroll?.scroll_to_item(p.cursorIndex);
    cx.notify();
  };
  switch (e.key) {
    case "down":
      move(at + 1);
      return true;
    case "up":
      move(at - 1);
      return true;
    case "escape":
      view.closePicker(cx);
      return true;
    default:
      return false;
  }
}

function frame(view, t, left, width, title, body) {
  return div()
    .id("picker-layer")
    .absolute()
    .inset_0()
    .on_mouse_down("left", (_e, cx) => view.closePicker(cx))
    .child(v_flex()
      .id("picker")
      .absolute()
      .top(40)
      .left(left)
      .w(width)
      .h(Math.min(460, Math.max(200, view.size.height - 60)))
      .rounded(8)
      .border_1()
      .border_color(t.border)
      .bg(t.popover)
      .shadow_md()
      .overflow_hidden()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(h_flex().h(38).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border)
        .child(icon("search", 13, t.dim))
        .child(Input.new(view.picker.input).flex_1().h_full().text_size(12)))
      .when(Boolean(title), (e) => e.child(div().px(10).py(6).text_size(11).text_color(t.dim).child(title)))
      .child(body));
}

function listBody(view, t, items, draw) {
  const p = view.picker;
  const selectable = items.findIndex((it) => it.kind !== "head");
  if (p.cursorIndex === undefined || items[p.cursorIndex]?.kind === "head" || p.cursorIndex >= items.length) p.cursorIndex = selectable >= 0 ? selectable : undefined;
  const sizes = items.map((it) => (it.kind === "head" ? HEAD_H : ROW_H));
  return div().flex_1().min_h(0).relative()
    .when(items.length === 0, (e) => e.child(div().p(12).text_size(12).text_color(t.dim).child(view.picker.which === "pr" ? (view.pullsError ?? (view.pulls ? "No open pull requests" : "Loading pull requests…")) : "Nothing matches")))
    .child(fill(v_virtual_list("picker-list", items.length, sizes, (i) => `${i}:${items[i].kind === "head" ? items[i].title : items[i].ref ?? items[i].pr?.number ?? items[i].kind}`, safeRows((range) =>
      items.slice(range.start, range.end).map((it, k) => draw(it, range.start + k)))).track_scroll(p.scroll).on_item_click((key, cx) => {
      const it = items[Number(key.split(":")[0])];
      if (it && it.kind !== "head") pick(view, cx, it);
    }).size_full()))
    .child(Scrollbar.vertical("picker-list").absolute().inset_0());
}

export function renderPicker(view, t) {
  const p = view.picker;
  const items = refItems(view);
  const current = p.which === "base" ? view.base : view.head;
  const draw = (it, i) => {
    if (it.kind === "head") return div().h(HEAD_H).px(10).flex().items_end().pb(3).text_size(10).font_semibold().text_color(t.dim).child(it.title.toUpperCase());
    const active = i === p.cursorIndex;
    return h_flex()
      .id(`pk-${i}`)
      .h(ROW_H)
      .px(10)
      .gap(8)
      .items_center()
      .text_size(12)
      .cursor_pointer()
      .when(active, (e) => e.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .when(it.ref === current, (e) => e.child(div().w(6).h(6).rounded_full().bg(t.accent).flex_none()))
      .when(Boolean(it.short), (e) => e.child(div().flex_none().font_family(mono()).text_size(11).text_color(t.dim).child(it.short)))
      .child(div().flex_none().max_w(260).truncate().child(it.title))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(it.detail ?? ""));
  };
  const left = p.which === "base" ? Math.max(8, view.baseX ?? 260) : Math.max(8, view.headX ?? 420);
  return frame(view, t, Math.min(left, Math.max(8, view.size.width - 568)), 560, p.which === "base" ? "Compare from (A)" : "Compare to (B)", listBody(view, t, items, draw));
}

export function renderPullPicker(view, t) {
  const p = view.picker;
  const items = pullItems(view);
  const draw = (it, i) => {
    const pr = it.pr;
    const active = i === p.cursorIndex;
    if (it.kind === "stop") {
      return h_flex().id("pr-stop").h(ROW_H).px(10).gap(8).items_center().text_size(12).cursor_pointer()
        .when(active, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
        .child(icon("close", 12, t.dim)).child(div().child(it.title));
    }
    return h_flex()
      .id(`pr-${pr.number}`)
      .h(ROW_H)
      .px(10)
      .gap(8)
      .items_center()
      .text_size(12)
      .cursor_pointer()
      .when(active, (e) => e.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .child(div().flex_none().font_family(mono()).text_size(11).text_color(t.dim).child(`#${pr.number}`))
      .child(div().flex_1().min_w(0).truncate().child(pr.title))
      .when(pr.isDraft, (e) => e.child(div().flex_none().text_size(10).text_color(t.dim).child("draft")))
      .child(div().flex_none().max_w(160).truncate().text_size(11).text_color(t.dim).child(`${pr.author} · ${pr.headRef}`));
  };
  const gh = view.pulls?.github;
  return frame(view, t, 200, 620, gh ? `Open pull requests on ${gh.owner}/${gh.name}` : null, listBody(view, t, items, draw));
}
