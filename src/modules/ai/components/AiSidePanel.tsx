import { cn } from "@/lib/utils";
import { MOD_KEY, fmtShortcut } from "@/lib/platform";
import { Kbd } from "@/components/ui/kbd";
import {
  AbsoluteIcon,
  Add01Icon,
  BookSearchIcon,
  Cancel01Icon,
  Clock01Icon,
  CodeIcon,
  DatabaseIcon,
  FileEditIcon,
  Notebook01Icon,
  PaintBrush04Icon,
  PencilEdit02Icon,
  ShieldUserIcon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import type { AgentIconId } from "../lib/agents";
import {
  sendMessage,
  stop as stopAgent,
  useChatStore,
} from "../store/chatStore";
import { useAgentsStore } from "../store/agentsStore";
import { usePlanStore, type AppliedPlanEdit } from "../store/planStore";
import { useTodosStore } from "../store/todoStore";
import { native, type CheckpointInfo } from "../lib/native";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { AiChatView } from "./AiChat";
import { AiInputBar, AiInputBarConnect } from "./AiInputBar";
import { AgentStatusPill } from "./AgentStatusPill";
import { ChatHistoryPanel } from "./ChatHistoryPanel";
import { PlanDiffReview } from "./PlanDiffReview";
import { TaskRunsPanel } from "./TaskRunsPanel";
import { TodoSummaryChip } from "./TodoStrip";

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

// Zustand selectors must return a stable reference when a session has no
// todos yet; allocating `[]` inside the selector triggers React's external
// store loop detector and can blank the whole renderer.
const EMPTY_TODOS: Array<{ id: string; title: string; status: string }> = [];

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

  const [historyOpen, setHistoryOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);

  useEffect(() => {
    const openReview = () => setReviewOpen(true);
    window.addEventListener("altai:open-change-review", openReview);
    return () => window.removeEventListener("altai:open-change-review", openReview);
  }, []);

  return (
    <aside
      data-ai-side-panel
      id="altai-ai-panel"
      aria-label="AI assistant"
      className="@container relative flex h-full min-h-0 flex-col overflow-hidden bg-card text-[12px]"
    >
      <WorkspaceTopbar
        onClose={onClose}
        historyOpen={historyOpen}
        onToggleHistory={() => setHistoryOpen((o) => !o)}
        inspectorOpen={inspectorOpen}
        onToggleInspector={() => setInspectorOpen((o) => !o)}
        tasksOpen={tasksOpen}
        onToggleTasks={() => setTasksOpen((o) => !o)}
        reviewOpen={reviewOpen}
        onToggleReview={() => setReviewOpen((o) => !o)}
      />
      <div className="relative grid min-h-0 flex-1 grid-cols-1 @[48rem]:grid-cols-[13.5rem_minmax(0,1fr)] @[76rem]:grid-cols-[13.5rem_minmax(0,1fr)_18rem]">
        <nav
          aria-label="Chat sessions"
          className="hidden min-h-0 border-r border-border/50 bg-muted/[0.16] @[48rem]:flex"
        >
          <ChatHistoryPanel onClose={() => undefined} />
        </nav>

        <main className="relative flex min-h-0 min-w-0 flex-col bg-background/30">
          {historyOpen ? (
            <ChatHistoryPanel onClose={() => setHistoryOpen(false)} />
          ) : sessionId ? (
            <Body />
          ) : (
            <div className="flex flex-1 items-center justify-center text-[11px] text-muted-foreground">
              Loading sessions…
            </div>
          )}
        </main>

        <RunInspector className="hidden @[76rem]:flex" />

        {inspectorOpen ? (
          <div className="absolute inset-0 z-20 flex bg-background/92 backdrop-blur-sm @[76rem]:hidden">
            <RunInspector className="flex w-full" onClose={() => setInspectorOpen(false)} />
          </div>
        ) : null}
        {tasksOpen ? <TaskRunsPanel onClose={() => setTasksOpen(false)} /> : null}
      </div>
      {!historyOpen && !inspectorOpen && !tasksOpen && <RuntimeStatusRow />}
      {!historyOpen && !inspectorOpen && !tasksOpen &&
        (hasComposer ? (
          <AiInputBar />
        ) : (
          <AiInputBarConnect onAdd={() => void openSettingsWindow("models")} />
        ))}
      <PlanDiffReview
        open={reviewOpen}
        autoOpen={!historyOpen && !inspectorOpen && !tasksOpen}
        onClose={() => setReviewOpen(false)}
      />
    </aside>
  );
}

