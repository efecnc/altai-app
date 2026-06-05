import type { GitHubItemsTab, Tab } from "@/modules/tabs";
import { GitHubItemsPanel } from "./GitHubItemsPanel";

type Props = {
  tabs: Tab[];
  activeId: number;
  onOpenDiff: (input: {
    path: string;
    repoRoot: string;
    mode: "+" | "-";
    originalPath?: string | null;
  }) => void;
};

/** Renders the active GitHub PR/issues tab, remounting per repo on switch. */
export function GitHubItemsStack({ tabs, activeId, onOpenDiff }: Props) {
  const active = tabs.find(
    (t): t is GitHubItemsTab => t.kind === "github-items" && t.id === activeId,
  );
  if (!active) return null;
  return (
    <GitHubItemsPanel
      key={active.id}
      repoRoot={active.repoRoot}
      onOpenDiff={onOpenDiff}
    />
  );
}
