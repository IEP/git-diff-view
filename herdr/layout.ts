/**
 * Puts the Diff button beside Herdr's tab bar in a layout, without touching the tab bar:
 * the block with id "tabs" becomes a row holding that same block (same mod, same props)
 * and a narrow block showing this mod in toolbar mode. Herdr's own mods keep updating;
 * only the personal layout copy this is applied to is ours.
 */

export const BUTTON_ID = "git-diff-toolbar";
export const ORIGINAL_ID = "git-diff-original-tabs";
const BUTTON_WIDTH = 72;

interface Node {
  id?: string;
  type?: string;
  content?: { mod?: unknown } & Record<string, unknown>;
  children?: Array<Node>;
  [key: string]: unknown;
}

export function withDiffButton(layout: unknown, platform: string = process.platform): unknown {
  const copy = JSON.parse(JSON.stringify(layout)) as Node;
  const nodes: Array<Node> = [];
  const walk = (n: Node) => {
    nodes.push(n);
    for (const c of n.children ?? []) walk(c);
  };
  walk(copy);
  if (nodes.some((n) => n.id === BUTTON_ID || n.id === ORIGINAL_ID)) throw new Error("This layout already has the Diff button.");
  const tabs = nodes.filter((n) => n.id === "tabs" && n.type === "block" && typeof n.content?.mod === "string");
  if (tabs.length !== 1) throw new Error('Expected exactly one "tabs" block showing a mod; this layout can\'t take the button safely.');
  const node = tabs[0]!;
  const { id: _id, type: _type, size: _size, content, ...rest } = node;
  // The row keeps the block's place and size; the tab bar keeps its own settings (window_drag…).
  for (const key of Object.keys(node)) if (!["id", "size"].includes(key)) delete node[key];
  node.type = "row";
  node.resizable = false;
  if (rest.window_drag !== undefined) node.window_drag = rest.window_drag;
  node.children = [
    { id: ORIGINAL_ID, type: "block", size: { weight: 1 }, ...rest, content },
    { id: BUTTON_ID, type: "block", size: { px: BUTTON_WIDTH }, content: { mod: "git-diff", props: { mode: "toolbar" } } },
  ];
  // Elsewhere the tab bar ends with the window's own buttons, which must stay last.
  if (platform !== "darwin") node.children.reverse();
  return copy;
}
