"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  Archive02Icon,
  ArchiveArrowDownIcon,
  ArrowRight01Icon,
  Book01Icon,
  Book02Icon,
  CheckListIcon,
  CloudDownloadIcon,
  File01Icon,
  FileEditIcon,
  FilePlusIcon,
  Folder01Icon,
  FolderAddIcon,
  FolderOpenIcon,
  GlobalSearchIcon,
  Link02Icon,
  RobotIcon,
  Search01Icon,
  SparklesIcon,
  TerminalIcon,
  ToolsIcon,
} from "@hugeicons/core-free-icons";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { HugeiconsIcon } from "@hugeicons/react";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement, memo, useState } from "react";


export type ToolPart = ToolUIPart | DynamicToolUIPart;

// Keyed on the tool names IsanAgent actually emits over
// `agent://event` — see `fn name()` across `isanagent/src/tools/*`. The
// previous keys (`bash_run`, `grep`, `glob`, `edit`, `list_directory`, …)
// were the Vercel AI SDK tool names from the removed chat path; under the
// native runtime they never matched, so common calls fell through to the
// raw snake_case name + generic icon.
const TOOL_META: Record<string, { label: string; icon: typeof File01Icon }> = {
  // Filesystem
  read_file: { label: "Read", icon: File01Icon },
  write_file: { label: "Write", icon: FilePlusIcon },
  edit_file: { label: "Edit", icon: FileEditIcon },
  list_dir: { label: "List", icon: FolderOpenIcon },
  glob_files: { label: "Glob", icon: Folder01Icon },
  // `search_text` is local-tree (ripgrep) search; the globe-with-magnifier
  // glyph reads as web search to anyone scanning the chat. Keep the plain
  // magnifier here and let `web_search` claim `GlobalSearchIcon`.
  search_text: { label: "Search", icon: Search01Icon },

  // Shell / code execution
  exec: { label: "Run", icon: TerminalIcon },
  python_run: { label: "Python", icon: TerminalIcon },

  // Sandboxed execution sessions
  execution_run: { label: "Run", icon: TerminalIcon },
  execution_run_background: { label: "Spawn", icon: TerminalIcon },
  execution_read_log: { label: "Logs", icon: TerminalIcon },
  execution_job_list: { label: "Jobs", icon: TerminalIcon },
  execution_job_status: { label: "Job status", icon: TerminalIcon },
  execution_job_result: { label: "Job result", icon: TerminalIcon },
  execution_job_cancel: { label: "Cancel job", icon: TerminalIcon },
  execution_cancel: { label: "Cancel", icon: TerminalIcon },
  execution_session_create: { label: "New session", icon: TerminalIcon },
  execution_session_close: { label: "Close session", icon: TerminalIcon },
  execution_env_info: { label: "Env info", icon: TerminalIcon },
  execution_artifact_list: { label: "Artifacts", icon: Archive02Icon },

  // Planning / interaction
  todo_write: { label: "Todos", icon: CheckListIcon },
  ask_user: { label: "Ask", icon: SparklesIcon },
  message: { label: "Message", icon: SparklesIcon },

  // Web & research
  web_search: { label: "Web search", icon: GlobalSearchIcon },
  web_fetch: { label: "Fetch", icon: Link02Icon },
  arxiv_search: { label: "arXiv search", icon: Book02Icon },
  arxiv_fetch: { label: "arXiv paper", icon: Book01Icon },
  hf_hub_file_fetch: { label: "HF Hub", icon: CloudDownloadIcon },

  // Memory & context management. `compact_context` schedules a between-turns
  // prune; `recall_tool_result` re-materializes a tool result that fell out
  // of the live context.
  search_memory: { label: "Search memory", icon: Search01Icon },
  fetch_memory_by_date: { label: "Memory by date", icon: ArchiveArrowDownIcon },
  compact_context: { label: "Compact context", icon: Archive02Icon },
  recall_tool_result: { label: "Recall result", icon: ArchiveArrowDownIcon },

  // Tooling / environment
  search_tools: { label: "Find tools", icon: ToolsIcon },
  get_env: { label: "Env", icon: TerminalIcon },
  cron: { label: "Schedule", icon: TerminalIcon },
  git_worktree: { label: "Worktree", icon: FolderAddIcon },
  colab_mcp_tool_call: { label: "Colab", icon: RobotIcon },
};

// Friendly label for a raw IsanAgent tool name (e.g. "exec" → "Run"). Used
// by the inline runtime-status pill so it doesn't surface raw snake_case.
// Unknown names pass through unchanged so non-tool status text (e.g.
// "Sending to ALTAI…") is left alone.
export function toolLabel(name: string): string {
  return TOOL_META[name]?.label ?? name;
}

const STATUS_DOT: Record<ToolPart["state"], string> = {
  "approval-requested": "bg-amber-500",
  "approval-responded": "bg-sky-500",
  "input-streaming": "bg-muted-foreground/40",
  "input-available": "bg-amber-500",
  "output-available": "bg-transparent border border-muted-foreground/40",
  "output-denied": "bg-orange-500",
  "output-error": "bg-destructive",
};

