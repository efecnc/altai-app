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

  // Keep the app visibly alive while we read persisted workspace state. If the
  // native store is slow or unavailable, folder.ts guarantees this resolves to
  // the welcome screen rather than leaving a black window behind.
  if (!hydrated) {
    return (
      <main className="flex h-screen w-screen items-center justify-center bg-background text-[13px] text-muted-foreground">
        Starting ALTAI…
      </main>
    );
  }

  if (!folder) return <WorkspaceWelcome />;

  return <>{children}</>;
}
