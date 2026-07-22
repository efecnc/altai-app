import { describe, expect, it } from "vitest";
import {
  isRetryableRunOutcome,
  parseAgentEventPayload,
} from "./agentEventBridge";

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
