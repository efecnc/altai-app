import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { useAgentRunsStore } from "@/modules/ai/store/agentRunsStore";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { useAgentsStore } from "@/modules/ai/store/agentsStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { MODELS, type ModelId } from "@/modules/ai/config";
import { native, type InstalledSkillInfo } from "@/modules/ai/lib/native";
import type { Assignment, AssignmentStatus } from "@/modules/github/lib/assignments";
import {
  ACTIVE_ASSIGNMENT_STATES,
  useAssignmentsStore,
} from "@/modules/github/store/assignmentsStore";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { FormEvent, useEffect, useMemo, useState } from "react";

const TERMINAL: AssignmentStatus[] = ["done", "failed", "cancelled"];

function currentStatus(
  assignment: Assignment,
  run: ReturnType<typeof useAgentRunsStore.getState>["runs"][string] | undefined,
): AssignmentStatus {
  if (TERMINAL.includes(assignment.status) || !run) return assignment.status;
  if (run.status === "thinking" || run.status === "streaming") return "running";
  if (run.status === "awaiting-approval") return "awaiting-approval";
  if (run.status === "error") return "failed";
  if (run.completed) return "done";
  return assignment.status;
}

const statusCopy: Record<AssignmentStatus, string> = {
  dispatching: "Starting",
  running: "Working",
  "awaiting-approval": "Needs approval",
  done: "Done",
  failed: "Failed",
  cancelled: "Stopped",
};

const TASK_TEMPLATES = [
  {
    label: "Fix a bug",
    prompt: "Investigate the reported bug, identify the root cause, implement the smallest safe fix, and run the relevant checks.",
  },
  {
    label: "Review changes",
    prompt: "Review the current working-tree changes for correctness, regressions, security risks, and missing tests. Make only clearly necessary fixes and report the findings.",
  },
  {
    label: "Add tests",
    prompt: "Inspect the relevant implementation, add focused tests for the important behavior and edge cases, then run the narrowest useful test command.",
  },
  {
    label: "Refactor safely",
    prompt: "Find the highest-value local refactor in the relevant area. Preserve behavior, keep the diff focused, and verify the result with appropriate checks.",
  },
];

/**
 * A workspace-level task launcher. Each run has a dedicated chat_id, so a
 * long-running job never steals the current conversation or its context.
 */
