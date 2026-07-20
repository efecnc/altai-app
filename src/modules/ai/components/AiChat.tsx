import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import { Tool } from "@/components/ai-elements/tool";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { motion } from "motion/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowRight01Icon,
  Cancel01Icon,
  CheckmarkCircle01Icon,
  CodeIcon,
  CopyIcon,
  File01Icon,
  GlobalSearchIcon,
  HashtagIcon,
  PencilEdit02Icon,
  Refresh01Icon,
  TerminalIcon,
} from "@hugeicons/core-free-icons";
import { SLASH_COMMANDS, ALTAI_CMD_RE } from "../lib/slashCommands";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { editUserMessage, retryLastMessage } from "../store/chatStore";
import type {
  ChatStatus,
  DynamicToolUIPart,
  ToolUIPart,
  UIMessage,
  UIMessagePart,
} from "ai";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AiToolApproval } from "./AiToolApproval";
import { AgentStatusPill } from "./AgentStatusPill";
import {
  Message,
  MessageActions,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";

function CommandSnippet({ name }: { name: string }) {
  const meta = SLASH_COMMANDS[name];
  if (!meta) {
    return (
      <div className="inline-flex items-center gap-1.5 rounded-md border border-border/50 bg-muted/40 px-2 py-1 font-mono text-[11px]">
        /{name}
      </div>
    );
  }
  return (
    <div className="inline-flex max-w-full items-center gap-2 rounded-md border border-border/50 bg-muted/40 px-2 py-1">
      <HugeiconsIcon
        icon={meta.icon}
        size={12}
        strokeWidth={1.75}
        className="shrink-0 text-foreground"
      />
      <span className="font-mono text-[11px] text-foreground">
        {meta.invocation}
      </span>
      <span className="truncate text-[11px] text-muted-foreground">
        {meta.label}
      </span>
    </div>
  );
}

type AnyToolPart = ToolUIPart | DynamicToolUIPart;

type ContextChip =
  | { kind: "selection"; source: "terminal" | "editor"; lines: number }
  | { kind: "file"; name: string; lines: number }
  | { kind: "terminal"; name: string; lines: number }
  | { kind: "diff"; name: string; lines: number }
  | { kind: "folder"; name: string; lines: number }
  | { kind: "snippet"; name: string };

const SELECTION_RE =
  /<selection\s+source="(terminal|editor)">\n?([\s\S]*?)\n?<\/selection>/g;
const FILE_RE =
  /<file\s+name="([^"]+)"[^>]*>\n?([\s\S]*?)\n?<\/file>/g;
const TERMINAL_CONTEXT_RE =
  /<terminal-context(?:\s+name="([^"]+)")?>\n?([\s\S]*?)\n?<\/terminal-context>/g;
const GIT_DIFF_RE =
  /<git-diff(?:\s+name="([^"]+)")?>\n?([\s\S]*?)\n?<\/git-diff>/g;
const FOLDER_RE = /<folder\s+name="([^"]+)">\n?([\s\S]*?)\n?<\/folder>/g;
const SNIPPET_RE = /<snippet\s+name="([^"]+)">\n?[\s\S]*?\n?<\/snippet>/g;

function countLines(s: string): number {
  if (!s) return 0;
  const trimmed = s.replace(/\n+$/, "");
  if (!trimmed) return 0;
  return trimmed.split("\n").length;
}

function stripUserContextBlocks(text: string): {
  text: string;
  chips: ContextChip[];
} {
  const chips: ContextChip[] = [];
  let out = text;
  out = out.replace(SELECTION_RE, (_m, source: string, body: string) => {
    chips.push({
      kind: "selection",
      source: source === "editor" ? "editor" : "terminal",
      lines: countLines(body),
    });
    return "";
  });
  out = out.replace(FILE_RE, (_m, name: string, body: string) => {
    chips.push({ kind: "file", name, lines: countLines(body) });
    return "";
  });
  out = out.replace(
    TERMINAL_CONTEXT_RE,
    (_m, name: string | undefined, body: string) => {
      chips.push({ kind: "terminal", name: name || "Active terminal", lines: countLines(body) });
      return "";
    },
  );
  out = out.replace(GIT_DIFF_RE, (_m, name: string | undefined, body: string) => {
    chips.push({ kind: "diff", name: name || "Working tree diff", lines: countLines(body) });
    return "";
  });
  out = out.replace(FOLDER_RE, (_m, name: string, body: string) => {
    chips.push({ kind: "folder", name, lines: countLines(body) });
    return "";
  });
  out = out.replace(SNIPPET_RE, (_m, name: string) => {
    chips.push({ kind: "snippet", name });
    return "";
  });
  return { text: out.trim(), chips };
}

