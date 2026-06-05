import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { github, useGitHubStore } from "@/modules/github";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import {
  ArrowReloadHorizontalIcon,
  GitBranchIcon,
  GithubIcon,
  LockIcon,
  Logout01Icon,
  Search01Icon,
  SortingAZ01Icon,
  StarIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { relativeTime } from "../lib/items";

type GitHubRepo = {
  full_name: string;
  clone_url: string;
  private: boolean;
  description: string | null;
  language: string | null;
  stargazers_count: number;
  updated_at: string;
  default_branch: string;
  owner: { login: string };
};

type Visibility = "all" | "public" | "private";
type SortKey = "updated" | "name";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Clone a repo URL into a user-chosen location, then open it. */
  cloneRepo: (url: string) => Promise<string | null>;
};

const LANG_COLORS: Record<string, string> = {
  TypeScript: "#3178c6",
  JavaScript: "#f1e05a",
  Python: "#3572a5",
  Rust: "#dea584",
  Go: "#00add8",
  Java: "#b07219",
  "C++": "#f34b7d",
  C: "#555555",
  "C#": "#178600",
  Ruby: "#701516",
  PHP: "#4f5d95",
  Swift: "#f05138",
  Kotlin: "#a97bff",
  Dart: "#00b4ab",
  Shell: "#89e051",
  HTML: "#e34c26",
  CSS: "#563d7c",
  Vue: "#41b883",
  Svelte: "#ff3e00",
};

function langColor(lang: string | null): string {
  if (!lang) return "#8b949e";
  return LANG_COLORS[lang] ?? "#8b949e";
}

const CONTENT_CLASS =
  "flex max-h-[80vh] w-full flex-col gap-3 overflow-hidden rounded-2xl p-4 sm:max-w-[38rem]";

/**
 * Modal dialog listing the connected account's repositories so the user can
 * pick one to clone instead of pasting a URL. Cloning uses the token-aware
 * `git_clone`, so private repos work once connected. Supports searching,
 * filtering by visibility/owner, sorting, and keyboard navigation. Rendering
 * as an overlay keeps the start screen from shifting when it opens.
 */
