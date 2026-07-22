import {
  Archive02Icon,
  CheckListIcon,
  File01Icon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { usePlanStore } from "../store/planStore";
import { useChatStore } from "../store/chatStore";
import { invoke } from "@tauri-apps/api/core";
import { currentWorkspaceFolder } from "@/modules/workspace/folder";

/**
 * Outcome of intercepting a slash command from the composer.
 *
 * - `"handled"`: command ran; the composer should NOT send a chat message.
 * - `"send-prompt"`: replace the user's text with `prompt` and send normally.
 * - `"none"`: not a slash command; let the composer behave as usual.
 */
export type SlashOutcome =
  | { kind: "handled"; toast?: string }
  | { kind: "send-prompt"; prompt: string; commandName?: string }
  | { kind: "none" };

const INIT_PROMPT = `Scan this workspace and produce ALTAI.md at the workspace root with:

- One-paragraph project description.
- Build / test / dev commands.
- Architecture overview (subsystems, data flow, key dirs).
- Conventions worth knowing (naming, patterns, gotchas).
- Paths to entry points.

Use grep/glob/list_directory/read_file to explore. Cap ALTAI.md under 200 lines. Use write_file to create it (will go through normal approval).`;

export type SlashCommandMeta = {
  name: string;
  invocation: string;
  label: string;
  icon: typeof SparklesIcon;
};

export const SLASH_COMMANDS: Record<string, SlashCommandMeta> = {
  init: {
    name: "init",
    invocation: "/init",
    label: "Initialize workspace",
    icon: SparklesIcon,
  },
  plan: {
    name: "plan",
    invocation: "/plan",
    label: "Plan mode",
    icon: CheckListIcon,
  },
  paper: {
    name: "paper",
    invocation: "/paper",
    label: "Import arXiv paper",
    icon: File01Icon,
  },
  compact: {
    name: "compact",
    invocation: "/compact",
    label: "Compact context",
    icon: Archive02Icon,
  },
};

export const ALTAI_CMD_RE =
  /^<altai-command\s+name="([a-z0-9-]+)"(?:\s+state="([a-z]+)")?\s*\/>(?:\n+|$)/;

export function wrapWithCommandMarker(prompt: string, name: string): string {
  return `<altai-command name="${name}" />\n\n${prompt}`;
}

export function tryRunSlashCommand(input: string): SlashOutcome {
  const trimmed = input.trim();
  const lead = trimmed[0];
  if (lead !== "/" && lead !== "#") return { kind: "none" };
  const [head, ...rest] = trimmed.slice(1).split(/\s+/);
  if (lead === "#" && !SLASH_COMMANDS[head]) return { kind: "none" };
  const tail = rest.join(" ").trim();

  switch (head) {
    case "plan": {
      const store = usePlanStore.getState();
      if (tail === "off" || tail === "exit") {
        store.disable();
        return { kind: "handled", toast: "Plan mode off" };
      }
      store.toggle();
      const nowActive = usePlanStore.getState().active;
      return {
        kind: "handled",
        toast: nowActive ? "Plan mode on" : "Plan mode off",
      };
    }
    case "init": {
      return {
        kind: "send-prompt",
        prompt: INIT_PROMPT,
        commandName: "init",
      };
    }
    case "paper": {
      useChatStore.getState().setPaperImportOpen(true);
      return { kind: "handled" };
    }
    case "compact":
    case "smol":
    case "condense": {
      void runCompactNow(tail || undefined);
      return { kind: "handled", toast: "Compaction requested" };
    }
    default:
      return { kind: "none" };
  }
}

/**
 * Fire a manual `/compact` directly (no input prefill, no Enter required).
 * Sends one direct backend FIFO command. It never creates a user message,
 * starts an agent run, or asks the model to select a compaction tool.
 */
export async function runCompactNow(focusInstructions?: string): Promise<boolean> {
  const store = useChatStore.getState();
  const chatId = store.activeSessionId;
  const workspacePath = currentWorkspaceFolder();
  if (!chatId || !workspacePath) return false;
  try {
    await invoke("agent_compact", {
      workspacePath,
      chatId,
      focusInstructions: focusInstructions?.trim() || null,
    });
    store.addActivity({
      label: "Context compaction requested",
      detail: "Queued directly on the agent runtime",
      kind: "agent",
      tone: "success",
    });
    return true;
  } catch (error) {
    store.addActivity({
      label: "Context compaction failed",
      detail: error instanceof Error ? error.message : String(error),
      kind: "agent",
      tone: "error",
    });
    return false;
  }
}
