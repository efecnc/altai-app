import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ingestAgentEventEnvelope,
  isRetryableRunOutcome,
  parseAgentEventPayload,
  replayRestoredAgentRuns,
} from "./agentEventBridge";
import { native } from "./native";
import { useAgentRunsStore } from "../store/agentRunsStore";
import { useChatStore } from "../store/chatStore";

const envelope = (event: unknown, overrides: Record<string, unknown> = {}) => ({
  version: 1 as const,
  scope: "run" as const,
  runId: "run-1",
  seq: 1,
  chatId: "chat-1",
  event,
  ...overrides,
});

describe("durable event replay", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useAgentRunsStore.setState({ runs: {} });
    useChatStore.setState({ activeSessionId: "chat-1", nativeMessages: [] });
  });

  it("recovers a persisted-before-delivery run without replaying UI mutations", async () => {
    vi.spyOn(native, "agentLatestRunReplayCursor").mockResolvedValue({
      runId: "run-1",
      lastSeq: 4,
      terminalSeq: 4,
    });
    const replay = vi.spyOn(native, "agentReplayEvents").mockResolvedValue([
      envelope({ type: "run_started", run_id: "run-1" }),
      envelope(
        { type: "tool_call_start", id: "tool-1", name: "test", input: {} },
        { seq: 2 },
      ),
      envelope(
        {
          type: "tool_call_end",
          id: "tool-1",
          name: "test",
          output: "passed",
        },
        { seq: 3 },
      ),
      envelope(
        {
          type: "run_terminated",
          run_id: "run-1",
          outcome: {
            kind: "failed",
            failure: "The previous app process ended before this run completed.",
            retryable: false,
          },
        },
        { seq: 4 },
      ),
    ]);

    await replayRestoredAgentRuns("/workspace", ["chat-1"]);

    expect(replay).toHaveBeenCalledWith(
      "chat-1",
      "run-1",
      0,
      "/workspace",
    );
    expect(useAgentRunsStore.getState().runs["chat-1"]).toMatchObject({
      runId: "run-1",
      lastSeq: 4,
      completed: true,
      outcome: { kind: "failed", retryable: false },
      verifications: [{ id: "tool-1", status: "passed" }],
    });
    expect(useChatStore.getState().nativeMessages).toEqual([]);
    expect(useChatStore.getState().agentMeta).toMatchObject({
      status: "error",
      error: "The previous app process ended before this run completed.",
    });
  });

  it("makes duplicate, delayed-live, overlapping, and unfocused recovery harmless", async () => {
    ingestAgentEventEnvelope(
      envelope({ type: "run_started", run_id: "run-1" }),
      "replay",
    );
    ingestAgentEventEnvelope(
      envelope({ type: "thinking", content: "delayed" }, { seq: 3 }),
      "replay",
    );
    expect(useAgentRunsStore.getState().runs["chat-1"].lastSeq).toBe(1);

    vi.spyOn(native, "agentLatestRunReplayCursor").mockImplementation(
      async (chatId) => ({
        runId: chatId === "chat-1" ? "run-1" : "run-2",
        lastSeq: 3,
        terminalSeq: 3,
      }),
    );
    vi.spyOn(native, "agentReplayEvents").mockImplementation(
      async (chatId, runId, afterSeq) => [
        ...(afterSeq === 0
          ? [envelope({ type: "run_started", run_id: runId }, { chatId, runId })]
          : []),
        envelope(
          { type: "thinking", content: "ordered" },
          { chatId, runId, seq: 2 },
        ),
        envelope(
          {
            type: "run_terminated",
            run_id: runId,
            outcome: { kind: "completed" },
          },
          { chatId, runId, seq: 3 },
        ),
      ],
    );

    await Promise.all([
      replayRestoredAgentRuns("/workspace", ["chat-1", "chat-2"]),
      replayRestoredAgentRuns("/workspace", ["chat-1"]),
    ]);
    ingestAgentEventEnvelope(
      envelope(
        {
          type: "run_terminated",
          run_id: "run-1",
          outcome: { kind: "completed" },
        },
        { seq: 3 },
      ),
      "replay",
    );

    expect(useAgentRunsStore.getState().runs["chat-1"]).toMatchObject({
      runId: "run-1",
      lastSeq: 3,
      completed: true,
    });
    expect(useAgentRunsStore.getState().runs["chat-2"]).toMatchObject({
      runId: "run-2",
      lastSeq: 3,
      completed: true,
    });
  });
});

