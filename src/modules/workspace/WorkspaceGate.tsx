import { useEffect, useState } from "react";
import { useWorkspaceFolderStore } from "./folder";

/**
 * IDE-style startup gate. Blocks the app until a workspace folder is chosen.
 * The last folder reopens automatically (persisted); the picker is only forced
 * when none is set. The chosen folder becomes the explorer root and the parent
 * of the IsanAgent workspace (`<folder>/.isanagent`).
 */
export function WorkspaceGate({ children }: { children: React.ReactNode }) {
  const hydrated = useWorkspaceFolderStore((s) => s.hydrated);
  const folder = useWorkspaceFolderStore((s) => s.folder);
  const hydrate = useWorkspaceFolderStore((s) => s.hydrate);
  const pickFolder = useWorkspaceFolderStore((s) => s.pickFolder);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // Brief blank while we read the persisted folder — avoids flashing the
  // picker before we know whether a workspace is already remembered.
  if (!hydrated) return null;

  if (!folder) {
    const onPick = async () => {
      setPicking(true);
      try {
        await pickFolder();
      } finally {
        setPicking(false);
      }
    };
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center gap-6 bg-background text-foreground">
        <div className="flex flex-col items-center gap-2 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">ALTAI</h1>
          <p className="max-w-sm text-sm text-muted-foreground">
            Open a folder to start. ALTAI works inside it like an IDE — the
            file tree, terminals, and the agent's workspace all live in the
            folder you choose.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void onPick()}
          disabled={picking}
          className="rounded-xl bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
        >
          {picking ? "Opening…" : "Open Folder…"}
        </button>
      </div>
    );
  }

  return <>{children}</>;
}
