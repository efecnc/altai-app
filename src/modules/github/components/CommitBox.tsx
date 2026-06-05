import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { native } from "@/modules/ai/lib/native";
import { fileIconUrl } from "@/modules/explorer/lib/iconResolver";
import { useSourceControl } from "@/modules/source-control";
import { PublishToGitHubDialog } from "@/modules/source-control/PublishToGitHubDialog";
import {
  ArrowDown01Icon,
  GitCommitIcon,
  GithubIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo, useState } from "react";

type DiffMode = "+" | "-";

type Props = {
  repoRoot: string;
  /** Open a file's diff in a workspace tab. */
  onOpenDiff: (input: {
    path: string;
    repoRoot: string;
    mode: DiffMode;
    originalPath?: string | null;
  }) => void;
};

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

function dirname(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const i = normalized.lastIndexOf("/");
  return i <= 0 ? "" : normalized.slice(0, i);
}

/**
 * Full commit experience embedded in the GitHub tab: stage or unstage
 * individual files, open their diffs, write a message and commit, then push or
 * publish — without the sidebar Source Control panel.
 */
export function CommitBox({ repoRoot, onOpenDiff }: Props) {
  const sc = useSourceControl(repoRoot, true);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<null | "stage" | "commit" | "push">(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);

  const files = useMemo(
    () => sc.status?.changedFiles ?? [],
    [sc.status],
  );
  const staged = useMemo(() => files.filter((f) => f.staged), [files]);
  const unstaged = useMemo(() => files.filter((f) => f.unstaged), [files]);

  if (!sc.hasRepo) return null;

  const canCommit = staged.length > 0 && message.trim().length > 0 && !busy;
  const hasUpstream = !!sc.status?.upstream;
  const ahead = sc.status?.ahead ?? 0;
  const remoteBusy = sc.busyAction !== null;

  const toggleFile = async (path: string, isStaged: boolean) => {
    if (busy) return;
    setBusy("stage");
    setError(null);
    try {
      if (isStaged) await native.gitUnstage(repoRoot, [path]);
      else await native.gitStage(repoRoot, [path]);
      await sc.refresh({ remote: "never" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const stageAll = async () => {
    if (busy || unstaged.length === 0) return;
    setBusy("stage");
    setError(null);
    try {
      await native.gitStage(repoRoot, unstaged.map((f) => f.path));
      await sc.refresh({ remote: "never" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const commit = async () => {
    if (!canCommit) return;
    setBusy("commit");
    setError(null);
    try {
      await native.gitCommit(repoRoot, message.trim());
      setMessage("");
      await sc.refresh({ remote: "never" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const push = async () => {
    if (remoteBusy) return;
    setBusy("push");
    setError(null);
    try {
      const res = await sc.runRemoteAction("push");
      if (!res.ok) setError(res.error ?? "Push failed.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const totalChanges = files.length;

  return (
    <div className="rounded-xl border border-border/60 bg-card/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <HugeiconsIcon
          icon={GitCommitIcon}
          size={14}
          strokeWidth={1.85}
          className="shrink-0 text-muted-foreground"
        />
        <span className="flex-1 text-[12px] font-medium text-foreground">
          Commit
        </span>
        <span className="text-[11px] text-muted-foreground/70">
          {totalChanges === 0
            ? "No changes"
            : `${staged.length} staged · ${unstaged.length} unstaged`}
        </span>
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          size={14}
          strokeWidth={2}
          className={cn(
            "shrink-0 text-muted-foreground/50 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open ? (
        <div className="flex flex-col gap-2 border-t border-border/50 p-3">
          {totalChanges === 0 ? (
            <p className="py-1 text-center text-[11.5px] text-muted-foreground/70">
              Working tree clean — nothing to commit.
            </p>
          ) : (
            <>
              {/* Changed files */}
              <ul className="flex max-h-48 flex-col gap-0.5 overflow-y-auto">
                {files.map((f) => {
                  const name = basename(f.path);
                  const dir = f.originalPath
                    ? `${f.originalPath} → ${f.path}`
                    : dirname(f.path);
                  const icon = fileIconUrl(name);
                  return (
                    <li key={f.path} className="flex items-center gap-2">
                      <Checkbox
                        aria-label={`Stage ${f.path}`}
                        checked={f.staged}
                        disabled={!!busy}
                        onCheckedChange={() => void toggleFile(f.path, f.staged)}
                        className="size-3.5 shrink-0"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          onOpenDiff({
                            path: f.path,
                            repoRoot,
                            mode: f.unstaged ? "-" : "+",
                            originalPath: f.originalPath,
                          })
                        }
                        className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-muted/50"
                      >
                        {icon ? (
                          <img src={icon} alt="" className="size-3.5 shrink-0" />
                        ) : (
                          <span className="size-3.5 shrink-0" />
                        )}
                        <span className="shrink-0 truncate text-[12px] text-foreground">
                          {name}
                        </span>
                        {dir ? (
                          <span className="min-w-0 flex-1 truncate text-[10.5px] text-muted-foreground/60">
                            {dir}
                          </span>
                        ) : null}
                        <span className="ml-auto shrink-0 text-[10px] font-medium uppercase text-muted-foreground/55">
                          {f.statusLabel?.slice(0, 1)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>

              <Textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={
                  staged.length === 0 ? "Stage changes to commit…" : "Commit message"
                }
                aria-label="Commit message"
                rows={2}
                className="resize-none text-[12px]"
              />
              {error ? (
                <p className="text-[11px] text-destructive">{error}</p>
              ) : null}
              <div className="flex items-center gap-2">
                {unstaged.length > 0 ? (
                  <Button
                    size="xs"
                    variant="outline"
                    className="h-7 text-[11px]"
                    onClick={() => void stageAll()}
                    disabled={!!busy}
                  >
                    {busy === "stage" ? (
                      <Spinner className="size-3.5" />
                    ) : (
                      `Stage all (${unstaged.length})`
                    )}
                  </Button>
                ) : null}
                {hasUpstream ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    className="h-7 text-[11px]"
                    onClick={() => void push()}
                    disabled={!!busy || remoteBusy || ahead === 0}
                  >
                    {busy === "push" || sc.busyAction === "push" ? (
                      <Spinner className="size-3.5" />
                    ) : (
                      `Push${ahead > 0 ? ` (${ahead})` : ""}`
                    )}
                  </Button>
                ) : (
                  <Button
                    size="xs"
                    variant="ghost"
                    className="h-7 gap-1.5 text-[11px]"
                    onClick={() => setPublishOpen(true)}
                    disabled={!!busy}
                  >
                    <HugeiconsIcon icon={GithubIcon} size={12} strokeWidth={1.85} />
                    Publish
                  </Button>
                )}
                <Button
                  size="xs"
                  className="ml-auto h-7 gap-1.5 text-[11px]"
                  onClick={() => void commit()}
                  disabled={!canCommit}
                >
                  {busy === "commit" ? (
                    <>
                      <Spinner className="size-3.5" />
                      Committing…
                    </>
                  ) : (
                    `Commit ${staged.length} file${staged.length === 1 ? "" : "s"}`
                  )}
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}

      <PublishToGitHubDialog
        open={publishOpen}
        onOpenChange={setPublishOpen}
        repoRoot={repoRoot}
        onPublished={() => void sc.refresh({ remote: "never" })}
      />
    </div>
  );
}