const ContextChips = memo(function ContextChips({
  chips,
}: {
  chips: ContextChip[];
}) {
  return (
    <div className="mb-1 flex flex-wrap gap-1">
      {chips.map((c, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1 rounded-md border border-border/50 bg-card/60 px-1.5 py-0.5 text-[10.5px] text-muted-foreground"
        >
          {chipIcon(c)}
          <span className="font-medium text-foreground">{chipLabel(c)}</span>
          {"lines" in c && c.lines > 0 ? (
            <span className="opacity-70">· {c.lines}L</span>
          ) : null}
        </span>
      ))}
    </div>
  );
});

function chipIcon(c: ContextChip) {
  if (c.kind === "selection") {
    return (
      <HugeiconsIcon
        icon={c.source === "editor" ? CodeIcon : TerminalIcon}
        size={10}
        strokeWidth={1.75}
      />
    );
  }
  if (c.kind === "file") {
    return <HugeiconsIcon icon={File01Icon} size={10} strokeWidth={1.75} />;
  }
  if (c.kind === "terminal") {
    return <HugeiconsIcon icon={TerminalIcon} size={10} strokeWidth={1.75} />;
  }
  if (c.kind === "diff") {
    return <HugeiconsIcon icon={CodeIcon} size={10} strokeWidth={1.75} />;
  }
  if (c.kind === "folder") {
    return <HugeiconsIcon icon={File01Icon} size={10} strokeWidth={1.75} />;
  }
  return <HugeiconsIcon icon={HashtagIcon} size={10} strokeWidth={1.75} />;
}

function chipLabel(c: ContextChip): string {
  if (c.kind === "selection") {
    return c.source === "editor" ? "Editor selection" : "Terminal selection";
  }
  if (c.kind === "file") return c.name;
  if (c.kind === "terminal" || c.kind === "diff" || c.kind === "folder") return c.name;
  return `#${c.name}`;
}
type AnyPart = UIMessagePart<Record<string, never>, Record<string, never>>;

type ApprovalArg = {
  id: string;
  approved: boolean;
  reason?: string;
};

type Props = {
  messages: UIMessage[];
  status: ChatStatus;
  error: Error | undefined;
  clearError: () => void;
  addToolApprovalResponse: (arg: ApprovalArg) => void | PromiseLike<void>;
  stop?: () => void;
};

