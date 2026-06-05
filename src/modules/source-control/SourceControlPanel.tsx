import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useGitHubStore } from "@/modules/github";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  ArrowUp01Icon,
  Download01Icon,
  FolderCloudIcon,
  FolderGitTwoIcon,
  GitBranchIcon,
  GithubIcon,
  KanbanIcon,
  Refresh01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { SourceControlSummary } from "./useSourceControl";
import { useSourceControlPanel } from "./useSourceControlPanel";

type Props = {
  open: boolean;
  sourceControl: SourceControlSummary;
  onOpenGitGraph?: () => void;
  onOpenGitHubItems?: () => void;
  onOpenProjects?: () => void;
  onOpenDiff: (input: {
    path: string;
    repoRoot: string;
    mode: "+" | "-";
    originalPath: string | null;
    title?: string;
  }) => void;
};

const SOURCE_CONTROL_TOOLTIP_CLASS =
  "border border-border/70 bg-zinc-950 text-zinc-100 shadow-lg shadow-black/30 dark:border-border/60 dark:bg-zinc-950 dark:text-zinc-100";

/**
 * Slim Source Control sidebar: a branch header with remote actions plus a menu
 * to the richer GitHub views (Commit Graph, Pull Requests & Issues). Committing,
 * staging, and diffing live in the GitHub workspace tab, so this panel stays a
 * compact navigation surface.
 */