export function TaskRunsPanel({ onClose }: { onClose: () => void }) {
  const assignments = useAssignmentsStore((s) => s.assignments);
  const hydrated = useAssignmentsStore((s) => s.hydrated);
  const dispatching = useAssignmentsStore((s) => s.dispatching);
  const hydrate = useAssignmentsStore((s) => s.hydrate);
  const runTask = useAssignmentsStore((s) => s.runTask);
  const updateStatus = useAssignmentsStore((s) => s.updateStatus);
  const cancel = useAssignmentsStore((s) => s.cancel);
  const remove = useAssignmentsStore((s) => s.remove);
  const runs = useAgentRunsStore((s) => s.runs);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const selectedModelId = useChatStore((s) => s.selectedModelId);
  const switchSession = useChatStore((s) => s.switchSession);
  const activeAgentId = useAgentsStore((s) => s.activeId);
  const defaultPermissionMode = usePreferencesStore((s) => s.permissionMode);
  const bypassEnabled = usePreferencesStore((s) => s.bypassPermissionsEnabled);
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [agentId, setAgentId] = useState(activeAgentId);
  const [permissionMode, setPermissionMode] = useState(defaultPermissionMode);
  const [modelId, setModelId] = useState(selectedModelId);
  const [includeFile, setIncludeFile] = useState(false);
  const [includeTerminal, setIncludeTerminal] = useState(false);
  const [includeDiff, setIncludeDiff] = useState(false);
  const [skills, setSkills] = useState<InstalledSkillInfo[]>([]);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);

  const agents = useMemo(() => {
    const store = useAgentsStore.getState();
    return store.all().filter((agent) => !store.isDisabled(agent.id));
  }, [activeAgentId]);

  const tasks = useMemo(
    () => assignments.filter((assignment) => assignment.source.kind === "task"),
    [assignments],
  );

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    let mounted = true;
    void native.workspaceCurrentDir()
      .then((workspace) => native.agentListSkills(workspace))
      .then((items) => { if (mounted) setSkills(items); })
      .catch(() => { if (mounted) setSkills([]); });
    return () => { mounted = false; };
  }, []);

  // Persist status changes even when the GitHub board is not mounted. This is
  // especially important for standalone tasks launched from the chat surface.
  useEffect(() => {
    for (const task of tasks) {
      const status = currentStatus(task, runs[task.sessionId]);
      if (status !== task.status) updateStatus(task.id, status);
    }
  }, [runs, tasks, updateStatus]);

  async function start(event: FormEvent) {
    event.preventDefault();
    if (!prompt.trim() || dispatching) return;
    setError(null);
    try {
      const taskPrompt = await addSelectedContext(prompt, {
        file: includeFile,
        terminal: includeTerminal,
        diff: includeDiff,
      });
      await runTask({
        title: prompt.trim().split("\n")[0],
        prompt: taskPrompt,
        runConfig: { agentId, modelId, permissionMode, skills: selectedSkills },
      });
      setPrompt("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't start the task.");
    }
  }

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-background/96 backdrop-blur-sm">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/50 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <h2 className="text-[12px] font-semibold text-foreground">Background tasks</h2>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            Runs stay separate from this chat and keep working while you continue here.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
          aria-label="Close background tasks"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={13} strokeWidth={1.75} />
        </button>
      </div>

      <form onSubmit={start} className="shrink-0 border-b border-border/50 p-3">
        <label htmlFor="background-task-prompt" className="text-[10.5px] font-medium text-foreground">
          Start a task
        </label>
        <textarea
          id="background-task-prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Example: Review the auth flow, fix the highest-impact issue, and run the relevant tests."
          className="mt-1.5 min-h-20 w-full resize-y rounded-lg border border-border/70 bg-muted/[0.28] px-2.5 py-2 text-[11px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/65 focus:border-sky-500/60 focus:ring-2 focus:ring-sky-500/15"
        />
        <div className="mt-2 flex flex-wrap gap-1">
          {TASK_TEMPLATES.map((template) => (
            <button
              key={template.label}
              type="button"
              onClick={() => setPrompt(template.prompt)}
              className="rounded-full border border-border/60 bg-background/50 px-2 py-1 text-[9.5px] font-medium text-muted-foreground transition-colors hover:border-sky-500/40 hover:bg-sky-500/5 hover:text-foreground"
            >
              {template.label}
            </button>
          ))}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 rounded-lg border border-border/50 bg-background/35 p-2">
          <label className="min-w-0">
            <span className="block text-[9.5px] font-medium uppercase tracking-wide text-muted-foreground">Agent</span>
            <select value={agentId} onChange={(event) => setAgentId(event.target.value)} className="mt-1 h-7 w-full rounded-md border border-border/60 bg-background px-1.5 text-[10.5px] text-foreground outline-none focus:border-sky-500/60">
              {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
            </select>
          </label>
          <label className="min-w-0">
            <span className="block text-[9.5px] font-medium uppercase tracking-wide text-muted-foreground">Model</span>
            <select value={modelId} onChange={(event) => setModelId(event.target.value as ModelId)} className="mt-1 h-7 w-full rounded-md border border-border/60 bg-background px-1.5 text-[10.5px] text-foreground outline-none focus:border-sky-500/60">
              {MODELS.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
            </select>
          </label>
          <label className="min-w-0">
            <span className="block text-[9.5px] font-medium uppercase tracking-wide text-muted-foreground">Permissions</span>
            <select value={permissionMode} onChange={(event) => setPermissionMode(event.target.value as typeof permissionMode)} className="mt-1 h-7 w-full rounded-md border border-border/60 bg-background px-1.5 text-[10.5px] text-foreground outline-none focus:border-sky-500/60">
              <option value="ask">Ask before changes</option>
              <option value="auto-edit">Auto-edit workspace</option>
              {bypassEnabled ? <option value="bypass">Bypass approvals</option> : null}
            </select>
          </label>
          <div className="col-span-2 border-t border-border/40 pt-2">
            <div className="text-[9.5px] font-medium uppercase tracking-wide text-muted-foreground">Attach context</div>
            <div className="mt-1.5 flex flex-wrap gap-1">
              <ContextToggle checked={includeFile} onChange={setIncludeFile} label="Active file" />
              <ContextToggle checked={includeTerminal} onChange={setIncludeTerminal} label="Terminal output" />
              <ContextToggle checked={includeDiff} onChange={setIncludeDiff} label="Working-tree diff" />
            </div>
          </div>
          {skills.length ? <div className="col-span-2 border-t border-border/40 pt-2">
            <div className="text-[9.5px] font-medium uppercase tracking-wide text-muted-foreground">Workspace skills</div>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {skills.map((skill) => <button key={skill.name} type="button" title={skill.description ?? skill.name} aria-pressed={selectedSkills.includes(skill.name)} onClick={() => setSelectedSkills((current) => current.includes(skill.name) ? current.filter((name) => name !== skill.name) : [...current, skill.name])} className={cn("rounded-full border px-2 py-1 text-[9.5px] font-medium transition-colors", selectedSkills.includes(skill.name) ? "border-violet-500/45 bg-violet-500/10 text-violet-700 dark:text-violet-300" : "border-border/60 bg-background/50 text-muted-foreground hover:text-foreground")}>{skill.name}</button>)}
            </div>
          </div> : null}
          <p className="col-span-2 text-[9.5px] leading-relaxed text-muted-foreground">Uses workspace scope and <span className="font-medium text-foreground/80">ALTAI.md</span> project instructions. The current chat is never modified.</p>
        </div>
        <div className="mt-2 flex items-center gap-2">
          {error ? <p className="min-w-0 flex-1 text-[10px] text-destructive">{error}</p> : <span className="flex-1" />}
          <button
            type="submit"
            disabled={!prompt.trim() || dispatching}
            className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-2.5 py-1.5 text-[10.5px] font-medium text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {dispatching ? <Spinner className="size-3" /> : null}
            Run in background
          </button>
        </div>
      </form>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {!hydrated ? (
          <div className="flex items-center justify-center gap-2 py-8 text-[11px] text-muted-foreground"><Spinner className="size-3.5" /> Loading tasks…</div>
        ) : tasks.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/70 px-4 py-8 text-center text-[11px] leading-relaxed text-muted-foreground">
            No background tasks yet. Start one above and keep chatting while it works.
          </div>
        ) : (
          <div className="space-y-2">
            {tasks.map((task) => {
              const run = runs[task.sessionId];
              const status = currentStatus(task, run);
              const active = ACTIVE_ASSIGNMENT_STATES.includes(status);
              const tokens = run ? run.tokens.input + run.tokens.output : 0;
              return (
                <article key={task.id} className="rounded-lg border border-border/60 bg-card/45 p-2.5">
                  <div className="flex items-start gap-2">
                    <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", status === "failed" ? "bg-destructive" : status === "done" ? "bg-emerald-500" : status === "cancelled" ? "bg-muted-foreground/50" : "animate-pulse bg-sky-500")} />
                    <div className="min-w-0 flex-1">
                      <h3 className="line-clamp-2 text-[11.5px] font-medium leading-snug text-foreground">{task.title.replace(/^🤖\s*/, "")}</h3>
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        <span className={cn(status === "failed" && "text-destructive", status === "done" && "text-emerald-500")}>{statusCopy[status]}</span>
                        {tokens ? ` · ${tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tokens` : ""}
                        {run?.subagents.length ? ` · ${run.subagents.length} agents` : ""}
                        {task.runConfig?.agentId ? ` · ${agents.find((agent) => agent.id === task.runConfig?.agentId)?.name ?? "Custom agent"}` : ""}
                        {task.runConfig?.modelId ? ` · ${MODELS.find((model) => model.id === task.runConfig?.modelId)?.label ?? task.runConfig.modelId}` : ""}
                        {task.runConfig?.skills?.length ? ` · ${task.runConfig.skills.join(", ")}` : ""}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void remove(task.id)}
                      aria-label="Remove task"
                      className="rounded p-0.5 text-muted-foreground/60 hover:bg-muted hover:text-foreground"
                    >
                      <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} />
                    </button>
                  </div>
                  {active && run?.step ? <p className="mt-2 flex items-center gap-1.5 truncate rounded-md bg-background/50 px-2 py-1.5 text-[10px] text-muted-foreground"><Spinner className="size-3 shrink-0" /> {run.step}</p> : null}
                  {status === "done" && run?.lastResult ? <p className="mt-2 line-clamp-3 rounded-md bg-background/50 px-2 py-1.5 text-[10px] leading-relaxed text-muted-foreground">{run.lastResult}</p> : null}
                  {(status === "done" || status === "failed") && run ? <TaskOutcome run={run} /> : null}
                  <div className="mt-2 flex items-center gap-1">
                    <button type="button" onClick={() => { switchSession(task.sessionId); onClose(); }} className="rounded-md px-2 py-1 text-[10px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground">
                      {activeSessionId === task.sessionId ? "Open now" : "Open transcript"}
                    </button>
                    {active ? <button type="button" onClick={() => void cancel(task.id)} className="ml-auto rounded-md px-2 py-1 text-[10px] font-medium text-destructive hover:bg-destructive/10">Stop</button> : null}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function ContextToggle({ checked, onChange, label }: { checked: boolean; onChange: (next: boolean) => void; label: string }) {
  return <button type="button" aria-pressed={checked} onClick={() => onChange(!checked)} className={cn("rounded-full border px-2 py-1 text-[9.5px] font-medium transition-colors", checked ? "border-sky-500/45 bg-sky-500/10 text-sky-700 dark:text-sky-300" : "border-border/60 bg-background/50 text-muted-foreground hover:text-foreground")}>{label}</button>;
}

async function addSelectedContext(
  prompt: string,
  selected: { file: boolean; terminal: boolean; diff: boolean },
): Promise<string> {
  const live = useChatStore.getState().live;
  const blocks: string[] = [];
  if (selected.file) {
    const path = live.getActiveFile();
    if (path) {
      try {
        const result = await native.readFile(path, { enforceIsanagentignore: true });
        if (result.kind === "text") blocks.push(`<active-file path="${path}">\n${result.content.slice(0, 60_000)}\n</active-file>`);
      } catch { /* unavailable files simply stay out of the task */ }
    }
  }
  if (selected.terminal && !live.isActiveTerminalPrivate()) {
    const output = live.getTerminalContext();
    if (output?.trim()) blocks.push(`<terminal-context>\n${output.trim().slice(0, 60_000)}\n</terminal-context>`);
  }
  if (selected.diff) {
    const cwd = live.getCwd() ?? live.getWorkspaceRoot();
    if (cwd) {
      try {
        const repo = await native.gitResolveRepo(cwd);
        if (repo) {
          const diff = await native.gitDiff(repo.repoRoot, null, false);
          if (diff.diffText.trim()) blocks.push(`<working-tree-diff${diff.truncated ? ' truncated="true"' : ""}>\n${diff.diffText.slice(0, 80_000)}\n</working-tree-diff>`);
        }
      } catch { /* non-git workspaces have no diff to include */ }
    }
  }
  return blocks.length ? `${prompt.trim()}\n\n<selected-context>\n${blocks.join("\n\n")}\n</selected-context>` : prompt;
}

function TaskOutcome({ run }: { run: NonNullable<ReturnType<typeof useAgentRunsStore.getState>["runs"][string]> }) {
  const checks = run.verifications.filter((item) => item.status !== "running");
  const passed = checks.filter((item) => item.status === "passed").length;
  const failed = checks.filter((item) => item.status === "failed").length;
  return (
    <section className="mt-2 rounded-md border border-border/50 bg-background/35 p-2">
      <div className="flex items-center gap-2 text-[9.5px] font-medium uppercase tracking-wide text-muted-foreground">
        <span>Outcome</span>
        {run.changes.length ? <span className="rounded bg-sky-500/10 px-1.5 py-0.5 normal-case text-sky-700 dark:text-sky-300">{run.changes.length} file{run.changes.length === 1 ? "" : "s"} changed</span> : null}
        {failed ? <span className="rounded bg-destructive/10 px-1.5 py-0.5 normal-case text-destructive">{failed} check failed</span> : passed ? <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 normal-case text-emerald-700 dark:text-emerald-300">{passed} check passed</span> : <span className="rounded bg-muted px-1.5 py-0.5 normal-case">No checks reported</span>}
      </div>
      {checks.length ? (
        <ul className="mt-1.5 space-y-1">
          {checks.slice(-3).reverse().map((check) => (
            <li key={check.id} className={cn("truncate text-[9.5px]", check.status === "failed" ? "text-destructive" : check.status === "passed" ? "text-emerald-700 dark:text-emerald-300" : "text-muted-foreground")} title={check.command ?? check.label}>
              {check.status === "failed" ? "✕" : check.status === "passed" ? "✓" : "•"} {check.label}{check.detail ? ` · ${check.detail}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
      {run.failures.length ? <p className="mt-1.5 line-clamp-2 text-[9.5px] leading-relaxed text-destructive">{run.failures[run.failures.length - 1]}</p> : null}
      {run.changes.length ? <button type="button" onClick={() => window.dispatchEvent(new CustomEvent("altai:open-change-review"))} className="mt-1.5 text-[9.5px] font-medium text-sky-700 hover:underline dark:text-sky-300">Review changes and restore points</button> : null}
    </section>
  );
}
