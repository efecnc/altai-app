import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { useGitHubStore } from "@/modules/github";
import type { RepoSlug } from "@/modules/github/lib/items";
import {
  type BoardCard,
  getProjectBoard,
  NO_STATUS_COLUMN,
  populateProject,
  setCardStatus,
  type Board,
} from "@/modules/github/lib/projects";
import {
  ArrowReloadHorizontalIcon,
  GithubIcon,
  GitPullRequestIcon,
  RecordIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useMemo, useState } from "react";
import { StateBadge } from "./itemBits";

type Props = {
  projectId: string;
  slug: RepoSlug;
};

function isScopeError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("required scope") ||
    m.includes("requires the project") ||
    (m.includes("scope") &&
      (m.includes("project") || m.includes("read:project")))
  );
}

function cardState(
  card: BoardCard,
): "open" | "closed" | "merged" | "draft" | null {
  if (card.type === "DraftIssue") return "draft";
  if (card.isDraft) return "draft";
  if (!card.state) return null;
  const s = card.state.toUpperCase();
  if (s === "MERGED") return "merged";
  if (s === "CLOSED") return "closed";
  return "open";
}

export function ProjectsV2Board({ projectId, slug }: Props) {
  const connect = useGitHubStore((s) => s.connect);
  const [board, setBoard] = useState<Board | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scopeError, setScopeError] = useState(false);
  const [scopeErrorDetail, setScopeErrorDetail] = useState<string | null>(null);
  const [dragItem, setDragItem] = useState<string | null>(null);
  const [populating, setPopulating] = useState(false);
  // All reloads flow through this counter so the single effect owns the
  // request's `alive` cleanup (no setState-after-unmount from manual calls).
  const [reloadTick, setReloadTick] = useState(0);

  const loadBoard = useCallback(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setScopeError(false);
    setScopeErrorDetail(null);
    getProjectBoard(projectId)
      .then((b) => alive && setBoard(b))
      .catch((e: unknown) => {
        if (!alive) return;
        const msg = e instanceof Error ? e.message : String(e);
        if (isScopeError(msg)) {
          setScopeError(true);
          setScopeErrorDetail(msg);
        } else {
          setError(msg);
        }
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [projectId, reloadTick]);

  useEffect(() => loadBoard(), [loadBoard]);

  const populate = async () => {
    if (populating) return;
    setPopulating(true);
    setError(null);
    try {
      await populateProject(projectId, slug);
      setReloadTick((t) => t + 1);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isScopeError(msg)) {
        setScopeError(true);
        setScopeErrorDetail(msg);
      } else {
        setError(msg);
      }
    } finally {
      setPopulating(false);
    }
  };

  const columns = useMemo(() => {
    if (!board) return [];
    return [...board.columns, NO_STATUS_COLUMN];
  }, [board]);

  const cardsByColumn = useMemo(() => {
    const map = new Map<string | null, BoardCard[]>();
    for (const col of columns) map.set(col.id, []);
    for (const card of board?.cards ?? []) {
      (map.get(card.statusOptionId) ?? map.get(null))?.push(card);
    }
    return map;
  }, [board, columns]);

  const onDrop = async (columnId: string | null) => {
    const itemId = dragItem;
    setDragItem(null);
    if (!board || !board.statusFieldId) return;
    const card = board.cards.find((c) => c.itemId === itemId);
    if (!itemId || !card || card.statusOptionId === columnId) return;
    const fieldId = board.statusFieldId;
    const projId = board.projectId;
    const prevStatus = card.statusOptionId;
    // Functional updates so a concurrent drag's change isn't clobbered.
    setBoard((b) =>
      b
        ? {
            ...b,
            cards: b.cards.map((c) =>
              c.itemId === itemId ? { ...c, statusOptionId: columnId } : c,
            ),
          }
        : b,
    );
    try {
      await setCardStatus(projId, fieldId, itemId, columnId);
    } catch (e) {
      setBoard((b) =>
        b
          ? {
              ...b,
              cards: b.cards.map((c) =>
                c.itemId === itemId ? { ...c, statusOptionId: prevStatus } : c,
              ),
            }
          : b,
      );
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (scopeError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6">
        <Glyph />
        <p className="text-[13px] font-medium text-foreground">
          Projects access needed
        </p>
        <p className="max-w-[26rem] text-center text-[12px] leading-relaxed text-muted-foreground">
          GitHub Projects needs the <span className="font-mono">project</span>{" "}
          scope. If reconnecting doesn&apos;t help, revoke the app on GitHub
          first, then reconnect so it re-prompts for the new scope.
        </p>
        {scopeErrorDetail ? (
          <p className="max-w-[28rem] rounded-md bg-muted/40 px-2.5 py-1.5 text-center font-mono text-[10.5px] leading-relaxed text-muted-foreground/80">
            {scopeErrorDetail}
          </p>
        ) : null}
        <div className="flex items-center gap-2">
          <Button onClick={() => void connect()} className="gap-1.5">
            <HugeiconsIcon icon={GithubIcon} size={14} strokeWidth={1.75} />
            Reconnect GitHub
          </Button>
          <Button
            variant="ghost"
            className="text-[12px]"
            onClick={() => void openUrl("https://github.com/settings/applications")}
          >
            Manage on GitHub ↗
          </Button>
        </div>
      </div>
    );
  }

  if (loading && !board) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[12px] text-muted-foreground">
        <Spinner className="size-4" />
        Loading board…
      </div>
    );
  }

  if (board && board.columns.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="max-w-[24rem] text-[12px] text-muted-foreground">
          This project has no <span className="font-mono">Status</span> field,
          so it can&apos;t be shown as a board. Add a single-select Status field
          on GitHub.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/50 px-4 py-2">
        <span className="text-[11px] text-muted-foreground/60">
          {board?.cards.length ?? 0} items
          {board?.truncated ? " (first 300)" : ""}
        </span>
        {board && board.cards.length === 0 ? (
          <Button
            size="xs"
            variant="outline"
            className="h-7 gap-1.5 text-[11px]"
            onClick={() => void populate()}
            disabled={populating}
          >
            {populating ? (
              <Spinner className="size-3.5" />
            ) : (
              "Add open issues & PRs"
            )}
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="ghost"
          className="ml-auto h-7 w-7 p-0"
          aria-label="Refresh board"
          onClick={() => setReloadTick((t) => t + 1)}
          disabled={loading}
        >
          <HugeiconsIcon
            icon={ArrowReloadHorizontalIcon}
            size={13}
            strokeWidth={2}
            className={cn(loading && "animate-spin")}
          />
        </Button>
      </div>

      {error ? (
        <div
          role="alert"
          className="mx-4 mt-2 rounded-lg border border-destructive/20 bg-destructive/10 px-2.5 py-2 text-[11.5px] text-destructive"
        >
          {error}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
        {columns.map((col) => {
          const cards = cardsByColumn.get(col.id) ?? [];
          return (
            <div
              key={col.id ?? "__none"}
              onDragOver={(e) => {
                if (board?.statusFieldId) e.preventDefault();
              }}
              onDrop={() => void onDrop(col.id)}
              className="flex w-64 shrink-0 flex-col rounded-xl border border-border/50 bg-card/30"
            >
              <div className="flex items-center gap-2 border-b border-border/40 px-3 py-2">
                <span className="truncate text-[12px] font-semibold text-foreground">
                  {col.name}
                </span>
                <span className="ml-auto rounded-full bg-foreground/10 px-1.5 text-[10px] font-semibold text-muted-foreground">
                  {cards.length}
                </span>
              </div>
              <ul className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2">
                {cards.map((card) => (
                  <li key={card.itemId}>
                    <ProjectCardView
                      card={card}
                      draggable={!!board?.statusFieldId}
                      onDragStart={() => setDragItem(card.itemId)}
                      onDragEnd={() => setDragItem(null)}
                    />
                  </li>
                ))}
                {cards.length === 0 ? (
                  <li className="px-1 py-3 text-center text-[11px] text-muted-foreground/40">
                    —
                  </li>
                ) : null}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ProjectCardView({
  card,
  draggable,
  onDragStart,
  onDragEnd,
}: {
  card: BoardCard;
  draggable: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const state = cardState(card);
  return (
    <div
      role="button"
      tabIndex={0}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={() => card.url && void openUrl(card.url)}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && card.url) {
          e.preventDefault();
          void openUrl(card.url);
        }
      }}
      className={cn(
        "group flex cursor-pointer flex-col gap-1.5 rounded-lg border border-border/50 bg-background/70 px-2.5 py-2 transition-colors hover:border-border hover:bg-background",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        draggable && "active:cursor-grabbing",
      )}
    >
      <p className="line-clamp-2 text-[12px] font-medium leading-snug text-foreground">
        {card.title}
      </p>
      <div className="flex items-center gap-2 text-[10.5px] text-muted-foreground/60">
        {card.type === "PullRequest" ? (
          <HugeiconsIcon icon={GitPullRequestIcon} size={11} strokeWidth={1.9} />
        ) : card.type === "Issue" ? (
          <HugeiconsIcon icon={RecordIcon} size={11} strokeWidth={1.9} />
        ) : null}
        {card.number ? <span className="font-mono">#{card.number}</span> : null}
        {state ? (
          <span className="ml-auto">
            <StateBadge state={state} />
          </span>
        ) : null}
      </div>
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