export function AiChatView({
  messages,
  status,
  error,
  clearError,
  addToolApprovalResponse,
  stop,
}: Props) {
  // Accessibility — pref-driven aria-live policy for the chat transcript.
  // "off" disables announcements entirely (some SR users prefer to pull
  // updates via virtual cursor instead of being interrupted on every chunk).
  const chatAnnounce = usePreferencesStore((s) => s.chatAnnounce);
  const ariaLiveProp: "off" | "polite" | "assertive" =
    chatAnnounce === "off"
      ? "off"
      : chatAnnounce === "assertive"
        ? "assertive"
        : "polite";
  const lastMessage = messages[messages.length - 1];
  const streamingMessageId =
    status === "streaming" && lastMessage?.role === "assistant"
      ? lastMessage.id
      : null;

  const onApproval = useCallback(
    (id: string, approved: boolean) => addToolApprovalResponse({ id, approved }),
    [addToolApprovalResponse],
  );

  if (messages.length === 0) {
    return (
      <Conversation className="overflow-x-hidden" aria-live={ariaLiveProp}>
        <ConversationContent className="min-w-0">
          <ConversationEmptyState
            title="Ask ALTAI anything"
            description="Explain command output, fix errors, generate snippets, or run a task."
          />
        </ConversationContent>
      </Conversation>
    );
  }

  return (
    <Conversation className="overflow-x-hidden" aria-live={ariaLiveProp}>
      <ConversationContent className="min-w-0 gap-5 p-3">
        {messages.map((m, i) => (
          <RenderedMessage
            key={m.id}
            message={m}
            onApproval={onApproval}
            streaming={m.id === streamingMessageId}
            canRetry={
              m.role === "assistant" && i === messages.length - 1 && status !== "streaming"
            }
            onRetry={() => void retryLastMessage()}
            onStop={() => void stop?.()}
          />
        ))}
         {/* Live tool state belongs to the conversation it describes, rather
            than floating above the composer. */}
        <div className="flex items-center px-1">
          <AgentStatusPill hideError />
        </div>
        {error && (
          // role="alert" => assertive live region. Without this the chat
          // failure was silent to screen readers and the agent appeared
          // to hang. JAWS/NVDA/VoiceOver will interrupt and announce the
          // error message + "Dismiss" affordance.
          <div
            role="alert"
            aria-atomic="true"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            <div className="font-medium">Something went wrong.</div>
            <div className="mt-0.5 leading-relaxed opacity-90">
              {error.message}
            </div>
            <button
              type="button"
              onClick={clearError}
              className="mt-1 underline opacity-80 hover:opacity-100"
            >
              Dismiss
            </button>
          </div>
        )}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}

function messageTextForCopy(m: UIMessage): string {
  return m.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

function MessageCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const tRef = useRef<number>(0);
  useEffect(() => () => window.clearTimeout(tRef.current), []);
  const onCopy = async () => {
    if (!navigator?.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      tRef.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* swallow */
    }
  };
  return (
    <button
      type="button"
      onClick={onCopy}
      title="Copy message"
      aria-label="Copy message"
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
    >
      <HugeiconsIcon
        icon={copied ? CheckmarkCircle01Icon : CopyIcon}
        size={11}
        strokeWidth={1.75}
      />
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function HoverActionButton({
  title,
  onClick,
  tone,
  children,
}: {
  title: string;
  onClick: () => void;
  tone?: "primary";
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] transition-colors hover:bg-foreground/10 hover:text-foreground",
        tone === "primary"
          ? "font-medium text-foreground"
          : "text-muted-foreground",
      )}
    >
      {children}
    </button>
  );
}