describe("isRetryableRunOutcome", () => {
  it("permits retry only for a typed retryable failure", () => {
    expect(
      isRetryableRunOutcome({
        kind: "failed",
        failure: "provider_retries_exhausted",
        retryable: true,
      }),
    ).toBe(true);

    expect(
      isRetryableRunOutcome({
        kind: "failed",
        failure: "provider",
        retryable: false,
      }),
    ).toBe(false);
    expect(isRetryableRunOutcome({ kind: "stuck", reason: "doom_loop" })).toBe(false);
    expect(isRetryableRunOutcome(null)).toBe(false);
  });
});

describe("parseAgentEventPayload", () => {
  it("accepts a well-formed terminal lifecycle event", () => {
    expect(
      parseAgentEventPayload(
        envelope({
          type: "run_terminated",
          run_id: "run-1",
          outcome: {
            kind: "budget_exhausted",
            budget: { iterations_used: 3, iterations_limit: 3 },
          },
        }),
      ),
    ).toMatchObject({ type: "run_terminated", run_id: "run-1" });
  });

  it("accepts a typed non-terminal budget warning", () => {
    expect(
      parseAgentEventPayload(
        envelope({
          type: "run_warning",
          run_id: "run-1",
          warning: {
            reason: { kind: "no_progress", turns: 6 },
            budget: { iterations_used: 6, iterations_limit: 50 },
          },
        }),
      ),
    ).toMatchObject({
      type: "run_warning",
      warning: { reason: { kind: "no_progress", turns: 6 } },
    });
  });

  it("rejects unknown versions even when they look legacy", () => {
    expect(
      parseAgentEventPayload({
        version: 2,
        type: "agent_message",
        content: "hi",
        role: "assistant",
      }),
    ).toBeNull();
  });

  it("rejects malformed lifecycle bodies and mismatched run ids", () => {
    expect(
      parseAgentEventPayload(
        envelope({ type: "run_started", run_id: "other" }),
      ),
    ).toBeNull();
    expect(
      parseAgentEventPayload(
        envelope({
          type: "run_terminated",
          run_id: "run-1",
          outcome: { kind: "failed" },
        }),
      ),
    ).toBeNull();
  });

  it("accepts only system-safe events in system scope", () => {
    expect(
      parseAgentEventPayload({
        version: 1,
        scope: "system",
        chatId: "chat-1",
        event: {
          type: "notification_updated",
          notification_id: "n-1",
          state: "seen",
        },
      }),
    ).toMatchObject({ type: "notification_updated", scope: "system" });
    expect(
      parseAgentEventPayload({
        version: 1,
        scope: "system",
        chatId: "chat-1",
        event: { type: "run_started", run_id: "run-1" },
      }),
    ).toBeNull();
  });

  it.each([
    { kind: "completed" },
    { kind: "cancelled" },
    { kind: "failed", failure: "provider", retryable: true },
    { kind: "stuck", reason: "doom_loop" },
    {
      kind: "budget_exhausted",
      budget: { iterations_used: 3, iterations_limit: 3 },
    },
  ])("accepts terminal outcome $kind", (outcome) => {
    expect(
      parseAgentEventPayload(
        envelope({ type: "run_terminated", run_id: "run-1", outcome }),
      ),
    ).not.toBeNull();
  });

  it("permits only valid legacy assistant text", () => {
    expect(
      parseAgentEventPayload({
        type: "agent_message",
        content: "hi",
        role: "assistant",
      }),
    ).toMatchObject({ legacy: true });
    expect(parseAgentEventPayload({ type: "done", reason: "no" })).toBeNull();
  });
});
