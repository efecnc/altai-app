import { useEffect } from "react";
import { useWorkspaceFolderStore } from "./folder";
import { WorkspaceWelcome } from "./WorkspaceWelcome";

/**
 * IDE-style startup gate. Blocks the app until a workspace folder is chosen.
 * The last folder reopens automatically (persisted); the Cursor-style welcome
 * screen is only shown when none is set. The chosen folder becomes the explorer
 * root and the parent of the IsanAgent workspace (`<folder>/.isanagent`).
 */
export function WorkspaceGate({ children }: { children: React.ReactNode }) {
  const hydrated = useWorkspaceFolderStore((s) => s.hydrated);
  const folder = useWorkspaceFolderStore((s) => s.folder);
  const hydrate = useWorkspaceFolderStore((s) => s.hydrate);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // Brief blank while we read the persisted folder — avoids flashing the
  // welcome screen before we know whether a workspace is already remembered.
  if (!hydrated) return null;

  if (!folder) return <WorkspaceWelcome />;

  return <>{children}</>;
}
