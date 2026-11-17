import { describe, expect, test } from "bun:test";
import { BUTTON_ID, ORIGINAL_ID, withDiffButton } from "./layout";

const layout = {
  type: "column",
  children: [
    { id: "tabs", type: "block", size: { px: 42 }, window_drag: true, content: { mod: "tabs" } },
    { id: "work-body", type: "row", children: [{ id: "main", type: "block", content: { tab: "active" } }] },
  ],
};

describe("withDiffButton", () => {
  test("wraps the tab bar in a row with the button after it, keeping the bar as it was", () => {
    const out = withDiffButton(layout, "darwin") as { children: Array<unknown> };
    expect(out.children[0]).toEqual({
      id: "tabs",
      type: "row",
      size: { px: 42 },
      resizable: false,
      window_drag: true,
      children: [
        { id: ORIGINAL_ID, type: "block", size: { weight: 1 }, window_drag: true, content: { mod: "tabs" } },
        { id: BUTTON_ID, type: "block", size: { px: 72 }, content: { mod: "git-diff", props: { mode: "toolbar" } } },
      ],
    });
    expect(out.children[1]).toEqual(layout.children[1]);
    expect(layout.children[0]!.type).toBe("block"); // the input is untouched
  });

  test("puts the button first where the bar ends with the window's own buttons", () => {
    const out = withDiffButton(layout, "linux") as { children: Array<{ children: Array<{ id: string }> }> };
    expect(out.children[0]!.children.map((c) => c.id)).toEqual([BUTTON_ID, ORIGINAL_ID]);
  });

  test("refuses a layout it can't place the button in safely", () => {
    expect(() => withDiffButton({ type: "column", children: [] })).toThrow('Expected exactly one "tabs" block');
    expect(() => withDiffButton(withDiffButton(layout))).toThrow("already has the Diff button");
  });
});
