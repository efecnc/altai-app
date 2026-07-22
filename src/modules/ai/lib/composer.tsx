import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useWhisperRecording } from "../hooks/useWhisperRecording";
import { expandSnippetTokens, type Snippet } from "../lib/snippets";
import { tryRunSlashCommand, type SlashCommandMeta } from "./slashCommands";
import { native } from "./native";
import { sendMessage, stop as stopAgent, useChatStore } from "../store/chatStore";
import { useAgentRunsStore } from "../store/agentRunsStore";
import { useSnippetsStore } from "../store/snippetsStore";

export type FileAttachment = {
  id: string;
  name: string;
  kind: "image" | "pdf" | "text" | "selection" | "terminal" | "diff" | "folder";
  mediaType: string;
  url?: string;
  text?: string;
  size: number;
  /** For kind === "selection": which surface it came from. */
  source?: "terminal" | "editor";
};

export const MAX_TEXT_INLINE = 200_000;
export const ACCEPTED_FILES =
  "image/*,.pdf,.txt,.md,.json,.yaml,.yml,.toml,.sh,.zsh,.bash,.py,.js,.jsx,.ts,.tsx,.rs,.go,.java,.c,.cpp,.h,.hpp,.html,.css,.csv,.log,.env,.config,.conf,.ini,Dockerfile,.dockerfile";

type Voice = ReturnType<typeof useWhisperRecording>;

export type ComposerAction = "send" | "steer" | "queue";

export type ComposerActionAvailability = {
  isBusy: boolean;
  isRunning: boolean;
  isCancelling: boolean;
  canSend: boolean;
  canSteer: boolean;
  canQueue: boolean;
};

export function getComposerActionAvailability(input: {
  status: string;
  hasDraft: boolean;
  hasNativeAttachment: boolean;
  runId: string | null;
  submitting: boolean;
}): ComposerActionAvailability {
  const isRunning = input.status === "thinking" || input.status === "streaming";
  const isCancelling = input.status === "cancelling";
  const isBusy = isRunning || isCancelling;
  const ready = input.hasDraft && !input.submitting;
  return {
    isBusy,
    isRunning,
    isCancelling,
    canSend: ready && !isBusy,
    canSteer:
      ready &&
      isRunning &&
      input.runId !== null &&
      !input.hasNativeAttachment,
    canQueue: ready && isBusy,
  };
}

export function resolveComposerEnterAction(input: {
  availability: ComposerActionAvailability;
  shiftKey: boolean;
  modifierKey: boolean;
}): ComposerAction | null {
  if (input.shiftKey) return null;
  if (input.modifierKey && input.availability.isRunning) {
    return input.availability.canSteer ? "steer" : null;
  }
  if (input.availability.isBusy) {
    return input.availability.canQueue ? "queue" : null;
  }
  return input.availability.canSend ? "send" : null;
}

export function remainingTextAfterAcceptedDispatch(
  current: string,
  submitted: string,
  draftWasUnchanged: boolean,
): string {
  if (draftWasUnchanged) return "";
  if (submitted && current.startsWith(submitted)) {
    return current.slice(submitted.length).replace(/^\s+/, "");
  }
  return current;
}

type ComposerCtx = {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  setValue: React.Dispatch<React.SetStateAction<string>>;
  files: FileAttachment[];
  addFiles: (list: FileList | null) => Promise<void>;
  /** Attach a file by absolute path — used by the file explorer's "Attach to Agent". */
  attachFileByPath: (path: string) => Promise<void>;
  attachFolderByPath: (path: string) => Promise<void>;
  /** Add a bounded, visible piece of runtime context (terminal output or diff). */
  addTextContext: (input: {
    kind: "terminal" | "diff" | "folder";
    name: string;
    text: string;
  }) => void;
  removeFile: (id: string) => void;
  pickedSnippets: Snippet[];
  addSnippet: (s: Snippet) => void;
  removeSnippet: (id: string) => void;
  pickedCommands: SlashCommandMeta[];
  addCommand: (c: SlashCommandMeta) => void;
  removeCommand: (name: string) => void;
  isBusy: boolean;
  isRunning: boolean;
  isCancelling: boolean;
  submit: () => void;
  steer: () => void;
  queueNext: () => void;
  stop: () => void;
  voice: Voice;
  canSend: boolean;
  canSteer: boolean;
  canQueue: boolean;
  actionAvailability: ComposerActionAvailability;
  contextTokenEstimate: number;
};

