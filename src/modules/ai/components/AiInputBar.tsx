import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  ArrowUpIcon,
  Attachment01Icon,
  Cancel01Icon,
  CodeIcon,
  File01Icon,
  HashtagIcon,
  Key01Icon,
  Mic01Icon,
  Search01Icon,
  TerminalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  ACCEPTED_FILES,
  resolveComposerEnterAction,
  useComposer,
  type FileAttachment,
} from "../lib/composer";
import { native } from "../lib/native";
import { useWorkspaceFiles } from "../hooks/useWorkspaceFiles";
import { SLASH_COMMANDS } from "../lib/slashCommands";
import type { Snippet } from "../lib/snippets";
import { useChatStore } from "../store/chatStore";
import { useSnippetsStore } from "../store/snippetsStore";
import { AgentSwitcher } from "./AgentSwitcher";
import { FilePickerContent } from "./FilePicker";
import { ModelDropdown } from "./AiStatusBarControls";
import { PaperImport } from "./PaperImport";
import { PermissionModeSwitcher } from "./PermissionModeSwitcher";
import { SnippetPickerContent, type PickerItem } from "./SnippetPicker";

type SnippetTrigger = {
  start: number;
  end: number;
  query: string;
};

type FileTrigger = {
  start: number;
  end: number;
  query: string;
};

function detectSnippetTrigger(
  value: string,
  caret: number,
): SnippetTrigger | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = value[i];
    if (ch === "#") {
      const prev = i === 0 ? " " : value[i - 1];
      if (!/\s/.test(prev)) return null;
      const slice = value.slice(i + 1, caret);
      if (!/^[a-z0-9-]*$/i.test(slice)) return null;
      return { start: i, end: caret, query: slice.toLowerCase() };
    }
    if (/\s/.test(ch)) return null;
    if (!/[a-z0-9-]/i.test(ch)) return null;
  }
  return null;
}

function detectFileTrigger(
  value: string,
  caret: number,
): FileTrigger | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = value[i];
    if (ch === "@") {
      const prev = i === 0 ? " " : value[i - 1];
      if (!/\s/.test(prev)) return null;
      const slice = value.slice(i + 1, caret);
      return { start: i, end: caret, query: slice };
    }
    if (/\s/.test(ch)) return null;
  }
  return null;
}

