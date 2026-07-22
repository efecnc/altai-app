import { describe, expect, it } from "vitest";
import {
  applyAgentEventPayload,
  isRetryableRunOutcome,
  parseAgentEventPayload,
} from "./agentEventBridge";
import { useChatStore } from "../store/chatStore";
import { useAgentRunsStore } from "../store/agentRunsStore";

const envelope = (event: unknown, overrides: Record<string, unknown> = {}) => ({
  version: 1,
  scope: "run",
  runId: "run-1",
  seq: 1,
  chatId: "chat-1",
  event,
  ...overrides,
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

  it("accepts replay metadata without weakening lifecycle validation", () => {
    expect(
      parseAgentEventPayload(
        envelope(
          { type: "run_started", run_id: "run-1" },
          { replay: true, timestampMs: 1_700_000_000_000 },
        ),
      ),
    ).toMatchObject({
      type: "run_started",
      run_id: "run-1",
      replay: true,
      timestamp_ms: 1_700_000_000_000,
    });
    expect(
      parseAgentEventPayload(
        envelope(
          { type: "run_started", run_id: "other-run" },
          { replay: true, timestampMs: 1_700_000_000_000 },
        ),
      ),
    ).toBeNull();
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

describe("replay side-effect boundary", () => {
  it("rebuilds lifecycle state without duplicating transcript or stale prompts", () => {
    const before = useChatStore.getState();
    useAgentRunsStore.setState({ runs: {} });
    useChatStore.setState({
      activeSessionId: "chat-1",
      nativeMessages: [],
      pendingClarificationsBySession: {},
      pendingChoices: null,
      pendingEditDiff: null,
      agentMeta: {
        ...before.agentMeta,
        pendingApprovals: [],
        approvalsPending: 0,
      },
    });

    applyAgentEventPayload(
      envelope({ type: "run_started", run_id: "run-1" }),
      true,
    );
    applyAgentEventPayload(
      envelope(
        { type: "agent_message", role: "assistant", content: "durable text" },
        { seq: 2, replay: true },
      ),
      true,
    );
    applyAgentEventPayload(
      envelope(
        { type: "tool_call_start", id: "tool-1", name: "shell", input: {} },
        { seq: 3, replay: true },
      ),
      true,
    );
    applyAgentEventPayload(
      envelope(
        {
          type: "tool_call_end",
          id: "tool-1",
          name: "shell",
          output: { exitCode: 0 },
        },
        { seq: 4, replay: true },
      ),
      true,
    );
    applyAgentEventPayload(
      envelope(
        {
          type: "approval_request",
          id: "approval-1",
          action: "shell",
          payload: {},
        },
        { seq: 5, replay: true },
      ),
      true,
    );
    applyAgentEventPayload(
      envelope(
        { type: "clarification", content: "Continue?", choices: ["Yes"] },
        { seq: 6, replay: true },
      ),
      true,
    );
    applyAgentEventPayload(
      envelope(
        {
          type: "run_terminated",
          run_id: "run-1",
          outcome: { kind: "completed" },
        },
        { seq: 7, replay: true },
      ),
      true,
    );

    const recovered = useChatStore.getState();
    expect(recovered.nativeMessages).toEqual([]);
    expect(recovered.pendingClarificationsBySession["chat-1"]).toBeUndefined();
    expect(recovered.agentMeta.pendingApprovals).toEqual([]);
    expect(useAgentRunsStore.getState().runs["chat-1"]).toMatchObject({
      runId: "run-1",
      lastSeq: 7,
      completed: true,
    });

    useChatStore.setState({
      activeSessionId: before.activeSessionId,
      nativeMessages: before.nativeMessages,
      pendingClarificationsBySession: before.pendingClarificationsBySession,
      pendingChoices: before.pendingChoices,
      pendingEditDiff: before.pendingEditDiff,
      agentMeta: before.agentMeta,
    });
    useAgentRunsStore.setState({ runs: {} });
  });
});
