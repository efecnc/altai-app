import { Button } from "@/components/ui/button";
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
  ArrowRight01Icon,
  Comment01Icon,
  InboxIcon,
  PlusSignIcon,
  Search01Icon,
  Tag01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useState } from "react";
import { AssignAgentButton } from "./AssignAgentButton";
import { Avatar, ItemStateIcon, itemState, Labels, StateText } from "./itemBits";

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
                <span className="rounded-full bg-foreground/10 px-1.5 text-[10px] font-semibold tabular-nums">
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
          <div className="relative">
            <HugeiconsIcon
              icon={Tag01Icon}
              size={12}
              strokeWidth={1.85}
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/50"
            />
            <select
              value={labelFilter}
              onChange={(e) => setLabelFilter(e.target.value)}
              aria-label="Filter by label"
              className={cn(
                "h-7 max-w-[9rem] cursor-pointer appearance-none rounded-lg border bg-background/60 pl-6 pr-2 text-[11px] text-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                labelFilter === "all"
                  ? "border-border/60"
                  : "border-ring/40 text-foreground",
              )}
            >
              <option value="all">All labels</option>
              {labelOptions.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </div>
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
        <SkeletonList />
      ) : filtered.length === 0 ? (
        <EmptyState
          filtered={items.length > 0}
          kind={kind}
          stateFilter={stateFilter}
        />
      ) : (
        <ul className="-mx-1 flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-1">
          {filtered.map((it) => {
            const st = itemState(it);
            const resolvedAt =
              st === "merged"
                ? it.merged_at ?? it.pull_request?.merged_at
                : st === "closed" || st === "not_planned"
                  ? it.closed_at
                  : null;
            const verb =
              st === "merged"
                ? "merged"
                : st === "closed" || st === "not_planned"
                  ? "closed"
                  : "updated";
            return (
              <li key={it.number} className="group/row min-w-0">
                <div className="flex items-stretch gap-1 rounded-xl border border-transparent pr-1.5 transition-colors hover:border-border/60 hover:bg-muted/40">
                  <button
                    type="button"
                    onClick={() => onOpenItem(kind, it.number)}
                    className="flex min-w-0 flex-1 items-start gap-2.5 rounded-xl px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <span className="mt-px flex size-5 items-center justify-center">
                      <ItemStateIcon state={st} kind={kind} size={15} />
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="flex min-w-0 items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-foreground">
                          {it.title}
                        </span>
                        <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground/50">
                          #{it.number}
                        </span>
                      </div>
                      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px] text-muted-foreground/70">
                        {st !== "open" ? (
                          <>
                            <StateText state={st} kind={kind} />
                            <span className="text-muted-foreground/40">·</span>
                          </>
                        ) : null}
                        <span className="flex items-center gap-1">
                          <Avatar url={it.user?.avatar_url} size={13} />
                          <span className="font-medium text-muted-foreground/80">
                            {it.user?.login ?? "unknown"}
                          </span>
                        </span>
                        <span className="text-muted-foreground/40">·</span>
                        <span>
                          {verb} {relativeTime(resolvedAt ?? it.updated_at)}
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
                        {it.labels.length > 0 ? (
                          <Labels labels={it.labels.slice(0, 3)} />
                        ) : null}
                      </div>
                    </div>
                    <HugeiconsIcon
                      icon={ArrowRight01Icon}
                      size={14}
                      strokeWidth={1.9}
                      className="mt-1 shrink-0 text-muted-foreground/0 transition-colors group-hover/row:text-muted-foreground/40"
                    />
                  </button>
                  <span className="flex items-center">
                    <AssignAgentButton
                      kind={kind === "pulls" ? "pr" : "issue"}
                      slug={slug}
                      number={it.number}
                      title={it.title}
                      body={it.body}
                      url={it.html_url}
                      variant="chip"
                    />
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function SkeletonList() {
  return (
    <ul className="flex flex-col gap-px px-1" aria-hidden>
      {Array.from({ length: 6 }).map((_, i) => (
        <li
          key={i}
          className="flex items-start gap-2.5 rounded-xl px-2.5 py-2.5"
          style={{ opacity: 1 - i * 0.13 }}
        >
          <span className="mt-0.5 size-3.5 shrink-0 animate-pulse rounded-full bg-muted" />
          <span className="flex min-w-0 flex-1 flex-col gap-2">
            <span
              className="h-3 animate-pulse rounded bg-muted"
              style={{ width: `${70 - i * 7}%` }}
            />
            <span className="h-2 w-1/3 animate-pulse rounded bg-muted/70" />
          </span>
        </li>
      ))}
    </ul>
  );
}

function EmptyState({
  filtered,
  kind,
  stateFilter,
}: {
  filtered: boolean;
  kind: ItemKind;
  stateFilter: ItemStateFilter;
}) {
  const noun = kind === "pulls" ? "pull requests" : "issues";
  const stateWord = stateFilter === "all" ? "" : `${stateFilter} `;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 py-12 text-center">
      <span className="flex size-10 items-center justify-center rounded-2xl bg-foreground/[0.04] text-muted-foreground/60">
        <HugeiconsIcon icon={InboxIcon} size={20} strokeWidth={1.6} />
      </span>
      <p className="text-[12.5px] font-medium text-foreground/80">
        {filtered ? "No matches" : `No ${stateWord}${noun}`}
      </p>
      <p className="max-w-[18rem] text-[11.5px] text-muted-foreground/60">
        {filtered
          ? "Try a different search or label filter."
          : `When ${noun} land here, you can open, comment, and assign an agent to them.`}
      </p>
    </div>
  );
}