export function AiInputBar() {
  const c = useComposer();
  const snippets = useSnippetsStore((s) => s.snippets);
  const workspaceRoot = useChatStore((s) => s.live.getWorkspaceRoot());
  const paperImportOpen = useChatStore((s) => s.paperImportOpen);
  const agentPickerEnabled = usePreferencesStore((s) => s.agentPickerEnabled);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [trigger, setTrigger] = useState<SnippetTrigger | null>(null);
  const [fileTrigger, setFileTrigger] = useState<FileTrigger | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [contextOpen, setContextOpen] = useState(false);
  const workspaceFiles = useWorkspaceFiles(workspaceRoot, fileTrigger !== null);

  const [fileQuery, setFileQuery] = useState("");
  useEffect(() => {
    if (!fileTrigger) {
      setFileQuery("");
      return;
    }
    const q = fileTrigger.query;
    const t = window.setTimeout(() => setFileQuery(q), 50);
    return () => window.clearTimeout(t);
  }, [fileTrigger]);

  useEffect(() => {
    autoresize(c.textareaRef.current);
  }, [c.value, c.textareaRef]);

  // Re-run autoresize when the textarea's container width changes (e.g. the
  // user drags the agent sidebar). Without this, wrapped lines change but the
  // forced inline `style.height` stays at the old value and the box looks
  // stuck-tall after a resize.
  useEffect(() => {
    const el = c.textareaRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => autoresize(el));
    ro.observe(el);
    return () => ro.disconnect();
  }, [c.textareaRef]);

  const updateTrigger = () => {
    const el = c.textareaRef.current;
    if (!el) {
      setTrigger(null);
      setFileTrigger(null);
      return;
    }
    const caret = el.selectionStart ?? 0;
    setTrigger(detectSnippetTrigger(c.value, caret));
    setFileTrigger(detectFileTrigger(c.value, caret));
  };

  useEffect(updateTrigger, [c.value, c.textareaRef]);

  const filteredItems = useMemo<PickerItem[]>(() => {
    if (!trigger) return [];
    const q = trigger.query;
    const cmdItems: PickerItem[] = Object.values(SLASH_COMMANDS)
      .filter(
        (c) => !q || c.name.includes(q) || c.label.toLowerCase().includes(q),
      )
      .map((command) => ({ kind: "command", command }));
    const snipItems: PickerItem[] = snippets
      .filter(
        (s) =>
          !q ||
          s.handle.includes(q) ||
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q),
      )
      .map((snippet) => ({ kind: "snippet", snippet }));
    return [...cmdItems, ...snipItems];
  }, [trigger, snippets]);

  const FILE_PICKER_CAP = 30;
  const filteredFiles = useMemo<string[]>(() => {
    if (!fileTrigger) return [];
    const q = fileQuery.toLowerCase();
    if (!q) return workspaceFiles.files.slice(0, FILE_PICKER_CAP);
    const out: string[] = [];
    for (const f of workspaceFiles.files) {
      if (f.toLowerCase().includes(q)) {
        out.push(f);
        if (out.length >= FILE_PICKER_CAP) break;
      }
    }
    return out;
  }, [fileTrigger, fileQuery, workspaceFiles.files]);

  const fileTriggerOpen = fileTrigger !== null;
  const snippetTriggerOpen = trigger !== null;
  useEffect(() => {
    setActiveIndex(0);
  }, [snippetTriggerOpen, fileTriggerOpen, fileQuery]);

  const pickerOpen = trigger !== null || fileTrigger !== null;

  const onPickItem = (item: PickerItem) => {
    if (!trigger) return;
    const before = c.value.slice(0, trigger.start);
    const afterRaw = c.value.slice(trigger.end);
    let insert = "";
    if (item.kind === "snippet") {
      const needsSpace = afterRaw.length === 0 || !/^\s/.test(afterRaw);
      insert = `#${item.snippet.handle}${needsSpace ? " " : ""}`;
      c.addSnippet(item.snippet);
    } else {
      c.addCommand(item.command);
    }
    const after =
      item.kind === "command" ? afterRaw.replace(/^\s+/, "") : afterRaw;
    c.setValue(`${before}${insert}${after}`);
    setTrigger(null);
    setActiveIndex(0);
    requestAnimationFrame(() => {
      const el = c.textareaRef.current;
      if (!el) return;
      const caret = before.length + insert.length;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  const onPickFile = async (filePath: string) => {
    if (!fileTrigger || !workspaceRoot) return;
    const before = c.value.slice(0, fileTrigger.start);
    const after = c.value.slice(fileTrigger.end);
    c.setValue(`${before}${after}`);
    setFileTrigger(null);
    setActiveIndex(0);
    const fullPath = workspaceRoot.endsWith("/")
      ? `${workspaceRoot}${filePath}`
      : `${workspaceRoot}/${filePath}`;
    await c.attachFileByPath(fullPath);
    requestAnimationFrame(() => {
      const el = c.textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(before.length, before.length);
    });
  };

  const pickActive = () => {
    if (fileTrigger) {
      const file = filteredFiles[activeIndex];
      if (file) void onPickFile(file);
      return;
    }
    const it = filteredItems[activeIndex];
    if (it) onPickItem(it);
  };

  const voiceLabel = c.voice.recording
    ? "Listening…"
    : c.voice.transcribing
      ? "Transcribing…"
      : null;

  const hasChips =
    c.files.length > 0 ||
    c.pickedSnippets.length > 0 ||
    c.pickedCommands.length > 0;

  const attachActiveFile = async () => {
    const path = useChatStore.getState().live.getActiveFile();
    if (!path) return;
    await c.attachFileByPath(path);
    setContextOpen(false);
  };

  const attachTerminalContext = () => {
    const output = useChatStore.getState().live.getTerminalContext();
    if (!output) return;
    c.addTextContext({ kind: "terminal", name: "Active terminal", text: output });
    setContextOpen(false);
  };

  const attachWorkingDiff = async () => {
    if (!workspaceRoot) return;
    try {
      const diff = await native.gitDiff(workspaceRoot, null, false);
      if (diff.diffText.trim()) {
        c.addTextContext({ kind: "diff", name: "Working tree diff", text: diff.diffText });
      }
    } catch (cause) {
      useChatStore.getState().addActivity({
        label: "Could not attach working-tree diff",
        detail: cause instanceof Error ? cause.message : String(cause),
        tone: "error",
      });
    } finally {
      setContextOpen(false);
    }
  };

  const attachWorkspaceMap = async () => {
    if (!workspaceRoot) return;
    await c.attachFolderByPath(workspaceRoot);
    setContextOpen(false);
  };

  const prepareSembleSearch = () => {
    const prefix = "Use the Semble Scout subagent to search this workspace before answering.";
    c.setValue((value) =>
      value.trim() ? `${prefix}\n\n${value}` : `${prefix}\n\n`,
    );
    requestAnimationFrame(() => c.textareaRef.current?.focus());
  };

  return (
    <div className="shrink-0 bg-transparent px-3 pb-2 pt-5">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={ACCEPTED_FILES}
        className="hidden"
        onChange={(e) => {
          void c.addFiles(e.target.files);
          e.target.value = "";
        }}
      />

      {paperImportOpen && (
        <PaperImport
          onClose={() => useChatStore.getState().setPaperImportOpen(false)}
        />
      )}

      <div
        className={cn(
          "flex flex-col overflow-hidden rounded-2xl border border-border/60 bg-card/85 shadow-[0_-12px_32px_-24px_rgba(0,0,0,0.7)] backdrop-blur-xl",
          "transition-[border-color,box-shadow,background-color] hover:border-border focus-within:border-foreground/40 focus-within:bg-card focus-within:shadow-[0_-16px_40px_-24px_rgba(0,0,0,0.8)]",
          c.isBusy && "opacity-95",
        )}
      >
        {hasChips && (
          <div className="border-b border-border/40 px-2.5 py-2">
            <ChipsRow
              files={c.files}
              onRemoveFile={c.removeFile}
              snippets={c.pickedSnippets}
              onRemoveSnippet={(id) => {
                const snip = c.pickedSnippets.find((s) => s.id === id);
                c.removeSnippet(id);
                if (!snip) return;
                const re = new RegExp(`(^|\\s)#${snip.handle}\\b ?`);
                c.setValue((v) => v.replace(re, (_m, lead: string) => lead));
              }}
              commands={c.pickedCommands}
              onRemoveCommand={(name) => c.removeCommand(name)}
              contextTokenEstimate={c.contextTokenEstimate}
            />
          </div>
        )}

        <Popover open={pickerOpen}>
          <PopoverAnchor asChild>
            <div className="relative px-3 pb-1 pt-2.5">
              <textarea
                ref={c.textareaRef}
                value={c.value}
                onChange={(e) => c.setValue(e.target.value)}
                onKeyUp={updateTrigger}
                onClick={updateTrigger}
                onSelect={updateTrigger}
                onKeyDown={(e) => {
                  if (pickerOpen) {
                    const items = fileTrigger ? filteredFiles : filteredItems;
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setActiveIndex((i) =>
                        Math.min(i + 1, Math.max(0, items.length - 1)),
                      );
                      return;
                    }
                    if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setActiveIndex((i) => Math.max(0, i - 1));
                      return;
                    }
                    if (e.key === "Tab" || e.key === "Enter") {
                      if (items.length > 0) {
                        e.preventDefault();
                        pickActive();
                        return;
                      }
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      if (fileTrigger) {
                        const before = c.value.slice(0, fileTrigger.start);
                        const after = c.value.slice(fileTrigger.end);
                        c.setValue(`${before}${after}`);
                        setFileTrigger(null);
                      } else {
                        setTrigger(null);
                      }
                      return;
                    }
                  }
                  if (e.key === "Enter") {
                    const action = resolveComposerEnterAction({
                      availability: c.actionAvailability,
                      shiftKey: e.shiftKey,
                      modifierKey: e.metaKey || e.ctrlKey,
                    });
                    if (action) e.preventDefault();
                    if (action === "steer") c.steer();
                    else if (action === "queue") c.queueNext();
                    else if (action === "send") c.submit();
                  }
                }}
                placeholder="Ask ALTAI anything…  @ files  # snippets"
                aria-label="Message ALTAI"
                rows={1}
                className={cn(
                  "block w-full max-h-44 min-h-[28px] resize-none bg-transparent",
                  // Right padding reserves space for the absolutely-positioned
                  // send/stop button so long text never slides under it.
                  "pr-10 text-[13px] leading-5 text-foreground outline-none",
                  "placeholder:text-muted-foreground/55",
                )}
              />
              {/* Send / stop button floats in the textarea's top-right corner.
                  Its accessible label is also exposed as a hover title. */}
              <div className="absolute right-3 top-2.5">
                {c.isBusy ? (
                  <HoverTooltip label={c.isCancelling ? "Cancelling…" : "Stop"}>
                    <Button
                      type="button"
                      size="icon-xs"
                      onClick={c.stop}
                      disabled={c.isCancelling}
                      className={cn(
                        "rounded-md p-0 transition-colors",
                        "bg-foreground/10 text-foreground hover:bg-foreground/15",
                      )}
                      aria-label={c.isCancelling ? "Cancelling" : "Stop"}
                    >
                      {c.isCancelling ? (
                        <Spinner className="size-3" />
                      ) : (
                        <span className="block size-2 rounded-[2px] bg-foreground" />
                      )}
                    </Button>
                  </HoverTooltip>
                ) : (
                  <HoverTooltip label="Send (Enter)">
                    <Button
                      type="button"
                      size="icon-xs"
                      onClick={c.submit}
                      disabled={!c.canSend}
                      className={cn(
                        "rounded-md p-0 transition-all",
                        c.canSend
                          ? "bg-foreground text-background hover:bg-foreground/90 active:scale-95"
                          : "bg-foreground/10 text-foreground/35",
                      )}
                      aria-label="Send"
                    >
                      <HugeiconsIcon
                        icon={ArrowUpIcon}
                        size={12}
                        strokeWidth={2.25}
                      />
                    </Button>
                  </HoverTooltip>
                )}
              </div>
            </div>
          </PopoverAnchor>
          {fileTrigger ? (
            <FilePickerContent
              files={filteredFiles}
              activeIndex={activeIndex}
              indexing={workspaceFiles.indexing}
              truncated={workspaceFiles.truncated}
              hasWorkspace={workspaceRoot !== null}
              onPick={(f) => void onPickFile(f)}
              onHover={setActiveIndex}
            />
          ) : (
            <SnippetPickerContent
              items={filteredItems}
              activeIndex={activeIndex}
              onPick={onPickItem}
              onHover={setActiveIndex}
            />
          )}
        </Popover>

        {c.isBusy && (
          <div className="flex items-center gap-1.5 border-t border-border/40 px-2.5 py-1.5">
            <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
              {c.isCancelling
                ? "Cancellation requested — you can queue the next task"
                : "Enter queues next · ⌘/Ctrl+Enter steers this run"}
            </span>
            {c.isRunning && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={c.steer}
                disabled={!c.canSteer}
                title={
                  c.files.some(
                    (file) => file.kind === "image" || file.kind === "pdf",
                  )
                    ? "Steering cannot include images or PDFs; use Queue next"
                    : "Apply at the active run's next safe boundary"
                }
                className="h-6 px-2 text-[11px]"
              >
                Steer now
              </Button>
            )}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={c.queueNext}
              disabled={!c.canQueue}
              title="Start after the active run terminates"
              className="h-6 px-2 text-[11px]"
            >
              Queue next
            </Button>
          </div>
        )}

        <div className="flex items-center gap-0.5 overflow-x-auto border-t border-border/40 bg-muted/[0.14] px-2.5 pb-1.5 pt-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <ToolbarIcon
            title="Attach file or image"
            onClick={() => fileInputRef.current?.click()}
          >
            <HugeiconsIcon icon={Attachment01Icon} size={14} strokeWidth={1.75} />
          </ToolbarIcon>

          <Popover open={contextOpen} onOpenChange={setContextOpen}>
            <PopoverAnchor asChild>
              <ToolbarIcon
                title="Add workspace context"
                onClick={() => setContextOpen((open) => !open)}
              >
                <HugeiconsIcon icon={CodeIcon} size={14} strokeWidth={1.75} />
              </ToolbarIcon>
            </PopoverAnchor>
            <PopoverContent side="top" align="start" sideOffset={6} className="w-56 p-1.5">
              <ContextAction icon={File01Icon} label="Active file" detail="Attach the file open in the editor" disabled={!workspaceRoot || !useChatStore.getState().live.getActiveFile()} onClick={() => void attachActiveFile()} />
              <ContextAction icon={Attachment01Icon} label="Workspace file map" detail="Attach a compact folder manifest" disabled={!workspaceRoot} onClick={() => void attachWorkspaceMap()} />
              <ContextAction icon={TerminalIcon} label="Active terminal" detail="Attach the latest non-private output" disabled={!useChatStore.getState().live.getTerminalContext()} onClick={attachTerminalContext} />
              <ContextAction icon={CodeIcon} label="Working tree diff" detail="Attach unstaged Git changes" disabled={!workspaceRoot} onClick={() => void attachWorkingDiff()} />
            </PopoverContent>
          </Popover>


          <ToolbarIcon
            title="Research with Semble Scout"
            onClick={prepareSembleSearch}
            disabled={!workspaceRoot}
          >
            <HugeiconsIcon icon={Search01Icon} size={14} strokeWidth={1.75} />
          </ToolbarIcon>

          <HoverTooltip label="Permission mode">
            <PermissionModeSwitcher variant="toolbar-icon" />
          </HoverTooltip>
          {agentPickerEnabled && <AgentSwitcher variant="toolbar" />}
          <ModelDropdown />

          <div className="flex-1" />

          {c.voice.supported && (
            <ToolbarIcon
              title={
                !c.voice.hasKey
                  ? "Voice needs an OpenAI key"
                  : c.voice.recording
                    ? "Stop & transcribe"
                    : c.voice.transcribing
                      ? "Transcribing…"
                      : "Voice input"
              }
              onClick={() =>
                c.voice.recording ? c.voice.stop() : void c.voice.start()
              }
              disabled={c.voice.transcribing || !c.voice.hasKey}
              className={cn(
                c.voice.recording &&
                  "bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive",
              )}
            >
              {c.voice.recording ? (
                <span className="size-2 animate-pulse rounded-full bg-destructive" />
              ) : c.voice.transcribing ? (
                <Spinner className="size-3" />
              ) : (
                <HugeiconsIcon icon={Mic01Icon} size={14} strokeWidth={1.75} />
              )}
            </ToolbarIcon>
          )}
        </div>
      </div>

      <AnimatePresence initial={false}>
        {voiceLabel && (
          <motion.div
            key={voiceLabel}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.12 }}
            className="mt-1 flex items-center gap-1.5 px-1.5 text-[11px] text-muted-foreground"
          >
            {c.voice.recording ? (
              <span className="size-1.5 animate-pulse rounded-full bg-destructive" />
            ) : (
              <Spinner className="size-3" />
            )}
            <span className="truncate">{voiceLabel}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ToolbarIcon({
  title,
  onClick,
  disabled,
  className,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <HoverTooltip label={title}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={title}
        onClick={onClick}
        disabled={disabled}
        className={cn(
          "size-6 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground",
          className,
        )}
      >
        {children}
      </Button>
    </HoverTooltip>
  );
}

/** Opens only while a pointer is over the control, never on click or focus. */
function HoverTooltip({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <Tooltip open={open} onOpenChange={() => undefined}>
      <TooltipTrigger asChild>
        <span
          className="inline-flex shrink-0"
          onPointerEnter={() => setOpen(true)}
          onPointerLeave={() => setOpen(false)}
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6} className="text-[11px]">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function ChipsRow({
  files,
  onRemoveFile,
  snippets,
  onRemoveSnippet,
  commands,
  onRemoveCommand,
  contextTokenEstimate,
}: {
  files: FileAttachment[];
  onRemoveFile: (id: string) => void;
  snippets: Snippet[];
  onRemoveSnippet: (id: string) => void;
  commands: { name: string; label: string; icon: typeof HashtagIcon }[];
  onRemoveCommand: (name: string) => void;
  contextTokenEstimate: number;
}) {
  if (files.length === 0 && snippets.length === 0 && commands.length === 0)
    return null;
  return (
    <div className="flex flex-wrap gap-1">
      <AnimatePresence initial={false}>
        {commands.map((cmd) => (
          <motion.div
            key={`cmd-${cmd.name}`}
            layout
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.92 }}
            transition={{ duration: 0.12 }}
            className="group flex items-center gap-1 rounded-md border border-border/60 bg-card px-1.5 py-0.5 text-[11px]"
            title={cmd.label}
          >
            <HugeiconsIcon
              icon={cmd.icon}
              size={11}
              strokeWidth={1.75}
              className="text-muted-foreground"
            />
            <span className="font-medium">#{cmd.name}</span>
            <button
              type="button"
              onClick={() => onRemoveCommand(cmd.name)}
              className="ml-0.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
              aria-label="Remove command"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2} />
            </button>
          </motion.div>
        ))}
        {snippets.map((s) => (
          <motion.div
            key={`snip-${s.id}`}
            layout
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.92 }}
            transition={{ duration: 0.12 }}
            className="group flex items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary"
            title={s.description || s.name}
          >
            <HugeiconsIcon
              icon={HashtagIcon}
              size={11}
              strokeWidth={2}
              className="opacity-80"
            />
            <span className="font-medium">{s.handle}</span>
            <button
              type="button"
              onClick={() => onRemoveSnippet(s.id)}
              className="ml-0.5 opacity-0 transition-opacity group-hover:opacity-100"
              aria-label="Remove snippet"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2} />
            </button>
          </motion.div>
        ))}
        {files.map((f) => (
          <motion.div
            key={f.id}
            layout
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.92 }}
            transition={{ duration: 0.12 }}
            className="group flex items-center gap-1 rounded-md border border-border/60 bg-card px-1.5 py-0.5 text-[11px]"
          >
            {f.kind === "image" && f.url ? (
              <img src={f.url} alt="" className="size-4 rounded object-cover" />
            ) : f.kind === "selection" ? (
              <HugeiconsIcon
                icon={f.source === "editor" ? CodeIcon : TerminalIcon}
                size={11}
                strokeWidth={1.75}
                className="text-muted-foreground"
              />
            ) : f.kind === "terminal" ? (
              <HugeiconsIcon icon={TerminalIcon} size={11} strokeWidth={1.75} className="text-sky-600 dark:text-sky-400" />
            ) : f.kind === "diff" ? (
              <HugeiconsIcon icon={CodeIcon} size={11} strokeWidth={1.75} className="text-amber-600 dark:text-amber-400" />
            ) : f.kind === "folder" ? (
              <HugeiconsIcon icon={Attachment01Icon} size={11} strokeWidth={1.75} className="text-violet-600 dark:text-violet-400" />
            ) : (
              <span className="font-mono text-[10px] text-muted-foreground">
                {extOf(f.name)}
              </span>
            )}
            <span className="max-w-35 truncate">
              {f.name}
              {f.kind === "selection" && f.text ? (
                <span className="ml-1 text-muted-foreground">
                  · {selLineCount(f.text)}L
                </span>
              ) : null}
              {(f.kind === "terminal" || f.kind === "diff" || f.kind === "folder") && f.text ? (
                <span className="ml-1 text-muted-foreground">· {selLineCount(f.text)}L</span>
              ) : null}
            </span>
            <button
              type="button"
              onClick={() => onRemoveFile(f.id)}
              className="ml-0.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
              aria-label="Remove"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2} />
            </button>
          </motion.div>
        ))}
        {contextTokenEstimate > 0 ? (
          <span className="self-center px-1 text-[10px] tabular-nums text-muted-foreground" title="Approximate attached context tokens">
            ~{contextTokenEstimate >= 1000 ? `${(contextTokenEstimate / 1000).toFixed(1)}k` : contextTokenEstimate} tokens
          </span>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function ContextAction({
  icon,
  label,
  detail,
  disabled,
  onClick,
}: {
  icon: typeof CodeIcon;
  label: string;
  detail: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left disabled:opacity-40 hover:bg-accent">
      <HugeiconsIcon icon={icon} size={13} strokeWidth={1.75} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0"><span className="block text-[11px] font-medium">{label}</span><span className="block truncate text-[9.5px] text-muted-foreground">{detail}</span></span>
    </button>
  );
}

function selLineCount(text: string): number {
  if (!text) return 0;
  const trimmed = text.replace(/\n+$/, "");
  if (!trimmed) return 0;
  return trimmed.split("\n").length;
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? "FILE" : name.slice(i + 1).toUpperCase();
}

function autoresize(el: HTMLTextAreaElement | null) {
  if (!el) return;
  // Always clear first so a stale inline height from prior content can't keep
  // the box tall after the value shrinks back to empty.
  el.style.height = "";
  if (el.value.length === 0) return;
  el.style.height = `${Math.min(el.scrollHeight, 176)}px`;
}

export type AiInputBarProps = { tabId: number };

export function AiInputBarConnect({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="shrink-0 border-t border-border/60 bg-card/40 px-3 py-2">
      <div className="flex h-10 items-center justify-between gap-3 rounded-lg px-3 text-xs">
        <span className="text-muted-foreground">
          Connect any AI provider (or use local models) - your key stays in your
          OS keychain.
        </span>
        <Button size="xs" onClick={onAdd}>
          <HugeiconsIcon icon={Key01Icon} />
          Connect provider
        </Button>
      </div>
    </div>
  );
}
