import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useGitHubStore } from "@/modules/github";
import {
  listRepoProjects,
  type ProjectSummary,
} from "@/modules/github/lib/projects";
import { useRepoSlug } from "@/modules/github/lib/useRepoSlug";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { GithubIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { OverviewBoard } from "./OverviewBoard";
import { ProjectsV2Board } from "./ProjectsV2Board";

type Props = {
  repoRoot: string;
};

const OVERVIEW = "overview";

function isScopeError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("required scope") ||
    m.includes("requires the project") ||
    (m.includes("scope") &&
      (m.includes("project") || m.includes("read:project")))
  );
}

/**
 * Project-management board tab. Defaults to an always-populated **Overview**
 * (issues, PRs, agent todos, and live sub-agents grouped into Todo / In
 * Progress / Done) so the board is never empty, and lets the user switch to any
 * linked GitHub Projects v2 board. The Overview needs no GitHub Project and no
 * `project` scope — it runs purely off the REST issues/PRs the user can already
 * see, plus local agent state.
 */
export function ProjectBoardPanel({ repoRoot }: Props) {
  const connection = useGitHubStore((s) => s.connection);
  const slugState = useRepoSlug(repoRoot);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectsNote, setProjectsNote] = useState<string | null>(null);
  const [mode, setMode] = useState<string>(OVERVIEW);

  const slug = slugState.status === "ready" ? slugState.slug : null;

  // Fetch linked Projects v2 for the mode selector. Non-blocking: a scope error
  // or no projects must NOT stop the Overview board from rendering.
  useEffect(() => {
    if (!slug || !connection) return;
    let alive = true;
    setProjectsNote(null);
    listRepoProjects(slug)
      .then((list) => {
        if (alive) setProjects(list);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        const msg = e instanceof Error ? e.message : String(e);
        setProjectsNote(
          isScopeError(msg)
            ? "Reconnect with the project scope to use GitHub Projects boards."
            : msg,
        );
      });
    return () => {
      alive = false;
    };
  }, [slug, connection]);

  if (!connection) {
    return (
      <Centered>
        <Glyph />
        <p className="text-[13px] font-medium text-foreground">
          Connect your GitHub account
        </p>
        <p className="max-w-[22rem] text-center text-[12px] text-muted-foreground">
          Track issues, PRs, agent todos, and live sub-agents on one board.
        </p>
        <Button onClick={() => openSettingsWindow("github")} className="gap-1.5">
          <HugeiconsIcon icon={GithubIcon} size={14} strokeWidth={1.75} />
          Connect to GitHub
        </Button>
      </Centered>
    );
  }

  if (slugState.status === "loading") {
    return (
      <Centered>
        <Spinner className="size-4" />
        <p className="text-[12px] text-muted-foreground">Resolving repository…</p>
      </Centered>
    );
  }

  if (slugState.status === "none" || !slug) {
    return (
      <Centered>
        <Glyph />
        <p className="text-[12.5px] text-muted-foreground">
          This repository has no GitHub remote (origin).
        </p>
      </Centered>
    );
  }

  return (
    <div className="flex h-full w-full flex-col">
      {/* Header: repo + mode selector */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border/50 px-4 py-2.5">
        <HugeiconsIcon
          icon={GithubIcon}
          size={15}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <span className="shrink-0 truncate text-[12.5px] font-medium text-foreground">
          {slug.owner}/{slug.repo}
        </span>
        <span className="text-muted-foreground/40">/</span>
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value)}
          aria-label="Board view"
          className="h-7 max-w-[16rem] rounded-lg border border-border/60 bg-background/60 px-2 text-[12px] font-medium text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <option value={OVERVIEW}>Overview</option>
          {projects.length > 0 ? (
            <optgroup label="GitHub Projects">
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                  {p.closed ? " (closed)" : ""}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
        {mode === OVERVIEW && projectsNote ? (
          <span className="truncate text-[10.5px] text-muted-foreground/55">
            {projectsNote}
          </span>
        ) : null}
      </div>

      <div className="min-h-0 flex-1">
        {mode === OVERVIEW ? (
          <OverviewBoard slug={slug} />
        ) : (
          <ProjectsV2Board key={mode} projectId={mode} slug={slug} />
        )}
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6">
      {children}
    </div>
  );
}

function Glyph() {
  return (
    <span className="flex size-12 items-center justify-center rounded-2xl bg-foreground/[0.04] text-muted-foreground">
      <HugeiconsIcon icon={GithubIcon} size={24} strokeWidth={1.6} />
    </span>
  );
}
