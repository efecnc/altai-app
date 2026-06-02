import { cn } from "@/lib/utils";
import { MOD_KEY, fmtShortcut } from "@/lib/platform";
import { Kbd } from "@/components/ui/kbd";
import {
  AbsoluteIcon,
  Add01Icon,
  BookSearchIcon,
  Cancel01Icon,
  CodeIcon,
  DatabaseIcon,
  Notebook01Icon,
  PaintBrush04Icon,
  PencilEdit02Icon,
  ShieldUserIcon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect } from "react";
import type { AgentIconId } from "../lib/agents";
import type { SessionMeta } from "../lib/sessions";
import {
  sendMessage,
  stop as stopAgent,
  useChatStore,
} from "../store/chatStore";
import { useAgentsStore } from "../store/agentsStore";
import { usePlanStore } from "../store/planStore";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { AiChatView } from "./AiChat";
import { AiInputBar, AiInputBarConnect } from "./AiInputBar";
import { ChatHistory } from "./ChatHistory";
import { PlanDiffReview } from "./PlanDiffReview";
import { TodoStrip } from "./TodoStrip";

const AGENT_ICONS: Record<AgentIconId, typeof CodeIcon> = {
  coder: CodeIcon,
  architect: AbsoluteIcon,
  reviewer: PencilEdit02Icon,
  security: ShieldUserIcon,
  designer: PaintBrush04Icon,
  paper: BookSearchIcon,
  notebook: Notebook01Icon,
  dataset: DatabaseIcon,
  spark: SparklesIcon,
};

export function AiSidePanel({
  onClose,
  hasComposer = true,
}: {
  onClose: () => void;
  hasComposer?: boolean;
}) {
  const sessionId = useChatStore((s) => s.activeSessionId);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      // Don't compete with Radix popovers/menus/dialogs — their own
      // dismiss handlers should run first. Radix sets data-state="open"
      // on triggers and renders portaled overlays with role="menu" /
      // role="listbox" / role="dialog".
      if (target?.closest('[data-state="open"]')) return;
      if (
        document.querySelector(
          '[role="menu"][data-state="open"], [role="listbox"][data-state="open"], [role="dialog"][data-state="open"]',
        )
      ) {
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside
      data-ai-side-panel
      id="altai-ai-panel"
      aria-label="AI assistant"
      className="flex h-full min-h-0 flex-col bg-card text-[12px]"
    >
      <SessionTabs onCloseLast={onClose} />
      {sessionId ? (
        <Body sessionId={sessionId} />
      ) : (
        <div className="flex flex-1 items-center justify-center text-[11px] text-muted-foreground">
          Loading sessions…
        </div>
      )}
      {hasComposer ? (
        <AiInputBar />
      ) : (
        <AiInputBarConnect onAdd={() => void openSettingsWindow("models")} />
      )}
      <PlanDiffReview />
    </aside>
  );
}