const RenderedMessage = memo(function RenderedMessage({
  message,
  onApproval,
  streaming,
  canRetry,
  onRetry,
  onStop,
}: {
  message: UIMessage;
  onApproval: (id: string, approved: boolean) => void;
  streaming: boolean;
  canRetry?: boolean;
  onRetry?: () => void;
  onStop?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // Index of the trailing text part — only that one is "live" mid-stream.
  // Earlier text parts (separated by tool calls) are already finalized.
  let lastTextIdx = -1;
  for (let i = message.parts.length - 1; i >= 0; i -= 1) {
    if (message.parts[i]?.type === "text") {
      lastTextIdx = i;
      break;
    }
  }
  if (message.role === "user") {
    const rawText = message.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n");

    const cmdMatch = rawText.match(ALTAI_CMD_RE);
    const commandName = cmdMatch?.[1] ?? null;
    const withoutCmd = cmdMatch ? rawText.slice(cmdMatch[0].length) : rawText;
    const stripped = stripUserContextBlocks(withoutCmd);

    const startEdit = () => {
      setDraft(stripped.text);
      setEditing(true);
    };
    const commitEdit = () => {
      const t = draft.trim();
      setEditing(false);
      if (t) void editUserMessage(message.id, t);
    };
    const cancelEdit = () => {
      setEditing(false);
      setDraft("");
    };

    if (editing) {
      return (
        <Message from="user">
          <MessageContent>
            <textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  commitEdit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancelEdit();
                }
              }}
              className="min-h-[3rem] w-full resize-y rounded-md bg-background/60 px-2 py-1.5 text-[12px] leading-relaxed outline-none ring-1 ring-border/60 focus:ring-foreground/30"
            />
          </MessageContent>
          <MessageActions className="justify-end gap-1">
            <HoverActionButton title="Save" onClick={commitEdit} tone="primary">
              Save
            </HoverActionButton>
            <HoverActionButton title="Cancel" onClick={cancelEdit}>
              Cancel
            </HoverActionButton>
          </MessageActions>
        </Message>
      );
    }

    return (
      <Message from="user">
        <MessageContent>
          {commandName ? <CommandSnippet name={commandName} /> : null}
          {stripped.chips.length > 0 ? (
            <ContextChips chips={stripped.chips} />
          ) : null}
          {stripped.text ? (
            <p className="whitespace-pre-wrap wrap-break-word">
              {stripped.text}
            </p>
          ) : null}
        </MessageContent>
        {stripped.text ? (
          <MessageActions className="justify-end opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            <MessageCopyButton text={stripped.text} />
            <HoverActionButton title="Edit" onClick={startEdit}>
              <HugeiconsIcon icon={PencilEdit02Icon} size={11} strokeWidth={1.75} />
              Edit
            </HoverActionButton>
          </MessageActions>
        ) : null}
      </Message>
    );
  }

  const groups = useMemo(() => buildPartGroups(message.parts as AnyPart[]), [
    message.parts,
  ]);

  return (
    <Message from={message.role}>
      <MessageContent>
        <div className="flex flex-col gap-3">
          {groups.map((g) => {
            if (g.kind === "reads") {
              return (
                <PartAppear key={`${message.id}-${g.key}`}>
                  <ReadGroup parts={g.parts} />
                </PartAppear>
              );
            }
            if (g.kind === "web") {
              return (
                <PartAppear key={`${message.id}-${g.key}`}>
                  <WebGroup parts={g.parts} onApproval={onApproval} />
                </PartAppear>
              );
            }
            if (g.kind === "cmd") {
              return (
                <PartAppear key={`${message.id}-${g.key}`}>
                  <CommandGroup parts={g.parts} onApproval={onApproval} />
                </PartAppear>
              );
            }
            const isReadSingle =
              toolNameOf(g.part) === "read_file" &&
              ((g.part as { state?: string }).state ?? "") !==
                "approval-requested";
            if (isReadSingle) {
              return (
                <PartAppear key={`${message.id}-${g.key}`}>
                  <ReadRow part={g.part} />
                </PartAppear>
              );
            }
            return (
              <PartAppear key={`${message.id}-${g.key}`}>
                <RenderedPart
                  part={g.part}
                  onApproval={onApproval}
                  streaming={streaming && g.idx === lastTextIdx}
                />
              </PartAppear>
            );
          })}
        </div>
      </MessageContent>
      <MessageActions className="opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <MessageCopyButton text={messageTextForCopy(message)} />
        {streaming ? (
          <HoverActionButton title="Stop generating" onClick={() => onStop?.()}>
            <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={1.75} />
            Stop
          </HoverActionButton>
        ) : canRetry ? (
          <HoverActionButton title="Retry" onClick={() => onRetry?.()}>
            <HugeiconsIcon icon={Refresh01Icon} size={11} strokeWidth={1.75} />
            Retry
          </HoverActionButton>
        ) : null}
      </MessageActions>
    </Message>
  );
});

type GroupKind = "reads" | "web" | "cmd";

type Group =
  | { kind: "single"; part: AnyPart; idx: number; key: string }
  | { kind: "reads"; parts: AnyPart[]; key: string }
  | { kind: "web"; parts: AnyPart[]; key: string }
  | { kind: "cmd"; parts: AnyPart[]; key: string };

function partType(p: AnyPart): string {
  return (p as { type?: string }).type ?? "";
}

// Vercel AI SDK transports statically-known tools as `type: "tool-<name>"`;
// IsanAgent (the production transport) ships every tool as
// `type: "dynamic-tool"` with the name on `toolName`. Both need to flow
// through the same grouping/summary logic, so we normalize the name once.
function toolNameOf(p: AnyPart): string | null {
  const type = partType(p);
  if (!type) return null;
  if (type === "dynamic-tool") {
    return (p as { toolName?: string }).toolName ?? null;
  }
  if (type.startsWith("tool-")) {
    return type.slice("tool-".length);
  }
  return null;
}