export const SourceControlPanel = memo(function SourceControlPanel({
  open,
  sourceControl,
  onOpenGitGraph,
  onOpenGitHubItems,
  onOpenProjects,
  onOpenDiff,
}: Props) {
  const scm = useSourceControlPanel(open, sourceControl, onOpenDiff);
  const refreshAnimationRef = useRef<number | null>(null);
  const [refreshAnimating, setRefreshAnimating] = useState(false);
  const githubConnection = useGitHubStore((s) => s.connection);
  const githubRefresh = useGitHubStore((s) => s.refresh);

  useEffect(() => {
    return () => {
      if (refreshAnimationRef.current) {
        window.clearTimeout(refreshAnimationRef.current);
      }
    };
  }, []);

  // Keep the GitHub connection indicator current while the panel is visible.
  useEffect(() => {
    if (open) void githubRefresh();
  }, [open, githubRefresh]);

  const isRefreshing = scm.panelState === "loading";
  const repoLabel = useMemo(() => {
    if (!scm.status) return "Source Control";
    return scm.status.isDetached ? "detached" : scm.status.branch;
  }, [scm.status]);

  const hasUpstream = !!scm.status?.upstream;
  const isDiverged =
    !!scm.status && scm.status.ahead > 0 && scm.status.behind > 0;
  const canPull =
    hasUpstream &&
    !!scm.status &&
    scm.status.behind > 0 &&
    !isDiverged &&
    !scm.actionBusy &&
    !sourceControl.busyAction;
  const canFetch = hasUpstream && !scm.actionBusy && !sourceControl.busyAction;
  const fetchBusy = sourceControl.busyAction === "fetch";
  const pullBusy = sourceControl.busyAction === "pull";

  const handleRefresh = useCallback(() => {
    setRefreshAnimating(true);
    if (refreshAnimationRef.current) {
      window.clearTimeout(refreshAnimationRef.current);
    }
    void scm.refresh().finally(() => {
      refreshAnimationRef.current = window.setTimeout(() => {
        setRefreshAnimating(false);
        refreshAnimationRef.current = null;
      }, 450);
    });
  }, [scm]);

  const handleFetch = useCallback(() => {
    void sourceControl.runRemoteAction("fetch");
  }, [sourceControl]);

  const handlePull = useCallback(() => {
    void sourceControl.runRemoteAction("pull");
  }, [sourceControl]);

  if (!open) return null;

  return (
    <TooltipProvider delayDuration={800} skipDelayDuration={300}>
      <aside className="flex h-full min-w-0 flex-col bg-card/80 backdrop-blur [contain:layout_style]">
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border/50 px-3 pb-2.5 pt-3">
          <div className="flex min-w-0 items-center gap-1.5">
            <div className="inline-flex min-w-0 items-center gap-1.5 rounded-md bg-foreground/5 px-2 py-1 text-[11.5px] font-medium leading-none text-foreground transition-colors hover:bg-foreground/10">
              <HugeiconsIcon
                icon={FolderGitTwoIcon}
                size={12}
                strokeWidth={1.9}
                className="shrink-0 text-muted-foreground"
              />
              <span className="max-w-[140px] truncate">{repoLabel}</span>
            </div>
            {scm.status && (scm.status.ahead > 0 || scm.status.behind > 0) ? (
              <div className="flex shrink-0 items-center gap-0.5 text-[10px] font-semibold tabular-nums leading-none text-muted-foreground">
                {scm.status.ahead > 0 ? (
                  <span className="inline-flex items-center gap-0.5 rounded-md border border-border/60 px-1 py-0.5">
                    <HugeiconsIcon
                      icon={ArrowUp01Icon}
                      size={9}
                      strokeWidth={2.2}
                    />
                    {scm.status.ahead}
                  </span>
                ) : null}
                {scm.status.behind > 0 ? (
                  <span className="inline-flex items-center gap-0.5 rounded-md border border-border/60 px-1 py-0.5">
                    <HugeiconsIcon
                      icon={ArrowDown01Icon}
                      size={9}
                      strokeWidth={2.2}
                    />
                    {scm.status.behind}
                  </span>
                ) : null}
              </div>
            ) : null}
            {scm.status?.isDetached ? (
              <span className="rounded bg-muted/55 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                detached
              </span>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <IconActionButton
              label={
                githubConnection
                  ? `GitHub: @${githubConnection.login}`
                  : "Connect to GitHub"
              }
              onClick={() => openSettingsWindow("github")}
              side="bottom"
            >
              <HugeiconsIcon
                icon={GithubIcon}
                size={14}
                strokeWidth={1.85}
                className={cn(githubConnection && "text-emerald-500")}
              />
            </IconActionButton>
            <IconActionButton
              label={fetchBusy ? "Fetching…" : "Fetch from remote"}
              disabled={!canFetch}
              onClick={handleFetch}
              side="bottom"
            >
              {fetchBusy ? (
                <Spinner className="size-3" />
              ) : (
                <HugeiconsIcon
                  icon={FolderCloudIcon}
                  size={14}
                  strokeWidth={1.85}
                />
              )}
            </IconActionButton>
            <IconActionButton
              label={
                pullBusy
                  ? "Pulling…"
                  : isDiverged
                    ? "Branch diverged — resolve in terminal"
                    : !hasUpstream
                      ? "No upstream configured"
                      : (scm.status?.behind ?? 0) === 0
                        ? "Already up to date"
                        : `Pull ${scm.status?.behind ?? 0} commits (fast-forward)`
              }
              disabled={!canPull}
              onClick={handlePull}
              side="bottom"
            >
              {pullBusy ? (
                <Spinner className="size-3" />
              ) : (
                <HugeiconsIcon
                  icon={Download01Icon}
                  size={14}
                  strokeWidth={1.9}
                />
              )}
            </IconActionButton>
            <IconActionButton
              label="Refresh source control"
              disabled={isRefreshing || !!scm.actionBusy}
              onClick={handleRefresh}
              side="bottom"
            >
              {isRefreshing ? (
                <Spinner className="size-3.5" />
              ) : (
                <HugeiconsIcon
                  icon={Refresh01Icon}
                  size={14}
                  strokeWidth={1.9}
                  className={cn(refreshAnimating && "animate-spin")}
                />
              )}
            </IconActionButton>
          </div>
        </header>

        {onOpenGitGraph ? (
          <button
            type="button"
            onClick={() => onOpenGitGraph()}
            className="group flex shrink-0 cursor-pointer items-center gap-2 border-b border-border/40 px-3 py-2 text-left text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
          >
            <HugeiconsIcon
              icon={GitBranchIcon}
              size={13}
              strokeWidth={1.85}
              className="shrink-0"
            />
            <span className="flex-1 text-[12px] font-medium">Commit Graph</span>
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              size={12}
              strokeWidth={2}
              className="shrink-0 opacity-50 transition-transform group-hover:translate-x-0.5"
            />
          </button>
        ) : null}

        {scm.status ? (
          <button
            type="button"
            onClick={() => onOpenGitHubItems?.()}
            className="group flex shrink-0 cursor-pointer items-center gap-2 border-b border-border/40 px-3 py-2 text-left text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
          >
            <HugeiconsIcon
              icon={GithubIcon}
              size={13}
              strokeWidth={1.85}
              className="shrink-0"
            />
            <span className="flex-1 text-[12px] font-medium">
              Pull Requests &amp; Issues
            </span>
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              size={12}
              strokeWidth={2}
              className="shrink-0 opacity-50 transition-transform group-hover:translate-x-0.5"
            />
          </button>
        ) : null}

        {scm.status ? (
          <button
            type="button"
            onClick={() => onOpenProjects?.()}
            className="group flex shrink-0 cursor-pointer items-center gap-2 border-b border-border/40 px-3 py-2 text-left text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
          >
            <HugeiconsIcon
              icon={KanbanIcon}
              size={13}
              strokeWidth={1.85}
              className="shrink-0"
            />
            <span className="flex-1 text-[12px] font-medium">
              Project Board
            </span>
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              size={12}
              strokeWidth={2}
              className="shrink-0 opacity-50 transition-transform group-hover:translate-x-0.5"
            />
          </button>
        ) : null}

        {scm.panelState === "loading" ? (
          <PanelCenter title="Loading repository" />
        ) : null}

        {scm.panelState === "no-repo" ? (
          <PanelCenter
            title="No repository"
            body="The active workspace is not inside a Git repository."
          />
        ) : null}

        {scm.panelState === "error" ? (
          <PanelCenter
            title="Source control error"
            body={scm.statusError ?? "Unknown source control error"}
            action={
              <Button size="sm" onClick={() => void scm.refresh()}>
                Retry
              </Button>
            }
          />
        ) : null}
      </aside>
    </TooltipProvider>
  );
});

function PanelCenter({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <div className="text-sm font-medium">{title}</div>
      {body ? (
        <div className="max-w-64 text-[11px] leading-relaxed text-muted-foreground">
          {body}
        </div>
      ) : null}
      {action}
    </div>
  );
}

function IconActionButton({
  label,
  disabled,
  side = "left",
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  side?: "left" | "top" | "right" | "bottom";
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon-sm"
          variant="ghost"
          className="size-6 p-3 cursor-pointer rounded-md text-muted-foreground hover:text-foreground disabled:cursor-not-allowed"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent
        side={side}
        className={cn(SOURCE_CONTROL_TOOLTIP_CLASS, "text-[10.5px]")}
      >
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