const Ctx = createContext<ComposerCtx | null>(null);

export function useComposer(): ComposerCtx {
  const ctx = useContext(Ctx);
  if (!ctx)
    throw new Error("useComposer must be used inside <AiComposerProvider>");
  return ctx;
}

type ProviderProps = {
  children: React.ReactNode;
};

export function AiComposerProvider({ children }: ProviderProps) {
  const sessionId = useChatStore((s) => s.activeSessionId);
  const status = useChatStore((s) => s.agentMeta.status);
  const runId = useAgentRunsStore((s) =>
    sessionId ? (s.runs[sessionId]?.runId ?? null) : null,
  );

  const [value, setValueState] = useState("");
  const valueRevision = useRef(0);
  const setValue: React.Dispatch<React.SetStateAction<string>> = (next) => {
    valueRevision.current += 1;
    setValueState(next);
  };
  const [files, setFiles] = useState<FileAttachment[]>([]);
  const [pickedSnippets, setPickedSnippets] = useState<Snippet[]>([]);
  const [pickedCommands, setPickedCommands] = useState<SlashCommandMeta[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const addFiles = async (list: FileList | null) => {
    if (!list) return;
    const next: FileAttachment[] = [];
    for (const f of Array.from(list)) {
      const att = await readAttachment(f);
      if (att) next.push(att);
    }
    if (next.length) setFiles((prev) => [...prev, ...next]);
  };

  const focusSignal = useChatStore((s) => s.focusSignal);
  const pendingPrefill = useChatStore((s) => s.pendingPrefill);
  const consumePrefill = useChatStore((s) => s.consumePrefill);
  const pendingSelections = useChatStore((s) => s.pendingSelections);
  const consumeSelections = useChatStore((s) => s.consumeSelections);

  useEffect(() => {
    if (focusSignal === 0) return;
    textareaRef.current?.focus();
    if (pendingPrefill != null) {
      const text = consumePrefill();
      if (text) setValue((v) => (v ? `${text}${v}` : text));
    }
  }, [focusSignal, pendingPrefill, consumePrefill]);

  // Listen for explorer's "Attach to Agent" event.
  useEffect(() => {
    const onAttach = (e: Event) => {
      const path = (e as CustomEvent<string>).detail;
      if (typeof path === "string" && path.length > 0) {
        void attachFileByPath(path);
      }
    };
    window.addEventListener("altai:ai-attach-file", onAttach);
    return () => window.removeEventListener("altai:ai-attach-file", onAttach);
    // attachFileByPath is stable for our purposes (closes over setFiles only)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tauri's webview surfaces OS file drags as normal HTML5 `FileList`s. Keep
  // this listener at document scope so a drop in either the workspace or the
  // chat attaches the files instead of letting the webview navigate away.
  useEffect(() => {
    const hasFiles = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const onDragOver = (event: DragEvent) => {
      if (hasFiles(event)) event.preventDefault();
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event) || !event.dataTransfer?.files.length) return;
      event.preventDefault();
      void addFiles(event.dataTransfer.files);
      useChatStore.getState().openMini();
      useChatStore.getState().focusInput();
    };
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("drop", onDrop);
    };
    // addFiles only closes over React's stable setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onAttach = (e: Event) => {
      const path = (e as CustomEvent<string>).detail;
      if (typeof path === "string" && path.length > 0) void attachFolderByPath(path);
    };
    window.addEventListener("altai:ai-attach-folder", onAttach);
    return () => window.removeEventListener("altai:ai-attach-folder", onAttach);
    // attachFolderByPath only closes over stable setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (pendingSelections.length === 0) return;
    const drained = consumeSelections();
    if (drained.length === 0) return;
    setFiles((prev) => {
      const existing = new Set(prev.map((f) => f.id));
      const next: FileAttachment[] = [];
      for (const sel of drained) {
        if (existing.has(sel.id)) continue;
        next.push({
          id: sel.id,
          name:
            sel.source === "editor"
              ? "Editor selection"
              : "Terminal selection",
          kind: "selection",
          mediaType: "text/plain",
          text: sel.text,
          size: sel.text.length,
          source: sel.source,
        });
      }
      return next.length ? [...prev, ...next] : prev;
    });
  }, [pendingSelections, consumeSelections]);

  const voice = useWhisperRecording({
    onResult: (transcript: string) => {
      setValue((v) => (v ? `${v} ${transcript}` : transcript));
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
  });

  const removeFile = (id: string) =>
    setFiles((prev) => prev.filter((f) => f.id !== id));

  const addSnippet = (s: Snippet) =>
    setPickedSnippets((prev) =>
      prev.some((p) => p.id === s.id) ? prev : [...prev, s],
    );
  const removeSnippet = (id: string) =>
    setPickedSnippets((prev) => prev.filter((s) => s.id !== id));

  const addCommand = (cmd: SlashCommandMeta) =>
    setPickedCommands((prev) =>
      prev.some((p) => p.name === cmd.name) ? prev : [...prev, cmd],
    );
  const removeCommand = (name: string) =>
    setPickedCommands((prev) => prev.filter((c) => c.name !== name));

  const attachFileByPath = async (path: string) => {
    try {
      if (/\.pdf$/i.test(path)) {
        // Workspace files are still converted to text so they remain readable
        // without a provider-specific file API. Browser-uploaded PDFs below
        // keep their original bytes and go to document-capable models directly.
        const result = await native.extractPdfPath(path);
        const name = path.split("/").pop() || path;
        const id = `path-${path}`;
        setFiles((prev) => prev.some((f) => f.id === id) ? prev : [...prev, {
          id, name, kind: "text", mediaType: "application/pdf",
          text: result.content, size: result.content.length,
        }]);
        useChatStore.getState().openMini();
        useChatStore.getState().focusInput();
        return;
      }
      const result = await native.readFile(path);
      if (result.kind !== "text") {
        // Binary/oversize files: skip (could surface a toast in future).
        console.warn("attachFileByPath: skipped non-text file", path, result);
        return;
      }
      const name = path.split("/").pop() || path;
      const id = `path-${path}`;
      setFiles((prev) => {
        if (prev.some((f) => f.id === id)) return prev;
        const att: FileAttachment = {
          id,
          name,
          kind: "text",
          mediaType: "text/plain",
          text: result.content,
          size: result.size,
        };
        return [...prev, att];
      });
      // Open the AI panel before focusing: on narrow windows it is an overlay,
      // so focusing a hidden composer made “Attach to Agent” look unresponsive.
      useChatStore.getState().openMini();
      useChatStore.getState().focusInput();
    } catch (e) {
      console.error("attachFileByPath failed:", e);
    }
  };

  const attachFolderByPath = async (path: string) => {
    try {
      const result = await native.listWorkspaceFiles(path);
      const files = result.files.slice(0, 500);
      const manifest = files.length ? files.map((file) => `- ${file}`).join("\n") : "(No files found)";
      const suffix = result.truncated ? "\n…[file list truncated]" : "";
      const name = path.split(/[\\/]/).filter(Boolean).pop() || path;
      addTextContext({ kind: "folder", name, text: `${manifest}${suffix}` });
    } catch (error) {
      console.error("attachFolderByPath failed:", error);
    }
  };

  const addTextContext = (input: {
    kind: "terminal" | "diff" | "folder";
    name: string;
    text: string;
  }) => {
    const text = input.text.trim();
    if (!text) return;
    // Keep a single context attachment from turning an ordinary chat turn
    // into an unbounded prompt. The backend already truncates git diffs; this
    // covers terminal output and external callers too.
    const bounded = text.length > 60_000 ? `${text.slice(0, 60_000)}\n…[truncated]` : text;
    const id = `context-${input.kind}-${input.name}`;
    setFiles((prev) => {
      const attachment: FileAttachment = {
        id,
        name: input.name,
        kind: input.kind,
        mediaType: "text/plain",
        text: bounded,
        size: bounded.length,
      };
      const existing = prev.findIndex((file) => file.id === id);
      if (existing < 0) return [...prev, attachment];
      const next = [...prev];
      next[existing] = attachment;
      return next;
    });
    useChatStore.getState().openMini();
    useChatStore.getState().focusInput();
  };

  const hasDraft =
    value.trim().length > 0 ||
    files.length > 0 ||
    pickedSnippets.length > 0 ||
    pickedCommands.length > 0;
  const actionAvailability = getComposerActionAvailability({
    status,
    hasDraft,
    hasNativeAttachment: files.some(
      (file) => file.kind === "image" || file.kind === "pdf",
    ),
    runId,
    submitting,
  });

  const clearAcceptedSnapshot = (snapshot: {
    valueRevision: number;
    value: string;
    files: FileAttachment[];
    snippets: Snippet[];
    commands: SlashCommandMeta[];
  }) => {
    setValueState((current) =>
      remainingTextAfterAcceptedDispatch(
        current,
        snapshot.value,
        valueRevision.current === snapshot.valueRevision,
      ),
    );
    setFiles((current) => current.filter((file) => !snapshot.files.includes(file)));
    setPickedSnippets((current) =>
      current.filter((snippet) => !snapshot.snippets.includes(snippet)),
    );
    setPickedCommands((current) =>
      current.filter((command) => !snapshot.commands.includes(command)),
    );
  };

  const dispatch = async (action: ComposerAction) => {
    if (submittingRef.current) return;
    if (action === "send" && !actionAvailability.canSend) return;
    if (action === "steer" && !actionAvailability.canSteer) return;
    if (action === "queue" && !actionAvailability.canQueue) return;
    const trimmed = value.trim();
    if (
      !trimmed &&
      files.length === 0 &&
      pickedSnippets.length === 0 &&
      pickedCommands.length === 0
    )
      return;

    const snapshot = {
      valueRevision: valueRevision.current,
      value,
      files,
      snippets: pickedSnippets,
      commands: pickedCommands,
    };

    // Slash-command interception. `/plan` toggles plan mode; `/init` rewrites
    // the prompt to the ALTAI.md scan template before sending.
    let effectiveText = trimmed;
    let commandMarker: string | null = null;
    let commandSource = trimmed;
    if (pickedCommands.length > 0 && !trimmed.startsWith("/") && !trimmed.startsWith("#")) {
      commandSource = `#${pickedCommands[0].name} ${trimmed}`.trim();
    }
    if (commandSource.startsWith("/") || commandSource.startsWith("#")) {
      const outcome = tryRunSlashCommand(commandSource);
      if (outcome.kind === "handled") {
        clearAcceptedSnapshot(snapshot);
        if (outcome.toast) console.info(outcome.toast);
        return;
      }
      if (outcome.kind === "send-prompt") {
        effectiveText = outcome.prompt;
        if (outcome.commandName) {
          commandMarker = `<altai-command name="${outcome.commandName}" />`;
        }
      }
    }

    const fileBlocks = files
      .filter((f) => f.kind === "text")
      .map(
        (f) =>
          `<file name="${f.name}" mediaType="${f.mediaType}">\n${f.text ?? ""}\n</file>`,
      );
    const selectionBlocks = files
      .filter((f) => f.kind === "selection")
      .map(
        (f) =>
          `<selection source="${f.source ?? "terminal"}">\n${f.text ?? ""}\n</selection>`,
      );
    const terminalBlocks = files
      .filter((f) => f.kind === "terminal")
      .map((f) => `<terminal-context name="${f.name}">\n${f.text ?? ""}\n</terminal-context>`);
    const diffBlocks = files
      .filter((f) => f.kind === "diff")
      .map((f) => `<git-diff name="${f.name}">\n${f.text ?? ""}\n</git-diff>`);
    const folderBlocks = files
      .filter((f) => f.kind === "folder")
      .map((f) => `<folder name="${f.name}">\n${f.text ?? ""}\n</folder>`);
    const { body: bodyAfterTokens, blocks: snippetBlocks } = expandSnippetTokens(
      effectiveText,
      useSnippetsStore.getState().snippets,
    );
    const seenHandles = new Set<string>();
    const allSnippetBlocks: string[] = [];
    for (const s of pickedSnippets) {
      if (seenHandles.has(s.handle)) continue;
      seenHandles.add(s.handle);
      allSnippetBlocks.push(
        `<snippet name="${s.handle}">\n${s.content}\n</snippet>`,
      );
    }
    for (const block of snippetBlocks) {
      const m = block.match(/^<snippet name="([^"]+)"/);
      if (m && seenHandles.has(m[1])) continue;
      if (m) seenHandles.add(m[1]);
      allSnippetBlocks.push(block);
    }
    const composed = [
      commandMarker ?? "",
      allSnippetBlocks.join("\n\n"),
      selectionBlocks.join("\n\n"),
      terminalBlocks.join("\n\n"),
      diffBlocks.join("\n\n"),
      folderBlocks.join("\n\n"),
      fileBlocks.join("\n\n"),
      bodyAfterTokens,
    ]
      .filter(Boolean)
      .join("\n\n");
    if (!sessionId) return;
    const store = useChatStore.getState();

    // Images and PDFs ride alongside the text as native multimodal parts.
    const imageUrls = files
      .filter((f) => f.kind === "image" && f.url)
      .map((f) => f.url as string);
    const documents = files
      .filter((f) => f.kind === "pdf" && f.url)
      .map((f) => ({
        data: f.url!.slice(f.url!.indexOf(",") + 1),
        mediaType: f.mediaType,
        name: f.name,
      }));

    submittingRef.current = true;
    setSubmitting(true);
    try {
      let accepted: boolean;
      if (action === "steer") {
        if (!runId) return;
        const acknowledgement = await native.agentSteer(
          sessionId,
          runId,
          composed,
        );
        if (
          acknowledgement.chatId !== sessionId ||
          acknowledgement.runId !== runId
        ) {
          throw new Error("The runtime acknowledged a different agent run");
        }
        store.appendNativeMessage(composed, "user");
        store.addActivity({
          label: "Steering queued for the active run",
          detail: "It will be applied at the next safe boundary",
          kind: "agent",
          tone: "success",
        });
        accepted = true;
      } else {
        accepted = await sendMessage(
          composed,
          imageUrls.length ? imageUrls : undefined,
          documents.length ? documents : undefined,
          { queue: action === "queue" },
        );
      }

      if (accepted) {
        if (!store.mini.open) store.openMini();
        clearAcceptedSnapshot(snapshot);
      }
    } catch (error) {
      store.addActivity({
        label:
          action === "steer"
            ? "Could not steer the active run"
            : "Task could not be queued",
        detail: error instanceof Error ? error.message : String(error),
        kind: "agent",
        tone: "error",
      });
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const submit = () => void dispatch("send");
  const steer = () => void dispatch("steer");
  const queueNext = () => void dispatch("queue");

  const stop = () => {
    if (!actionAvailability.isCancelling) stopAgent();
  };

  const { isBusy, isRunning, isCancelling, canSend, canSteer, canQueue } =
    actionAvailability;
  const contextTokenEstimate = Math.ceil(
    (files.reduce((total, file) => total + (file.kind === "image" ? 0 : (file.text?.length ?? 0)), 0) +
      pickedSnippets.reduce((total, snippet) => total + snippet.content.length, 0)) /
      4,
  );

  const ctx: ComposerCtx = {
    textareaRef,
    value,
    setValue,
    files,
    addFiles,
    attachFileByPath,
    attachFolderByPath,
    addTextContext,
    removeFile,
    pickedSnippets,
    addSnippet,
    removeSnippet,
    pickedCommands,
    addCommand,
    removeCommand,
    isBusy,
    isRunning,
    isCancelling,
    submit,
    steer,
    queueNext,
    stop,
    voice,
    canSend,
    canSteer,
    canQueue,
    actionAvailability,
    contextTokenEstimate,
  };

  return <Ctx.Provider value={ctx}>{children}</Ctx.Provider>;
}

async function readAttachment(file: File): Promise<FileAttachment | null> {
  const id = `${file.name}-${file.size}-${file.lastModified}`;
  if (file.type.startsWith("image/")) {
    const url = await readAsDataURL(file);
    return {
      id,
      name: file.name,
      kind: "image",
      mediaType: file.type || "image/png",
      url,
      size: file.size,
    };
  }
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
    if (file.size > 10 * 1024 * 1024) return null;
    return {
      id,
      name: file.name,
      kind: "pdf",
      mediaType: "application/pdf",
      url: await readAsDataURL(file),
      size: file.size,
    };
  }
  if (file.size > MAX_TEXT_INLINE) return null;
  const text = await file.text();
  return {
    id,
    name: file.name,
    kind: "text",
    mediaType: file.type || "text/plain",
    text,
    size: file.size,
  };
}

function readAsDataURL(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
