import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useChatStore } from "../store/chatStore";
import { tryRunSlashCommand } from "./slashCommands";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => ({ chatId: "chat-1" })),
}));

vi.mock("@/modules/workspace/folder", () => ({
  currentWorkspaceFolder: () => "/workspace",
}));

describe("manual compaction slash command", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockClear();
    useChatStore.setState({ activeSessionId: "chat-1" });
  });

  it("reaches exactly one backend command without producing a model prompt", async () => {
    const outcome = tryRunSlashCommand("/compact keep API decisions");

    expect(outcome).toMatchObject({ kind: "handled" });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("agent_compact", {
      workspacePath: "/workspace",
      chatId: "chat-1",
      focusInstructions: "keep API decisions",
    });
    await Promise.resolve();
  });
});