const READ_GROUP_TOOLS = new Set(["read_file"]);
const WEB_GROUP_TOOLS = new Set([
  "web_search",
  "web_fetch",
  "arxiv_search",
  "arxiv_fetch",
  "hf_hub_file_fetch",
]);
// Shell/command runs. A task that chains `cd`, `ls`, `git status`, … would
// otherwise stack a dozen identical-looking rows; collapse consecutive ones
// into a single "Ran N commands" group (expandable to the per-call cards).
const CMD_GROUP_TOOLS = new Set([
  "exec",
  "execution_run",
  "execution_run_background",
]);

// What collapsible run, if any, this part participates in. Approval
// cards always render as their own card so we never sweep them into
// a group — the approval UI is the one place where the user is
// expected to read and act.
function groupKindFor(p: AnyPart): GroupKind | null {
  const state = (p as { state?: string }).state ?? "";
  if (state === "approval-requested") return null;
  const name = toolNameOf(p);
  if (!name) return null;
  if (READ_GROUP_TOOLS.has(name)) return "reads";
  if (WEB_GROUP_TOOLS.has(name)) return "web";
  if (CMD_GROUP_TOOLS.has(name)) return "cmd";
  return null;
}

function partKey(p: AnyPart, idx: number): string {
  const tc = (p as { toolCallId?: string }).toolCallId;
  if (tc) return tc;
  const id = (p as { approval?: { id?: string } }).approval?.id;
  if (id) return id;
  return `i-${idx}`;
}

function buildPartGroups(parts: AnyPart[]): Group[] {
  const out: Group[] = [];
  let run: { kind: GroupKind; parts: AnyPart[]; startIdx: number } | null =
    null;
  const flushRun = () => {
    if (!run) return;
    if (run.parts.length >= 2) {
      out.push({
        kind: run.kind,
        parts: run.parts,
        key: `${run.kind}-${partKey(run.parts[0], run.startIdx)}`,
      });
    } else {
      run.parts.forEach((p, k) => {
        const idx = run!.startIdx + k;
        out.push({ kind: "single", part: p, idx, key: partKey(p, idx) });
      });
    }
    run = null;
  };
  parts.forEach((p, i) => {
    const kind = groupKindFor(p);
    if (kind) {
      if (run && run.kind === kind) {
        run.parts.push(p);
      } else {
        flushRun();
        run = { kind, parts: [p], startIdx: i };
      }
      return;
    }
    flushRun();
    out.push({ kind: "single", part: p, idx: i, key: partKey(p, i) });
  });
  flushRun();
  return out;
}

