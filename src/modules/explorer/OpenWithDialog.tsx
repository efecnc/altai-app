import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { openWithApplication } from "./lib/contextActions";
import { useEffect, useState } from "react";

type Props = {
  path: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function basename(path: string): string {
  return path.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || path;
}

/**
 * A cross-platform application picker. The OS opener accepts application names
 * on macOS and executable names or paths on Windows/Linux.
 */
export function OpenWithDialog({ path, open, onOpenChange }: Props) {
  const [application, setApplication] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setApplication("");
    setBusy(false);
    setError(null);
  }, [open, path]);

  const submit = async () => {
    const app = application.trim();
    if (!app) {
      setError("Enter an application name or executable.");
      return;
    }
    if (!path) return;

    setBusy(true);
    setError(null);
    try {
      await openWithApplication(path, app);
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Open With</DialogTitle>
          <DialogDescription>
            Open {path ? <span className="font-medium text-foreground">{basename(path)}</span> : "this item"} with another application.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Label htmlFor="open-with-application">Application</Label>
          <Input
            id="open-with-application"
            autoFocus
            value={application}
            onChange={(event) => setApplication(event.target.value)}
            placeholder="e.g. Visual Studio Code, notepad.exe, or code"
            disabled={busy}
          />
          <p className="text-xs text-muted-foreground">
            Use an installed app name on macOS, or an executable name/full path on Windows and Linux.
          </p>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !application.trim()}>
            {busy ? "Opening…" : "Open"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
