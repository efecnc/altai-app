import type { Tab } from "@/modules/tabs/lib/useTabs";
import { NotebookPane } from "./NotebookPane";
import { cn } from "@/lib/utils";

type NotebookStackProps = {
  tabs: Tab[];
  activeId: number;
  onDirtyChange: (id: number, dirty: boolean) => void;
};

export function NotebookStack({ tabs, activeId, onDirtyChange }: NotebookStackProps) {
  const notebookTabs = tabs.filter((t) => t.kind === "notebook");

  return (
    <>
      {notebookTabs.map((tab) => {
        if (tab.kind !== "notebook") return null;
        const isActive = tab.id === activeId;
        return (
          <div
            key={tab.id}
            className={cn(
              "absolute inset-0",
              !isActive && "invisible pointer-events-none",
            )}
            aria-hidden={!isActive}
          >
            <NotebookPane
              path={tab.path}
              active={isActive}
              onDirtyChange={(dirty) => onDirtyChange(tab.id, dirty)}
            />
          </div>
        );
      })}
    </>
  );
}