function readPathFromPart(p: AnyPart): string | null {
  const input = (p as { input?: { path?: unknown } }).input;
  const path = input?.path;
  return typeof path === "string" && path.length > 0 ? path : null;
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

const ReadGroup = memo(function ReadGroup({ parts }: { parts: AnyPart[] }) {
  const paths = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of parts) {
      const path = readPathFromPart(p);
      if (!path) continue;
      if (seen.has(path)) continue;
      seen.add(path);
      out.push(path);
    }
    return out;
  }, [parts]);
  const count = paths.length || parts.length;
  const preview = paths.map(basename).join(", ");

  return (
    <Collapsible className="group/read overflow-hidden rounded-md border border-border/50 bg-card/50">
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-2 px-2 py-1.5 text-left text-[12px]",
          "transition-colors hover:bg-muted/50",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
      >
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          size={11}
          strokeWidth={2}
          className={cn(
            "shrink-0 text-muted-foreground transition-transform",
            "group-data-[state=open]/read:rotate-90",
          )}
        />
        <HugeiconsIcon
          icon={File01Icon}
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <span className="shrink-0 font-medium text-foreground">Read</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {count} file{count === 1 ? "" : "s"}
        </span>
        {paths.length > 0 ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground/80 group-data-[state=open]/read:invisible">
            · {preview}
          </span>
        ) : null}
      </CollapsibleTrigger>
      <CollapsibleContent className="altai-collapsible-content border-t border-border/30">
        <ul className="flex flex-col gap-0.5 px-2 py-1.5">
          {paths.map((path) => (
            <li
              key={path}
              className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground"
            >
              <HugeiconsIcon
                icon={File01Icon}
                size={10}
                strokeWidth={1.75}
                className="shrink-0 opacity-60"
              />
              <span className="truncate text-foreground">
                {basename(path)}
              </span>
              <span className="truncate opacity-60">{path}</span>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
});

function webSummaryForPart(p: AnyPart): string | null {
  const name = toolNameOf(p);
  const input = (p as { input?: Record<string, unknown> }).input;
  if (!input || typeof input !== "object") return null;
  const str = (k: string) =>
    typeof input[k] === "string" ? (input[k] as string) : null;
  if (name === "web_search" || name === "arxiv_search") {
    const q = str("query");
    return q ? `"${q}"` : null;
  }
  if (name === "web_fetch") {
    const url = str("url");
    if (!url) return null;
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }
  if (name === "arxiv_fetch") return str("arxiv_id");
  if (name === "hf_hub_file_fetch") {
    return str("repo_id") ?? str("repo") ?? str("path") ?? null;
  }
  return null;
}

// Two or more consecutive web/arxiv/hf research calls collapse into one
// row so a five-call research chain doesn't push the whole transcript
// off-screen. Expanded view inlines each call as a full `<Tool>` so the
// per-call output cards (parsed search hits, fetched doc previews) stay
// reachable.
const WebGroup = memo(function WebGroup({
  parts,
  onApproval,
}: {
  parts: AnyPart[];
  onApproval: (id: string, approved: boolean) => void;
}) {
  const summaries = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of parts) {
      const s = webSummaryForPart(p);
      if (!s) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
    return out;
  }, [parts]);
  const count = parts.length;
  const preview = summaries.slice(0, 3).join(", ");

  return (
    <Collapsible className="group/web overflow-hidden rounded-md border border-border/50 bg-card/50">
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-2 px-2 py-1.5 text-left text-[12px]",
          "transition-colors hover:bg-muted/50",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
      >
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          size={11}
          strokeWidth={2}
          className={cn(
            "shrink-0 text-muted-foreground transition-transform",
            "group-data-[state=open]/web:rotate-90",
          )}
        />
        <HugeiconsIcon
          icon={GlobalSearchIcon}
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <span className="shrink-0 font-medium text-foreground">Web</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {count} call{count === 1 ? "" : "s"}
        </span>
        {preview ? (
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/80 group-data-[state=open]/web:invisible">
            · {preview}
            {summaries.length > 3
              ? `, +${summaries.length - 3} more`
              : ""}
          </span>
        ) : null}
      </CollapsibleTrigger>
      <CollapsibleContent className="altai-collapsible-content border-t border-border/30">
        <div className="flex flex-col gap-1 px-2 py-1.5">
          {parts.map((p, i) => (
            <RenderedPart
              key={partKey(p, i)}
              part={p}
              onApproval={onApproval}
              streaming={false}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
});

// First line of the command a run-tool executed, for the collapsed preview.
function cmdSummaryForPart(p: AnyPart): string | null {
  const name = toolNameOf(p);
  const input = (p as { input?: Record<string, unknown> }).input;
  if (!input || typeof input !== "object") return null;
  const str = (k: string) =>
    typeof input[k] === "string" ? (input[k] as string) : null;
  let raw: string | null = null;
  if (name === "exec") raw = str("description") ?? str("command");
  else if (name === "execution_run" || name === "execution_run_background")
    raw = str("description") ?? str("code");
  if (!raw) return null;
  const firstLine = raw.split("\n")[0].trim();
  return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
}

// Two or more consecutive shell runs collapse into one row so a chain of
// `cd`/`ls`/`git` calls doesn't push the transcript off-screen. Expanded
// view inlines each call as a full `<Tool>` so its stdout/exit card stays
// reachable — same pattern as WebGroup.
const CommandGroup = memo(function CommandGroup({
  parts,
  onApproval,
}: {
  parts: AnyPart[];
  onApproval: (id: string, approved: boolean) => void;
}) {
  const summaries = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of parts) {
      const s = cmdSummaryForPart(p);
      if (!s || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
    return out;
  }, [parts]);
  const count = parts.length;
  const preview = summaries.slice(0, 3).join(" · ");

  return (
    <Collapsible className="group/cmd overflow-hidden rounded-md border border-border/50 bg-card/50">
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-2 px-2 py-1.5 text-left text-[12px]",
          "transition-colors hover:bg-muted/50",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
      >
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          size={11}
          strokeWidth={2}
          className={cn(
            "shrink-0 text-muted-foreground transition-transform",
            "group-data-[state=open]/cmd:rotate-90",
          )}
        />
        <HugeiconsIcon
          icon={TerminalIcon}
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <span className="shrink-0 font-medium text-foreground">Ran</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {count} command{count === 1 ? "" : "s"}
        </span>
        {preview ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground/80 group-data-[state=open]/cmd:invisible">
            · {preview}
            {summaries.length > 3 ? `, +${summaries.length - 3} more` : ""}
          </span>
        ) : null}
      </CollapsibleTrigger>
      <CollapsibleContent className="altai-collapsible-content border-t border-border/30">
        <div className="flex flex-col gap-1 px-2 py-1.5">
          {parts.map((p, i) => (
            <RenderedPart
              key={partKey(p, i)}
              part={p}
              onApproval={onApproval}
              streaming={false}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
});

const PartAppear = memo(function PartAppear({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      style={{ willChange: "transform, opacity" }}
    >
      {children}
    </motion.div>
  );
});

const ReadRow = memo(function ReadRow({ part }: { part: AnyPart }) {
  const path = readPathFromPart(part);
  const state = (part as { state?: string }).state ?? "";
  const isError = state === "output-error";
  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px]">
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          isError
            ? "bg-destructive"
            : "border border-muted-foreground/40 bg-transparent",
        )}
      />
      <HugeiconsIcon
        icon={File01Icon}
        size={13}
        strokeWidth={1.75}
        className="shrink-0 text-muted-foreground"
      />
      <span className="shrink-0 font-medium text-foreground">Read</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
        {path ?? ""}
      </span>
    </div>
  );
});

const RenderedPart = memo(function RenderedPart({
  part,
  onApproval,
  streaming,
}: {
  part: AnyPart;
  onApproval: (id: string, approved: boolean) => void;
  streaming: boolean;
}) {
  if (part.type === "text") {
    return (
      <MessageResponse streaming={streaming}>
        {(part as unknown as { text: string }).text}
      </MessageResponse>
    );
  }

  if (part.type === "reasoning") {
    return (
      <Reasoning>
        <ReasoningTrigger />
        <ReasoningContent>
          {(part as unknown as { text: string }).text}
        </ReasoningContent>
      </Reasoning>
    );
  }

  if (
    part.type === "dynamic-tool" ||
    (typeof part.type === "string" && part.type.startsWith("tool-"))
  ) {
    return (
      <RenderedTool
        part={part as unknown as AnyToolPart}
        onApproval={onApproval}
      />
    );
  }

  return null;
});

const RenderedTool = memo(function RenderedTool({
  part,
  onApproval,
}: {
  part: AnyToolPart;
  onApproval: (id: string, approved: boolean) => void;
}) {
  const toolName =
    part.type === "dynamic-tool"
      ? part.toolName
      : part.type.replace(/^tool-/, "");

  if (part.state === "approval-requested") {
    return (
      <AiToolApproval
        part={part as Extract<ToolUIPart, { state: "approval-requested" }>}
        toolName={toolName}
        onRespond={(approved) => onApproval(part.approval.id, approved)}
      />
    );
  }

  return (
    <Tool
      toolName={toolName}
      state={part.state}
      input={part.input}
      output={"output" in part ? part.output : undefined}
      errorText={"errorText" in part ? part.errorText : undefined}
      defaultOpen={toolName === "list_directory"}
    />
  );
});
