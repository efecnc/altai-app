import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  type GHItem,
  type ItemKind,
  type ItemStateFilter,
  listItems,
  relativeTime,
  type RepoSlug,
} from "@/modules/github/lib/items";
import {
  ArrowReloadHorizontalIcon,
  Comment01Icon,
  PlusSignIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useState } from "react";
import { AssignAgentButton } from "./AssignAgentButton";
import { itemState, Labels, StateBadge } from "./itemBits";

type Props = {
  slug: RepoSlug;
  kind: ItemKind;
  onKindChange: (kind: ItemKind) => void;
  onOpenItem: (kind: ItemKind, number: number) => void;
  onCreate: (kind: ItemKind) => void;
  /** Bumped by the parent to force a reload after a mutation. */
  reloadKey: number;
};

export function ItemListView({
  slug,
  kind,
  onKindChange,
  onOpenItem,
  onCreate,
  reloadKey,
}: Props) {
  const [stateFilter, setStateFilter] = useState<ItemStateFilter>("open");
  const [query, setQuery] = useState("");
  const [labelFilter, setLabelFilter] = useState<string>("all");
  const [items, setItems] = useState<GHItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    listItems(slug, kind, stateFilter)
      .then((list) => alive && setItems(list))
      .catch((e: unknown) => {
        if (alive) {
          setError(e instanceof Error ? e.message : String(e));
          setItems([]);
        }
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [slug, kind, stateFilter, reloadTick, reloadKey]);

  const labelOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const it of items) for (const l of it.labels) seen.add(l.name);
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [items]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((it) => {
      if (labelFilter !== "all" && !it.labels.some((l) => l.name === labelFilter))
        return false;
      if (!q) return true;
      return (
        it.title.toLowerCase().includes(q) || String(it.number).includes(q)
      );
    });
  }, [items, query, labelFilter]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5">
      {/* Kind tabs + New */}
      <div className="flex items-center gap-2">
        <div className="flex rounded-lg bg-muted/40 p-0.5">
          {(["pulls", "issues"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => onKindChange(k)}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-1 text-[12px] font-medium transition-all",
                kind === k
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground/70 hover:text-foreground",
              )}
            >
              {k === "pulls" ? "Pull Requests" : "Issues"}
              {kind === k ? (
                <span className="rounded-full bg-foreground/10 px-1.5 text-[10px] font-semibold">
                  {filtered.length}
                </span>
              ) : null}
            </button>
          ))}
        </div>
        <Button
          size="xs"
          variant="ghost"
          className="ml-auto h-7 gap-1 text-[11px]"
          onClick={() => onCreate(kind)}
        >
          <HugeiconsIcon icon={PlusSignIcon} size={12} strokeWidth={2} />
          {kind === "pulls" ? "New PR" : "New issue"}
        </Button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2">
        <div className="flex rounded-lg bg-muted/40 p-0.5">
          {(["open", "closed", "all"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStateFilter(s)}
              className={cn(
                "rounded-md px-2.5 py-1 text-[11px] font-medium capitalize transition-all",
                stateFilter === s
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground/70 hover:text-foreground",
              )}
            >
              {s}
            </button>
          ))}
        </div>
        {labelOptions.length > 0 ? (
          <select
            value={labelFilter}
            onChange={(e) => setLabelFilter(e.target.value)}
            aria-label="Filter by label"
            className="h-7 max-w-[8rem] rounded-lg border border-border/60 bg-background/60 px-2 text-[11px] text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="all">All labels</option>
            {labelOptions.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        ) : null}
        <div className="relative ml-auto min-w-0 flex-1">
          <HugeiconsIcon
            icon={Search01Icon}
            size={13}
            strokeWidth={1.85}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/50"
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            aria-label="Search items"
            spellCheck={false}
            className="h-7 w-full rounded-lg border border-border/60 bg-background/60 pl-7 pr-2 text-[11.5px] text-foreground placeholder:text-muted-foreground/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
        <Button
          size="xs"
          variant="ghost"
          className="h-7 w-7 p-0"
          aria-label="Refresh"
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
          className="rounded-lg border border-destructive/20 bg-destructive/10 px-2.5 py-2 text-[11.5px] text-destructive"
        >
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="flex items-center gap-2 px-1 py-6 text-[12px] text-muted-foreground">
          <Spinner className="size-3.5" />
          Loading…
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-10 text-center text-[12px] text-muted-foreground/70">
          {items.length === 0
            ? kind === "pulls"
              ? `No ${stateFilter === "all" ? "" : stateFilter} pull requests.`
              : `No ${stateFilter === "all" ? "" : stateFilter} issues.`
            : "Nothing matches your filters."}
        </div>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
          {filtered.map((it) => (
            <li key={it.number} className="min-w-0">
              <div className="flex items-center gap-1 rounded-lg border border-transparent pr-1.5 transition-colors hover:bg-muted/40">
              <button
                type="button"
                onClick={() => onOpenItem(kind, it.number)}
                className="flex min-w-0 flex-1 flex-col gap-1 rounded-lg px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <StateBadge state={itemState(it)} />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-foreground">
                    {it.title}
                  </span>
                  <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground/60">
                    #{it.number}
                  </span>
                </div>
                <div className="flex items-center gap-2.5 text-[10.5px] text-muted-foreground/60">
                  <span>
                    {it.user?.login ?? "unknown"} · {relativeTime(it.updated_at)}
                  </span>
                  {it.comments > 0 ? (
                    <span className="flex items-center gap-1">
                      <HugeiconsIcon
                        icon={Comment01Icon}
                        size={10}
                        strokeWidth={1.9}
                      />
                      {it.comments}
                    </span>
                  ) : null}
                  <div className="ml-auto">
                    <Labels labels={it.labels.slice(0, 3)} />
                  </div>
                </div>
              </button>
              <AssignAgentButton
                kind={kind === "pulls" ? "pr" : "issue"}
                slug={slug}
                number={it.number}
                title={it.title}
                body={it.body}
                url={it.html_url}
                variant="chip"
              />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
