import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { native, type GitBranch } from "@/modules/ai/lib/native";
import {
  ArrowDown01Icon,
  GitBranchIcon,
  Loading03Icon,
  PlusSignIcon,
  Search01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

type Props = {
  repoRoot: string;
  currentBranch: string;
  isDetached?: boolean;
  /** Called after a successful checkout/create so the caller can refresh git
   * status and reload open editors. */
  onSwitched: () => void;
  /** Custom trigger element. Falls back to a built-in branch button. */
  trigger?: ReactNode;
};

function normalizeError(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return "Failed to switch branch";
}

export function BranchSwitcher({
  repoRoot,
  currentBranch,
  isDetached,
  onSwitched,
  trigger,
}: Props) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  // Synchronous in-flight latch — `busy` state lags a render, so two
  // activations in the same tick could both pass a state-based guard.
  const inFlightRef = useRef(false);

  const loadBranches = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setBranches(await native.gitBranches(repoRoot));
    } catch (e) {
      setError(normalizeError(e));
    } finally {
      setLoading(false);
    }
  }, [repoRoot]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    void loadBranches();
  }, [open, loadBranches]);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? branches.filter((b) => b.name.toLowerCase().includes(q))
    : branches;
  const exactMatch = branches.some((b) => b.name === query.trim());
  const showCreate = query.trim() !== "" && !exactMatch;
  const rowCount = filtered.length + (showCreate ? 1 : 0);

  useEffect(() => {
    setActiveIndex((i) => (i >= rowCount ? Math.max(0, rowCount - 1) : i));
  }, [rowCount]);

  // Keep the active option in view during arrow-key navigation.
  useEffect(() => {
    if (!open) return;
    document
      .getElementById(`${listboxId}-opt-${activeIndex}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open, listboxId]);

  const checkout = useCallback(
    async (name: string) => {
      if (inFlightRef.current) return;
      if (name === currentBranch) {
        setOpen(false);
        return;
      }
      inFlightRef.current = true;
      setBusy(true);
      setError(null);
      try {
        await native.gitCheckoutBranch(repoRoot, name);
        setOpen(false);
        onSwitched();
      } catch (e) {
        setError(normalizeError(e));
      } finally {
        setBusy(false);
        inFlightRef.current = false;
      }
    },
    [currentBranch, repoRoot, onSwitched],
  );

  const createBranch = useCallback(
    async (name: string) => {
      const trimmed = name.trim();
      if (inFlightRef.current || !trimmed) return;
      inFlightRef.current = true;
      setBusy(true);
      setError(null);
      try {
        await native.gitCreateBranch(repoRoot, trimmed);
        setOpen(false);
        onSwitched();
      } catch (e) {
        setError(normalizeError(e));
      } finally {
        setBusy(false);
        inFlightRef.current = false;
      }
    },
    [repoRoot, onSwitched],
  );

  const activateRow = useCallback(
    (index: number) => {
      if (index < filtered.length) void checkout(filtered[index].name);
      else if (showCreate) void createBranch(query);
    },
    [filtered, showCreate, query, checkout, createBranch],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (rowCount === 0 ? 0 : (i + 1) % rowCount));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (rowCount === 0 ? 0 : (i - 1 + rowCount) % rowCount));
    } else if (e.key === "Enter") {
      e.preventDefault();
      activateRow(activeIndex);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {trigger ?? (
          <button
            type="button"
            aria-label={
              isDetached
                ? "Detached HEAD. Switch branch"
                : `Current branch: ${currentBranch}. Switch branch`
            }
            className="flex max-w-44 shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <HugeiconsIcon icon={GitBranchIcon} size={12} strokeWidth={2} />
            <span className="truncate">
              {isDetached ? "detached" : currentBranch}
            </span>
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              size={11}
              strokeWidth={2}
              className="opacity-60"
            />
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={6}
        className="w-72 p-0"
      >
        <div className="flex items-center gap-1.5 border-b border-border/50 px-2.5 py-2">
          <HugeiconsIcon
            icon={Search01Icon}
            size={13}
            strokeWidth={1.9}
            className="shrink-0 text-muted-foreground"
          />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Switch or create branch…"
            role="combobox"
            aria-expanded
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={
              rowCount > 0 ? `${listboxId}-opt-${activeIndex}` : undefined
            }
            className="min-w-0 flex-1 bg-transparent text-[12px] text-foreground outline-none placeholder:text-muted-foreground/70"
          />
          {(loading || busy) && (
            <HugeiconsIcon
              icon={Loading03Icon}
              size={13}
              strokeWidth={2}
              className="shrink-0 animate-spin text-muted-foreground"
            />
          )}
        </div>

        <ul
          id={listboxId}
          role="listbox"
          aria-label="Branches"
          className="max-h-64 overflow-y-auto py-1"
        >
          {filtered.map((b, i) => {
            const active = i === activeIndex;
            return (
              <li
                key={b.name}
                id={`${listboxId}-opt-${i}`}
                role="option"
                aria-selected={b.current}
                tabIndex={-1}
              >
                {/* Option is focus-managed by the combobox via
                    aria-activedescendant; the inner button carries the
                    click/keyboard activation. */}
                <button
                  type="button"
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => void checkout(b.name)}
                  className={cn(
                    "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px]",
                    active
                      ? "bg-accent text-foreground"
                      : "text-foreground/90 hover:bg-accent/50",
                  )}
                >
                  <span className="flex size-3.5 shrink-0 items-center justify-center">
                    {b.current ? (
                      <HugeiconsIcon
                        icon={Tick02Icon}
                        size={13}
                        strokeWidth={2}
                        className="text-emerald-500"
                      />
                    ) : null}
                  </span>
                  <span className="flex-1 truncate">{b.name}</span>
                  {b.upstream ? (
                    <span className="shrink-0 truncate text-[10.5px] text-muted-foreground">
                      {b.upstream}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}

          {showCreate && (
            <li
              id={`${listboxId}-opt-${filtered.length}`}
              role="option"
              aria-selected={false}
              tabIndex={-1}
              className="border-t border-border/40"
            >
              <button
                type="button"
                onMouseEnter={() => setActiveIndex(filtered.length)}
                onClick={() => void createBranch(query)}
                className={cn(
                  "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px]",
                  activeIndex === filtered.length
                    ? "bg-accent text-foreground"
                    : "text-foreground/90 hover:bg-accent/50",
                )}
              >
                <HugeiconsIcon
                  icon={PlusSignIcon}
                  size={13}
                  strokeWidth={2}
                  className="shrink-0 text-muted-foreground"
                />
                <span className="truncate">
                  Create branch “{query.trim()}”
                </span>
              </button>
            </li>
          )}

          {!loading && !error && filtered.length === 0 && !showCreate && (
            <li className="px-2.5 py-2 text-[12px] text-muted-foreground">
              No branches found.
            </li>
          )}
        </ul>

        {error && (
          <div className="border-t border-border/50 px-2.5 py-1.5 text-[11px] text-red-500">
            {error}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