const STATUS_LABEL: Record<ToolPart["state"], string> = {
  "approval-requested": "awaiting approval",
  "approval-responded": "responded",
  "input-streaming": "preparing",
  "input-available": "running",
  "output-available": "done",
  "output-denied": "denied",
  "output-error": "error",
};

function deriveSummary(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const i = input as Record<string, unknown>;
  const str = (k: string) =>
    typeof i[k] === "string" ? (i[k] as string) : null;

  switch (toolName) {
    case "read_file":
    case "write_file":
    case "edit_file":
    case "list_dir":
      return str("path");
    // Prefer the agent's human-facing `description` ("Navigate to project
    // root") as the headline, Cursor-style; the raw command rides underneath
    // as a mono subtitle (see deriveSubtitle). Falls back to the command/code
    // when the model didn't write one.
    case "exec":
      return str("description") ?? str("command");
    case "execution_run":
    case "execution_run_background":
      return str("description") ?? str("code");
    case "execution_read_log":
    case "execution_job_status":
    case "execution_job_result":
    case "execution_job_cancel":
    case "execution_cancel":
      return str("job_id") ?? str("run_id");
    case "execution_session_create":
    case "execution_session_close":
      return str("session_id");
    case "search_text":
    case "glob_files":
      return str("pattern");
    case "web_search":
    case "arxiv_search":
    case "search_memory":
    case "search_tools":
      return str("query");
    case "web_fetch": {
      const url = str("url");
      return url ? prettyUrl(url) : null;
    }
    case "arxiv_fetch":
      return str("arxiv_id");
    case "hf_hub_file_fetch": {
      const repo = str("repo_id") ?? str("repo");
      const path = str("path") ?? str("filename");
      if (repo && path) return `${repo} · ${path}`;
      return repo ?? path;
    }
    case "ask_user":
      return str("prompt");
    case "cron":
    case "git_worktree":
      return str("action");
    case "compact_context":
      return str("focus_instructions");
    case "recall_tool_result":
      return str("tool_call_id");
    case "todo_write": {
      const items = Array.isArray(i.items) ? i.items : null;
      return items
        ? `${items.length} item${items.length === 1 ? "" : "s"}`
        : null;
    }
    default:
      return null;
  }
}

// Secondary mono line under the headline. Only for run-tools, and only when
// the agent supplied a `description` (which becomes the headline) — then the
// actual command is shown beneath it so both the "why" and the "what" read at
// a glance without expanding. No description → the command is already the
// headline, so there's nothing to add here.
function deriveSubtitle(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const i = input as Record<string, unknown>;
  const str = (k: string) =>
    typeof i[k] === "string" ? (i[k] as string) : null;
  if (!str("description")) return null;
  let cmd: string | null = null;
  if (toolName === "exec") cmd = str("command");
  else if (
    toolName === "execution_run" ||
    toolName === "execution_run_background"
  )
    cmd = str("code");
  if (!cmd) return null;
  const firstLine = cmd.split("\n")[0].trim();
  return firstLine.length > 120 ? `${firstLine.slice(0, 119)}…` : firstLine;
}

// Strip protocol/trailing slash so the chip reads as `host/path` instead
// of a noisy `https://…/?utm_source=…` blob. Falls back to the raw input
// if it isn't parseable as a URL (occasionally the model passes a bare
// host).
function prettyUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
    return `${u.hostname}${path}`;
  } catch {
    return url;
  }
}

