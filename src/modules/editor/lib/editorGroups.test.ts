import { describe, expect, it } from "vitest";
import {
  addTabToLeaf,
  allLeaves,
  emptyLeaf,
  leafContainingTab,
  reconcile,
  removeTab,
  setActiveTab,
  splitLeafWithTab,
  tabIdsInTree,
  type EditorGroupNode,
} from "./editorGroups";

/** Every leaf in the tree holds at least one tab (no dangling empty panes). */
function noEmptyLeaves(node: EditorGroupNode): boolean {
  return allLeaves(node).every((l) => l.tabIds.length > 0);
}

describe("addTabToLeaf", () => {
  it("appends a tab and makes it active", () => {
    const node = addTabToLeaf(emptyLeaf(1), 1, 10);
    expect(tabIdsInTree(node)).toEqual([10]);
    expect(allLeaves(node)[0].activeTabId).toBe(10);
  });

  it("does not duplicate an already-present tab", () => {
    let node = addTabToLeaf(emptyLeaf(1), 1, 10);
    node = addTabToLeaf(node, 1, 10);
    expect(tabIdsInTree(node)).toEqual([10]);
  });
});

describe("setActiveTab", () => {
  it("returns the same reference when already active", () => {
    const node = addTabToLeaf(emptyLeaf(1), 1, 10);
    expect(setActiveTab(node, 1, 10)).toBe(node);
  });

  it("updates the active tab when different", () => {
    let node = addTabToLeaf(emptyLeaf(1), 1, 10);
    node = addTabToLeaf(node, 1, 11); // 11 becomes active
    const next = setActiveTab(node, 1, 10);
    expect(next).not.toBe(node);
    expect(allLeaves(next)[0].activeTabId).toBe(10);
  });

  it("ignores a tab that is not in the leaf", () => {
    const node = addTabToLeaf(emptyLeaf(1), 1, 10);
    expect(setActiveTab(node, 1, 99)).toBe(node);
  });
});

describe("removeTab", () => {
  it("removes a tab and falls back to the last remaining as active", () => {
    let node = addTabToLeaf(emptyLeaf(1), 1, 10);
    node = addTabToLeaf(node, 1, 11);
    node = removeTab(node, 11);
    expect(tabIdsInTree(node)).toEqual([10]);
    expect(allLeaves(node)[0].activeTabId).toBe(10);
  });

  it("collapses a split's single-child after a leaf empties", () => {
    const split = splitLeafWithTab(
      // leaf 1 has [10, 11]; split 11 to the right → two leaves
      addTabToLeaf(addTabToLeaf(emptyLeaf(1), 1, 10), 1, 11),
      1,
      11,
      "right",
      2,
      3,
    );
    expect(allLeaves(split)).toHaveLength(2);
    // removing the only tab of one leaf collapses the split back to a leaf
    const collapsed = removeTab(split, 11);
    expect(collapsed.kind).toBe("leaf");
    expect(tabIdsInTree(collapsed)).toEqual([10]);
  });

  it("never collapses to nothing — keeps one empty leaf", () => {
    const node = addTabToLeaf(emptyLeaf(1), 1, 10);
    const empty = removeTab(node, 10);
    expect(empty.kind).toBe("leaf");
    expect(tabIdsInTree(empty)).toEqual([]);
  });
});

describe("splitLeafWithTab", () => {
  const base = addTabToLeaf(addTabToLeaf(emptyLeaf(1), 1, 10), 1, 11);

  it("splits right as a row with [target, new]", () => {
    const node = splitLeafWithTab(base, 1, 11, "right", 2, 3);
    expect(node.kind).toBe("split");
    if (node.kind !== "split") return;
    expect(node.dir).toBe("row");
    expect(tabIdsInTree(node.children[0])).toEqual([10]);
    expect(tabIdsInTree(node.children[1])).toEqual([11]);
  });

  it("splits left as a row with [new, target]", () => {
    const node = splitLeafWithTab(base, 1, 11, "left", 2, 3);
    if (node.kind !== "split") throw new Error("expected split");
    expect(node.dir).toBe("row");
    expect(tabIdsInTree(node.children[0])).toEqual([11]);
    expect(tabIdsInTree(node.children[1])).toEqual([10]);
  });

  it("splits bottom/top as a column", () => {
    expect(
      (splitLeafWithTab(base, 1, 11, "bottom", 2, 3) as { dir: string }).dir,
    ).toBe("col");
    expect(
      (splitLeafWithTab(base, 1, 11, "top", 2, 3) as { dir: string }).dir,
    ).toBe("col");
  });

  it("center moves a tab into a different leaf (collapsing the emptied one)", () => {
    const split = splitLeafWithTab(base, 1, 11, "right", 2, 3);
    const [leafA, leafB] = allLeaves(split); // [10], [11]
    expect(leafA.tabIds).toEqual([10]);
    // center-drop A's only tab into B → A empties and collapses away
    const moved = splitLeafWithTab(split, leafB.id, 10, "center", 4, 5);
    expect(moved.kind).toBe("leaf");
    expect(tabIdsInTree(moved).sort()).toEqual([10, 11]);
  });

  it("center is a no-op when the tab already lives in the target leaf", () => {
    const node = splitLeafWithTab(base, 1, 10, "center", 2, 3);
    expect(node).toBe(base);
  });

  it("does not leave a dangling empty leaf when splitting a leaf's only tab onto its own edge (C1)", () => {
    const solo = addTabToLeaf(emptyLeaf(1), 1, 10);
    const node = splitLeafWithTab(solo, 1, 10, "left", 2, 3);
    expect(noEmptyLeaves(node)).toBe(true);
    expect(tabIdsInTree(node)).toEqual([10]);
    expect(node.kind).toBe("leaf");
  });
});

describe("reconcile", () => {
  const node = addTabToLeaf(addTabToLeaf(emptyLeaf(1), 1, 10), 1, 11);

  it("returns the same reference when the live set is unchanged", () => {
    expect(reconcile(node, [10, 11], null)).toBe(node);
  });

  it("returns the same reference regardless of id order", () => {
    expect(reconcile(node, [11, 10], null)).toBe(node);
  });

  it("drops tabs that no longer exist", () => {
    const next = reconcile(node, [10], null);
    expect(tabIdsInTree(next)).toEqual([10]);
  });

  it("places a new tab into the preferred leaf", () => {
    const next = reconcile(node, [10, 11, 12], 1);
    expect(leafContainingTab(next, 12)?.id).toBe(1);
  });
});
