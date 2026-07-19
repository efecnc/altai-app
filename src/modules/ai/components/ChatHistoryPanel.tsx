import { cn } from "@/lib/utils";
import {
  Add01Icon,
  Cancel01Icon,
  Delete02Icon,
  PencilEdit02Icon,
  Search01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadMessages, type SessionMeta } from "../lib/sessions";
import { useChatStore } from "../store/chatStore";

type DateGroup = { label: string; items: SessionMeta[] };

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function bucketFor(ts: number, nowDay: number): string {
  const day = startOfDay(ts);
  if (day === nowDay) return "Today";
  if (day === nowDay - DAY_MS) return "Yesterday";
  if (day > nowDay - 7 * DAY_MS) return "Previous 7 days";
  if (day > nowDay - 30 * DAY_MS) return "Previous 30 days";
  return "Older";
}

const GROUP_ORDER = [
  "Today",
  "Yesterday",
  "Previous 7 days",
  "Previous 30 days",
  "Older",
];

function extractSnippet(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    for (const p of m.parts) {
      if (p.type !== "text") continue;
      const raw = (p as { text?: string }).text ?? "";
      const cleaned = raw
        .replace(/<terminal-context[\s\S]*?<\/terminal-context>\s*/g, "")
        .replace(/<git-diff[\s\S]*?<\/git-diff>\s*/g, "")
        .replace(/<folder[\s\S]*?<\/folder>\s*/g, "")
        .replace(/<selection[\s\S]*?<\/selection>\s*/g, "")
        .replace(/<file[\s\S]*?<\/file>\s*/g, "")
        .replace(/<env>[\s\S]*?<\/env>\s*/gi, "")
        .replace(/\s+/g, " ")
        .trim();
      if (cleaned) {
        return cleaned.length > 90 ? `${cleaned.slice(0, 90)}…` : cleaned;
      }
    }
  }
  return "";
}

/**
 * Inline, Kilo-Code-style chat history view. Renders in place of the
 * conversation when toggled open: search + a "New chat" action + sessions
 * grouped by recency. Sessions are durable — they live here until explicitly
 * deleted; the trash icon is the only way to remove one permanently.
 */