export type ToolProps = ComponentProps<typeof Collapsible> & {
  toolName: string;
  state: ToolPart["state"];
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

// Tools whose `input` is large and streamed (file bodies, sub-agent
// prompts, todo lists). We hide the *input* body for these — the AI
// diff tab is the canonical place to view file changes, and re-rendering
// streamed input on every token both stalls the UI and duplicates
// information. Outputs are still shown: a `run_subagent` summary or a
// `write_file` "✓ wrote · path" card is the meaningful artifact.
const INPUT_HEAVY_TOOLS = new Set([
  "write_file",
  "edit_file",
  "todo_write",
  "python_run",
  "execution_run",
  "execution_run_background",
]);

const ToolImpl = ({
  className,
  toolName,
  state,
  input,
  output,
  errorText,
  defaultOpen,
  ...props
}: ToolProps) => {
  const meta = TOOL_META[toolName];
  const Icon = meta?.icon ?? ToolsIcon;
  const label = meta?.label ?? toolName;
  const summary = deriveSummary(toolName, input);
  const subtitle = deriveSubtitle(toolName, input);
  const isError = state === "output-error";
  const open = defaultOpen ?? isError;
  const isInputHeavy = INPUT_HEAVY_TOOLS.has(toolName);
  // Hide just the streamed input for heavy tools — outputs are always
  // shown when present so e.g. a `run_subagent` summary or a
  // `write_file` confirmation card remains reachable.
  const showInputBody = !isInputHeavy && Boolean(input);
  const showOutputBody = output !== undefined;
  const hasDetails =
    showInputBody || showOutputBody || Boolean(errorText);

  return (
    <Collapsible
      defaultOpen={open}
      className={cn("group/tool not-prose w-full", className)}
      {...props}
    >
      <CollapsibleTrigger
        disabled={!hasDetails}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left",
          "text-[12px] transition-colors",
          "hover:bg-muted/60 disabled:cursor-default disabled:hover:bg-transparent",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
      >
        <span
          className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[state])}
          aria-label={STATUS_LABEL[state]}
        />
        <HugeiconsIcon
          icon={Icon}
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <span className="shrink-0 font-medium text-foreground">{label}</span>
        {summary ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
            {summary}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {isError && (
          <span className="shrink-0 text-[10px] font-medium text-destructive">
            failed
          </span>
        )}
      </CollapsibleTrigger>

      {subtitle ? (
        <div className="-mt-0.5 truncate pb-1 pl-[2.65rem] pr-2 font-mono text-[10.5px] text-muted-foreground/70">
          {subtitle}
        </div>
      ) : null}

      {hasDetails && (
        <CollapsibleContent
          className={cn("altai-collapsible-content")}
        >
          <div className="ml-3 mt-1 space-y-2 border-l border-border/60 pl-3 pb-1">
            {showInputBody ? (
              <ToolInput toolName={toolName} input={input} />
            ) : null}
            {showOutputBody || errorText ? (
              <ToolOutput
                toolName={toolName}
                output={showOutputBody ? output : undefined}
                errorText={errorText}
              />
            ) : null}
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
};

// For heavy tools, the only thing that should trigger a re-render is a
// state transition or the path summary changing — NOT every input-content
// token. We compare the cheap derived summary instead of the input ref.
export const Tool = memo(ToolImpl, (a, b) => {
  if (a.toolName !== b.toolName || a.state !== b.state) return false;
  if (a.errorText !== b.errorText) return false;
  if (a.output !== b.output) return false;
  if (a.className !== b.className) return false;
  if (INPUT_HEAVY_TOOLS.has(a.toolName)) {
    return deriveSummary(a.toolName, a.input) ===
      deriveSummary(b.toolName, b.input);
  }
  return a.input === b.input;
});

function ToolInput({ toolName, input }: { toolName: string; input: unknown }) {
  if (input == null) return null;
  const preview = renderInputPreview(toolName, input);
  if (preview) {
    return (
      <div className="space-y-1">
        <div className="text-[10px] font-medium text-muted-foreground">
          Input
        </div>
        {preview}
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <div className="text-[10px] font-medium text-muted-foreground">Input</div>
      <CodeBlockMini
        code={
          typeof input === "string" ? input : JSON.stringify(input, null, 2)
        }
        language="json"
      />
    </div>
  );
}

function renderInputPreview(
  toolName: string,
  input: unknown,
): ReactNode | null {
  if (!input || typeof input !== "object") return null;
  const i = input as Record<string, unknown>;
  const str = (k: string) =>
    typeof i[k] === "string" ? (i[k] as string) : null;

  if (toolName === "exec") {
    const cmd = str("command");
    const cwd = str("working_dir");
    if (!cmd) return null;
    return (
      <div className="space-y-1">
        {cwd ? (
          <div className="font-mono text-[10px] text-muted-foreground">
            {cwd}
          </div>
        ) : null}
        <pre className="overflow-auto rounded bg-muted/40 p-2 font-mono text-[11px] leading-relaxed">
          {cmd}
        </pre>
      </div>
    );
  }
  if (toolName === "read_file" || toolName === "list_dir") {
    const path = str("path");
    if (!path) return null;
    return (
      <div className="font-mono text-[11px] text-muted-foreground">{path}</div>
    );
  }
  if (toolName === "search_text" || toolName === "glob_files") {
    const pat = str("pattern");
    const path = str("path");
    if (!pat) return null;
    return (
      <div className="space-y-0.5 font-mono text-[11px]">
        <div className="text-foreground">{pat}</div>
        {path ? <div className="text-muted-foreground">{path}</div> : null}
      </div>
    );
  }
  return null;
}

function ToolOutput({
  toolName,
  output,
  errorText,
}: {
  toolName: string;
  output: unknown;
  errorText?: string;
}) {
  if (errorText) {
    return (
      <div className="space-y-1">
        <div className="text-[10px] font-medium text-destructive">Error</div>
        <div className="rounded bg-destructive/10 px-2 py-1.5 font-mono text-[11px] text-destructive whitespace-pre-wrap">
          {errorText}
        </div>
      </div>
    );
  }
  if (output === undefined || output === null) return null;

  const custom = renderToolOutput(toolName, output);
  if (custom) return custom;

  let body: ReactNode;
  if (typeof output === "string") {
    body = <CodeBlockMini code={output} language="text" />;
  } else if (typeof output === "object" && !isValidElement(output)) {
    body = (
      <CodeBlockMini code={JSON.stringify(output, null, 2)} language="json" />
    );
  } else {
    body = <div className="text-[12px]">{output as ReactNode}</div>;
  }

  return (
    <div className="space-y-1">
      <div className="text-[10px] font-medium text-muted-foreground">
        Output
      </div>
      {body}
    </div>
  );
}

function renderToolOutput(toolName: string, output: unknown): ReactNode | null {
  // String-output tools — IsanAgent's web/arxiv/hf tools all return a
  // single text blob (markdown preview or Atom snippets) rather than a
  // structured JSON object. The default renderer would dump them into a
  // monospace `CodeBlockMini` which reads as a wall of text; we extract
  // the meaningful bits instead.
  if (typeof output === "string") {
    if (toolName === "web_fetch" || toolName === "arxiv_fetch") {
      return <FetchedDocOutput text={output} />;
    }
    if (toolName === "web_search") {
      return <WebSearchOutput text={output} />;
    }
    if (toolName === "arxiv_search") {
      return <ArxivSearchOutput text={output} />;
    }
    if (toolName === "hf_hub_file_fetch") {
      return <HfHubFileOutput text={output} />;
    }
    return null;
  }

  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;

  if (toolName === "read_file") {
    const path = typeof o.path === "string" ? o.path : "";
    const size = typeof o.size === "number" ? o.size : null;
    const content = typeof o.content === "string" ? o.content : "";
    const lines = content ? content.split("\n").length : null;
    return (
      <div className="flex items-center gap-1.5 font-mono text-[11px]">
        <span className="text-emerald-600 dark:text-emerald-400">✓</span>
        <span className="text-foreground">read</span>
        {path ? <span className="text-muted-foreground">· {path}</span> : null}
        {lines != null ? (
          <span className="text-muted-foreground">
            ({lines} line{lines === 1 ? "" : "s"}
            {size != null ? `, ${formatBytes(size)}` : ""})
          </span>
        ) : null}
      </div>
    );
  }

  if (toolName === "list_directory") {
    const entries = Array.isArray(o.entries)
      ? (o.entries as Array<{ name: string; kind: string }>)
      : [];
    if (entries.length === 0) {
      return (
        <div className="text-[11px] italic text-muted-foreground">empty</div>
      );
    }
    const dirs = entries.filter(
      (e) => e.kind === "directory" || e.kind === "dir",
    );
    const files = entries.filter(
      (e) => !(e.kind === "directory" || e.kind === "dir"),
    );
    return (
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[11px]">
        {dirs.map((e) => (
          <div
            key={`d-${e.name}`}
            className="flex items-center gap-1.5 truncate"
          >
            <HugeiconsIcon
              icon={FolderOpenIcon}
              size={11}
              strokeWidth={1.75}
              className="shrink-0 text-muted-foreground"
            />
            <span className="truncate text-foreground">{e.name}/</span>
          </div>
        ))}
        {files.map((e) => (
          <div
            key={`f-${e.name}`}
            className="flex items-center gap-1.5 truncate"
          >
            <HugeiconsIcon
              icon={File01Icon}
              size={11}
              strokeWidth={1.75}
              className="shrink-0 text-muted-foreground"
            />
            <span className="truncate text-muted-foreground">{e.name}</span>
          </div>
        ))}
      </div>
    );
  }

  if (toolName === "bash_run") {
    return <BashRunOutput data={o} />;
  }

  if (toolName === "suggest_command") {
    const cmd = typeof o.command === "string" ? o.command : null;
    const explanation =
      typeof o.explanation === "string" ? o.explanation : null;
    if (!cmd) return null;
    return <SuggestCommandCard command={cmd} explanation={explanation} />;
  }

  if (toolName === "grep") {
    const hits = Array.isArray(o.hits)
      ? (o.hits as Array<{
          rel?: string;
          path?: string;
          line: number;
          text: string;
        }>)
      : [];
    const pattern = typeof o.pattern === "string" ? o.pattern : null;
    const truncated = Boolean(o.truncated);
    const filesScanned =
      typeof o.files_scanned === "number" ? o.files_scanned : null;

    if (hits.length === 0) {
      return (
        <div className="text-[11px] italic text-muted-foreground">
          no matches
          {filesScanned != null ? ` · ${filesScanned} files scanned` : ""}
        </div>
      );
    }

    return (
      <div className="space-y-1">
        <div className="max-h-72 overflow-auto rounded bg-muted/30 font-mono text-[11px]">
          {hits.slice(0, 200).map((h, idx) => (
            <div
              key={`${h.rel ?? h.path}-${h.line}-${idx}`}
              className="flex gap-2 border-b border-border/30 px-2 py-1 last:border-b-0 hover:bg-muted/60"
            >
              <span className="shrink-0 text-muted-foreground">
                {h.rel ?? h.path}:{h.line}
              </span>
              <span className="min-w-0 flex-1 truncate text-foreground">
                {pattern ? highlightMatch(h.text, pattern) : h.text}
              </span>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          <span>
            {hits.length} hit{hits.length === 1 ? "" : "s"}
            {filesScanned != null ? ` · ${filesScanned} files` : ""}
          </span>
          {truncated ? (
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-700 dark:text-amber-400">
              truncated
            </span>
          ) : null}
        </div>
      </div>
    );
  }

  if (toolName === "glob") {
    const matches = Array.isArray(o.matches)
      ? (o.matches as string[])
      : Array.isArray(o.paths)
        ? (o.paths as string[])
        : [];
    if (matches.length === 0) {
      return (
        <div className="text-[11px] italic text-muted-foreground">
          no matches
        </div>
      );
    }
    return (
      <div className="max-h-60 overflow-auto rounded bg-muted/30 px-2 py-1 font-mono text-[11px]">
        {matches.slice(0, 300).map((p) => (
          <div key={p} className="truncate text-muted-foreground">
            {p}
          </div>
        ))}
      </div>
    );
  }

  if (toolName === "edit" || toolName === "multi_edit") {
    const ok = o.ok === true || typeof o.replacements === "number";
    if (ok) {
      const reps = typeof o.replacements === "number" ? o.replacements : null;
      const path = typeof o.path === "string" ? o.path : "";
      return (
        <div className="flex items-center gap-1.5 font-mono text-[11px]">
          <span className="text-emerald-600 dark:text-emerald-400">✓</span>
          {reps != null ? (
            <span className="text-foreground">
              {reps} replacement{reps === 1 ? "" : "s"}
            </span>
          ) : null}
          {path ? (
            <span className="text-muted-foreground">· {path}</span>
          ) : null}
        </div>
      );
    }
  }

  if (toolName === "write_file" || toolName === "create_directory") {
    const path = typeof o.path === "string" ? o.path : "";
    const bytes = typeof o.bytesWritten === "number" ? o.bytesWritten : null;
    return (
      <div className="flex items-center gap-1.5 font-mono text-[11px]">
        <span className="text-emerald-600 dark:text-emerald-400">✓</span>
        <span className="text-foreground">
          {toolName === "create_directory" ? "created" : "wrote"}
        </span>
        {path ? <span className="text-muted-foreground">· {path}</span> : null}
        {bytes != null ? (
          <span className="text-muted-foreground">({formatBytes(bytes)})</span>
        ) : null}
      </div>
    );
  }

  if (toolName === "bash_logs") {
    const bytes = typeof o.bytes === "string" ? o.bytes : "";
    const dropped = typeof o.dropped === "number" ? o.dropped : 0;
    const exited = Boolean(o.exited);
    const exit = typeof o.exit_code === "number" ? o.exit_code : null;
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-1.5 text-[10px]">
          <span
            className={cn(
              "size-1.5 rounded-full",
              exited
                ? exit === 0
                  ? "bg-emerald-500"
                  : "bg-destructive"
                : "bg-emerald-500 animate-pulse",
            )}
          />
          <span className="text-foreground">
            {exited ? `exited${exit != null ? ` · exit ${exit}` : ""}` : "running"}
          </span>
          {dropped > 0 ? (
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-amber-700 dark:text-amber-400">
              {formatBytes(dropped)} dropped
            </span>
          ) : null}
          <span className="flex-1" />
          <span className="font-mono text-muted-foreground">
            {bytes.length.toLocaleString()} bytes
          </span>
        </div>
        <pre className="max-h-60 overflow-auto rounded bg-muted/40 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
          {bytes || " "}
        </pre>
      </div>
    );
  }

  if (toolName === "bash_list") {
    const procs = Array.isArray(o.processes)
      ? (o.processes as Array<{
          handle: number;
          command: string;
          cwd: string | null;
          started_at_ms: number;
          exited: boolean;
          exit_code: number | null;
        }>)
      : [];
    if (procs.length === 0) {
      return (
        <div className="text-[11px] italic text-muted-foreground">
          no background processes
        </div>
      );
    }
    return (
      <div className="space-y-0.5 font-mono text-[11px]">
        {procs.map((p) => (
          <div
            key={p.handle}
            className="flex items-center gap-2 rounded px-1.5 py-0.5 hover:bg-muted/40"
          >
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                p.exited
                  ? p.exit_code === 0
                    ? "bg-emerald-500/70"
                    : "bg-destructive/70"
                  : "bg-emerald-500 animate-pulse",
              )}
            />
            <span className="shrink-0 text-muted-foreground">#{p.handle}</span>
            <span className="min-w-0 flex-1 truncate text-foreground">
              {p.command}
            </span>
            {p.exited ? (
              <span className="shrink-0 text-[10px] text-muted-foreground">
                exit {p.exit_code ?? "?"}
              </span>
            ) : (
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {formatStartedAgo(p.started_at_ms)}
              </span>
            )}
          </div>
        ))}
      </div>
    );
  }

  if (toolName === "bash_kill") {
    const handle = typeof o.handle === "number" ? o.handle : null;
    return (
      <div className="flex items-center gap-1.5 font-mono text-[11px]">
        <span className="text-emerald-600 dark:text-emerald-400">✓</span>
        <span className="text-foreground">killed</span>
        {handle != null ? (
          <span className="text-muted-foreground">· #{handle}</span>
        ) : null}
      </div>
    );
  }

  if (toolName === "open_preview") {
    const url = typeof o.url === "string" ? o.url : "";
    return (
      <div className="flex items-center gap-1.5 font-mono text-[11px]">
        <span className="text-emerald-600 dark:text-emerald-400">✓</span>
        <span className="text-foreground">opened</span>
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer noopener"
            className="truncate text-muted-foreground hover:text-foreground hover:underline"
          >
            {url}
          </a>
        ) : null}
      </div>
    );
  }

  if (toolName === "todo_write") {
    const count = typeof o.count === "number" ? o.count : null;
    const inProgress =
      typeof o.inProgress === "string" ? o.inProgress : null;
    return (
      <div className="space-y-0.5 font-mono text-[11px]">
        <div className="flex items-center gap-1.5">
          <span className="text-emerald-600 dark:text-emerald-400">✓</span>
          <span className="text-foreground">
            {count != null
              ? `${count} item${count === 1 ? "" : "s"}`
              : "updated"}
          </span>
        </div>
        {inProgress ? (
          <div className="flex items-center gap-1.5 pl-3">
            <span className="size-1.5 shrink-0 rounded-full bg-amber-500" />
            <span className="truncate text-muted-foreground">
              in progress · {inProgress}
            </span>
          </div>
        ) : null}
      </div>
    );
  }

  if (toolName === "run_subagent") {
    const type = typeof o.type === "string" ? o.type : null;
    const summary = typeof o.summary === "string" ? o.summary : "";
    const stepCount = typeof o.stepCount === "number" ? o.stepCount : null;
    const durationMs =
      typeof o.durationMs === "number" ? o.durationMs : null;
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-1.5 font-mono text-[11px]">
          <span className="text-emerald-600 dark:text-emerald-400">✓</span>
          <span className="text-foreground">subagent</span>
          {type ? (
            <span className="text-muted-foreground">· {type}</span>
          ) : null}
          {stepCount != null ? (
            <span className="text-muted-foreground">
              · {stepCount} step{stepCount === 1 ? "" : "s"}
            </span>
          ) : null}
          {durationMs != null ? (
            <span className="text-muted-foreground">
              · {formatDuration(durationMs)}
            </span>
          ) : null}
        </div>
        {summary ? (
          <div className="rounded bg-muted/30 px-2 py-1.5 text-[11.5px] leading-relaxed text-foreground whitespace-pre-wrap">
            {summary}
          </div>
        ) : null}
      </div>
    );
  }

  if (toolName === "bash_background") {
    const handle = typeof o.handle === "string" ? o.handle : null;
    const cmd = typeof o.command === "string" ? o.command : "";
    return (
      <div className="space-y-0.5 font-mono text-[11px]">
        <div className="flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
          {handle ? <span className="text-foreground">{handle}</span> : null}
          <span className="text-muted-foreground">running</span>
        </div>
        {cmd ? (
          <div className="truncate text-muted-foreground">{cmd}</div>
        ) : null}
      </div>
    );
  }

  return null;
}

// Trailing footer the Rust runtime appends to every web_fetch / arxiv_fetch
// response so the model knows the full doc was saved to disk. Useful to the
// model, useless visual noise to the user — we strip it for the preview and
// surface the saved path as a small chip instead.
const SAVED_PATH_RE =
  /\n*---\nNote:\s*The full response \((\d+) lines,\s*(\d+)\s*bytes\)\s*was saved to\s*`([^`]+)`\.[\s\S]*$/;

function parseSavedFooter(text: string): {
  body: string;
  lines: number | null;
  bytes: number | null;
  path: string | null;
} {
  const m = text.match(SAVED_PATH_RE);
  if (!m) return { body: text, lines: null, bytes: null, path: null };
  return {
    body: text.slice(0, m.index ?? 0).trimEnd(),
    lines: Number.parseInt(m[1], 10) || null,
    bytes: Number.parseInt(m[2], 10) || null,
    path: m[3] ?? null,
  };
}

function extractDocTitle(markdown: string): string | null {
  // Markdown heading takes precedence (Jina Reader prefixes one) — otherwise
  // the first non-empty line, capped so a giant paragraph doesn't become the
  // title.
  for (const raw of markdown.split("\n").slice(0, 30)) {
    const line = raw.trim();
    if (!line) continue;
    const headed = line.match(/^#{1,6}\s+(.+)$/);
    if (headed) return headed[1].trim().slice(0, 140);
    return line.slice(0, 140);
  }
  return null;
}

function FetchedDocOutput({ text }: { text: string }) {
  const { body, lines, bytes, path } = parseSavedFooter(text);
  const title = extractDocTitle(body);
  return (
    <div className="space-y-1">
      {title ? (
        <div className="truncate text-[11.5px] font-medium text-foreground">
          {title}
        </div>
      ) : null}
      <pre className="max-h-60 overflow-auto rounded bg-muted/40 p-2 font-mono text-[11px] leading-relaxed text-foreground whitespace-pre-wrap">
        {body || " "}
      </pre>
      {(lines != null || bytes != null || path) && (
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          {lines != null && bytes != null ? (
            <span>
              {lines.toLocaleString()} lines · {formatBytes(bytes)}
            </span>
          ) : null}
          {path ? (
            <span className="min-w-0 flex-1 truncate font-mono opacity-80">
              saved · {path}
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}

// IsanAgent's web_search ships the backend output verbatim. Jina Reader
// returns a markdown list with one block per hit; DuckDuckGo Lite returns
// `TITLE\nURL\nSNIPPET\n\n` repeated. Both decompose cleanly into the same
// {title, url, snippet} shape by splitting on blank lines and pulling the
// first URL-looking token out of each block.
const URL_RE = /https?:\/\/[^\s)\]"']+/;

type SearchHit = { title: string; url: string | null; snippet: string };

function parseWebSearchResults(text: string): SearchHit[] {
  const blocks = text
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0 && b !== "---");
  const hits: SearchHit[] = [];
  for (const block of blocks) {
    const urlMatch = block.match(URL_RE);
    const url = urlMatch ? urlMatch[0] : null;
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    // Markdown link `[Title](url)` → title is the [Title] portion.
    const linked = lines[0].match(/^\[(.+?)\]\((https?:[^\s)]+)\)/);
    const title = linked
      ? linked[1]
      : lines[0].replace(/^\d+\.\s*/, "").replace(URL_RE, "").trim() ||
        (url ? prettyUrl(url) : lines[0]);
    const snippet = lines
      .slice(1)
      .filter((l) => !URL_RE.test(l) || l.length > 80)
      .join(" ")
      .replace(URL_RE, "")
      .trim();
    hits.push({ title: title.slice(0, 200), url, snippet: snippet.slice(0, 280) });
    if (hits.length >= 20) break;
  }
  return hits;
}

function WebSearchOutput({ text }: { text: string }) {
  const hits = parseWebSearchResults(text);
  if (hits.length === 0) {
    return (
      <div className="text-[11px] italic text-muted-foreground">
        no parseable results — agent received {text.length.toLocaleString()} chars
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      {hits.map((h, i) => (
        <div
          key={i}
          className="space-y-0.5 rounded border border-border/40 bg-card/40 px-2 py-1.5"
        >
          <div className="flex items-baseline gap-2">
            {h.url ? (
              <a
                href={h.url}
                target="_blank"
                rel="noreferrer noopener"
                className="truncate text-[11.5px] font-medium text-foreground hover:underline"
              >
                {h.title}
              </a>
            ) : (
              <span className="truncate text-[11.5px] font-medium text-foreground">
                {h.title}
              </span>
            )}
            {h.url ? (
              <span className="shrink-0 truncate font-mono text-[10px] text-muted-foreground">
                {prettyUrl(h.url)}
              </span>
            ) : null}
          </div>
          {h.snippet ? (
            <div className="line-clamp-2 text-[11px] text-muted-foreground">
              {h.snippet}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

// arXiv search format from IsanAgent is deterministic — `ID:`, `Title:`,
// `Summary:` triplets separated by `\n\n---\n`. Render as cards with a
// clickable arXiv link.
type ArxivHit = { id: string; title: string; summary: string };

function parseArxivResults(text: string): ArxivHit[] {
  const out: ArxivHit[] = [];
  for (const block of text.split(/\n*---\n*/)) {
    const id = block.match(/^ID:\s*(.+)$/m)?.[1]?.trim();
    const title = block.match(/^Title:\s*([\s\S]+?)(?=\nSummary:|$)/m)?.[1]?.trim();
    const summary = block.match(/^Summary:\s*([\s\S]+)$/m)?.[1]?.trim();
    if (!id && !title) continue;
    out.push({
      id: id ?? "",
      title: (title ?? "").slice(0, 220),
      summary: (summary ?? "").slice(0, 360),
    });
    if (out.length >= 20) break;
  }
  return out;
}

function ArxivSearchOutput({ text }: { text: string }) {
  if (text.trim() === "No results found.") {
    return (
      <div className="text-[11px] italic text-muted-foreground">no results</div>
    );
  }
  const hits = parseArxivResults(text);
  if (hits.length === 0) {
    return (
      <pre className="max-h-60 overflow-auto rounded bg-muted/40 p-2 font-mono text-[11px] whitespace-pre-wrap">
        {text}
      </pre>
    );
  }
  return (
    <div className="space-y-1.5">
      {hits.map((h, i) => (
        <div
          key={`${h.id}-${i}`}
          className="space-y-0.5 rounded border border-border/40 bg-card/40 px-2 py-1.5"
        >
          <div className="flex items-baseline gap-2">
            <span className="truncate text-[11.5px] font-medium text-foreground">
              {h.title || h.id}
            </span>
            {h.id ? (
              <a
                href={`https://arxiv.org/abs/${h.id}`}
                target="_blank"
                rel="noreferrer noopener"
                className="shrink-0 font-mono text-[10px] text-muted-foreground hover:text-foreground hover:underline"
              >
                {h.id}
              </a>
            ) : null}
          </div>
          {h.summary ? (
            <div className="line-clamp-2 text-[11px] text-muted-foreground">
              {h.summary}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

// HF Hub returns the raw file body, possibly tail-truncated with the
// literal `\n... [TRUNCATED]` marker. Split that off so the indicator
// chip is explicit rather than buried at the bottom of a 20KB blob.
const HF_TRUNCATED_TAIL = "\n... [TRUNCATED]";

function HfHubFileOutput({ text }: { text: string }) {
  const truncated = text.endsWith(HF_TRUNCATED_TAIL);
  const body = truncated
    ? text.slice(0, -HF_TRUNCATED_TAIL.length)
    : text;
  const lines = body ? body.split("\n").length : 0;
  return (
    <div className="space-y-1">
      <pre className="max-h-60 overflow-auto rounded bg-muted/40 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
        {body || " "}
      </pre>
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <span>
          {lines.toLocaleString()} line{lines === 1 ? "" : "s"} ·{" "}
          {formatBytes(body.length)}
        </span>
        {truncated ? (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-700 dark:text-amber-400">
            truncated
          </span>
        ) : null}
      </div>
    </div>
  );
}

// "started_at_ms" is a wall-clock millis epoch; show "5m ago" / "2h ago"
// so a `bash_list` snapshot reads at a glance without parsing dates.
function formatStartedAgo(startedAtMs: number): string {
  const ms = Date.now() - startedAtMs;
  if (ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
}

function BashRunOutput({ data }: { data: Record<string, unknown> }) {
  const stdout = typeof data.stdout === "string" ? data.stdout : "";
  const stderr = typeof data.stderr === "string" ? data.stderr : "";
  const exit = typeof data.exit_code === "number" ? data.exit_code : null;
  const cwdAfter = typeof data.cwd_after === "string" ? data.cwd_after : null;
  const truncated = Boolean(data.truncated);
  const timedOut = Boolean(data.timed_out);

  const hasStdout = stdout.length > 0;
  const hasStderr = stderr.length > 0;
  const initial = hasStdout ? "stdout" : hasStderr ? "stderr" : "stdout";
  const [tab, setTab] = useState<"stdout" | "stderr">(initial);

  const tabs: Array<{
    key: "stdout" | "stderr";
    label: string;
    count: number;
  }> = [
    { key: "stdout", label: "stdout", count: stdout.length },
    { key: "stderr", label: "stderr", count: stderr.length },
  ];

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              "rounded px-1.5 py-0.5 font-mono text-[10px] transition-colors",
              tab === t.key
                ? "bg-foreground/10 text-foreground"
                : "text-muted-foreground hover:text-foreground",
              t.count === 0 && "opacity-40",
            )}
            disabled={t.count === 0}
          >
            {t.label}
            {t.count > 0 ? (
              <span className="ml-1 text-muted-foreground">{t.count}</span>
            ) : null}
          </button>
        ))}
        <span className="flex-1" />
        {exit != null ? (
          <span
            className={cn(
              "rounded px-1.5 py-0.5 font-mono text-[10px]",
              exit === 0
                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                : "bg-destructive/15 text-destructive",
            )}
          >
            exit {exit}
          </span>
        ) : null}
        {timedOut ? (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:text-amber-400">
            timed out
          </span>
        ) : null}
        {truncated ? (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:text-amber-400">
            truncated
          </span>
        ) : null}
      </div>
      <pre className="max-h-72 overflow-auto rounded bg-muted/40 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
        {tab === "stdout" ? stdout || " " : stderr || " "}
      </pre>
      {cwdAfter ? (
        <div className="font-mono text-[10px] text-muted-foreground">
          cwd → {cwdAfter}
        </div>
      ) : null}
    </div>
  );
}

