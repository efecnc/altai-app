import type { ProjectBoardTab, Tab } from "@/modules/tabs";
import { ProjectBoardPanel } from "./ProjectBoardPanel";

type Props = {
  tabs: Tab[];
  activeId: number;
};

/** Renders the active Project Board tab, remounting per repo on switch. */
export function ProjectBoardStack({ tabs, activeId }: Props) {
  const active = tabs.find(
    (t): t is ProjectBoardTab => t.kind === "project-board" && t.id === activeId,
  );
  if (!active) return null;
  return <ProjectBoardPanel key={active.id} repoRoot={active.repoRoot} />;
}
