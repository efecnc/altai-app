import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  PROJECT_INSTRUCTIONS_FILE,
  projectInstructionsPath,
} from "@/modules/ai/lib/projectInstructions";
import { native } from "@/modules/ai/lib/native";
import {
  CheckmarkCircle02Icon,
  InformationCircleIcon,
  Refresh01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";

const STARTER = `# ALTAI project instructions

## Project
- What this application does:
- Important architecture decisions:

## Development
- Install command:
- Test command:
- Lint/type-check command:

## Conventions
- Naming and formatting:
- Files or areas that need extra care:
- Things the agent must not change:
`;

type LoadState = "loading" | "ready" | "missing" | "unavailable" | "error";

/** Workspace-facing controls for the IsanAgent context that otherwise lives
 * behind its runtime. The file is injected into every newly-started agent. */
export function ProjectIntelligenceSection() {
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [state, setState] = useState<LoadState>("loading");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    setNotice(null);
    setState("loading");
    try {
      const root = await native.workspaceCurrentDir();
      if (!root) {
        setWorkspace(null);
        setState("unavailable");
        return;
      }
      setWorkspace(root);
      try {
        const result = await native.readFile(projectInstructionsPath(root));
        if (result.kind === "text") {
          setContent(result.content);
          setState("ready");
        } else {
          setContent("");
          setState("error");
        }
      } catch {
        setContent("");
        setState("missing");
      }
    } catch {
      setWorkspace(null);
      setState("unavailable");
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const save = async () => {
    if (!workspace || saving) return;
    setSaving(true);
    setNotice(null);
    try {
      await native.writeFile(projectInstructionsPath(workspace), content.trimEnd() + "\n", {
        source: "altai-project-intelligence",
      });
      setState("ready");
      setNotice("Project instructions saved. New agent runs will use them.");
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Could not save project instructions.");
    } finally {
      setSaving(false);
    }
  };

  const canEdit = state !== "loading" && state !== "unavailable" && state !== "error";

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="Project Intelligence"
        description="Make IsanAgent's workspace context visible and editable. ALTAI combines these project rules with the selected agent's instructions whenever it starts a run."
      />

      <section className="rounded-xl border border-border/60 bg-card/60 p-5">
        <div className="flex items-start gap-2">
          <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-sky-500/10 text-sky-600 dark:text-sky-400">
            <HugeiconsIcon icon={InformationCircleIcon} size={13} strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <h3 className="text-[12.5px] font-medium">Workspace memory</h3>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              IsanAgent keeps chat history and runtime state inside this workspace’s <code className="rounded bg-muted px-1 py-0.5 text-[10px]">.isanagent</code> directory. This page controls the human-written project contract at <code className="rounded bg-muted px-1 py-0.5 text-[10px]">{PROJECT_INSTRUCTIONS_FILE}</code>; it does not expose private chat contents.
            </p>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border/60 bg-card/60 p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-[12.5px] font-medium">Project instructions</h3>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {workspace ? projectInstructionsPath(workspace) : "Open a workspace to manage its instructions."}
            </p>
          </div>
          <Button type="button" size="sm" variant="ghost" className="h-7 gap-1.5 text-[10.5px]" onClick={() => void load()} disabled={state === "loading" || saving}>
            <HugeiconsIcon icon={Refresh01Icon} size={12} strokeWidth={1.75} /> Refresh
          </Button>
        </div>

        {state === "loading" ? <p className="py-8 text-center text-[11px] text-muted-foreground">Loading workspace context…</p> : null}
        {state === "unavailable" ? <p className="mt-4 rounded-lg bg-muted/50 px-3 py-4 text-[11px] text-muted-foreground">No active workspace is available.</p> : null}
        {state === "error" ? <p className="mt-4 rounded-lg bg-destructive/10 px-3 py-4 text-[11px] text-destructive">{PROJECT_INSTRUCTIONS_FILE} exists but could not be read as text.</p> : null}
        {state === "missing" ? (
          <div className="mt-4 rounded-lg border border-dashed border-border/70 p-4">
            <p className="text-[11px] leading-relaxed text-muted-foreground">No {PROJECT_INSTRUCTIONS_FILE} yet. You can create a small starter here, or use <code className="rounded bg-muted px-1 py-0.5 text-[10px]">/init</code> in chat to ask the agent to inspect the repository and draft it.</p>
            <Button type="button" size="sm" className="mt-3 h-7 text-[10.5px]" onClick={() => { setContent(STARTER); setState("ready"); }}>
              Create starter
            </Button>
          </div>
        ) : null}
        {canEdit ? (
          <>
            <Textarea value={content} onChange={(event) => setContent(event.target.value)} className="mt-4 min-h-80 rounded-lg border-border/70 bg-background/60 font-mono text-[11px] leading-relaxed" placeholder="Project goals, commands, conventions, and constraints…" />
            <div className="mt-3 flex items-center gap-3">
              <Button type="button" size="sm" className="h-7 gap-1.5 text-[10.5px]" onClick={() => void save()} disabled={saving || !content.trim()}>
                <HugeiconsIcon icon={Tick02Icon} size={12} strokeWidth={1.75} /> {saving ? "Saving…" : "Save instructions"}
              </Button>
              {notice ? <span className="flex items-center gap-1.5 text-[10.5px] text-emerald-700 dark:text-emerald-300"><HugeiconsIcon icon={CheckmarkCircle02Icon} size={12} strokeWidth={1.75} />{notice}</span> : null}
            </div>
          </>
        ) : null}
      </section>

      <section className="rounded-xl border border-border/60 bg-card/60 p-5">
        <h3 className="text-[12.5px] font-medium">Skills and task runs</h3>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">Install reusable IsanAgent skills from the <strong className="font-medium text-foreground">Skills</strong> settings tab. Use the notebook button in chat to launch a templated or custom background task; each task keeps its own durable IsanAgent chat.</p>
      </section>
    </div>
  );
}
