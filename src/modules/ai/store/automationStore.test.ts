import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAutomationInfo } from "../lib/native";

const nativeMocks = vi.hoisted(() => ({
  agentListAutomations: vi.fn(),
  agentListBackgroundJobs: vi.fn(),
  agentAutomationCreate: vi.fn(),
  agentAutomationRemove: vi.fn(),
}));

vi.mock("../lib/native", () => ({ native: nativeMocks }));

import { useAutomationStore } from "./automationStore";

function automation(overrides: Partial<AgentAutomationInfo> = {}): AgentAutomationInfo {
  return {
    id: "altai:b",
    schedule: { kind: "every", everyMs: 3_600_000 },
    message: "Write a briefing",
    chatId: "chat-a",
    lastRunAtMs: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  nativeMocks.agentListAutomations.mockResolvedValue([]);
  nativeMocks.agentListBackgroundJobs.mockResolvedValue([]);
  nativeMocks.agentAutomationCreate.mockResolvedValue(automation());
  nativeMocks.agentAutomationRemove.mockResolvedValue(undefined);
  useAutomationStore.setState({
    workspacePath: null,
    items: [],
    jobsByAutomationId: {},
    hydrated: false,
    loading: false,
    error: null,
    pendingIds: {},
  });
});

describe("automation store", () => {
  it("loads only the requested workspace and sorts its records", async () => {
    nativeMocks.agentListAutomations.mockResolvedValue([
      automation({ id: "altai:z" }),
      automation({ id: "altai:a" }),
    ]);

    await useAutomationStore.getState().refresh("/workspace");

    expect(nativeMocks.agentListAutomations).toHaveBeenCalledWith("/workspace");
    expect(useAutomationStore.getState().items.map((item) => item.id)).toEqual([
      "altai:a",
      "altai:z",
    ]);
  });

  it("uses the current workspace and owning chat for mutations", async () => {
    useAutomationStore.setState({ workspacePath: "/workspace" });

    const created = await useAutomationStore
      .getState()
      .create("chat-a", { kind: "at", atMs: 2_000_000_000_000 }, "Run once");

    expect(created).toBe(true);
    expect(nativeMocks.agentAutomationCreate).toHaveBeenCalledWith(
      "chat-a",
      { kind: "at", atMs: 2_000_000_000_000 },
      "Run once",
      "/workspace",
    );

    await useAutomationStore.getState().remove("altai:b", "chat-a");
    expect(nativeMocks.agentAutomationRemove).toHaveBeenCalledWith(
      "altai:b",
      "chat-a",
      "/workspace",
    );
  });
});
