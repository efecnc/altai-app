import { cn } from "@/lib/utils";
import { MOD_KEY, fmtShortcut } from "@/lib/platform";
import { Kbd } from "@/components/ui/kbd";
import { useChat, type UIMessage } from "@ai-sdk/react";
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
import { useEffect, useMemo } from "react";
import type { AgentIconId } from "../lib/agents";
import type { SessionMeta } from "../lib/sessions";
import { getOrCreateChat, useChatStore } from "../store/chatStore";
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
      if (e.key === "Escape") {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      data-ai-side-panel
      className="flex h-full min-h-0 flex-col bg-card text-[12px]"
    >
      <SessionTabs />
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
    </div>
  );
}

function SessionTabs() {
  const sessions = useChatStore((s) => s.sessions);
  const activeId = useChatStore((s) => s.activeSessionId);
  const switchSession = useChatStore((s) => s.switchSession);
  const newSession = useChatStore((s) => s.newSession);
  const deleteSession = useChatStore((s) => s.deleteSession);

  return (
    <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-border/40 bg-transparent px-1.5">
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {sessions.map((session) => (
          <SessionTab
            key={session.id}
            session={session}
            active={session.id === activeId}
            onSelect={() => switchSession(session.id)}
            onDelete={() => deleteSession(session.id)}
            canDelete={sessions.length > 1}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={() => newSession()}
        title="New chat session"
        aria-label="New chat session"
        className={cn(
          "inline-flex size-6 shrink-0 items-center justify-center rounded-md",
          "text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        )}
      >
        <HugeiconsIcon icon={Add01Icon} size={13} strokeWidth={1.75} />
      </button>
      <ChatHistory />
    </div>
  );
}

function SessionTab({
  session,
  active,
  onSelect,
  onDelete,
  canDelete,
}: {
  session: SessionMeta;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
  canDelete: boolean;
}) {
  return (
    <div
      role="tab"
      aria-selected={active}
      onClick={onSelect}
      title={session.title || "New chat"}
      className={cn(
        "group flex h-6 min-w-0 max-w-44 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[11px] transition-colors",
        active
          ? "bg-foreground/[0.07] text-foreground"
          : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground/85",
      )}
    >
      <span className="min-w-0 flex-1 truncate">
        {session.title || "New chat"}
      </span>
      {canDelete ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title="Close session"
          aria-label="Close session"
          className={cn(
            "inline-flex size-3.5 shrink-0 items-center justify-center rounded transition-opacity",
            "hover:bg-foreground/10",
            active
              ? "opacity-60 hover:opacity-100"
              : "opacity-0 group-hover:opacity-60",
          )}
        >
          <HugeiconsIcon icon={Cancel01Icon} size={9} strokeWidth={2} />
        </button>
      ) : null}
    </div>
  );
}

function Body({ sessionId }: { sessionId: string }) {
  const focusInput = useChatStore((s) => s.focusInput);
  const backendMode = useChatStore((s) => s.backendMode);
  const nativeMessages = useChatStore((s) => s.nativeMessages);
  const agentStatus = useChatStore((s) => s.agentMeta.status);

  const chat = useMemo(() => getOrCreateChat(sessionId), [sessionId]);
  const helpers = useChat<UIMessage>({ chat });

  const isNative = backendMode === "isanagent";
  const displayMessages = isNative ? nativeMessages : helpers.messages;
  const displayStatus = isNative
    ? agentStatus === "streaming" || agentStatus === "thinking"
      ? "streaming"
      : "ready"
    : helpers.status;

  return (
    <>
      <PlanModeStrip />

      <div className="flex min-h-0 flex-1 flex-col">
        {displayMessages.length === 0 ? (
          <EmptyState onPick={focusInput} />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col [&_.text-sm]:text-[12.5px] [&_p]:leading-relaxed">
            <AiChatView
              messages={displayMessages}
              status={displayStatus}
              error={helpers.error}
              clearError={helpers.clearError}
              addToolApprovalResponse={helpers.addToolApprovalResponse}
              stop={helpers.stop}
            />
          </div>
        )}
      </div>

      <TodoStrip sessionId={sessionId} />
    </>
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
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-10">
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

      <div className="mt-7 flex w-full flex-col">
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

      <div className="mt-8 flex items-center justify-center gap-1.5 text-[10px] text-muted-foreground/70">
        <span>Toggle with</span>
        <Kbd className="h-4 gap-px px-1.5 font-mono text-[10px]">
          {fmtShortcut(MOD_KEY, "I")}
        </Kbd>
      </div>
    </div>
  );
}