export function CloneFromGitHub({ open, onOpenChange, cloneRepo }: Props) {
  const connection = useGitHubStore((s) => s.connection);
  const refresh = useGitHubStore((s) => s.refresh);
  const disconnect = useGitHubStore((s) => s.disconnect);

  const [repos, setRepos] = useState<GitHubRepo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("all");
  const [owner, setOwner] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("updated");
  const [error, setError] = useState<string | null>(null);
  const [cloningUrl, setCloningUrl] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const itemEls = useRef<(HTMLLIElement | null)[]>([]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const load = useCallback(() => {
    if (!open || !connection) return () => {};
    let alive = true;
    setLoading(true);
    setError(null);
    github
      .api<GitHubRepo[]>(
        "GET",
        "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
      )
      .then((list) => {
        if (alive) setRepos(list);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, connection]);

  useEffect(() => load(), [load]);

  const owners = useMemo(() => {
    if (!repos) return [];
    return Array.from(new Set(repos.map((r) => r.owner.login))).sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase()),
    );
  }, [repos]);

  const filtered = useMemo(() => {
    if (!repos) return [];
    const q = query.trim().toLowerCase();
    const result = repos.filter((r) => {
      if (q && !r.full_name.toLowerCase().includes(q)) return false;
      if (visibility === "public" && r.private) return false;
      if (visibility === "private" && !r.private) return false;
      if (owner !== "all" && r.owner.login !== owner) return false;
      return true;
    });
    result.sort((a, b) =>
      sortKey === "name"
        ? a.full_name.toLowerCase().localeCompare(b.full_name.toLowerCase())
        : new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    );
    return result;
  }, [repos, query, visibility, owner, sortKey]);

  // Keep the highlighted row in range whenever the visible set changes.
  useEffect(() => {
    setActiveIndex((i) => Math.min(Math.max(0, i), Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  // Scroll the keyboard-selected row into view.
  useEffect(() => {
    itemEls.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const onPick = useCallback(
    async (repo: GitHubRepo) => {
      if (cloningUrl) return;
      setCloningUrl(repo.clone_url);
      setError(null);
      try {
        await cloneRepo(repo.clone_url);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setCloningUrl(null);
      }
    },
    [cloningUrl, cloneRepo],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      const repo = filtered[activeIndex];
      if (repo) {
        e.preventDefault();
        void onPick(repo);
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className={CONTENT_CLASS}>
        <DialogTitle className="sr-only">Clone from GitHub</DialogTitle>

        {!connection ? (
          <div className="flex flex-col items-center gap-4 py-8 text-center">
            <span className="flex size-12 items-center justify-center rounded-2xl bg-foreground/[0.04] text-muted-foreground">
              <HugeiconsIcon icon={GithubIcon} size={24} strokeWidth={1.6} />
            </span>
            <div className="flex flex-col gap-1">
              <p className="text-[13px] font-medium text-foreground">
                Connect your GitHub account
              </p>
              <p className="max-w-[20rem] text-[11.5px] leading-relaxed text-muted-foreground">
                Browse and clone your public and private repositories without
                leaving ALTAI.
              </p>
            </div>
            <button
              type="button"
              onClick={() => openSettingsWindow("github")}
              className={cn(
                "flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3.5 py-2",
                "text-[12px] font-medium text-primary-foreground transition-colors hover:bg-primary/90",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              )}
            >
              <HugeiconsIcon icon={GithubIcon} size={14} strokeWidth={1.75} />
              Connect to GitHub
            </button>
          </div>
        ) : (
          <>
            {/* Connected account header */}
            <div className="flex items-center gap-2.5">
              <img
                src={connection.avatarUrl}
                alt=""
                draggable={false}
                className="size-8 shrink-0 rounded-full ring-2 ring-border/50"
              />
              <div className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="truncate text-[12.5px] font-semibold text-foreground">
                  {connection.name ?? connection.login}
                </span>
                <span className="truncate text-[11px] text-muted-foreground/70">
                  @{connection.login}
                  {repos ? ` · ${repos.length} repos` : ""}
                </span>
              </div>
              <button
                type="button"
                onClick={() => void disconnect()}
                className={cn(
                  "flex shrink-0 items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] text-muted-foreground/80",
                  "transition-colors hover:bg-muted/60 hover:text-foreground",
                  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                )}
              >
                <HugeiconsIcon icon={Logout01Icon} size={12} strokeWidth={1.85} />
                Disconnect
              </button>
            </div>

            {/* Search */}
            <div className="relative">
              <HugeiconsIcon
                icon={Search01Icon}
                size={14}
                strokeWidth={1.85}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/50"
              />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Search repositories…"
                aria-label="Search repositories"
                autoFocus
                spellCheck={false}
                className={cn(
                  "h-9 w-full rounded-xl border border-border/60 bg-background/60 pl-9 pr-3",
                  "text-[12.5px] text-foreground placeholder:text-muted-foreground/50",
                  "transition-colors focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                )}
              />
            </div>

            {/* Filters + sort */}
            <div className="flex items-center gap-2">
              <div className="flex rounded-lg bg-muted/40 p-0.5">
                {(["all", "public", "private"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setVisibility(v)}
                    className={cn(
                      "rounded-md px-2.5 py-1 text-[11px] font-medium capitalize transition-all",
                      visibility === v
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground/70 hover:text-foreground",
                    )}
                  >
                    {v}
                  </button>
                ))}
              </div>

              {owners.length > 1 ? (
                <select
                  value={owner}
                  onChange={(e) => setOwner(e.target.value)}
                  aria-label="Filter by owner"
                  className={cn(
                    "h-7 min-w-0 max-w-[9rem] rounded-lg border border-border/60 bg-background/60 px-2 text-[11px]",
                    "text-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  )}
                >
                  <option value="all">All owners</option>
                  {owners.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : null}

              <button
                type="button"
                onClick={() =>
                  setSortKey((k) => (k === "updated" ? "name" : "updated"))
                }
                title={
                  sortKey === "updated"
                    ? "Sorted by recently updated"
                    : "Sorted by name"
                }
                className={cn(
                  "ml-auto flex h-7 shrink-0 items-center gap-1 rounded-lg border border-border/60 bg-background/60 px-2.5 text-[11px]",
                  "text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground",
                  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                )}
              >
                <HugeiconsIcon icon={SortingAZ01Icon} size={12} strokeWidth={1.85} />
                {sortKey === "updated" ? "Recent" : "Name"}
              </button>
            </div>

            {error ? (
              <div
                role="alert"
                className="flex items-start justify-between gap-2 rounded-lg border border-destructive/20 bg-destructive/10 px-2.5 py-2 text-[11px] leading-relaxed text-destructive"
              >
                <span className="min-w-0">{error}</span>
                <button
                  type="button"
                  onClick={() => load()}
                  className="flex shrink-0 items-center gap-1 font-medium underline-offset-2 hover:underline"
                >
                  <HugeiconsIcon
                    icon={ArrowReloadHorizontalIcon}
                    size={11}
                    strokeWidth={2}
                  />
                  Retry
                </button>
              </div>
            ) : null}

            {loading || repos === null ? (
              <ul
                className="flex flex-col gap-1.5"
                aria-label="Loading repositories"
              >
                <li className="flex items-center gap-2 px-1 pb-1 text-[11.5px] text-muted-foreground">
                  <Spinner className="size-3.5" />
                  Loading your repositories…
                </li>
                {Array.from({ length: 5 }).map((_, i) => (
                  <li
                    key={i}
                    className="flex flex-col gap-2 rounded-xl border border-transparent px-3 py-2.5"
                  >
                    <div
                      className="h-3 w-2/5 animate-pulse rounded bg-muted/70"
                      style={{ animationDelay: `${i * 90}ms` }}
                    />
                    <div
                      className="h-2.5 w-3/4 animate-pulse rounded bg-muted/40"
                      style={{ animationDelay: `${i * 90}ms` }}
                    />
                    <div
                      className="h-2 w-1/4 animate-pulse rounded bg-muted/30"
                      style={{ animationDelay: `${i * 90}ms` }}
                    />
                  </li>
                ))}
              </ul>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-1 py-10 text-center">
                <HugeiconsIcon
                  icon={GithubIcon}
                  size={22}
                  strokeWidth={1.5}
                  className="text-muted-foreground/40"
                />
                <p className="text-[12px] text-muted-foreground/70">
                  {repos && repos.length > 0
                    ? "No repositories match your filters."
                    : "No repositories found."}
                </p>
              </div>
            ) : (
              <ul className="-mr-1 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-1">
                {filtered.map((repo, index) => {
                  const busy = cloningUrl === repo.clone_url;
                  const active = index === activeIndex;
                  return (
                    <li
                      key={repo.full_name}
                      ref={(el) => {
                        itemEls.current[index] = el;
                      }}
                      className="min-w-0"
                    >
                      <button
                        type="button"
                        onClick={() => void onPick(repo)}
                        onMouseEnter={() => setActiveIndex(index)}
                        disabled={!!cloningUrl}
                        className={cn(
                          "group/repo flex w-full min-w-0 flex-col gap-1 rounded-xl border px-3 py-2.5 text-left transition-all",
                          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                          "disabled:opacity-60",
                          active
                            ? "border-primary/30 bg-primary/[0.06]"
                            : "border-transparent hover:bg-muted/40",
                        )}
                      >
                        <div className="flex min-w-0 items-center gap-1.5">
                          {repo.private ? (
                            <HugeiconsIcon
                              icon={LockIcon}
                              size={11}
                              strokeWidth={1.9}
                              className="shrink-0 text-muted-foreground/70"
                            />
                          ) : null}
                          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-foreground">
                            {repo.full_name}
                          </span>
                          {busy ? (
                            <Spinner className="size-3.5 shrink-0" />
                          ) : (
                            <span className="shrink-0 text-[10.5px] text-muted-foreground/50">
                              {relativeTime(repo.updated_at)}
                            </span>
                          )}
                        </div>

                        {repo.description ? (
                          <p className="truncate text-[11px] leading-snug text-muted-foreground/75">
                            {repo.description}
                          </p>
                        ) : null}

                        <div className="flex items-center gap-3 text-[10.5px] text-muted-foreground/60">
                          {repo.language ? (
                            <span className="flex items-center gap-1.5">
                              <span
                                className="size-2 rounded-full"
                                style={{
                                  backgroundColor: langColor(repo.language),
                                }}
                              />
                              {repo.language}
                            </span>
                          ) : null}
                          {repo.default_branch ? (
                            <span className="flex items-center gap-1">
                              <HugeiconsIcon
                                icon={GitBranchIcon}
                                size={10}
                                strokeWidth={1.9}
                              />
                              {repo.default_branch}
                            </span>
                          ) : null}
                          {repo.stargazers_count > 0 ? (
                            <span className="flex items-center gap-1">
                              <HugeiconsIcon
                                icon={StarIcon}
                                size={10}
                                strokeWidth={1.9}
                              />
                              {repo.stargazers_count}
                            </span>
                          ) : null}
                          <span
                            className={cn(
                              "ml-auto text-[10.5px] font-medium text-primary opacity-0 transition-opacity",
                              active && "opacity-100",
                            )}
                          >
                            Clone ↵
                          </span>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