function highlightMatch(text: string, pattern: string): ReactNode {
  if (!pattern) return text;
  let re: RegExp;
  try {
    re = new RegExp(
      `(${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`,
      "gi",
    );
  } catch {
    return text;
  }
  const parts = text.split(re);
  return parts.map((p, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="rounded bg-amber-500/30 px-0.5 text-foreground">
        {p}
      </mark>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function CodeBlockMini({ code }: { code: string; language: string }) {
  // Tool input/output is debug-grade detail — JSON arrives pre-formatted and
  // file content is shown in the editor diff tab. Highlighting here is not
  // worth the parser hop.
  return (
    <pre className="max-h-60 overflow-auto rounded bg-muted/40 p-2 font-mono text-[11px] leading-relaxed text-foreground whitespace-pre-wrap">
      {code}
    </pre>
  );
}

function SuggestCommandCard({
  command,
  explanation,
}: {
  command: string;
  explanation: string | null;
}) {
  const [inserted, setInserted] = useState(false);
  const onInsert = () => {
    const ok = useChatStore
      .getState()
      .live.injectIntoActivePty(command);
    if (ok) setInserted(true);
  };
  return (
    <div className="space-y-1.5">
      {explanation ? (
        <div className="text-[11px] text-muted-foreground">{explanation}</div>
      ) : null}
      <div className="flex items-stretch gap-1.5 rounded bg-muted/40 overflow-hidden">
        <pre className="flex-1 overflow-auto p-2 font-mono text-[11px] leading-relaxed">
          {command}
        </pre>
        <button
          type="button"
          onClick={onInsert}
          disabled={inserted}
          className={cn(
            "shrink-0 flex items-center gap-1 px-2.5 text-[11px] font-medium",
            "border-l border-border/60",
            "hover:bg-muted/80 active:bg-muted",
            "disabled:opacity-60 disabled:cursor-default disabled:hover:bg-transparent",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          )}
          aria-label="Insert into active terminal"
        >
          <HugeiconsIcon
            icon={inserted ? TerminalIcon : ArrowRight01Icon}
            size={12}
            strokeWidth={1.75}
          />
          <span>{inserted ? "Inserted" : "Insert"}</span>
        </button>
      </div>
    </div>
  );
}

// Compatibility re-exports — the previous API exposed these subcomponents,
// but the new compact <Tool /> takes everything via props. Kept as no-ops
// to avoid breaking accidental imports.
export const ToolHeader = () => null;
export const ToolContent = ({ children }: { children?: ReactNode }) => (
  <>{children}</>
);
export { ToolInput, ToolOutput };