function SessionTabs({ onCloseLast }: { onCloseLast: () => void }) {
  const sessions = useChatStore((s) => s.sessions);
  const activeId = useChatStore((s) => s.activeSessionId);
  const switchSession = useChatStore((s) => s.switchSession);
  const newSession = useChatStore((s) => s.newSession);
  const deleteSession = useChatStore((s) => s.deleteSession);

  // When the user removes the last session, close the AI panel. The store
  // auto-creates a fresh "New chat" placeholder so the next reopen starts
  // clean — without this the user gets stuck with one undeletable pill
  // showing a stale auto-title (e.g. "Restructure the selected function
  // for...") that the panel refuses to release.
  const onSessionDelete = (id: string) => {
    const wasLast = sessions.length === 1;
    deleteSession(id);
    if (wasLast) onCloseLast();
  };

  // ARIA tablist arrow / Home / End / Delete navigation. Auto-activation
  // (moving focus also switches the session) — most common pattern; JAWS
  // announces "tab N of M selected" on each move, but only when focus
  // actually lands on the new tab. After we mutate state, React re-renders
  // with `tabIndex={0}` on the new active tab — at that point we explicitly
  // move focus to it. Without this the SR keeps reading the old tab.
  const onTablistKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const idx = sessions.findIndex((s) => s.id === activeId);
    if (idx < 0) return;
    const total = sessions.length;
    let next = idx;
    let handled = false;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      next = (idx + 1) % total;
      handled = true;
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      next = (idx - 1 + total) % total;
      handled = true;
    } else if (e.key === "Home") {
      next = 0;
      handled = true;
    } else if (e.key === "End") {
      next = total - 1;
      handled = true;
    } else if (e.key === "Delete") {
      e.preventDefault();
      const wasLast = total === 1;
      deleteSession(sessions[idx].id);
      if (wasLast) {
        onCloseLast();
      } else {
        // The store picked a new active session; move focus to whichever
        // tab is now selected so the SR announces the new selection.
        moveFocusToActiveTab(e.currentTarget);
      }
      return;
    } else {
      return;
    }
    if (!handled) return;
    e.preventDefault();
    switchSession(sessions[next].id);
    moveFocusToActiveTab(e.currentTarget);
  };

  /**
   * After React re-renders with the new active session, the tab that owns
   * `tabIndex=0` changes. Move focus there explicitly so JAWS / NVDA /
   * VoiceOver announce the new selection. Without this the SR re-reads
   * the *old* tab because focus never left it.
   */
  function moveFocusToActiveTab(tablist: HTMLDivElement) {
    requestAnimationFrame(() => {
      const selected = tablist.querySelector<HTMLElement>(
        '[role="tab"][aria-selected="true"]',
      );
      selected?.focus();
    });
  }

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/40 bg-transparent px-2">
      {/* WAI-ARIA tablist with roving tabindex: focus lives on the active tab,
          not the tablist itself, so the container is intentionally not focusable. */}
      {/* eslint-disable-next-line jsx-a11y/interactive-supports-focus */}
      <div
        role="tablist"
        aria-label="Chat sessions"
        aria-orientation="horizontal"
        onKeyDown={onTablistKey}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {sessions.map((session, i) => (
          <SessionTab
            key={session.id}
            session={session}
            active={session.id === activeId}
            position={i + 1}
            total={sessions.length}
            onSelect={() => switchSession(session.id)}
            onDelete={() => onSessionDelete(session.id)}
            // Always allow closing — even the last chat. Removing the last
            // pill closes the AI panel; the store creates a fresh "New
            // chat" silently so the next reopen starts clean.
            canDelete={true}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={() => newSession()}
        title="New chat session"
        aria-label="New chat session"
        className={cn(
          "inline-flex size-7 shrink-0 items-center justify-center rounded-md",
          "text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground",
        )}
      >
        <HugeiconsIcon icon={Add01Icon} size={14} strokeWidth={1.75} />
      </button>
      <ChatHistory />
    </div>
  );
}

function SessionTab({
  session,
  active,
  position,
  total,
  onSelect,
  onDelete,
  canDelete,
}: {
  session: SessionMeta;
  active: boolean;
  position: number;
  total: number;
  onSelect: () => void;
  onDelete: () => void;
  canDelete: boolean;
}) {
  const title = session.title || "New chat";
  return (
    <div
      role="tab"
      aria-selected={active}
      aria-label={`${title}, tab ${position} of ${total}`}
      tabIndex={active ? 0 : -1}
      onClick={onSelect}
      onKeyDown={(e) => {
        // Enter / Space activate the focused tab (auto-activation also
        // fires on arrow keys via the parent tablist handler).
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      title={title}
      className={cn(
        // Pill geometry: h-7 (28px) inside the h-9 (36px) strip gives a
        // proper 4 px top/bottom breathing margin. max-w-52 (208px) lets
        // longer titles read before truncating.
        "group/tab relative flex h-7 min-w-0 max-w-52 shrink-0 cursor-pointer items-center rounded-md text-[11.5px] outline-none transition-colors",
        // Padding is asymmetric: roomy on the left for the title, tighter
        // on the right where the X sits. When the close button is hidden
        // the right padding matches the left for symmetry.
        canDelete ? "pl-2.5 pr-1" : "px-2.5",
        // Active state lights up clearly via bg + medium weight; inactive
        // hover is a much softer ghost.
        active
          ? "bg-foreground/[0.09] font-medium text-foreground"
          : "text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground/90",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {canDelete ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          onKeyDown={(e) => {
            // Don't let Enter/Space bubble — the parent tab handler would
            // re-activate the tab and the parent tablist handler would
            // intercept the keystroke.
            if (e.key === "Enter" || e.key === " ") e.stopPropagation();
          }}
          title="Close session"
          aria-label={`Close session ${title}`}
          className={cn(
            // 24×24 hit area satisfies WCAG 2.5.8. The visible chrome lives
            // on a perfectly round 18×18 pip below — that's the geometry
            // the eye reads. The outer 24×24 region stays transparent so
            // there's no awkward squared-off hover slab next to the title.
            "group/closex ml-0.5 inline-flex size-6 shrink-0 items-center justify-center outline-none",
            "transition-opacity duration-150",
            // Hidden by default; appears in one step when the pill is
            // hovered. Snap-on feels more native at this scale than a
            // graded opacity cascade.
            "opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100",
          )}
        >
          <span
            className={cn(
              // 18×18 round pip. The size is chosen to look balanced inside
              // a 28-px pill while keeping a 3-px breathing gap to the
              // outer hit area on every side.
              "inline-flex size-[18px] items-center justify-center rounded-full",
              "text-muted-foreground/80 transition-colors duration-150",
              "group-hover/closex:bg-foreground/15 group-hover/closex:text-foreground",
              "group-focus-visible/closex:bg-foreground/15 group-focus-visible/closex:text-foreground group-focus-visible/closex:ring-1 group-focus-visible/closex:ring-foreground/20",
            )}
          >
            <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2.5} />
          </span>
        </button>
      ) : null}
    </div>
  );
}

function Body({ sessionId }: { sessionId: string }) {
  const focusInput = useChatStore((s) => s.focusInput);
  const nativeMessages = useChatStore((s) => s.nativeMessages);
  const agentStatus = useChatStore((s) => s.agentMeta.status);
  const errorText = useChatStore((s) => s.agentMeta.error);
  const respondToApproval = useChatStore((s) => s.respondToApproval);
  const patchAgentMeta = useChatStore((s) => s.patchAgentMeta);

  const displayMessages = nativeMessages;
  const displayStatus =
    agentStatus === "streaming" || agentStatus === "thinking"
      ? "streaming"
      : "ready";

  return (
    <div
      role="tabpanel"
      aria-label="Active chat session"
      tabIndex={-1}
      className="flex min-h-0 flex-1 flex-col"
    >
      <PlanModeStrip />

      <div className="flex min-h-0 flex-1 flex-col">
        {displayMessages.length === 0 ? (
          <EmptyState onPick={focusInput} />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col [&_.text-sm]:text-[12.5px] [&_p]:leading-relaxed">
            <AiChatView
              messages={displayMessages}
              status={displayStatus}
              error={errorText ? new Error(errorText) : undefined}
              clearError={() => patchAgentMeta({ error: null })}
              addToolApprovalResponse={({ id, approved }) =>
                respondToApproval(id, approved)
              }
              stop={stopAgent}
            />
          </div>
        )}
      </div>

      <ClarificationChoices />
      <TodoStrip sessionId={sessionId} />
    </div>
  );
}

function ClarificationChoices() {
  const choices = useChatStore((s) => s.pendingChoices);
  if (!choices || choices.length === 0) return null;
  return (
    <div
      role="group"
      aria-label="Suggested replies"
      className="flex shrink-0 flex-wrap gap-1.5 border-t border-border/40 px-3 py-2"
    >
      <span aria-live="polite" className="sr-only">
        {choices.length} suggested{" "}
        {choices.length === 1 ? "reply" : "replies"} available
      </span>
      {choices.map((choice, i) => (
        <button
          key={`${i}-${choice}`}
          type="button"
          onClick={() => void sendMessage(choice)}
          className="rounded-full border border-border/60 bg-card/60 px-3 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-accent"
        >
          {choice}
        </button>
      ))}
    </div>
  );
}

function PlanModeStrip() {
  const active = usePlanStore((s) => s.active);
  const queueLen = usePlanStore((s) => s.queue.length);
  const disable = usePlanStore((s) => s.disable);
  if (!active) return null;
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border/40 bg-amber-500/[0.06] px-3 py-1.5">
      <span className="size-1.5 shrink-0 rounded-full bg-amber-500" />
      <span className="text-[11px] font-medium text-foreground">Plan mode</span>
      <span className="text-[11px] text-muted-foreground">
        {queueLen > 0 ? `· ${queueLen} queued` : "· no edits queued"}
      </span>
      <span className="flex-1" />
      <button
        type="button"
        onClick={() => disable()}
        className="rounded px-1.5 py-0.5 text-[10.5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        Exit
      </button>
    </div>
  );
}

type Example = { title: string; description: string };

const EXAMPLES_BY_AGENT: Record<string, Example[]> = {
  coder: [
    {
      title: "Refactor for clarity",
      description:
        "Restructure the selected function for readability while preserving behavior.",
    },
    {
      title: "Add tests",
      description:
        "Generate focused unit tests for the active file, covering happy paths and edges.",
    },
    {
      title: "Explain this code",
      description:
        "Walk through what the active file does, line by line, in plain English.",
    },
    {
      title: "Debug the last error",
      description:
        "Trace the failure from the terminal output back to the most likely cause.",
    },
  ],
  architect: [
    {
      title: "Plan a feature",
      description:
        "Sketch a high-level implementation plan with phases, risks, and open questions.",
    },
    {
      title: "Compare approaches",
      description:
        "Weigh two designs for the same problem and recommend one with reasoning.",
    },
    {
      title: "Define module boundaries",
      description:
        "Propose how to split this feature across modules with clear interfaces.",
    },
    {
      title: "Find missing edge cases",
      description:
        "Audit the current design for gaps, failure modes, and silent assumptions.",
    },
  ],
  reviewer: [
    {
      title: "Review the staged diff",
      description:
        "Spot bugs, risky changes, and missing tests in the current diff.",
    },
    {
      title: "Performance pass",
      description:
        "Find slow paths, redundant work, or wasteful allocations in this function.",
    },
    {
      title: "Coverage check",
      description:
        "Identify untested branches in the recent changes and suggest tests.",
    },
    {
      title: "Readability pass",
      description:
        "Suggest small non-behavioral improvements for naming and structure.",
    },
  ],
  security: [
    {
      title: "Threat-model this endpoint",
      description:
        "Enumerate likely attack paths against the active route and rank them.",
    },
    {
      title: "Auth & authz audit",
      description:
        "Check the selected file for authentication and authorization gaps.",
    },
    {
      title: "Injection check",
      description:
        "Hunt for SQL, XSS, or command-injection risks in this query or template.",
    },
    {
      title: "Secrets audit",
      description:
        "Look for hard-coded credentials or unsafe secret handling in this module.",
    },
  ],
  designer: [
    {
      title: "Critique this screen",
      description:
        "Point out the top UX issues and propose concrete fixes for each.",
    },
    {
      title: "Tighter layout",
      description:
        "Suggest a cleaner visual hierarchy and spacing for this component.",
    },
    {
      title: "Better empty state",
      description:
        "Rewrite the empty-state copy and structure to guide the next action.",
    },
    {
      title: "Add micro-interactions",
      description:
        "Suggest subtle motion or feedback that would make this feel polished.",
    },
  ],
  paper: [
    {
      title: "Find the official repo",
      description:
        "Locate the reference implementation for arXiv:NNNN.NNNNN and summarize it.",
    },
    {
      title: "Reproduce a figure",
      description:
        "Recreate Figure 3 end-to-end with code, data, and exact hyperparameters.",
    },
    {
      title: "Port to PyTorch",
      description:
        "Translate the paper's algorithm into runnable, tested PyTorch code.",
    },
    {
      title: "Summarize the paper",
      description:
        "Extract key contributions, methods, assumptions, and reported results.",
    },
  ],
  notebook: [
    {
      title: "Generate EDA cell",
      description:
        "Add an exploratory data analysis cell for this CSV: shape, dtypes, summary.",
    },
    {
      title: "Plot a distribution",
      description:
        "Visualize the distribution of column X with the right chart for its dtype.",
    },
    {
      title: "Script → notebook",
      description:
        "Convert this script into clean, runnable cells with markdown commentary.",
    },
    {
      title: "Profile slow cells",
      description:
        "Identify the slowest cell in the active notebook and explain why.",
    },
  ],
  dataset: [
    {
      title: "Synthetic Q&A pairs",
      description:
        "Generate 500 prompt/response pairs suitable for supervised fine-tuning.",
    },
    {
      title: "Labelled intent set",
      description:
        "Create classification examples covering all intents in the schema.",
    },
    {
      title: "Edge-case eval set",
      description:
        "Build a small eval covering tricky inputs and known failure modes.",
    },
    {
      title: "Paraphrase augment",
      description:
        "Expand this dataset with diverse paraphrased variants that preserve labels.",
    },
  ],
};

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  const activeId = useAgentsStore((s) => s.activeId);
  const customAgents = useAgentsStore((s) => s.customAgents);
  void customAgents;

  const agents = useAgentsStore.getState().all();
  const active = agents.find((a) => a.id === activeId) ?? agents[0];
  const Icon = AGENT_ICONS[active.icon] ?? SparklesIcon;
  const examples =
    EXAMPLES_BY_AGENT[active.id] ??
    EXAMPLES_BY_AGENT[active.icon] ??
    EXAMPLES_BY_AGENT.coder;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-6">
      <div className="flex flex-1 flex-col items-center justify-center">
        <div className="flex flex-col items-center gap-3.5 text-center">
          <div className="flex size-10 items-center justify-center rounded-2xl bg-foreground/[0.04] text-foreground/80">
            <HugeiconsIcon icon={Icon} size={18} strokeWidth={1.5} />
          </div>
          <div className="space-y-0.5">
            <p className="text-[13px] font-medium tracking-tight text-foreground">
              {active.name}
            </p>
            <p className="mx-auto max-w-[20rem] text-[11.5px] leading-relaxed text-muted-foreground">
              {active.description}
            </p>
          </div>
        </div>

        <div className="mt-7 flex w-full max-w-[22rem] flex-col">
          {examples.map((ex) => (
            <button
              key={ex.title}
              type="button"
              onClick={() => onPick(ex.description)}
              className={cn(
                "group flex w-full flex-col gap-0.5 rounded-md px-3 py-2 text-left",
                "transition-colors hover:bg-foreground/[0.04]",
              )}
            >
              <span className="text-[12px] font-medium text-foreground">
                {ex.title}
              </span>
              <span className="text-[11px] leading-snug text-muted-foreground">
                {ex.description}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-center gap-1.5 pt-4 text-[10px] text-muted-foreground/70">
        <span>Toggle with</span>
        <Kbd className="h-4 gap-px px-1.5 font-mono text-[10px]">
          {fmtShortcut(MOD_KEY, "I")}
        </Kbd>
      </div>
    </div>
  );
}