export function ChatHistoryPanel({ onClose }: { onClose: () => void }) {
  const sessions = useChatStore((s) => s.sessions);
  const activeId = useChatStore((s) => s.activeSessionId);
  const switchSession = useChatStore((s) => s.switchSession);
  const newSession = useChatStore((s) => s.newSession);
  const deleteSession = useChatStore((s) => s.deleteSession);
  const renameSession = useChatStore((s) => s.renameSession);

  const [search, setSearch] = useState("");
  const [snippets, setSnippets] = useState<Record<string, string>>({});
  const loadedRef = useRef<Set<string>>(new Set());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }, []);

  // Lazy load snippets so each row can show a preview of the conversation.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      for (const s of sessions) {
        if (loadedRef.current.has(s.id)) continue;
        loadedRef.current.add(s.id);
        const msgs = await loadMessages(s.id);
        if (cancelled) return;
        const snippet = extractSnippet(msgs ?? []);
        setSnippets((prev) =>
          prev[s.id] === snippet ? prev : { ...prev, [s.id]: snippet },
        );
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [sessions]);

  useEffect(() => {
    if (renamingId) {
      requestAnimationFrame(() => {
        const el = renameInputRef.current;
        if (el) {
          el.focus();
          el.select();
        }
      });
    }
  }, [renamingId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => {
      const title = (s.title || "New chat").toLowerCase();
      if (title.includes(q)) return true;
      const snippet = snippets[s.id] ?? "";
      return snippet.toLowerCase().includes(q);
    });
  }, [sessions, search, snippets]);

  const groups = useMemo<DateGroup[]>(() => {
    const nowDay = startOfDay(Date.now());
    const map = new Map<string, SessionMeta[]>();
    for (const s of filtered) {
      const label = bucketFor(s.updatedAt, nowDay);
      const arr = map.get(label) ?? [];
      arr.push(s);
      map.set(label, arr);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    return GROUP_ORDER.filter((label) => map.has(label)).map((label) => ({
      label,
      items: map.get(label)!,
    }));
  }, [filtered]);

  const handlePick = useCallback(
    (id: string) => {
      switchSession(id);
      onClose();
    },
    [switchSession, onClose],
  );

  const handleNew = useCallback(() => {
    newSession();
    onClose();
  }, [newSession, onClose]);

  const commitRename = useCallback(() => {
    if (!renamingId) return;
    const trimmed = renameValue.trim();
    if (trimmed) renameSession(renamingId, trimmed);
    setRenamingId(null);
    setRenameValue("");
  }, [renamingId, renameValue, renameSession]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-card">
      <div className="flex shrink-0 flex-col gap-2 border-b border-border/60 px-2.5 py-2">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleNew}
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11.5px] font-medium",
              "bg-foreground/[0.07] text-foreground transition-colors hover:bg-foreground/[0.12]",
            )}
          >
            <HugeiconsIcon icon={Add01Icon} size={13} strokeWidth={2} />
            New chat
          </button>
        </div>
        <div className="flex items-center gap-2 rounded-md bg-background/60 px-2">
          <HugeiconsIcon
            icon={Search01Icon}
            size={13}
            strokeWidth={1.75}
            className="shrink-0 text-muted-foreground/80"
          />
          <input
            ref={searchInputRef}
            aria-label="Search chat history"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && search) {
                e.stopPropagation();
                setSearch("");
              }
            }}
            placeholder="Search chat history…"
            className="w-full bg-transparent py-1.5 text-[12px] outline-none placeholder:text-muted-foreground/60"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {groups.length === 0 ? (
          <div className="px-3 py-8 text-center text-[11px] text-muted-foreground/70">
            {search ? "No chats match." : "No chats yet."}
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.label} className="px-1">
              <div className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">
                {group.label}
              </div>
              {group.items.map((session) => {
                const title = session.title || "New chat";
                const renaming = renamingId === session.id;
                return (
                  <div
                    key={session.id}
                    role="button"
                    tabIndex={renaming ? -1 : 0}
                    onClick={() => {
                      if (!renaming) handlePick(session.id);
                    }}
                    onKeyDown={(e) => {
                      if (renaming) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handlePick(session.id);
                      }
                    }}
                    className={cn(
                      "group relative flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                      session.id === activeId
                        ? "bg-accent text-foreground"
                        : "hover:bg-accent/50",
                    )}
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      {renaming ? (
                        <input
                          ref={renameInputRef}
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              commitRename();
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              setRenamingId(null);
                              setRenameValue("");
                            }
                            e.stopPropagation();
                          }}
                          onBlur={commitRename}
                          className="w-full bg-transparent text-[12px] font-medium text-foreground outline-none"
                        />
                      ) : (
                        <span className="truncate text-[12px] font-medium">
                          {title}
                        </span>
                      )}
                      {snippets[session.id] ? (
                        <span className="line-clamp-1 text-[10.5px] leading-snug text-muted-foreground">
                          {snippets[session.id]}
                        </span>
                      ) : null}
                    </div>

                    {renaming ? (
                      <div className="flex shrink-0 items-center gap-0.5">
                        <RowIconButton
                          title="Save"
                          onClick={(e) => {
                            e.stopPropagation();
                            commitRename();
                          }}
                        >
                          <HugeiconsIcon icon={Tick02Icon} size={11} strokeWidth={2} />
                        </RowIconButton>
                        <RowIconButton
                          title="Cancel"
                          onClick={(e) => {
                            e.stopPropagation();
                            setRenamingId(null);
                            setRenameValue("");
                          }}
                        >
                          <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2} />
                        </RowIconButton>
                      </div>
                    ) : (
                      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                        <RowIconButton
                          title="Rename"
                          onClick={(e) => {
                            e.stopPropagation();
                            setRenamingId(session.id);
                            setRenameValue(title);
                          }}
                        >
                          <HugeiconsIcon
                            icon={PencilEdit02Icon}
                            size={11}
                            strokeWidth={1.75}
                          />
                        </RowIconButton>
                        <RowIconButton
                          title="Delete"
                          tone="destructive"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteSession(session.id);
                          }}
                        >
                          <HugeiconsIcon
                            icon={Delete02Icon}
                            size={11}
                            strokeWidth={1.75}
                          />
                        </RowIconButton>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function RowIconButton({
  title,
  onClick,
  tone,
  children,
}: {
  title: string;
  onClick: (e: React.MouseEvent) => void;
  tone?: "destructive";
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={cn(
        "inline-flex size-5 items-center justify-center rounded transition-colors",
        tone === "destructive"
          ? "text-muted-foreground/80 hover:bg-destructive/10 hover:text-destructive"
          : "text-muted-foreground/80 hover:bg-foreground/10 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
