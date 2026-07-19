import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { useTodosStore } from "@/modules/ai/store/todoStore";
import {
  buildItemSeed,
  buildTodoSeed,
} from "@/modules/github/lib/assignments";
import {
  BOARD_COLUMNS,
  type BoardItem,
  type BoardSource,
  issueToBoardItem,
  pullToBoardItem,
  todoToBoardItem,
} from "@/modules/github/lib/boardModel";
import { listItems, type GHItem, type RepoSlug } from "@/modules/github/lib/items";
import { useAssignmentsStore } from "@/modules/github/store/assignmentsStore";
import {
  ArrowReloadHorizontalIcon,
  Robot01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useState } from "react";
import { AssignmentsRail } from "./AssignmentsRail";
import { StateBadge } from "./itemBits";

type Props = {
  slug: RepoSlug;
};

type AssignableSource = Exclude<BoardSource, "agent">;

const SOURCE_META: Record<AssignableSource, { label: string; cls: string }> = {
  issue: { label: "Issue", cls: "bg-sky-500/15 text-sky-500" },
  pr: { label: "PR", cls: "bg-violet-500/15 text-violet-400" },
  todo: { label: "Todo", cls: "bg-amber-500/15 text-amber-500" },
};

const ALL_SOURCES: AssignableSource[] = ["issue", "pr", "todo"];