/**
 * Slim live-status row that sits between the transcript and the input bar.
 * Shows the agent's current step / approval state so the user always knows
 * what's happening without it cluttering the conversation. Kilo-Code places
 * the equivalent indicator here rather than inside the chat scroll.
 */
function RuntimeStatusRow() {
  const agentStatus = useChatStore((s) => s.agentMeta.status);
  // Only render the row when there's something to say — when idle it
  // collapses away so the input bar hugs the transcript.
  if (agentStatus === "idle") return null;
  return (
    <div className="flex shrink-0 items-center gap-1.5 px-3 pb-0.5 pt-1">
      <AgentStatusPill hideError />
    </div>
  );
}

/**
 * The workspace topbar keeps the task context visible instead of treating the
 * chat as an isolated message list. The permanent session navigator and run
 * inspector appear when the panel is wide enough; buttons open those surfaces
 * as overlays in compact layouts.
 */
function WorkspaceTopbar({
  onClose,
  historyOpen,
  onToggleHistory,
  inspectorOpen,
  onToggleInspector,
  tasksOpen,
  onToggleTasks,
  reviewOpen,
  onToggleReview,
}: {
  onClose: () => void;
  historyOpen: boolean;
  onToggleHistory: () => void;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  tasksOpen: boolean;
  onToggleTasks: () => void;
  reviewOpen: boolean;
  onToggleReview: () => void;
}) {
  const activeId = useChatStore((s) => s.activeSessionId);
  const sessions = useChatStore((s) => s.sessions);
  const newSession = useChatStore((s) => s.newSession);
  const active = sessions.find((s) => s.id === activeId);
  const agentMeta = useChatStore((s) => s.agentMeta);
  const activeAgentId = useAgentsStore((s) => s.activeId);
  const agents = useAgentsStore.getState().all();
  const activeAgent = agents.find((agent) => agent.id === activeAgentId);
  const planActive = usePlanStore((s) => s.active);
  const title = active?.title || "New chat";

  return (
    <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border/50 bg-card/90 px-2.5 backdrop-blur">
      <button
        type="button"
        onClick={() => newSession()}
        title="New chat"
        aria-label="New chat"
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
      >
        <HugeiconsIcon icon={Add01Icon} size={14} strokeWidth={1.75} />
      </button>
      <button
        type="button"
        onClick={onToggleHistory}
        title={historyOpen ? "Back to task" : "Chat sessions"}
        aria-label={historyOpen ? "Back to task" : "Chat sessions"}
        aria-pressed={historyOpen}
        className={cn(
          "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground @[48rem]:hidden",
          historyOpen && "bg-foreground/[0.09] text-foreground",
        )}
      >
        <HugeiconsIcon icon={Clock01Icon} size={14} strokeWidth={1.75} />
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-medium text-foreground/90">
          {historyOpen ? "Chat sessions" : title}
        </div>
        {!historyOpen ? (
          <div className="mt-0.5 flex items-center gap-1.5 truncate text-[10px] text-muted-foreground">
            <span className="truncate">{activeAgent?.name ?? "Agent"}</span>
            <span aria-hidden="true">·</span>
            <span>{planActive ? "Plan" : "Build"}</span>
            {agentMeta.status !== "idle" ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="truncate">{agentMeta.step ?? "Working"}</span>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
      {!historyOpen && activeId ? (
        <TodoSummaryChip sessionId={activeId} />
      ) : null}
      <button
        type="button"
        onClick={onToggleReview}
        title={reviewOpen ? "Close change review" : "Review changes"}
        aria-label={reviewOpen ? "Close change review" : "Review changes"}
        aria-pressed={reviewOpen}
        className={cn(
          "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground",
          reviewOpen && "bg-foreground/[0.09] text-foreground",
        )}
      >
        <HugeiconsIcon icon={FileEditIcon} size={14} strokeWidth={1.75} />
      </button>
      <button
        type="button"
        onClick={onToggleInspector}
        title={inspectorOpen ? "Close run inspector" : "Open run inspector"}
        aria-label={inspectorOpen ? "Close run inspector" : "Open run inspector"}
        aria-pressed={inspectorOpen}
        className={cn(
          "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground @[76rem]:hidden",
          inspectorOpen
            ? "bg-foreground/[0.09] text-foreground"
            : "",
        )}
      >
        <HugeiconsIcon icon={SparklesIcon} size={14} strokeWidth={1.75} />
      </button>
      <button
        type="button"
        onClick={onToggleTasks}
        title={tasksOpen ? "Close background tasks" : "Background tasks"}
        aria-label={tasksOpen ? "Close background tasks" : "Background tasks"}
        aria-pressed={tasksOpen}
        className={cn(
          "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground",
          tasksOpen && "bg-foreground/[0.09] text-foreground",
        )}
      >
        <HugeiconsIcon icon={Notebook01Icon} size={14} strokeWidth={1.75} />
      </button>
      <button
        type="button"
        onClick={onClose}
        title="Close panel"
        aria-label="Close panel"
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
      >
        <HugeiconsIcon icon={Cancel01Icon} size={13} strokeWidth={1.75} />
      </button>
    </div>
  );
}

type InspectorTab =
  | "activity"
  | "research"
  | "mcp"
  | "artifacts"
  | "changes"
  | "todos"
  | "approvals"
  | "agents"
  | "snapshots";

function RunInspector({ className, onClose }: { className?: string; onClose?: () => void }) {
  const [tab, setTab] = useState<InspectorTab>("activity");
  const meta = useChatStore((s) => s.agentMeta);
  const sessionId = useChatStore((s) => s.activeSessionId);
  const planQueue = usePlanStore((s) => s.queue);
  const appliedPlanEdits = usePlanStore((s) => s.applied);
  const hydrateTodos = useTodosStore((s) => s.hydrate);
  const todos = useTodosStore((s) =>
    sessionId ? s.bySession[sessionId] ?? EMPTY_TODOS : EMPTY_TODOS,
  );
  const [checkpoints, setCheckpoints] = useState<CheckpointInfo[]>([]);

  useEffect(() => {
    if (sessionId) void hydrateTodos(sessionId);
  }, [hydrateTodos, sessionId]);

  useEffect(() => {
    let mounted = true;
    void native.checkpointList().then((items) => {
      if (mounted) setCheckpoints(items);
    });
    return () => {
      mounted = false;
    };
  }, [sessionId, planQueue.length]);

  const completedTodos = todos.filter((todo) => todo.status === "completed").length;
  const tabs: Array<{ id: InspectorTab; label: string; count?: number }> = [
    { id: "activity", label: "Activity" },
    { id: "research", label: "Research", count: meta.activity.filter((item) => item.kind === "research").length || undefined },
    { id: "mcp", label: "MCP", count: meta.activity.filter((item) => item.kind === "mcp").length || undefined },
    { id: "artifacts", label: "Files", count: meta.artifacts.length || undefined },
    { id: "changes", label: "Changes", count: planQueue.length || undefined },
    { id: "todos", label: "Todos", count: todos.length || undefined },
    { id: "approvals", label: "Approvals", count: meta.pendingApprovals.length || undefined },
    { id: "agents", label: "Agents", count: meta.activeSubagents.length || undefined },
    { id: "snapshots", label: "Undo", count: checkpoints.length + appliedPlanEdits.length || undefined },
  ];

  return (
    <aside
      aria-label="Task inspector"
      className={cn(
        "min-h-0 min-w-0 flex-col border-l border-border/50 bg-muted/[0.13]",
        className,
      )}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border/50 px-3 py-2.5">
        <span className="flex size-5 items-center justify-center rounded-md bg-foreground/[0.06] text-foreground/80">
          <HugeiconsIcon icon={SparklesIcon} size={12} strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11.5px] font-medium text-foreground">Task inspector</div>
          <div className="truncate text-[10px] text-muted-foreground">
            {meta.status === "idle" ? "Ready for the next task" : meta.step ?? "Agent is working"}
          </div>
        </div>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
            aria-label="Close run inspector"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={1.75} />
          </button>
        ) : null}
      </div>

      <div className="flex shrink-0 overflow-x-auto border-b border-border/50 px-1.5 py-1">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={cn(
              "flex h-7 items-center gap-1 rounded-md px-2 text-[10.5px] font-medium transition-colors",
              tab === item.id
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground",
            )}
          >
            {item.label}
            {item.count ? (
              <span className="rounded bg-foreground/[0.07] px-1 text-[9px] tabular-nums text-foreground/80">
                {item.count}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
        {tab === "activity" ? <ActivityInspector meta={meta} /> : null}
        {tab === "research" ? <ResearchInspector events={meta.activity.filter((item) => item.kind === "research")} /> : null}
        {tab === "mcp" ? <McpInspector events={meta.activity.filter((item) => item.kind === "mcp")} /> : null}
        {tab === "artifacts" ? <ArtifactsInspector items={meta.artifacts} /> : null}
        {tab === "changes" ? <ChangesInspector queue={planQueue} /> : null}
        {tab === "todos" ? <TodosInspector done={completedTodos} total={todos.length} todos={todos} /> : null}
        {tab === "approvals" ? <ApprovalsInspector approvals={meta.pendingApprovals} /> : null}
        {tab === "agents" ? <AgentsInspector tasks={meta.activeSubagents} /> : null}
        {tab === "snapshots" ? <SnapshotsInspector items={checkpoints} applied={appliedPlanEdits} setItems={setCheckpoints} /> : null}
      </div>
    </aside>
  );
}

function InspectorEmpty({ children }: { children: React.ReactNode }) {
  return <div className="px-2 py-8 text-center text-[11px] leading-relaxed text-muted-foreground">{children}</div>;
}

function ActivityInspector({ meta }: { meta: ReturnType<typeof useChatStore.getState>["agentMeta"] }) {
  const tokenTotal = meta.tokens.inputTokens + meta.tokens.outputTokens;
  return (
    <div className="space-y-2">
      <section className="rounded-lg border border-border/50 bg-background/60 p-2.5">
        <div className="flex items-center gap-2">
          <AgentStatusPill announce={false} />
          <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
            {tokenTotal > 0 ? `${tokenTotal.toLocaleString()} tokens` : "No tokens yet"}
          </span>
        </div>
        {meta.step ? <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{meta.step}</p> : null}
      </section>
      <section className="rounded-lg border border-border/50 bg-background/40 p-2.5">
        <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Run state</div>
        <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
          <Metric label="Approvals" value={String(meta.approvalsPending)} />
          <Metric label="Subagents" value={String(meta.activeSubagents.length)} />
          <Metric label="Input" value={meta.tokens.inputTokens.toLocaleString()} />
          <Metric label="Output" value={meta.tokens.outputTokens.toLocaleString()} />
        </div>
      </section>
      {meta.error ? (
        <section className="rounded-lg border border-destructive/30 bg-destructive/[0.06] p-2.5 text-[11px] text-destructive">
          {meta.error}
        </section>
      ) : null}
      <section className="rounded-lg border border-border/50 bg-background/40 p-2.5">
        <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Timeline</div>
        {meta.activity.length ? (
          <div className="mt-2 space-y-2">
            {[...meta.activity].reverse().map((item) => (
              <div key={item.id} className="flex gap-2">
                <span
                  className={cn(
                    "mt-1.5 size-1.5 shrink-0 rounded-full",
                    item.tone === "success"
                      ? "bg-emerald-500"
                      : item.tone === "warning"
                        ? "bg-amber-500"
                        : item.tone === "error"
                          ? "bg-destructive"
                          : "bg-sky-500",
                  )}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-[10.5px] text-foreground">{item.label}</span>
                    <time className="shrink-0 text-[9px] tabular-nums text-muted-foreground" dateTime={new Date(item.createdAt).toISOString()}>
                      {new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </time>
                  </div>
                  {item.detail ? <div className="mt-0.5 line-clamp-2 text-[9.5px] leading-relaxed text-muted-foreground">{item.detail}</div> : null}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-[10.5px] leading-relaxed text-muted-foreground">Run events will appear here as the agent works.</p>
        )}
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-foreground/[0.035] px-2 py-1.5">
      <div className="text-[9.5px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-medium tabular-nums text-foreground">{value}</div>
    </div>
  );
}

function ResearchInspector({
  events,
}: {
  events: ReturnType<typeof useChatStore.getState>["agentMeta"]["activity"];
}) {
  if (!events.length) {
    return <InspectorEmpty>Web searches, fetched pages, and paper lookups will appear here.</InspectorEmpty>;
  }
  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-sky-500/20 bg-sky-500/[0.05] p-2.5 text-[11px] leading-relaxed text-foreground">
        Research activity stays separate from implementation work so sources and retrieval steps are easy to audit.
      </div>
      {[...events].reverse().map((item) => (
        <div key={item.id} className="rounded-lg border border-border/50 bg-background/55 px-2.5 py-2">
          <div className="flex items-center gap-2">
            <span className="size-1.5 shrink-0 rounded-full bg-sky-500" />
            <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{item.label}</span>
            <time className="text-[9px] tabular-nums text-muted-foreground" dateTime={new Date(item.createdAt).toISOString()}>
              {new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </time>
          </div>
          {item.detail ? <div className="mt-1 pl-3.5 text-[10px] text-muted-foreground">{item.detail}</div> : null}
        </div>
      ))}
    </div>
  );
}

function McpInspector({
  events,
}: {
  events: ReturnType<typeof useChatStore.getState>["agentMeta"]["activity"];
}) {
  if (!events.length) {
    return <InspectorEmpty>MCP server calls will appear here when the agent uses a connected tool.</InspectorEmpty>;
  }
  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-violet-500/20 bg-violet-500/[0.055] p-2.5 text-[11px] leading-relaxed text-foreground">
        Connected MCP activity is tracked separately so external tool calls are easy to audit.
      </div>
      {[...events].reverse().map((item) => (
        <div key={item.id} className="rounded-lg border border-border/50 bg-background/55 px-2.5 py-2">
          <div className="flex items-center gap-2">
            <span className={cn("size-1.5 shrink-0 rounded-full", item.tone === "error" ? "bg-destructive" : item.tone === "success" ? "bg-emerald-500" : "bg-violet-500")} />
            <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{item.label}</span>
            <time className="text-[9px] tabular-nums text-muted-foreground" dateTime={new Date(item.createdAt).toISOString()}>
              {new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </time>
          </div>
          {item.detail ? <div className="mt-1 pl-3.5 text-[10px] text-muted-foreground">{item.detail}</div> : null}
        </div>
      ))}
    </div>
  );
}

function ArtifactsInspector({
  items,
}: {
  items: ReturnType<typeof useChatStore.getState>["agentMeta"]["artifacts"];
}) {
  if (!items.length) {
    return <InspectorEmpty>Files emitted by experiments and execution jobs will appear here.</InspectorEmpty>;
  }
  return (
    <div className="space-y-2">
      {[...items].reverse().map((item) => (
        <div key={item.id} className="flex items-center gap-2 rounded-lg border border-border/50 bg-background/55 px-2.5 py-2">
          <HugeiconsIcon icon={FileEditIcon} size={12} strokeWidth={1.75} className="shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[11px] font-medium" title={item.path}>{item.path.split(/[\\/]/).pop() || item.path}</div>
            <div className="mt-0.5 truncate font-mono text-[9.5px] text-muted-foreground">{item.path}</div>
          </div>
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent<string>("altai:open-file", { detail: item.path }))}
            className="rounded-md bg-foreground/[0.07] px-1.5 py-1 text-[10px] font-medium text-foreground hover:bg-foreground/[0.12]"
          >
            Open
          </button>
        </div>
      ))}
    </div>
  );
}

function ChangesInspector({
  queue,
}: {
  queue: ReturnType<typeof usePlanStore.getState>["queue"];
}) {
  if (!queue.length) {
    return <InspectorEmpty>Planned and agent-made changes will appear here for review.</InspectorEmpty>;
  }
  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-amber-500/25 bg-amber-500/[0.06] p-2.5 text-[11px] leading-relaxed text-foreground">
        {queue.length} proposed change{queue.length === 1 ? " is" : "s are"} waiting in plan review.
      </div>
      {queue.map((change) => {
        const beforeLines = change.originalContent.split("\n").length;
        const afterLines = change.proposedContent.split("\n").length;
        const delta = afterLines - beforeLines;
        const name = change.path.split(/[/\\]/).pop() || change.path;
        return (
          <div key={change.id} className="rounded-lg border border-border/50 bg-background/55 px-2.5 py-2">
            <div className="flex items-center gap-2">
              <HugeiconsIcon icon={FileEditIcon} size={12} strokeWidth={1.75} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] font-medium">{name}</span>
              {change.isNewFile ? <span className="text-[9.5px] text-emerald-600 dark:text-emerald-400">new</span> : null}
              {!change.isNewFile ? (
                <span className={cn("text-[9.5px] tabular-nums", delta >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-destructive")}>
                  {delta >= 0 ? "+" : ""}{delta}L
                </span>
              ) : null}
            </div>
            <div className="mt-1 truncate pl-5 font-mono text-[9.5px] text-muted-foreground">{change.path}</div>
          </div>
        );
      })}
    </div>
  );
}

function TodosInspector({ done, total, todos }: { done: number; total: number; todos: Array<{ id: string; title: string; status: string }> }) {
  if (!total) return <InspectorEmpty>The agent’s task checklist will appear here.</InspectorEmpty>;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-1 text-[10.5px] text-muted-foreground">
        <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <span className="absolute inset-y-0 left-0 rounded-full bg-foreground/70" style={{ width: `${Math.round((done / total) * 100)}%` }} />
        </span>
        <span className="tabular-nums">{done}/{total}</span>
      </div>
      {todos.map((todo) => (
        <div key={todo.id} className="flex items-start gap-2 rounded-lg border border-border/45 bg-background/50 px-2.5 py-2">
          <span className={cn("mt-1 size-1.5 shrink-0 rounded-full", todo.status === "completed" ? "bg-emerald-500" : todo.status === "in_progress" ? "bg-sky-500" : "bg-muted-foreground/50")} />
          <span className={cn("text-[11px] leading-relaxed", todo.status === "completed" && "text-muted-foreground line-through")}>{todo.title}</span>
        </div>
      ))}
    </div>
  );
}

function ApprovalsInspector({
  approvals,
}: {
  approvals: ReturnType<typeof useChatStore.getState>["agentMeta"]["pendingApprovals"];
}) {
  const respond = useChatStore((s) => s.respondToApproval);
  if (!approvals.length) {
    return <InspectorEmpty>Actions that need your approval will appear here without interrupting the task view.</InspectorEmpty>;
  }
  return (
    <div className="space-y-2">
      {approvals.map((approval) => (
        <div key={approval.id} className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-2.5">
          <div className="flex items-center gap-2">
            <span className="size-1.5 animate-pulse rounded-full bg-amber-500" />
            <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{approval.action}</span>
          </div>
          <pre className="mt-2 max-h-24 overflow-auto rounded-md bg-background/70 p-2 font-mono text-[9.5px] leading-relaxed text-muted-foreground">
            {approvalPreview(approval.payload)}
          </pre>
          <div className="mt-2 flex justify-end gap-1.5">
            <button type="button" onClick={() => respond(approval.id, false)} className="rounded-md px-2 py-1 text-[10px] font-medium text-muted-foreground hover:bg-background/70 hover:text-foreground">Deny</button>
            <button type="button" onClick={() => respond(approval.id, true)} className="rounded-md bg-foreground px-2 py-1 text-[10px] font-medium text-background hover:bg-foreground/90">Approve</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function approvalPreview(payload: unknown): string {
  try {
    const serialized = JSON.stringify(payload, null, 2) ?? String(payload);
    return serialized.length > 900 ? `${serialized.slice(0, 900)}…` : serialized;
  } catch {
    return String(payload);
  }
}

function AgentsInspector({ tasks }: { tasks: ReturnType<typeof useChatStore.getState>["agentMeta"]["activeSubagents"] }) {
  if (!tasks.length) return <InspectorEmpty>Delegated research, review, and test tasks will stay visible here.</InspectorEmpty>;
  return (
    <div className="space-y-2">
      {tasks.map((task) => (
        <div key={task.taskId} className="rounded-lg border border-border/50 bg-background/55 px-2.5 py-2">
          <div className="flex items-center gap-2">
            <span className="size-1.5 animate-pulse rounded-full bg-sky-500" />
            <span className="truncate text-[11px] font-medium">{task.displayName ?? task.agentName ?? "Subagent"}</span>
          </div>
          <div className="mt-1 truncate pl-3.5 font-mono text-[9.5px] text-muted-foreground">{task.childChatId}</div>
        </div>
      ))}
    </div>
  );
}

function SnapshotsInspector({
  items,
  applied,
  setItems,
}: {
  items: CheckpointInfo[];
  applied: AppliedPlanEdit[];
  setItems: (items: CheckpointInfo[]) => void;
}) {
  const [restoring, setRestoring] = useState<string | null>(null);
  const restoreApplied = usePlanStore((s) => s.restoreApplied);
  const [error, setError] = useState<string | null>(null);
  if (!items.length && !applied.length) return <InspectorEmpty>Before-agent-edit and reviewed-change snapshots will appear here, ready to restore safely.</InspectorEmpty>;
  const restore = async (id: string) => {
    if (restoring) return;
    setError(null);
    setRestoring(id);
    try {
      await native.checkpointRestore(id);
      setItems(await native.checkpointList());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRestoring(null);
    }
  };
  const restorePlan = async (id: string) => {
    if (restoring) return;
    setError(null);
    setRestoring(id);
    try {
      const result = await restoreApplied(id);
      if (result && !result.ok) setError(result.error ?? "Could not restore change.");
    } finally {
      setRestoring(null);
    }
  };
  return (
    <div className="space-y-2">
      {applied.length ? (
        <section className="space-y-2">
          <div className="px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Plan review</div>
          {[...applied].reverse().map((item) => (
            <div key={item.id} className="flex items-center gap-2 rounded-lg border border-border/50 bg-background/55 px-2.5 py-2">
              <HugeiconsIcon icon={FileEditIcon} size={12} strokeWidth={1.75} className="shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[11px] font-medium" title={item.path}>{item.path.split(/[\\/]/).pop()}</div>
                <div className="mt-0.5 text-[9.5px] text-muted-foreground">Accepted change · {item.isNewFile ? "removes new file" : "restores prior content"}</div>
              </div>
              <button type="button" disabled={restoring === item.id} onClick={() => void restorePlan(item.id)} className="rounded-md bg-foreground/[0.07] px-1.5 py-1 text-[10px] font-medium text-foreground hover:bg-foreground/[0.12] disabled:opacity-50">
                {restoring === item.id ? "…" : "Restore"}
              </button>
            </div>
          ))}
        </section>
      ) : null}
      {items.length ? <div className="px-1 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Agent edits</div> : null}
      {items.map((item) => (
        <div key={item.id} className="flex items-center gap-2 rounded-lg border border-border/50 bg-background/55 px-2.5 py-2">
          <HugeiconsIcon icon={FileEditIcon} size={12} strokeWidth={1.75} className="shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[11px] font-medium" title={item.path}>{item.path.split(/[\\/]/).pop()}</div>
            <div className="mt-0.5 text-[9.5px] text-muted-foreground">{item.label}</div>
          </div>
          <button type="button" disabled={restoring === item.id} onClick={() => void restore(item.id)} className="rounded-md bg-foreground/[0.07] px-1.5 py-1 text-[10px] font-medium text-foreground hover:bg-foreground/[0.12] disabled:opacity-50">
            {restoring === item.id ? "…" : "Restore"}
          </button>
        </div>
      ))}
      {error ? <div className="rounded-lg border border-destructive/30 bg-destructive/[0.06] p-2 text-[10.5px] text-destructive">{error}</div> : null}
    </div>
  );
}

function Body() {
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
