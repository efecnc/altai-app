import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Spinner } from "@/components/ui/spinner";
import { github, useGitHubStore } from "@/modules/github";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { GithubIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repoRoot: string | null;
  onPublished: () => void;
};

function basename(path: string): string {
  const parts = path.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] ?? "";
}

/** Sanitize a folder name into a valid GitHub repo name. */
function toRepoName(raw: string): string {
  return raw
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

export function PublishToGitHubDialog({
  open,
  onOpenChange,
  repoRoot,
  onPublished,
}: Props) {
  const connection = useGitHubStore((s) => s.connection);
  const refresh = useGitHubStore((s) => s.refresh);

  const [name, setName] = useState("");
  const [isPrivate, setIsPrivate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(repoRoot ? toRepoName(basename(repoRoot)) : "");
    setIsPrivate(true);
    setError(null);
    setBusy(false);
    void refresh();
  }, [open, repoRoot, refresh]);

  const submit = async () => {
    const repoName = toRepoName(name);
    if (!repoName) {
      setError("Enter a repository name.");
      return;
    }
    if (!repoRoot) {
      setError("No repository is open.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const repo = await github.createRepo({ name: repoName, private: isPrivate });
      await github.publish(repoRoot, repo.cloneUrl);
      onPublished();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.75">
            <HugeiconsIcon icon={GithubIcon} size={16} strokeWidth={1.75} />
            Publish to GitHub
          </DialogTitle>
          <DialogDescription>
            Create a new GitHub repository and push the current branch to it.
          </DialogDescription>
        </DialogHeader>

        {!connection ? (
          <div className="flex flex-col gap-3 py-1">
            <p className="text-[12.5px] text-muted-foreground">
              Connect your GitHub account first to publish a repository.
            </p>
            <Button
              onClick={() => {
                onOpenChange(false);
                openSettingsWindow("github");
              }}
              className="gap-1.5"
            >
              <HugeiconsIcon icon={GithubIcon} size={14} strokeWidth={1.75} />
              Connect to GitHub
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3 py-1">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="gh-repo-name" className="text-[12px]">
                Repository name
              </Label>
              <Input
                id="gh-repo-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !busy) {
                    e.preventDefault();
                    void submit();
                  }
                }}
                placeholder="my-project"
                autoFocus
              />
              <span className="truncate text-[11px] text-muted-foreground">
                {connection.login}/{toRepoName(name) || "…"}
              </span>
            </div>

            <label className="flex cursor-pointer items-center gap-2 text-[12.5px]">
              <Checkbox
                checked={isPrivate}
                onCheckedChange={(v) => setIsPrivate(v === true)}
              />
              Private repository
            </label>

            {error ? (
              <p className="text-[11.5px] text-destructive">{error}</p>
            ) : null}
          </div>
        )}

        {connection ? (
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void submit()} disabled={busy} className="gap-1.5">
              {busy ? <Spinner className="size-3.5" /> : null}
              {busy ? "Publishing…" : "Create & Publish"}
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
