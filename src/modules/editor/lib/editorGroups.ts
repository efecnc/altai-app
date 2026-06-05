// Editor split groups (#65). A binary/n-ary tree of editor groups, parallel to
// the terminal pane tree. Each leaf is a group holding an ordered list of editor
// tab ids plus its own active tab; splits arrange child groups row/column.

export type SplitEdge = "left" | "right" | "top" | "bottom" | "center";

export type EditorGroupLeaf = {
  kind: "leaf";
  id: number;
  tabIds: number[];
  activeTabId: number | null;
};

export type EditorGroupSplit = {
  kind: "split";
  id: number;
  dir: "row" | "col";
  children: EditorGroupNode[];
};

export type EditorGroupNode = EditorGroupLeaf | EditorGroupSplit;

export function emptyLeaf(id: number): EditorGroupLeaf {
  return { kind: "leaf", id, tabIds: [], activeTabId: null };
}

export function allLeaves(node: EditorGroupNode): EditorGroupLeaf[] {
  if (node.kind === "leaf") return [node];
  return node.children.flatMap(allLeaves);
}

export function tabIdsInTree(node: EditorGroupNode): number[] {
  return allLeaves(node).flatMap((l) => l.tabIds);
}

export function leafContainingTab(
  node: EditorGroupNode,
  tabId: number,
): EditorGroupLeaf | null {
  return allLeaves(node).find((l) => l.tabIds.includes(tabId)) ?? null;
}

export function firstLeaf(node: EditorGroupNode): EditorGroupLeaf {
  return allLeaves(node)[0];
}

/** Map every leaf through `fn`, rebuilding the tree immutably. */
function mapLeaves(
  node: EditorGroupNode,
  fn: (leaf: EditorGroupLeaf) => EditorGroupLeaf,
): EditorGroupNode {
  if (node.kind === "leaf") return fn(node);
  return { ...node, children: node.children.map((c) => mapLeaves(c, fn)) };
}

/** Collapse splits that ended up with a single child after a removal. */
function collapse(node: EditorGroupNode): EditorGroupNode {
  if (node.kind === "leaf") return node;
  const children = node.children
    .map(collapse)
    // drop empty leaves entirely (an emptied group disappears)
    .filter((c) => !(c.kind === "leaf" && c.tabIds.length === 0));
  if (children.length === 0) return emptyLeaf(node.id);
  if (children.length === 1) return children[0];
  return { ...node, children };
}

export function addTabToLeaf(
  node: EditorGroupNode,
  leafId: number,
  tabId: number,
): EditorGroupNode {
  return mapLeaves(node, (l) =>
    l.id === leafId && !l.tabIds.includes(tabId)
      ? { ...l, tabIds: [...l.tabIds, tabId], activeTabId: tabId }
      : l,
  );
}

export function setActiveTab(
  node: EditorGroupNode,
  leafId: number,
  tabId: number,
): EditorGroupNode {
  const leaf = allLeaves(node).find((l) => l.id === leafId);
  // No-op (return same ref) when already active — avoids needless re-renders.
  if (!leaf || !leaf.tabIds.includes(tabId) || leaf.activeTabId === tabId) {
    return node;
  }
  return mapLeaves(node, (l) =>
    l.id === leafId ? { ...l, activeTabId: tabId } : l,
  );
}

/** Remove a tab from whatever leaf holds it, fixing up active + empties. */
export function removeTab(
  node: EditorGroupNode,
  tabId: number,
): EditorGroupNode {
  const next = mapLeaves(node, (l) => {
    if (!l.tabIds.includes(tabId)) return l;
    const tabIds = l.tabIds.filter((id) => id !== tabId);
    const activeTabId =
      l.activeTabId === tabId
        ? (tabIds[tabIds.length - 1] ?? null)
        : l.activeTabId;
    return { ...l, tabIds, activeTabId };
  });
  // collapse() always returns a leaf or split (an emptied split becomes
  // emptyLeaf), so the tree never collapses to nothing.
  return collapse(next);
}

/**
 * Split `targetLeafId` along `edge`, moving `tabId` into a fresh leaf on that
 * side. `center` just moves the tab into the target leaf (no split).
 */
export function splitLeafWithTab(
  node: EditorGroupNode,
  targetLeafId: number,
  tabId: number,
  edge: SplitEdge,
  newLeafId: number,
  newSplitId: number,
): EditorGroupNode {
  // Center = drop into the target group (no split). No-op when the tab already
  // lives there, so it doesn't pointlessly detach + re-append (which would
  // reorder the strip and flip the active tab).
  if (edge === "center") {
    if (leafContainingTab(node, tabId)?.id === targetLeafId) return node;
    return addTabToLeaf(removeTab(node, tabId), targetLeafId, tabId);
  }
  // Detach the tab from its current home first, then wrap the target leaf.
  const detached = removeTab(node, tabId);
  const dir: "row" | "col" =
    edge === "left" || edge === "right" ? "row" : "col";
  const before = edge === "left" || edge === "top";
  const newLeaf: EditorGroupLeaf = {
    kind: "leaf",
    id: newLeafId,
    tabIds: [tabId],
    activeTabId: tabId,
  };
  const replace = (n: EditorGroupNode): EditorGroupNode => {
    if (n.kind === "leaf") {
      if (n.id !== targetLeafId) return n;
      const split: EditorGroupSplit = {
        kind: "split",
        id: newSplitId,
        dir,
        children: before ? [newLeaf, n] : [n, newLeaf],
      };
      return split;
    }
    return { ...n, children: n.children.map(replace) };
  };
  // collapse() cleans up the degenerate case where detaching emptied the
  // target leaf (e.g. dropping a leaf's only tab onto its own edge) — that
  // leaf is dropped and the split with a single child unwraps.
  return collapse(replace(detached));
}

/**
 * Reconcile the tree against the live set of editor tab ids: drop tabs that no
 * longer exist and place any new tab into `preferredLeafId` (or the first leaf).
 * Returns the same reference when nothing changed.
 */
export function reconcile(
  node: EditorGroupNode,
  editorTabIds: number[],
  preferredLeafId: number | null,
): EditorGroupNode {
  const live = new Set(editorTabIds);
  let next: EditorGroupNode = node;

  // Remove tabs that are gone.
  for (const id of tabIdsInTree(next)) {
    if (!live.has(id)) next = removeTab(next, id);
  }
  // Add tabs not yet placed.
  const placed = new Set(tabIdsInTree(next));
  const target =
    (preferredLeafId != null &&
      allLeaves(next).find((l) => l.id === preferredLeafId)?.id) ||
    firstLeaf(next).id;
  for (const id of editorTabIds) {
    if (!placed.has(id)) next = addTabToLeaf(next, target, id);
  }
  return next;
}