export function OverviewBoard({ slug }: Props) {
  const [issues, setIssues] = useState<GHItem[]>([]);
  const [pulls, setPulls] = useState<GHItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [assignError, setAssignError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [enabled, setEnabled] = useState<Set<AssignableSource>>(
    () => new Set(ALL_SOURCES),
  );

  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const todos = useTodosStore((s) =>
    activeSessionId ? s.bySession[activeSessionId] : undefined,
  );
  const hydrateTodos = useTodosStore((s) => s.hydrate);

  const assignments = useAssignmentsStore((s) => s.assignments);
  const assign = useAssignmentsStore((s) => s.assign);

  useEffect(() => {
    if (activeSessionId) void hydrateTodos(activeSessionId);
  }, [activeSessionId, hydrateTodos]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    Promise.all([
      listItems(slug, "issues", "all"),
      listItems(slug, "pulls", "all"),
    ])
      .then(([is, ps]) => {
        if (!alive) return;
        setIssues(is);
        setPulls(ps);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [slug, reloadTick]);

  const items = useMemo<BoardItem[]>(() => {
    const out: BoardItem[] = [];
    if (enabled.has("issue")) out.push(...issues.map(issueToBoardItem));
    if (enabled.has("pr")) out.push(...pulls.map(pullToBoardItem));
    if (enabled.has("todo")) {
      (todos ?? []).forEach((t, i) => out.push(todoToBoardItem(t, i)));
    }
    return out;
  }, [issues, pulls, todos, enabled]);

  const byColumn = useMemo(() => {
    const map = new Map<string, BoardItem[]>();
    for (const col of BOARD_COLUMNS) map.set(col.id, []);
    for (const item of items) map.get(item.status)?.push(item);
    return map;
  }, [items]);

  // Board-item keys that already have an assignment, so we don't offer a
  // duplicate "Assign agent".
  const assignedKeys = useMemo(() => {
    const set = new Set<string>();
    for (const a of assignments) {
      if (a.source.kind === "issue") set.add(`issue-${a.source.number}`);
      else if (a.source.kind === "pr") set.add(`pr-${a.source.number}`);
      else if (a.source.kind === "todo") set.add(`todo-${a.source.todoId}`);
    }
    return set;
  }, [assignments]);

  const toggleSource = (s: AssignableSource) =>
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const onAssign = async (card: BoardItem) => {
    setAssignError(null);
    try {
      if (
        (card.source === "issue" || card.source === "pr") &&
        card.number != null
      ) {
        const arr = card.source === "issue" ? issues : pulls;
        const gh = arr.find((x) => x.number === card.number);
        const seed = buildItemSeed({
          kind: card.source,
          owner: slug.owner,
          repo: slug.repo,
          number: card.number,
          title: card.title,
          body: gh?.body ?? null,
        });
        await assign({
          source: {
            kind: card.source,
            owner: slug.owner,
            repo: slug.repo,
            number: card.number,
            url: card.url ?? "",
          },
          title: `🤖 ${SOURCE_META[card.source].label} #${card.number} · ${card.title}`,
          seed,
        });
      } else if (card.source === "todo") {
        const todoId = card.key.replace(/^todo-/, "");
        await assign({
          source: { kind: "todo", todoId },
          title: `🤖 ${card.title}`,
          seed: buildTodoSeed(card.title),
        });
      }
    } catch (e) {
      setAssignError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex h-full w-full flex-col">
      <AssignmentsRail />

      {/* Source filters */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border/50 px-4 py-2">
        {ALL_SOURCES.map((s) => {
          const on = enabled.has(s);
          const count = items.filter((it) => it.source === s).length;
          return (
            <button
              key={s}
              type="button"
              onClick={() => toggleSource(s)}
              className={cn(
                "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors",
                on
                  ? SOURCE_META[s].cls
                  : "text-muted-foreground/50 hover:text-muted-foreground",
              )}
            >
              {SOURCE_META[s].label}
              <span className="opacity-70">{count}</span>
            </button>
          );
        })}
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

      {error || assignError ? (
        <div
          role="alert"
          className="mx-4 mt-2 rounded-lg border border-destructive/20 bg-destructive/10 px-2.5 py-2 text-[11.5px] text-destructive"
        >
          {assignError ?? error}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
        {BOARD_COLUMNS.map((col) => {
          const cards = byColumn.get(col.id) ?? [];
          return (
            <div
              key={col.id}
              className="flex w-72 shrink-0 flex-col rounded-xl border border-border/50 bg-card/30"
            >
              <div className="flex items-center gap-2 border-b border-border/40 px-3 py-2">
                <span className="text-[12px] font-semibold text-foreground">
                  {col.name}
                </span>
                <span className="ml-auto rounded-full bg-foreground/10 px-1.5 text-[10px] font-semibold text-muted-foreground">
                  {cards.length}
                </span>
              </div>
              <ul className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2">
                {loading && cards.length === 0 ? (
                  <li className="flex items-center gap-2 px-1 py-3 text-[11px] text-muted-foreground/60">
                    <Spinner className="size-3.5" />
                    Loading…
                  </li>
                ) : null}
                {cards.map((card) => (
                  <li key={card.key}>
                    <OverviewCardView
                      card={card}
                      assigned={assignedKeys.has(card.key)}
                      onAssign={() => void onAssign(card)}
                    />
                  </li>
                ))}
                {!loading && cards.length === 0 ? (
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

function OverviewCardView({
  card,
  assigned,
  onAssign,
}: {
  card: BoardItem;
  assigned: boolean;
  onAssign: () => void;
}) {
  const clickable = !!card.url;
  const source = card.source === "agent" ? null : SOURCE_META[card.source];
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border/50 bg-background/70 px-2.5 py-2">
      <button
        type="button"
        onClick={() => card.url && void openUrl(card.url)}
        disabled={!clickable}
        className={cn(
          "flex flex-col gap-1.5 text-left",
          clickable && "cursor-pointer",
        )}
      >
        <p className="line-clamp-2 text-[12px] font-medium leading-snug text-foreground">
          {card.title}
        </p>
        <div className="flex items-center gap-2 text-[10.5px] text-muted-foreground/60">
          {source ? (
            <span
              className={cn(
                "rounded px-1.5 py-px text-[9.5px] font-semibold uppercase",
                source.cls,
              )}
            >
              {source.label}
            </span>
          ) : null}
          {card.number ? <span className="font-mono">#{card.number}</span> : null}
          {card.meta ? <span className="truncate">{card.meta}</span> : null}
          {card.badge ? (
            <span className="ml-auto">
              <StateBadge state={card.badge} />
            </span>
          ) : null}
        </div>
      </button>

      {assigned ? (
        <span className="flex items-center gap-1 text-[10px] font-medium text-emerald-500">
          <HugeiconsIcon icon={Robot01Icon} size={11} strokeWidth={1.9} />
          Agent assigned
        </span>
      ) : (
        <button
          type="button"
          onClick={onAssign}
          className="flex items-center gap-1 self-start rounded-md px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground/70 transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          <HugeiconsIcon icon={Robot01Icon} size={11} strokeWidth={1.9} />
          Assign agent
        </button>
      )}
    </div>
  );
}
